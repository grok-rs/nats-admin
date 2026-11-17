// Base class for webview panels: HTML shell with CSP, a request/response RPC
// bridge (webview → host) and fire-and-forget events (host → webview).
//
// Webview side: see webview/lib/vscode.ts (`rpc(method, params)` / `onEvent`).

import * as vscode from "vscode";
import type { HostMessage, RpcRequest } from "../shared/dto";
import { errorMessage } from "../core/connectionManager";
import { log } from "../core/log";

export interface PanelOptions {
  viewType: string;
  /** Uniqueness key: an existing panel with the same key is revealed instead. */
  key: string;
  title: string;
  /** Webview bundle name: dist/webview/<script>.js (+ .css). */
  script: string;
  /** Serializable initial data, available as `init` in the webview. */
  init: unknown;
  column?: vscode.ViewColumn;
  retainContextWhenHidden?: boolean;
}

export type RpcHandler = (params: any) => unknown | Promise<unknown>;

/** Recent webview RPCs as "viewType method ok|error" (exposed to integration tests). */
export const rpcLog: string[] = [];

export abstract class WebviewPanelBase implements vscode.Disposable {
  private static readonly open = new Map<string, WebviewPanelBase>();
  protected readonly panel: vscode.WebviewPanel;
  protected readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  /** Reveal an existing panel for `key`. Returns it when found. */
  static reveal<T extends WebviewPanelBase>(key: string): T | undefined {
    const p = WebviewPanelBase.open.get(key) as T | undefined;
    p?.panel.reveal();
    return p;
  }

  static disposeWhere(pred: (key: string) => boolean): void {
    for (const [key, p] of [...WebviewPanelBase.open]) if (pred(key)) p.dispose();
  }

  constructor(
    protected readonly context: vscode.ExtensionContext,
    protected readonly opts: PanelOptions,
  ) {
    this.panel = vscode.window.createWebviewPanel(opts.viewType, opts.title, opts.column ?? vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: opts.retainContextWhenHidden ?? true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist"), vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, "media", "nats-light.svg"),
      dark: vscode.Uri.joinPath(context.extensionUri, "media", "nats-dark.svg"),
    };
    this.panel.webview.html = this.html(opts.init);
    WebviewPanelBase.open.set(opts.key, this);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m: RpcRequest) => this.onMessage(m), null, this.disposables);
  }

  /** Method table for webview RPCs. */
  protected abstract handlers(): Record<string, RpcHandler>;

  get isDisposed(): boolean {
    return this.disposed;
  }

  setTitle(title: string): void {
    this.panel.title = title;
  }

  /** Push an event to the webview. */
  post(event: string, data?: unknown): void {
    if (this.disposed) return;
    const msg: HostMessage = { kind: "evt", event, data };
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(m: RpcRequest): Promise<void> {
    if (!m || m.kind !== "req") return;
    const handler = this.handlers()[m.method];
    let reply: HostMessage;
    if (!handler) {
      reply = { kind: "res", id: m.id, ok: false, error: `Unknown method ${m.method}` };
    } else {
      try {
        const result = await handler(m.params ?? {});
        reply = { kind: "res", id: m.id, ok: true, result: result ?? null };
      } catch (e) {
        const error = errorMessage(e);
        log.debug(`[${this.opts.viewType}] ${m.method} failed: ${error}`);
        reply = { kind: "res", id: m.id, ok: false, error };
      }
    }
    rpcLog.push(`${this.opts.viewType} ${m.method} ${reply.ok ? "ok" : `error: ${reply.error}`}`);
    if (rpcLog.length > 500) rpcLog.shift();
    if (!this.disposed) void this.panel.webview.postMessage(reply);
  }

  private html(init: unknown): string {
    const webview = this.panel.webview;
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    const dist = vscode.Uri.joinPath(this.context.extensionUri, "dist");
    const js = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview", `${this.opts.script}.js`));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview", `${this.opts.script}.css`));
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(dist, "codicons", "codicon.css"));
    const initJson = JSON.stringify(init ?? null).replace(/</g, "\\u003c");
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link href="${codicons}" rel="stylesheet">
<link href="${css}" rel="stylesheet">
<title>${escapeHtml(this.opts.title)}</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">window.__INIT__ = ${initJson};</script>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  /** Hook for subclasses (subscriptions, timers…). Always call super.dispose(). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (WebviewPanelBase.open.get(this.opts.key) === this) WebviewPanelBase.open.delete(this.opts.key);
    this.panel.dispose();
    for (const d of this.disposables.splice(0)) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
