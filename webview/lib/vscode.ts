// Webview side of the RPC bridge (see src/panels/webviewHost.ts).

import type { HostMessage } from "../../src/shared/dto";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    __INIT__: unknown;
  }
  function acquireVsCodeApi(): VsCodeApi;
}

const api = acquireVsCodeApi();
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners = new Map<string, Set<(data: any) => void>>();

window.addEventListener("message", (ev: MessageEvent<HostMessage>) => {
  const m = ev.data;
  if (!m || typeof m !== "object") return;
  if (m.kind === "res") {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error));
  } else if (m.kind === "evt") {
    listeners.get(m.event)?.forEach((cb) => cb(m.data));
  }
});

/** Call a host method; rejects with the host's error message. */
export function rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    api.postMessage({ kind: "req", id, method, params });
  });
}

/** Subscribe to host events. Returns an unsubscribe function. */
export function onEvent<T = any>(event: string, cb: (data: T) => void): () => void {
  let set = listeners.get(event);
  if (!set) listeners.set(event, (set = new Set()));
  set.add(cb);
  return () => set!.delete(cb);
}

export function getInit<T>(): T {
  return window.__INIT__ as T;
}

export function getState<T>(): T | undefined {
  return api.getState() as T | undefined;
}

export function setState<T>(s: T): void {
  api.setState(s);
}
