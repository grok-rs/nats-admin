// Tiny event bus for health summaries: the health module publishes, the
// overview / home / status bar views subscribe. Decouples feature modules.

import * as vscode from "vscode";

export type Severity = "error" | "warning" | "info";

export interface HealthSummary {
  connId: string;
  /** 0–100, higher is healthier. */
  score: number;
  errors: number;
  warnings: number;
  infos: number;
  /** ISO time of the check. */
  at: string;
  /** Short titles of the most important findings (max ~5). */
  top: { severity: Severity; title: string }[];
}

const summaries = new Map<string, HealthSummary>();
/** Fired with the new summary, or with { connId, cleared: true } when a summary is removed. */
export type HealthChange = HealthSummary | { connId: string; cleared: true };
const emitter = new vscode.EventEmitter<HealthChange>();

export const healthBus = {
  onDidChange: emitter.event,
  publish(s: HealthSummary): void {
    summaries.set(s.connId, s);
    emitter.fire(s);
  },
  get(connId: string): HealthSummary | undefined {
    return summaries.get(connId);
  },
  clear(connId: string): void {
    if (summaries.delete(connId)) emitter.fire({ connId, cleared: true });
  },
};
