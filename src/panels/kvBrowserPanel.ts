// KV Browser: every key of a bucket with values, live updates, a JSON
// structure view, inline editing with compare-and-set, and revision history.

import * as vscode from "vscode";
import { assertWritable, confirmDanger } from "../core/ui";
import { writeFile } from "node:fs/promises";
import type { KV } from "@nats-io/kv";
import type { Services } from "../services";
import { WebviewPanelBase } from "./webviewHost";
import { bucketToDTO, entryToDTO, history, snapshotAndWatch, type WatchHandle } from "../nats/kv";
import type { KvBucketDTO, KvEntryDTO } from "../shared/dto";
import { base64ToBytes } from "../shared/encoding";
import { detect } from "../shared/payload";
import { cfg } from "../core/ui";
import { errorMessage, type LiveConnection } from "../core/connectionManager";
import { kvUri } from "../fs/kvFs";
import { infoUri } from "../fs/infoDocs";

export interface KvBrowserInit {
  connName: string;
  bucket: string;
  status: KvBucketDTO;
  separator: string;
  maxKeys: number;
  filter?: string;
  selectKey?: string;
}

const MAX_VALUE_BYTES = 256 * 1024;

class KvBrowserPanel extends WebviewPanelBase {
  private watch?: WatchHandle;
  private pending: KvEntryDTO[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly s: Services,
    private readonly profileId: string,
    private readonly bucket: string,
    key: string,
    init: KvBrowserInit,
  ) {
    super(s.context, { viewType: "nats.kvBrowser", key, title: `KV: ${bucket}`, script: "kvBrowser", init });
    this.disposables.push(
      { dispose: () => this.stopWatch() },
      s.manager.onDidChangeState((e) => {
        if (e.profileId !== profileId) return;
        this.post("connection", { state: e.state });
        if (e.state !== "connected") this.stopWatch();
      }),
    );
  }

  private lc(): LiveConnection {
    const lc = this.s.manager.get(this.profileId);
    if (!lc) throw new Error("Not connected — reconnect from the NATS explorer");
    return lc;
  }

  private kv(): Promise<KV> {
    return this.lc().kvm().open(this.bucket);
  }

  private stopWatch(): void {
    this.watch?.stop();
    this.watch = undefined;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pending = [];
  }

