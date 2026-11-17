// Owns live NATS connections (one per profile), tracks their state, and hands
// out lazily created JetStream / KV / Object Store / Services clients.

import * as vscode from "vscode";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection, ServerInfo } from "@nats-io/nats-core";
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { Objm } from "@nats-io/obj";
import { Svcm } from "@nats-io/services";
import { buildConnectOptions, describeServers, type ConnectionProfile } from "./profile";
import type { ConnectionStore } from "./connectionStore";
import { log } from "./log";
import { CancelledError } from "./errors";
import { credsInfo, expiryStatus } from "./creds";

export type ConnState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

export class LiveConnection {
  state: ConnState = "connected";
  lastError?: string;
  private jsmPromise?: Promise<JetStreamManager>;
  private _js?: JetStreamClient;
  private _kvm?: Kvm;
  private _objm?: Objm;
  private _svcm?: Svcm;

  constructor(
    private readonly initialProfile: ConnectionProfile,
    readonly nc: NatsConnection,
    private readonly resolveProfile: () => ConnectionProfile | undefined = () => undefined,
  ) {}

  /** Always the current profile (environment / read-only changes apply to live connections). */
  get profile(): ConnectionProfile {
    return this.resolveProfile() ?? this.initialProfile;
  }

  get id(): string {
    return this.profile.id;
  }

  get info(): ServerInfo | undefined {
    return this.nc.info;
  }

  private get jsOpts() {
    const o: { domain?: string; apiPrefix?: string; timeout: number } = { timeout: 10_000 };
    if (this.profile.jsDomain) o.domain = this.profile.jsDomain;
    if (this.profile.jsApiPrefix) o.apiPrefix = this.profile.jsApiPrefix;
    return o;
  }

  /** JetStream manager; rejects if JetStream isn't enabled for the account. */
  jsm(): Promise<JetStreamManager> {
    if (!this.jsmPromise) {
      this.jsmPromise = jetstreamManager(this.nc, this.jsOpts);
      this.jsmPromise.catch(() => (this.jsmPromise = undefined));
    }
    return this.jsmPromise;
  }

  js(): JetStreamClient {
    return (this._js ??= jetstream(this.nc, this.jsOpts));
  }

  kvm(): Kvm {
    return (this._kvm ??= new Kvm(this.js()));
  }

  objm(): Objm {
    return (this._objm ??= new Objm(this.js()));
  }

  svcm(): Svcm {
    return (this._svcm ??= new Svcm(this.nc));
  }

  async hasJetStream(): Promise<boolean> {
    try {
      await this.jsm();
      return true;
    } catch {
      return false;
    }
  }
}

export interface StateChange {
  profileId: string;
  state: ConnState;
}

export class ConnectionManager implements vscode.Disposable {
  private readonly live = new Map<string, LiveConnection>();
  private readonly pending = new Map<string, Promise<LiveConnection>>();
  private readonly states = new Map<string, { state: ConnState; error?: string }>();
  private readonly _onDidChangeState = new vscode.EventEmitter<StateChange>();
  readonly onDidChangeState = this._onDidChangeState.event;
  private readonly _onDidChangeActive = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeActive = this._onDidChangeActive.event;
  private _activeId: string | undefined;

  constructor(
    private readonly store: ConnectionStore,
    private readonly memento: vscode.Memento,
  ) {
    this._activeId = memento.get<string>("nats.activeConnection");
  }

  get activeId(): string | undefined {
    return this._activeId;
  }

  setActive(id: string | undefined): void {
    if (this._activeId === id) return;
    this._activeId = id;
    void this.memento.update("nats.activeConnection", id);
    this._onDidChangeActive.fire(id);
  }

  get(id: string): LiveConnection | undefined {
    const c = this.live.get(id);
    return c && !c.nc.isClosed() ? c : undefined;
  }

  connected(): LiveConnection[] {
    return [...this.live.values()].filter((c) => !c.nc.isClosed());
  }

  stateOf(id: string): { state: ConnState; error?: string } {
    return this.states.get(id) ?? { state: "disconnected" };
  }

  private setState(id: string, state: ConnState, error?: string): void {
    this.states.set(id, { state, error });
    const c = this.live.get(id);
    if (c) {
      c.state = state;
      c.lastError = error;
    }
    this._onDidChangeState.fire({ profileId: id, state });
  }

