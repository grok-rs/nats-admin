// Read-only virtual documents (scheme `nats-info`), resolved from the URI so
// they survive window reloads:
//   nats-info://<conn>/server.json
//   nats-info://<conn>/stream/<name>.json
//   nats-info://<conn>/consumer/<stream>/<name>.json
//   nats-info://<conn>/kv/<bucket>.json
//   nats-info://<conn>/kv-rev/<bucket>/<revision>/<key>
//   nats-info://<conn>/obj/<bucket>.json
//   nats-info://<conn>/object-info/<bucket>/<name>.json
//   nats-info://<conn>/object/<bucket>/<name>
//   nats-info://<conn>/service/<name>.json
// Ad-hoc documents (e.g. playbook replies) can be registered with `setDynamic`.

import * as vscode from "vscode";
import type { ConnectionManager, LiveConnection } from "../core/connectionManager";
import { errorMessage } from "../core/connectionManager";
import { readObject } from "../nats/obj";
import { headersToArray } from "../nats/messages";
import { discoverServices } from "../nats/services";
import { detect, hexdump, prettyJson } from "../shared/payload";
import { cfg } from "../core/ui";

export const INFO_SCHEME = "nats-info";

type Route = { re: RegExp; render: (lc: LiveConnection, m: RegExpMatchArray) => Promise<string> };

export function infoUri(connId: string, path: string, query?: string): vscode.Uri {
  return vscode.Uri.from({ scheme: INFO_SCHEME, authority: connId, path: path.startsWith("/") ? path : `/${path}`, query });
}

