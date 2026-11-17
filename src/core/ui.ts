// Small VS Code UI helpers shared by commands and panels.

import * as vscode from "vscode";
import type { Services } from "../services";
import { errorMessage, type LiveConnection } from "./connectionManager";
import { log } from "./log";
import { CancelledError } from "./errors";

export function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration("nats").get<T>(key, fallback);
}

/** Errors surfaced to the user (exposed to the integration tests). */
export const reportedErrors: string[] = [];

export function showError(prefix: string, e: unknown): void {
  const msg = `${prefix}: ${errorMessage(e)}`;
  reportedErrors.push(msg);
  if (reportedErrors.length > 50) reportedErrors.shift();
  log.error(msg);
  void vscode.window.showErrorMessage(msg);
}

/** Wrap a command handler: report errors instead of throwing into VS Code. */
export function safe<A extends unknown[]>(label: string, fn: (...args: A) => unknown): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (e) {
      if (e instanceof CancelledError) return;
      showError(label, e);
    }
  };
}

export { CancelledError };

/** Throw CancelledError when the user dismissed a prompt. */
export function required<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new CancelledError();
  return v;
}

export class ReadOnlyError extends Error {
  constructor(connection: string, action: string) {
    super(`"${connection}" is read-only — ${action} is blocked. Turn off read-only mode in the connection settings to allow changes.`);
  }
}

/**
 * Guard for every write operation (publish, KV put/delete, stream/consumer
 * changes, purges, acks…). Throws ReadOnlyError for read-only connections.
 */
export function assertWritable(lc: LiveConnection | { profile: { name: string; readOnly?: boolean } }, action: string): void {
  if (lc.profile.readOnly) throw new ReadOnlyError(lc.profile.name, action);
}

export function isProduction(lc?: { profile: { environment?: string } }): boolean {
  return lc?.profile.environment === "prod";
}

/**
 * Confirmation for destructive actions. Respects nats.confirmDestructiveActions,
 * except on production connections where the user must type `typeToConfirm`
 * (usually the resource name) and confirmation can't be switched off.
 */
export async function confirmDanger(
  message: string,
  detail: string,
  action: string,
  opts: { lc?: LiveConnection; typeToConfirm?: string } = {},
): Promise<boolean> {
  if (opts.lc) assertWritable(opts.lc, action.toLowerCase());
  if (isProduction(opts.lc) && opts.typeToConfirm) {
    const typed = await vscode.window.showInputBox({
      title: `⚠ PRODUCTION · ${opts.lc!.profile.name}`,
      prompt: `${message} ${detail} Type "${opts.typeToConfirm}" to confirm.`,
      placeHolder: opts.typeToConfirm,
      ignoreFocusOut: true,
      validateInput: (v) => (v === opts.typeToConfirm ? undefined : `Type "${opts.typeToConfirm}" exactly`),
    });
    return typed === opts.typeToConfirm;
  }
  if (!cfg("confirmDestructiveActions", true) && !isProduction(opts.lc)) return true;
  const prefix = isProduction(opts.lc) ? `⚠ PRODUCTION (${opts.lc!.profile.name}): ` : "";
  const choice = await vscode.window.showWarningMessage(prefix + message, { modal: true, detail }, action);
  return choice === action;
}

export async function withProgress<T>(title: string, fn: () => Promise<T>): Promise<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, fn);
}

/**
 * Resolve a live connection for a command. Uses the given profile id, else the
 * active connection, else asks the user (connecting if necessary).
 */
export async function pickConnection(s: Services, profileId?: string): Promise<LiveConnection> {
  if (profileId) {
    const lc = s.manager.get(profileId) ?? (await connectWithProgress(s, profileId));
    s.manager.setActive(profileId);
    return lc;
  }
  const live = s.manager.connected();
  if (live.length === 1) return live[0];
  const active = s.manager.activeId ? s.manager.get(s.manager.activeId) : undefined;
  if (active && live.length > 0) return active;
  const profiles = s.store.list();
  if (profiles.length === 0) {
    const add = await vscode.window.showInformationMessage("No NATS connections configured.", "Add Connection");
    if (add) await vscode.commands.executeCommand("nats.addConnection");
    throw new CancelledError();
  }
  const pick = await vscode.window.showQuickPick(
    profiles.map((p) => ({
      label: p.name,
      description: p.servers.join(", "),
      detail: s.manager.get(p.id) ? "$(circle-filled) connected" : undefined,
      id: p.id,
    })),
    { placeHolder: "Select a NATS connection" },
  );
  const id = required(pick).id;
  const lc = s.manager.get(id) ?? (await connectWithProgress(s, id));
  s.manager.setActive(id);
  return lc;
}

export async function connectWithProgress(s: Services, id: string): Promise<LiveConnection> {
  const p = s.store.get(id);
  return withProgress(`Connecting to ${p?.name ?? "NATS"}…`, () => s.manager.connect(id));
}

export async function pickFrom<T>(items: T[], label: (t: T) => string, placeHolder: string, describe?: (t: T) => string): Promise<T> {
  if (items.length === 0) {
    void vscode.window.showInformationMessage(`Nothing to choose from: ${placeHolder.toLowerCase()}`);
    throw new CancelledError();
  }
  const pick = await vscode.window.showQuickPick(
    items.map((item) => ({ label: label(item), description: describe?.(item), item })),
    { placeHolder },
  );
  return required(pick).item;
}

/** NATS-safe token names (streams, consumers, buckets). */
export function validateName(v: string): string | undefined {
  if (!v.trim()) return "Name is required";
  if (!/^[A-Za-z0-9_-]+$/.test(v)) return "Use letters, digits, '-' and '_' only";
  return undefined;
}

export function validateSubject(v: string, allowWildcards = true): string | undefined {
  const s = v.trim();
  if (!s) return "Subject is required";
  if (/\s/.test(s)) return "Subjects cannot contain whitespace";
  const tokens = s.split(".");
  if (tokens.some((t) => t === "")) return "Empty token in subject";
  if (!allowWildcards && tokens.some((t) => t === "*" || t === ">")) return "Wildcards are not allowed here";
  if (tokens.slice(0, -1).includes(">")) return "'>' must be the last token";
  return undefined;
}