  async connect(id: string): Promise<LiveConnection> {
    const existing = this.get(id);
    if (existing) return existing;
    const inflight = this.pending.get(id);
    if (inflight) return inflight;
    const profile = this.store.get(id);
    if (!profile) throw new Error("Unknown connection profile");

    const p = (async () => {
      this.setState(id, "connecting");
      log.info(`Connecting "${profile.name}" → ${describeServers(profile)}`);
      try {
        const warning = this.store.warningFor(id);
        if (warning) throw new Error(warning);
        const opts = await buildConnectOptions(profile, await this.store.ensureSecrets(profile));
        const nc = await connect(opts);
        const lc = new LiveConnection(profile, nc, () => this.store.get(id));
        this.live.set(id, lc);
        this.watchStatus(lc);
        this.setState(id, "connected");
        this.setActive(id);
        log.info(`Connected "${profile.name}" to ${nc.getServer()} (server ${nc.info?.server_name} v${nc.info?.version})`);
        void this.persistLive();
        void this.warnCredsExpiry(profile);
        return lc;
      } catch (e) {
        if (e instanceof CancelledError) {
          this.setState(id, "disconnected");
          throw e;
        }
        let msg = errorMessage(e);
        if (profile.auth.kind === "creds" && profile.auth.credsFile && /authori[sz]ation|expired/i.test(msg)) {
          const exp = expiryStatus((await credsInfo(profile.auth.credsFile))?.expires);
          if (exp?.level === "expired") msg = `${msg} — ${exp.text}`;
        }
        log.error(`Connection "${profile.name}" failed: ${msg}`);
        this.setState(id, "error", msg);
        throw new Error(msg);
      } finally {
        this.pending.delete(id);
      }
    })();
    this.pending.set(id, p);
    return p;
  }

  private watchStatus(lc: LiveConnection): void {
    const id = lc.id;
    void (async () => {
      try {
        for await (const s of lc.nc.status()) {
          switch (s.type) {
            case "disconnect":
            case "reconnecting":
              if (lc.state !== "reconnecting") {
                log.warn(`"${lc.profile.name}" disconnected — reconnecting…`);
                this.setState(id, "reconnecting");
              }
              break;
            case "reconnect":
              log.info(`"${lc.profile.name}" reconnected to ${lc.nc.getServer()}`);
              this.setState(id, "connected");
              break;
            case "error":
              log.error(`"${lc.profile.name}" error: ${errorMessage((s as { error?: unknown }).error ?? s)}`);
              break;
            case "ldm":
              log.warn(`"${lc.profile.name}": server entering lame duck mode`);
              break;
            default:
              break;
          }
        }
      } catch {
        /* status iterator ends with the connection */
      }
    })();
    void lc.nc.closed().then((err) => {
      if (this.live.get(id) === lc) this.live.delete(id);
      const msg = err ? errorMessage(err) : undefined;
      if (msg) log.error(`"${lc.profile.name}" closed: ${msg}`);
      this.setState(id, msg ? "error" : "disconnected", msg);
    });
  }

  async disconnect(id: string): Promise<void> {
    const c = this.live.get(id);
    if (!c) return;
    this.live.delete(id);
    try {
      await c.nc.drain();
    } catch {
      await c.nc.close().catch(() => undefined);
    }
    this.setState(id, "disconnected");
    log.info(`Disconnected "${c.profile.name}"`);
    void this.persistLive();
  }

  private async warnCredsExpiry(profile: ConnectionProfile): Promise<void> {
    if (profile.auth.kind !== "creds" || !profile.auth.credsFile) return;
    const exp = expiryStatus((await credsInfo(profile.auth.credsFile))?.expires);
    if (exp) void vscode.window.showWarningMessage(`${profile.name}: ${exp.text}.`);
  }

  private persistLive(): Thenable<void> {
    return this.memento.update(
      "nats.lastConnected",
      this.connected().map((c) => c.id),
    );
  }

  /**
   * Connect profiles marked auto-connect, plus (with nats.connections.restoreOnStartup)
   * the ones that were open last time. Failures are logged and shown in the tree only.
   */
  async connectOnStartup(): Promise<void> {
    const restore = vscode.workspace.getConfiguration("nats").get<boolean>("connections.restoreOnStartup", false);
    const last = restore ? this.memento.get<string[]>("nats.lastConnected", []) : [];
    const ids = new Set([...this.store.list().filter((p) => p.autoConnect).map((p) => p.id), ...last.filter((id) => this.store.get(id))]);
    await Promise.all(
      [...ids].map((id) =>
        this.connect(id).catch((e) => {
          log.warn(`Startup connection "${this.store.get(id)?.name ?? id}" failed: ${errorMessage(e)}`);
        }),
      ),
    );
  }

  /** Called when a profile is edited: reconnect if it was live. */
  async reconnectIfLive(id: string): Promise<void> {
    if (!this.live.has(id)) return;
    await this.disconnect(id);
    await this.connect(id);
  }

  dispose(): void {
    for (const c of this.live.values()) void c.nc.close();
    this.live.clear();
    this._onDidChangeState.dispose();
    this._onDidChangeActive.dispose();
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    const base = e.message || e.name;
    if (cause instanceof Error && cause.message && !base.includes(cause.message)) return `${base}: ${cause.message}`;
    return base;
  }
  return String(e);
}