  private queueUpdate(e: KvEntryDTO): void {
    this.pending.push(e);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        const batch = this.pending.splice(0);
        if (batch.length) this.post("updates", batch);
      }, 120);
    }
  }

  setFilter(filter: string | undefined, selectKey?: string): void {
    this.post("setFilter", { filter: filter ?? "", selectKey });
  }

  protected handlers() {
    return {
      load: async ({ filter, live, max: maxOverride }: { filter?: string; live: boolean; max?: number }) => {
        this.stopWatch();
        const kv = await this.kv();
        const max = maxOverride && maxOverride > 0 ? Math.floor(maxOverride) : cfg("kv.maxKeys", 5000);
        const generation = Symbol();
        this.currentGen = generation;
        this.watch = await snapshotAndWatch(kv, {
          filter,
          max,
          maxValueBytes: MAX_VALUE_BYTES,
          live,
          onInitial: (entries, truncated) => {
            if (this.currentGen === generation) this.post("snapshot", { entries, truncated, max });
          },
          onUpdate: (e) => {
            if (this.currentGen === generation) this.queueUpdate(e);
          },
          onError: (err) => {
            const msg = errorMessage(err);
            this.post(
              "error",
              /\$JS\.FC/.test(msg)
                ? 'Live updates stopped: this account may not publish flow-control replies ($JS.FC.>). The snapshot above is complete — use Reload to refresh it, or ask for publish permission on "$JS.FC.>".'
                : msg,
            );
          },
        });
        return true;
      },
      openSetting: async () => {
        await vscode.commands.executeCommand("workbench.action.openSettings", "nats.kv.maxKeys");
        return true;
      },
      stopLive: () => {
        this.stopWatch();
        return true;
      },
      status: async () => bucketToDTO(await (await this.kv()).status()),
      get: async ({ key }: { key: string }) => {
        const e = await (await this.kv()).get(key);
        return e ? entryToDTO(e) : null;
      },
      history: async ({ key }: { key: string }) => (await history(await this.kv(), key)).map((e) => entryToDTO(e, MAX_VALUE_BYTES)),
      put: async ({ key, data, revision }: { key: string; data: string; revision?: number }) => {
        assertWritable(this.lc(), "writing a key");
        const kv = await this.kv();
        const bytes = base64ToBytes(data);
        try {
          return revision ? await kv.update(key, bytes, revision) : await kv.put(key, bytes);
        } catch (e) {
          const msg = errorMessage(e);
          if (revision && /wrong last sequence|10071/i.test(msg)) {
            const cur = await kv.get(key);
            throw new Error(`Conflict: "${key}" was modified on the server (now revision ${cur?.revision ?? "?"}). Reload the value or overwrite.`);
          }
          throw e;
        }
      },
      create: async ({ key, data }: { key: string; data: string }) => {
        assertWritable(this.lc(), "creating a key");
        return (await this.kv()).create(key, base64ToBytes(data));
      },
      delete: async ({ key }: { key: string }) => {
        assertWritable(this.lc(), "deleting a key");
        await (await this.kv()).delete(key);
        return true;
      },
      purge: async ({ key }: { key: string }) => {
        assertWritable(this.lc(), "purging a key");
        await (await this.kv()).purge(key);
        return true;
      },
      confirm: async ({ message, detail, action, typeToConfirm }: { message: string; detail?: string; action: string; typeToConfirm?: string }) =>
        confirmDanger(message, detail ?? "", action, { lc: this.lc(), typeToConfirm: typeToConfirm ?? this.bucket }),
      openInEditor: async ({ key }: { key: string }) => {
        const doc = await vscode.workspace.openTextDocument(kvUri(this.profileId, this.bucket, key));
        await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
        return true;
      },
      diff: async ({ key, revision }: { key: string; revision: number }) => {
        const left = infoUri(this.profileId, `/kv-rev/${this.bucket}/${revision}/${key}`);
        const right = kvUri(this.profileId, this.bucket, key);
        await vscode.commands.executeCommand("vscode.diff", left, right, `${key}: rev ${revision} ↔ current`, { preview: true, viewColumn: vscode.ViewColumn.Beside });
        return true;
      },
      bucketInfo: async () => {
        await this.s.infoDocs.show(infoUri(this.profileId, `/kv/${this.bucket}.json`), { column: vscode.ViewColumn.Beside });
        return true;
      },
      export: async ({ entries }: { entries: KvEntryDTO[] }) => {
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`${this.bucket}.json`),
          filters: { JSON: ["json"] },
          title: `Export ${entries.length} keys from ${this.bucket}`,
        });
        if (!target) return null;
        const out: Record<string, unknown> = {};
        for (const e of entries) {
          const bytes = e.data ? base64ToBytes(e.data) : new Uint8Array();
          const d = detect(bytes);
          out[e.key] = d.format === "json" ? d.json : d.format === "binary" ? { $base64: e.data } : (d.text ?? "");
        }
        await writeFile(target.fsPath, JSON.stringify(out, null, 2));
        return target.fsPath;
      },
      refreshTree: () => {
        this.s.explorer.refreshFolder(this.profileId, "kv");
        return true;
      },
    };
  }

  private currentGen?: symbol;
}

export async function openKvBrowser(s: Services, lc: LiveConnection, bucket: string, opts: { filter?: string; selectKey?: string } = {}): Promise<void> {
  const key = `kvBrowser:${lc.id}:${bucket}`;
  const existing = WebviewPanelBase.reveal<KvBrowserPanel>(key);
  if (existing) {
    if (opts.filter !== undefined || opts.selectKey) existing.setFilter(opts.filter, opts.selectKey);
    return;
  }
  const kv = await lc.kvm().open(bucket);
  const status = bucketToDTO(await kv.status());
  new KvBrowserPanel(s, lc.id, bucket, key, {
    connName: lc.profile.name,
    bucket,
    status,
    separator: cfg("kv.keySeparator", "."),
    maxKeys: cfg("kv.maxKeys", 5000),
    filter: opts.filter,
    selectKey: opts.selectKey,
  });
}
