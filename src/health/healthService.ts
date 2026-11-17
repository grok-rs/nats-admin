// Runs health checks per connection, keeps the latest report (and a short score
// history), auto-runs after connecting, re-runs periodically, clears on
// disconnect and publishes summaries to the health bus.

import * as vscode from "vscode";
import type { Services } from "../services";
import { errorMessage, type ConnState } from "../core/connectionManager";
import { cfg } from "../core/ui";
import { log } from "../core/log";
import { healthBus } from "../core/healthBus";
import { deriveMonitorUrl } from "../core/profile";
import { collectSnapshot } from "./collect";
import { analyze } from "./checks";
import { buildReport, summarize } from "./score";
import { DEFAULT_THRESHOLDS, type CheckThresholds, type HealthReport, type HealthSnapshot, type HealthViewModel } from "./model";

const HISTORY = 30;
/** Skip the automatic run after a reconnect when the last report is this recent. */
const AUTO_RUN_FRESH_MS = 60_000;

export function readThresholds(): CheckThresholds {
  const num = (key: string, fallback: number, min = 0, max = Number.POSITIVE_INFINITY) => {
    const v = Number(cfg<number>(key, fallback));
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  };
  return {
    ...DEFAULT_THRESHOLDS,
    pendingWarning: num("health.pendingWarning", DEFAULT_THRESHOLDS.pendingWarning),
    ackPendingRatio: num("health.ackPendingRatio", DEFAULT_THRESHOLDS.ackPendingRatio, 0, 1),
    storageWarningRatio: num("health.storageWarningRatio", DEFAULT_THRESHOLDS.storageWarningRatio, 0, 1),
    storageErrorRatio: num("health.storageErrorRatio", DEFAULT_THRESHOLDS.storageErrorRatio, 0, 1),
    rttWarningMs: num("health.rttWarningMs", DEFAULT_THRESHOLDS.rttWarningMs),
  };
}

export class HealthService implements vscode.Disposable {
  private readonly reports = new Map<string, HealthReport>();
  private readonly snapshots = new Map<string, HealthSnapshot>();
  private readonly histories = new Map<string, { at: number; score: number }[]>();
  private readonly running = new Map<string, Promise<HealthReport>>();
  private readonly errors = new Map<string, string>();
  private readonly autoTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _onDidChange = new vscode.EventEmitter<string>();
  /** Fires with the connection id whenever a report, running state or error changes. */
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [];
  private interval?: ReturnType<typeof setInterval>;

