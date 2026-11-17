// Editable JetStream configs as JSON files:
//   nats-config://<conn>/stream/<name>.json            → streams.update on save
//   nats-config://<conn>/consumer/<stream>/<name>.json → consumers.update on save
// Server-side validation errors surface as "Failed to save" notifications.

import * as vscode from "vscode";
import type { ConnectionManager, LiveConnection } from "../core/connectionManager";
import { errorMessage } from "../core/connectionManager";
import { log } from "../core/log";
import { utf8Encode } from "../shared/encoding";

export const CONFIG_SCHEME = "nats-config";

export function streamConfigUri(connId: string, stream: string): vscode.Uri {
  return vscode.Uri.from({ scheme: CONFIG_SCHEME, authority: connId, path: `/stream/${stream}.json` });
}

export function consumerConfigUri(connId: string, stream: string, consumer: string): vscode.Uri {
  return vscode.Uri.from({ scheme: CONFIG_SCHEME, authority: connId, path: `/consumer/${stream}/${consumer}.json` });
}

type Target = { kind: "stream"; stream: string } | { kind: "consumer"; stream: string; consumer: string };

function parse(uri: vscode.Uri): Target | undefined {
  let m = /^\/stream\/([^/]+)\.json$/.exec(uri.path);
  if (m) return { kind: "stream", stream: m[1] };
  m = /^\/consumer\/([^/]+)\/([^/]+)\.json$/.exec(uri.path);
  if (m) return { kind: "consumer", stream: m[1], consumer: m[2] };
  return undefined;
}

export class ConfigFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;
  private readonly versions = new Map<string, number>();

  constructor(
    private readonly manager: ConnectionManager,
    private readonly onSaved: (connId: string, target: Target) => void,
  ) {}

  private async live(connId: string): Promise<LiveConnection> {
    return this.manager.get(connId) ?? this.manager.connect(connId);
  }

  private async read(uri: vscode.Uri): Promise<Uint8Array> {
    const t = parse(uri);
    if (!t) throw vscode.FileSystemError.FileNotFound(uri);
    const jsm = await (await this.live(uri.authority)).jsm();
    try {
      const cfg = t.kind === "stream" ? (await jsm.streams.info(t.stream)).config : (await jsm.consumers.info(t.stream, t.consumer)).config;
      return utf8Encode(JSON.stringify(cfg, null, 2) + "\n");
    } catch (e) {
      throw vscode.FileSystemError.FileNotFound(`${uri.path}: ${errorMessage(e)}`);
    }
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    if (!parse(uri)) return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    const content = await this.read(uri);
    const v = this.versions.get(uri.toString()) ?? 1;
    const readOnly = this.manager.get(uri.authority)?.profile.readOnly;
    return { type: vscode.FileType.File, ctime: 0, mtime: v, size: content.length, permissions: readOnly ? vscode.FilePermission.Readonly : undefined };
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.read(uri);
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const t = parse(uri);
    if (!t) throw vscode.FileSystemError.NoPermissions("Not a JetStream config document");
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(new TextDecoder().decode(content));
    } catch (e) {
      throw vscode.FileSystemError.Unavailable(`Invalid JSON: ${errorMessage(e)}`);
    }
    const lc = await this.live(uri.authority);
    if (lc.profile.readOnly) throw vscode.FileSystemError.NoPermissions(`"${lc.profile.name}" is read-only`);
    const jsm = await lc.jsm();
    try {
      if (t.kind === "stream") {
        if (cfg.name && cfg.name !== t.stream) throw new Error(`Stream name cannot change ("${t.stream}")`);
        const { name: _name, ...update } = cfg;
        await jsm.streams.update(t.stream, update);
      } else {
        const durable = (cfg.durable_name as string | undefined) ?? (cfg.name as string | undefined) ?? t.consumer;
        if (durable !== t.consumer) throw new Error(`Consumer name cannot change ("${t.consumer}")`);
        await jsm.consumers.update(t.stream, t.consumer, cfg);
      }
    } catch (e) {
      throw vscode.FileSystemError.Unavailable(`Server rejected the update: ${errorMessage(e)}`);
    }
    this.versions.set(uri.toString(), (this.versions.get(uri.toString()) ?? 1) + 1);
    log.info(`Updated ${t.kind} config ${t.kind === "stream" ? t.stream : `${t.stream}/${t.consumer}`}`);
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    this.onSaved(uri.authority, t);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }
  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
  delete(): void {
    throw vscode.FileSystemError.NoPermissions("Delete streams/consumers from the NATS explorer");
  }
  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
  dispose(): void {
    this._onDidChangeFile.dispose();
  }
}
