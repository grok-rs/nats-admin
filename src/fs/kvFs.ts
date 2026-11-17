// Editable KV values as files: nats-kv://<connection>/<bucket>/<key>
//
// - Compact JSON is shown pretty-printed (nats.kv.prettyPrintJson) and stored
//   compact again on save, so formatting round-trips.
// - mtime is the entry's revision, so VS Code's built-in "file is newer"
//   conflict detection protects against overwriting concurrent changes.
// - Open editors live-reload through a per-key KV watcher.
// - Binary values open read-only as a hex dump.

import * as vscode from "vscode";
import { KvWatchInclude, type KV, type KvEntry } from "@nats-io/kv";
import type { ConnectionManager, LiveConnection } from "../core/connectionManager";
import { errorMessage } from "../core/connectionManager";
import { cfg } from "../core/ui";
import { log } from "../core/log";
import { utf8Encode } from "../shared/encoding";
import { detect, hexdump, looksPretty, prettyJson } from "../shared/payload";

export const KV_SCHEME = "nats-kv";

export function kvUri(connId: string, bucket: string, key: string): vscode.Uri {
  return vscode.Uri.from({ scheme: KV_SCHEME, authority: connId, path: `/${bucket}/${key}` });
}

export function parseKvUri(uri: vscode.Uri): { connId: string; bucket: string; key: string } | undefined {
  const m = /^\/([^/]+)\/(.+)$/.exec(uri.path);
  if (!m) return undefined;
  return { connId: uri.authority, bucket: m[1], key: m[2] };
}

interface Loaded {
  entry: KvEntry;
  content: Uint8Array;
  /** We pretty-printed compact JSON → re-compact on save. */
  prettified: boolean;
  binary: boolean;
  isJson: boolean;
  at: number;
}

const CACHE_MS = 1500;

export class KvFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;
  private readonly cache = new Map<string, Loaded>();
  /** Formatting state of the last read per document, used on save. */
  private readonly formatState = new Map<string, { prettified: boolean }>();

  constructor(private readonly manager: ConnectionManager) {}

  private async live(connId: string): Promise<LiveConnection> {
    const lc = this.manager.get(connId);
    if (lc) return lc;
    try {
      return await this.manager.connect(connId);
    } catch (e) {
      throw vscode.FileSystemError.Unavailable(`NATS connection unavailable: ${errorMessage(e)}`);
    }
  }

  private async bucket(connId: string, bucket: string): Promise<KV> {
    const lc = await this.live(connId);
    return lc.kvm().open(bucket);
  }

  private async load(uri: vscode.Uri, force = false): Promise<Loaded> {
    const key = uri.toString();
    const cached = this.cache.get(key);
    if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached;
    const p = parseKvUri(uri);
    if (!p) throw vscode.FileSystemError.FileNotFound(uri);
    const kv = await this.bucket(p.connId, p.bucket);
    const entry = await kv.get(p.key);
    if (!entry || entry.operation !== "PUT") throw vscode.FileSystemError.FileNotFound(uri);
    const d = detect(entry.value);
    let content = entry.value;
    let prettified = false;
    if (d.format === "json" && cfg("kv.prettyPrintJson", true) && d.text !== undefined && !looksPretty(d.text) && (d.kind === "object" || d.kind === "array")) {
      content = utf8Encode(prettyJson(d.json) + "\n");
      prettified = true;
    } else if (d.format === "binary") {
      content = utf8Encode(`// Binary value (${entry.value.length} bytes) — read-only hex view.\n// Use "NATS: Copy Value" or the KV Browser to work with raw bytes.\n${hexdump(entry.value)}\n`);
    }
    const loaded: Loaded = { entry, content, prettified, binary: d.format === "binary", isJson: d.format === "json", at: Date.now() };
    this.cache.set(key, loaded);
    return loaded;
  }

  /** True when the last loaded value for this document is JSON. */
  isJson(uri: vscode.Uri): boolean | undefined {
    return this.cache.get(uri.toString())?.isJson;
  }

  private assertWritable(connId: string): void {
    const lc = this.manager.get(connId);
    if (lc?.profile.readOnly) throw vscode.FileSystemError.NoPermissions(`"${lc.profile.name}" is read-only`);
  }

  // --- FileSystemProvider -----------------------------------------------------------

  watch(uri: vscode.Uri): vscode.Disposable {
    const p = parseKvUri(uri);
    if (!p) return new vscode.Disposable(() => undefined);
    let stopped = false;
    let stop: (() => void) | undefined;
    void (async () => {
      try {
        const lc = this.manager.get(p.connId);
        if (!lc) return; // not connected: no live updates
        const kv = await lc.kvm().open(p.bucket);
        const it = await kv.watch({ key: p.key, include: KvWatchInclude.UpdatesOnly });
        stop = () => it.stop();
        if (stopped) return it.stop();
        for await (const e of it) {
          this.cache.delete(uri.toString());
          this._onDidChangeFile.fire([{ type: e.operation === "PUT" ? vscode.FileChangeType.Changed : vscode.FileChangeType.Deleted, uri }]);
        }
      } catch (e) {
        if (!stopped) log.debug(`kv watch ${uri.toString()} ended: ${errorMessage(e)}`);
      }
    })();
    return new vscode.Disposable(() => {
      stopped = true;
      stop?.();
    });
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const p = parseKvUri(uri);
    if (!p) {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    const l = await this.load(uri);
    return {
      type: vscode.FileType.File,
      ctime: l.entry.created.getTime(),
      // Revisions only grow, which makes them a reliable change marker.
      mtime: l.entry.revision,
      size: l.content.length,
      permissions: l.binary || this.manager.get(uri.authority)?.profile.readOnly ? vscode.FilePermission.Readonly : undefined,
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const l = await this.load(uri, true);
    this.formatState.set(uri.toString(), { prettified: l.prettified });
    return l.content;
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    const p = parseKvUri(uri);
    if (!p) throw vscode.FileSystemError.NoPermissions("Not a KV key");
    const cached = this.cache.get(uri.toString());
    if (cached?.binary) throw vscode.FileSystemError.NoPermissions("Binary values are read-only in the editor");
    this.assertWritable(p.connId);
    const kv = await this.bucket(p.connId, p.bucket);
    let data = content;
    const fmt = this.formatState.get(uri.toString());
    if (fmt?.prettified) {
      const text = new TextDecoder().decode(content);
      try {
        data = utf8Encode(JSON.stringify(JSON.parse(text)));
      } catch {
        // No longer valid JSON: store exactly what was typed.
      }
    }
    try {
      if (options.create && !options.overwrite) await kv.create(p.key, data);
      else await kv.put(p.key, data);
    } catch (e) {
      throw vscode.FileSystemError.Unavailable(`Saving ${p.bucket}/${p.key} failed: ${errorMessage(e)}`);
    }
    this.cache.delete(uri.toString());
    log.info(`KV ${p.bucket}/${p.key} saved (${data.length} bytes)`);
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  async delete(uri: vscode.Uri): Promise<void> {
    const p = parseKvUri(uri);
    if (!p) throw vscode.FileSystemError.NoPermissions("Not a KV key");
    this.assertWritable(p.connId);
    const kv = await this.bucket(p.connId, p.bucket);
    await kv.delete(p.key);
    this.cache.delete(uri.toString());
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions("KV buckets cannot be created from the file system");
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions("Renaming KV keys is not supported");
  }

  dispose(): void {
    this._onDidChangeFile.dispose();
  }
}