export class InfoDocs implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  private readonly dynamic = new Map<string, () => Promise<string>>();
  private readonly routes: Route[] = [];

  constructor(private readonly manager: ConnectionManager) {
    const json = (v: unknown) => prettyJson(v);
    const dec = decodeURIComponent;
    this.route(/^\/server\.json$/, async (lc) => {
      const rtt = await lc.nc.rtt().catch(() => undefined);
      let jetstream: unknown = "not enabled";
      if (await lc.hasJetStream()) jetstream = await (await lc.jsm()).getAccountInfo();
      return json({ connectedUrl: lc.nc.getServer(), rttMs: rtt, server: lc.info, stats: lc.nc.stats(), jetstream });
    });
    this.route(/^\/stream\/(.+)\.json$/, async (lc, m) => json(await (await lc.jsm()).streams.info(dec(m[1]), { deleted_details: false })));
    this.route(/^\/consumer\/([^/]+)\/(.+)\.json$/, async (lc, m) => json(await (await lc.jsm()).consumers.info(dec(m[1]), dec(m[2]))));
    this.route(/^\/kv\/(.+)\.json$/, async (lc, m) => {
      // KvStatus exposes its fields as getters, so copy them explicitly.
      const st = await (await lc.kvm().open(dec(m[1]))).status();
      return json({
        bucket: st.bucket,
        description: st.description,
        values: st.values,
        history: st.history,
        ttlMs: st.ttl,
        markerTTL: st.markerTTL,
        size: st.size,
        storage: st.storage,
        replicas: st.replicas,
        maxBytes: st.max_bytes,
        maxValueSize: st.maxValueSize,
        compression: st.compression,
        metadata: st.metadata,
        backingStream: st.streamInfo?.config?.name,
        streamInfo: st.streamInfo,
      });
    });
    this.route(/^\/kv-rev\/([^/]+)\/(\d+)\/(.+)$/, async (lc, m) => {
      const kv = await lc.kvm().open(dec(m[1]));
      const e = await kv.get(m[3], { revision: Number(m[2]) });
      if (!e) return `// revision ${m[2]} of "${m[3]}" is no longer available`;
      if (e.operation !== "PUT") return `// revision ${e.revision}: ${e.operation} marker (${e.created.toISOString()})`;
      return renderValue(e.value);
    });
    this.route(/^\/obj\/(.+)\.json$/, async (lc, m) => {
      const st = await (await lc.objm().open(dec(m[1]))).status();
      return json({
        bucket: st.bucket,
        description: st.description,
        ttlNanos: st.ttl,
        storage: st.storage,
        replicas: st.replicas,
        sealed: st.sealed,
        size: st.size,
        compression: st.compression,
        metadata: st.metadata,
        backingStore: st.backingStore,
        streamInfo: st.streamInfo,
      });
    });
    this.route(/^\/object-info\/([^/]+)\/(.+)\.json$/, async (lc, m) => {
      const o = await (await lc.objm().open(dec(m[1]))).info(m[2]);
      if (!o) return `// object "${m[2]}" not found`;
      // ObjectInfo exposes getters — copy fields explicitly.
      return json({
        name: o.name,
        bucket: o.bucket,
        description: o.description,
        size: o.size,
        chunks: o.chunks,
        digest: o.digest,
        mtime: o.mtime,
        revision: o.revision,
        nuid: o.nuid,
        deleted: o.deleted,
        options: o.options,
        metadata: o.metadata,
        headers: o.headers ? headersToArray(o.headers) : undefined,
      });
    });
    this.route(/^\/object\/([^/]+)\/(.+)$/, async (lc, m) => {
      const os = await lc.objm().open(dec(m[1]));
      const { data } = await readObject(os, m[2], cfg("objectStore.maxPreviewBytes", 5 * 1024 * 1024));
      const d = detect(data);
      return d.format === "binary" ? `// binary object (${data.length} bytes) — hex preview\n${hexdump(data)}` : (d.text ?? "");
    });
    this.route(/^\/service\/(.+)\.json$/, async (lc, m) => {
      const all = await discoverServices(lc.svcm(), 1500);
      const svc = all.find((s) => s.name === dec(m[1]));
      return svc ? json(svc) : `// service "${dec(m[1])}" did not respond`;
    });
  }

  private route(re: RegExp, render: Route["render"]): void {
    this.routes.push({ re, render });
  }

  /** Register (or replace) content for an ad-hoc document. */
  setDynamic(uri: vscode.Uri, gen: () => Promise<string>): void {
    this.dynamic.set(uri.toString(), gen);
    this._onDidChange.fire(uri);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const dyn = this.dynamic.get(uri.toString());
    try {
      if (dyn) return await dyn();
      const route = this.routes.find((r) => r.re.test(uri.path));
      if (!route) return "// Unknown NATS document";
      let lc = this.manager.get(uri.authority);
      if (!lc) {
        try {
          lc = await this.manager.connect(uri.authority);
        } catch (e) {
          return `// Not connected: ${errorMessage(e)}\n// Connect from the NATS explorer and use "Refresh".`;
        }
      }
      return await route.render(lc, uri.path.match(route.re)!);
    } catch (e) {
      return `// Error: ${errorMessage(e)}`;
    }
  }

  refresh(uri: vscode.Uri): void {
    this._onDidChange.fire(uri);
  }

  /** Open (or refresh and focus) a document. */
  async show(uri: vscode.Uri, opts: { preview?: boolean; column?: vscode.ViewColumn; language?: string } = {}): Promise<vscode.TextEditor> {
    this._onDidChange.fire(uri);
    let doc = await vscode.workspace.openTextDocument(uri);
    if (opts.language && doc.languageId !== opts.language) doc = await vscode.languages.setTextDocumentLanguage(doc, opts.language);
    return vscode.window.showTextDocument(doc, { preview: opts.preview ?? true, viewColumn: opts.column });
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

/** Render a stored value as text: pretty JSON when JSON, hex dump when binary. */
export function renderValue(value: Uint8Array): string {
  const d = detect(value);
  if (d.format === "json" && cfg("kv.prettyPrintJson", true)) return prettyJson(d.json);
  if (d.format === "binary") return `// binary value (${value.length} bytes) — hex preview\n${hexdump(value)}`;
  return d.text ?? "";
}
