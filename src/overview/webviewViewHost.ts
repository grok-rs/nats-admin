// Base class for sidebar webview views (vscode.WebviewViewProvider) with the same RPC bridge as
// src/panels/webviewHost.ts: webview → host requests answered from handlers(), host → webview
// events via post(). The webview side is unchanged (webview/lib/vscode.ts).

import * as vscode from "vscode";
import type { HostMessage, RpcRequest } from "../shared/dto";
import { errorMessage } from "../core/connectionManager";
import { log } from "../core/log";
import { rpcLog, type RpcHandler } from "../panels/webviewHost";

export interface ViewOptions {
  viewType: string;
  /** Webview bundle name: dist/webview/<script>.js (+ .css). */
  script: string;
  title: string;
}

export abstract class WebviewViewHost implements vscode.WebviewViewProvider, vscode.Disposable {
  protected view: vscode.WebviewView | undefined;
  /** Disposed when the view is disposed (re-created on the next resolve). */
  protected readonly viewDisposables: vscode.Disposable[] = [];
  private disposed = false;

  constructor(
    protected readonly context: vscode.ExtensionContext,
    protected readonly opts: ViewOptions,
  ) {}

  /** Method table for webview RPCs. */
  protected abstract handlers(): Record<string, RpcHandler>;

  /** Serializable init data, available as `init` in the webview. */
  protected abstract init(): unknown;

  /** Hook: the view became visible / hidden. */
  protected onVisibilityChanged(_visible: boolean): void {
    /* optional */
  }

  get visible(): boolean {
    return !!this.view?.visible;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.disposeView();
    this.view = view;
    const dist = vscode.Uri.joinPath(this.context.extensionUri, "dist");
    view.webview.options = { enableScripts: true, localResourceRoots: [dist, vscode.Uri.joinPath(this.context.extensionUri, "media")] };
    view.webview.html = this.html(view.webview, this.init());
    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((m: RpcRequest) => void this.onMessage(m)),
      view.onDidChangeVisibility(() => {
        this.post("visibility", { visible: view.visible });
        this.onVisibilityChanged(view.visible);
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined;
        this.disposeView();
      }),
    );
    this.onVisibilityChanged(view.visible);
  }

  /** Push an event to the webview (dropped while no view is resolved). */
  post(event: string, data?: unknown): void {
    if (this.disposed || !this.view) return;
    const msg: HostMessage = { kind: "evt", event, data };
    void this.view.webview.postMessage(msg);
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
    if (this.view && !this.disposed) void this.view.webview.postMessage(reply);
  }

  private html(webview: vscode.Webview, init: unknown): string {
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
<title>${this.opts.title.replace(/[&<>"']/g, "")}</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">window.__INIT__ = ${initJson};</script>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  private disposeView(): void {
    for (const d of this.viewDisposables.splice(0)) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeView();
    this.view = undefined;
  }
}