  constructor(private readonly s: Services) {
    this.disposables.push(
      this._onDidChange,
      s.manager.onDidChangeState((e) => this.onState(e.profileId, e.state)),
      s.store.onDidChange(() => {
        for (const id of [...this.reports.keys()]) if (!s.store.get(id)) this.clear(id);
        for (const id of this.reports.keys()) this._onDidChange.fire(id);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("nats.health")) return;
        this.reanalyze();
        this.schedulePeriodic();
        // autoRun / intervalMinutes are part of every view model, with or without a report.
        for (const id of new Set([...this.connIds(), ...s.manager.connected().map((c) => c.id)])) this._onDidChange.fire(id);
      }),
    );
    this.schedulePeriodic();
    for (const lc of s.manager.connected()) this.scheduleAutoRun(lc.id, 500);
  }

  get(connId: string): HealthReport | undefined {
    return this.reports.get(connId);
  }

  history(connId: string): { at: number; score: number }[] {
    return this.histories.get(connId) ?? [];
  }

  isRunning(connId: string): boolean {
    return this.running.has(connId);
  }

  lastError(connId: string): string | undefined {
    return this.errors.get(connId);
  }

  /** Connections with a report, a run in progress or a failed run. */
  connIds(): string[] {
    return [...new Set([...this.reports.keys(), ...this.running.keys(), ...this.errors.keys()])];
  }

  /** Run (or join the run in progress) for a connected profile. */
  run(connId: string): Promise<HealthReport> {
    const inflight = this.running.get(connId);
    if (inflight) return inflight;
    const lc = this.s.manager.get(connId);
    if (!lc) return Promise.reject(new Error(`${this.s.store.get(connId)?.name ?? "Connection"} is not connected`));
    // Every request would time out while the client reconnects, and the report would be a list of
    // "could not read" notes (or worse, "JetStream not enabled"). Keep the last report instead.
    if (lc.state === "reconnecting" || lc.state === "connecting") return Promise.reject(new Error(`${lc.profile.name} is reconnecting — run the health check once it is connected again`));
    const timer = this.autoTimers.get(connId);
    if (timer) clearTimeout(timer);
    this.autoTimers.delete(connId);
    const p = (async () => {
      try {
        const snap = await collectSnapshot(lc, { connId, connName: lc.profile.name, monitorUrl: deriveMonitorUrl(lc.profile) });
        const thresholds = readThresholds();
        const report = buildReport(snap, analyze(snap, thresholds), thresholds);
        if (!this.s.manager.get(connId)) throw new Error("Disconnected during the health check");
        this.snapshots.set(connId, snap);
        this.store(report);
        this.errors.delete(connId);
        log.info(`Health check "${lc.profile.name}": score ${report.score} (${report.counts.error} errors, ${report.counts.warning} warnings, ${report.counts.info} info) in ${report.durationMs} ms`);
        return report;
      } catch (e) {
        // A run cut short by a disconnect leaves nothing behind: clear() already reset this connection,
        // and a stored error would bring the closed connection back into the Health view.
        if (this.s.manager.get(connId)) this.errors.set(connId, errorMessage(e));
        throw e;
      } finally {
        this.running.delete(connId);
        this._onDidChange.fire(connId);
      }
    })();
    this.running.set(connId, p);
    this._onDidChange.fire(connId);
    return p;
  }

  clear(connId: string): void {
    const timer = this.autoTimers.get(connId);
    if (timer) clearTimeout(timer);
    this.autoTimers.delete(connId);
    const hadReport = this.reports.delete(connId);
    const hadError = this.errors.delete(connId);
    const had = hadReport || hadError;
    this.snapshots.delete(connId);
    this.histories.delete(connId);
    healthBus.clear(connId);
    if (had) this._onDidChange.fire(connId);
  }

  viewModel(connId: string): HealthViewModel {
    const p = this.s.store.get(connId);
    const ids = new Set([...this.s.manager.connected().map((c) => c.id), ...this.connIds(), connId]);
    return {
      connId,
      connName: p?.name ?? connId,
      environment: p?.environment,
      readOnly: p?.readOnly,
      state: this.s.manager.stateOf(connId).state,
      running: this.isRunning(connId),
      error: this.lastError(connId),
      report: this.get(connId),
      history: this.history(connId),
      connections: [...ids]
        .map((id) => ({ id, p: this.s.store.get(id) }))
        .filter((x) => x.p)
        .map(({ id, p: prof }) => ({ id, name: prof!.name, state: this.s.manager.stateOf(id).state, score: this.reports.get(id)?.score, environment: prof!.environment }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      autoRun: cfg("health.autoRun", true),
      intervalMinutes: cfg("health.intervalMinutes", 0),
    };
  }

  private store(report: HealthReport): void {
    this.reports.set(report.connId, report);
    const h = [...(this.histories.get(report.connId) ?? []), { at: report.at, score: report.score }].slice(-HISTORY);
    this.histories.set(report.connId, h);
    healthBus.publish(summarize(report));
  }

  /** Thresholds changed: re-run the pure analysis on the last snapshots (no server round trip). */
  private reanalyze(): void {
    const thresholds = readThresholds();
    for (const [connId, snap] of this.snapshots) {
      if (!this.reports.has(connId)) continue;
      const report = buildReport(snap, analyze(snap, thresholds), thresholds);
      this.reports.set(connId, report);
      const h = this.histories.get(connId);
      if (h?.length) h[h.length - 1] = { at: report.at, score: report.score };
      healthBus.publish(summarize(report));
    }
  }

  private onState(connId: string, state: ConnState): void {
    if (state === "connected") this.scheduleAutoRun(connId, 1500);
    else if (state === "disconnected" || state === "error") this.clear(connId);
    else this._onDidChange.fire(connId);
  }

  private scheduleAutoRun(connId: string, delay: number): void {
    if (!cfg("health.autoRun", true)) {
      this._onDidChange.fire(connId);
      return;
    }
    const last = this.reports.get(connId);
    if (last && Date.now() - last.at < AUTO_RUN_FRESH_MS) {
      this._onDidChange.fire(connId);
      return;
    }
    const prev = this.autoTimers.get(connId);
    if (prev) clearTimeout(prev);
    this.autoTimers.set(
      connId,
      setTimeout(() => {
        this.autoTimers.delete(connId);
        if (!this.s.manager.get(connId)) return;
        this.run(connId).catch((e) => log.warn(`Automatic health check failed: ${errorMessage(e)}`));
      }, delay),
    );
  }

  private schedulePeriodic(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    const minutes = Number(cfg("health.intervalMinutes", 0));
    if (!(minutes > 0)) return;
    this.interval = setInterval(() => {
      for (const lc of this.s.manager.connected()) {
        if (lc.state !== "connected" || this.running.has(lc.id)) continue;
        const last = this.reports.get(lc.id);
        if (last && Date.now() - last.at < minutes * 60_000 - 5_000) continue;
        this.run(lc.id).catch((e) => log.warn(`Periodic health check for "${lc.profile.name}" failed: ${errorMessage(e)}`));
      }
    }, 60_000);
  }

  dispose(): void {
    if (this.interval) clearInterval(this.interval);
    for (const t of this.autoTimers.values()) clearTimeout(t);
    this.autoTimers.clear();
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
