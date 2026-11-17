// Add / edit a connection profile (webview form) with "Test Connection".

import * as vscode from "vscode";
import { connect } from "@nats-io/transport-node";
import type { Services } from "../services";
import { WebviewPanelBase } from "./webviewHost";
import { buildConnectOptions, deriveMonitorUrl, normalizeServers, type ConnectionProfile, type ProfileSecrets } from "../core/profile";
import { errorMessage } from "../core/connectionManager";
import { fetchMonitor } from "../nats/monitor";
import { jetstreamManager } from "@nats-io/jetstream";

export interface EditorInit {
  profile: Omit<ConnectionProfile, "id"> & { id?: string };
  stored: { password: boolean; token: boolean; nkeySeed: boolean };
  isNew: boolean;
}

interface FormSubmit {
  profile: Omit<ConnectionProfile, "id"> & { id?: string };
  /** Only fields the user typed into; omitted = keep stored. */
  secrets: ProfileSecrets;
  clearSecrets?: boolean;
}

class ConnectionEditorPanel extends WebviewPanelBase {
  constructor(
    private readonly s: Services,
    key: string,
    init: EditorInit,
  ) {
    super(s.context, {
      viewType: "nats.connectionEditor",
      key,
      title: init.isNew ? "New NATS Connection" : `Edit ${init.profile.name}`,
      script: "connectionEditor",
      init,
    });
  }

  private async mergedSecrets(form: FormSubmit): Promise<ProfileSecrets> {
    const stored = form.profile.id ? await this.s.store.getSecrets(form.profile.id) : {};
    return { ...stored, ...Object.fromEntries(Object.entries(form.secrets).filter(([, v]) => v !== undefined && v !== "")) };
  }

  protected handlers() {
    return {
      browse: async ({ title, filters }: { title: string; filters?: Record<string, string[]> }) => {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false, title, filters, openLabel: "Select" });
        return picked?.[0]?.fsPath ?? null;
      },
      deriveMonitor: ({ servers }: { servers: string }) =>
        deriveMonitorUrl({ id: "", name: "", servers: normalizeServers(servers), auth: { kind: "none" } }) ?? "",
      test: async (form: FormSubmit) => {
        const profile = { ...form.profile, id: form.profile.id ?? "test" } as ConnectionProfile;
        const opts = await buildConnectOptions(profile, await this.mergedSecrets(form));
        opts.maxReconnectAttempts = 0;
        opts.name = "NATS Admin (connection test)";
        const started = Date.now();
        const nc = await connect(opts);
        try {
          const rtt = await nc.rtt();
          let jetstream = "disabled";
          try {
            const jsm = await jetstreamManager(nc, { domain: profile.jsDomain || undefined, apiPrefix: profile.jsApiPrefix || undefined, timeout: 3000 });
            const ai = await jsm.getAccountInfo();
            jetstream = `enabled · ${ai.streams} streams · ${ai.consumers} consumers`;
          } catch {
            /* not enabled */
          }
          let monitor = "not reachable";
          const murl = deriveMonitorUrl(profile);
          if (murl) {
            try {
              await fetchMonitor(murl, "healthz", {}, 1500);
              monitor = `reachable at ${murl}`;
            } catch {
              monitor = `not reachable at ${murl}`;
            }
          }
          const i = nc.info;
          return {
            server: `${i?.server_name} (${i?.server_id?.slice(0, 8)}…) v${i?.version}`,
            url: nc.getServer(),
            rtt: `${rtt.toFixed(2)} ms`,
            connectMs: Date.now() - started,
            jetstream,
            monitor,
            tls: i?.tls_required ? "required" : "off",
          };
        } finally {
          await nc.close();
        }
      },
      save: async ({ form, connectAfter }: { form: FormSubmit; connectAfter: boolean }) => {
        const p = form.profile;
        if (!p.name.trim()) throw new Error("Name is required");
        const clash = this.s.store.list().find((x) => x.name.toLowerCase() === p.name.trim().toLowerCase() && x.id !== p.id);
        if (clash) throw new Error(`A connection named "${clash.name}" already exists`);
        const secrets = form.clearSecrets ? form.secrets : await this.mergedSecrets(form);
        // Drop secrets that don't belong to the chosen auth method.
        const kind = p.auth.kind;
        const keep: ProfileSecrets = {
          password: kind === "userpass" ? secrets.password : undefined,
          token: kind === "token" ? secrets.token : undefined,
          nkeySeed: kind === "nkey" ? secrets.nkeySeed : undefined,
        };
        const saved = await this.s.store.save({ ...p, name: p.name.trim(), servers: normalizeServers(p.servers) }, keep);
        const wasLive = Boolean(this.s.manager.get(saved.id));
        this.dispose();
        if (wasLive) {
          const again = await vscode.window.showInformationMessage(`Connection "${saved.name}" updated. Reconnect now to apply the changes?`, "Reconnect");
          if (again) await this.s.manager.reconnectIfLive(saved.id).catch((e) => vscode.window.showErrorMessage(errorMessage(e)));
        } else if (connectAfter) {
          await vscode.commands.executeCommand("nats.connect", saved.id);
        }
        return true;
      },
      cancel: () => this.dispose(),
    };
  }
}

export async function openConnectionEditor(s: Services, existing?: ConnectionProfile, template?: Omit<ConnectionProfile, "id">): Promise<void> {
  const key = `connEditor:${existing?.id ?? "new"}`;
  if (WebviewPanelBase.reveal(key)) return;
  let stored = { password: false, token: false, nkeySeed: false };
  if (existing) {
    const sec = await s.store.getSecrets(existing.id);
    stored = { password: Boolean(sec.password), token: Boolean(sec.token), nkeySeed: Boolean(sec.nkeySeed) };
  }
  const profile: EditorInit["profile"] = existing ??
    template ?? {
      name: uniqueName(s, "local"),
      servers: ["nats://127.0.0.1:4222"],
      auth: { kind: "none" },
    };
  new ConnectionEditorPanel(s, key, { profile, stored, isNew: !existing });
}

export function uniqueName(s: Services, base: string): string {
  const names = new Set(s.store.list().map((p) => p.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!names.has(`${base}-${i}`.toLowerCase())) return `${base}-${i}`;
}
