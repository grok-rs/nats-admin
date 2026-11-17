// All connection profiles, from four sources:
//   manual     — created in VS Code, stored in globalState (+ secrets in SecretStorage)
//   ctx        — NATS CLI contexts, read live from ~/.config/nats/context (secrets stay in the files)
//   workspace  — setting nats.connections (team-shared, secrets prompted once → SecretStorage)
//   env        — NATS_URL & friends from the VS Code process environment
// Per-profile overlays (environment, read-only, auto-connect) apply to every source.

import * as vscode from "vscode";
import { dirname } from "node:path";
import { newProfileId, type ConnectionProfile, type Environment, type ProfileSecrets } from "./profile";
import { natsContextDir } from "./natsContexts";
import { cliContextSecrets, discoverCliContexts, environmentProfile, selectedCliContext, workspaceProfiles, type CliContext } from "./sources";
import { CancelledError } from "./errors";
import { log } from "./log";

const PROFILES_KEY = "nats.connections.v1";
const OVERLAYS_KEY = "nats.connections.overlays.v1";
const HIDDEN_KEY = "nats.connections.hidden.v1";
const secretKey = (id: string) => `nats.connection.secret.${id}`;

export interface Overlay {
  environment?: Environment | "none";
  readOnly?: boolean;
  autoConnect?: boolean;
}

interface Discovered {
  profile: ConnectionProfile;
  raw?: CliContext;
  secrets?: ProfileSecrets;
  warning?: string;
}

export class ConnectionStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private discovered: Discovered[] = [];
  private selectedContext?: string;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshing?: Promise<void>;
  private lastSignature = "";
  /** Resolves after the first discovery pass. */
  readonly ready: Promise<void>;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.ready = this.refresh();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("nats.connections") || e.affectsConfiguration("nats.contexts")) {
          this.watchContexts();
          void this.refresh();
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.refresh()),
      // Cheap safety net for context files edited while the watcher isn't active.
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) void this.refresh();
      }),
    );
    this.watchContexts();
  }

  private contextWatcher?: vscode.Disposable;

  private contextDir(): string {
    return vscode.workspace.getConfiguration("nats").get<string>("contexts.directory", "")?.trim() || natsContextDir();
  }

  private watchContexts(): void {
    this.contextWatcher?.dispose();
    this.contextWatcher = undefined;
    if (!vscode.workspace.getConfiguration("nats").get<boolean>("contexts.autoDiscover", true)) return;
    try {
      const parent = dirname(this.contextDir());
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(parent), "{context.txt,context/*.json}"));
      const onFs = () => void this.refresh();
      w.onDidCreate(onFs);
      w.onDidChange(onFs);
      w.onDidDelete(onFs);
      this.contextWatcher = w;
    } catch (e) {
      log.debug(`context watcher unavailable: ${String(e)}`);
    }
  }

  /** Re-read contexts, workspace settings and environment. Fires onDidChange when something changed. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const cfg = vscode.workspace.getConfiguration("nats");
      const next: Discovered[] = [];
      if (cfg.get<boolean>("contexts.autoDiscover", true)) {
        const dir = this.contextDir();
        for (const d of await discoverCliContexts(dir)) next.push({ profile: d.profile, raw: d.raw, warning: d.warning });
        this.selectedContext = await selectedCliContext(dir);
      } else {
        this.selectedContext = undefined;
      }
      if (vscode.workspace.isTrusted) {
        for (const p of workspaceProfiles(cfg.get("connections"))) next.push({ profile: p });
      }
      if (cfg.get<boolean>("connections.fromEnvironment", true)) {
        const env = environmentProfile();
        if (env) next.push({ profile: env.profile, secrets: env.secrets });
      }
      this.discovered = next;
      const signature = JSON.stringify([next.map((d) => [d.profile, d.warning]), this.selectedContext]);
      if (signature !== this.lastSignature) {
        this.lastSignature = signature;
        this._onDidChange.fire();
      }
    })().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private managed(): ConnectionProfile[] {
    return this.context.globalState.get<ConnectionProfile[]>(PROFILES_KEY, []).map((p) => ({ ...p, origin: "manual" as const }));
  }

  private overlays(): Record<string, Overlay> {
    return this.context.globalState.get<Record<string, Overlay>>(OVERLAYS_KEY, {});
  }

  private hiddenIds(): string[] {
    return this.context.globalState.get<string[]>(HIDDEN_KEY, []);
  }

  private applyOverlay(p: ConnectionProfile): ConnectionProfile {
    const o = this.overlays()[p.id];
    const out: ConnectionProfile = { ...p };
    if (o) {
      if (o.environment === "none") out.environment = undefined;
      else if (o.environment) out.environment = o.environment;
      if (o.readOnly !== undefined) out.readOnly = o.readOnly;
      if (o.autoConnect !== undefined) out.autoConnect = o.autoConnect;
    }
    return out;
  }

  /** Visible profiles: managed first, then discovered ones not shadowed by a managed profile of the same name. */
  list(): ConnectionProfile[] {
    const managed = this.managed();
    const names = new Set(managed.map((p) => p.name.toLowerCase()));
    const hidden = new Set(this.hiddenIds());
    const discovered = this.discovered.filter((d) => !hidden.has(d.profile.id) && !names.has(d.profile.name.toLowerCase())).map((d) => d.profile);
    return [...managed, ...discovered].map((p) => this.applyOverlay(p));
  }

  /** Every profile including hidden/shadowed discovered ones (for lookups by id). */
  private all(): ConnectionProfile[] {
    return [...this.managed(), ...this.discovered.map((d) => d.profile)];
  }

  get(id: string): ConnectionProfile | undefined {
    const p = this.all().find((x) => x.id === id);
    return p ? this.applyOverlay(p) : undefined;
  }

  findByName(name: string): ConnectionProfile | undefined {
    const lower = name.toLowerCase();
    return this.list().find((p) => p.name.toLowerCase() === lower);
  }

  isManaged(id: string): boolean {
    return this.managed().some((p) => p.id === id);
  }

  /** Context-specific problem that prevents connecting (nsc://, socks proxy…). */
  warningFor(id: string): string | undefined {
    return this.discovered.find((d) => d.profile.id === id)?.warning;
  }

  /** True for the context selected with `nats context select` (or NATS_CONTEXT). */
  isSelectedContext(p: ConnectionProfile): boolean {
    return p.origin === "nats-context" && !!this.selectedContext && p.contextName === this.selectedContext;
  }

  selectedContextProfile(): ConnectionProfile | undefined {
    return this.list().find((p) => this.isSelectedContext(p));
  }

  async getSecrets(id: string): Promise<ProfileSecrets> {
    const d = this.discovered.find((x) => x.profile.id === id);
    if (d?.raw) return cliContextSecrets(d.raw);
    const stored = await this.readStoredSecrets(id);
    if (d?.secrets) return { ...d.secrets, ...stored };
    return stored;
  }

  private async readStoredSecrets(id: string): Promise<ProfileSecrets> {
    const raw = await this.context.secrets.get(secretKey(id));
    if (!raw) return {};
    try {
      return JSON.parse(raw) as ProfileSecrets;
    } catch {
      return {};
    }
  }

  private async writeStoredSecrets(id: string, secrets: ProfileSecrets): Promise<void> {
    const clean = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== undefined && v !== "")) as ProfileSecrets;
    if (Object.keys(clean).length) await this.context.secrets.store(secretKey(id), JSON.stringify(clean));
    else await this.context.secrets.delete(secretKey(id));
  }

  /**
   * Secrets for connecting, prompting for anything missing (e.g. the password of
   * a team connection from workspace settings). Prompted values are stored in the
   * keychain for manual and workspace profiles.
   */
  async ensureSecrets(p: ConnectionProfile): Promise<ProfileSecrets> {
    const secrets = await this.getSecrets(p.id);
    const missing: { key: keyof ProfileSecrets; prompt: string } | undefined =
      p.auth.kind === "userpass" && !secrets.password
        ? { key: "password", prompt: `Password for ${p.auth.username ?? "user"} @ ${p.name}` }
        : p.auth.kind === "token" && !secrets.token
          ? { key: "token", prompt: `Token for ${p.name}` }
          : p.auth.kind === "nkey" && !secrets.nkeySeed && !p.auth.nkeyFile
            ? { key: "nkeySeed", prompt: `NKey seed (SU…) for ${p.name}` }
            : undefined;
    if (!missing) return secrets;
    const value = await vscode.window.showInputBox({ title: `Connect to ${p.name}`, prompt: missing.prompt, password: true, ignoreFocusOut: true });
    if (value === undefined) throw new CancelledError();
    const merged = { ...secrets, [missing.key]: value };
    if (p.origin === "manual" || p.origin === "workspace" || p.origin === undefined) {
      await this.writeStoredSecrets(p.id, { ...(await this.readStoredSecrets(p.id)), [missing.key]: value });
    }
    return merged;
  }

  /** Create or update a manual profile. `secrets === undefined` keeps the stored secrets. */
  async save(profile: Omit<ConnectionProfile, "id"> & { id?: string }, secrets?: ProfileSecrets): Promise<ConnectionProfile> {
    const full: ConnectionProfile = { ...profile, id: profile.id || newProfileId(), origin: "manual" } as ConnectionProfile;
    delete full.contextFile;
    delete full.contextName;
    const list = this.context.globalState.get<ConnectionProfile[]>(PROFILES_KEY, []);
    const idx = list.findIndex((p) => p.id === full.id);
    if (idx >= 0) list[idx] = full;
    else list.push(full);
    await this.context.globalState.update(PROFILES_KEY, list);
    if (secrets !== undefined) await this.writeStoredSecrets(full.id, secrets);
    this._onDidChange.fire();
    return full;
  }

  async remove(id: string): Promise<void> {
    await this.context.globalState.update(
      PROFILES_KEY,
      this.context.globalState.get<ConnectionProfile[]>(PROFILES_KEY, []).filter((p) => p.id !== id),
    );
    await this.context.secrets.delete(secretKey(id));
    const overlays = this.overlays();
    delete overlays[id];
    await this.context.globalState.update(OVERLAYS_KEY, overlays);
    this._onDidChange.fire();
  }

  /** Change environment / read-only / auto-connect for any profile. */
  async setOverlay(id: string, patch: Overlay): Promise<void> {
    if (this.isManaged(id)) {
      const p = this.managed().find((x) => x.id === id)!;
      const next: ConnectionProfile = { ...p };
      if (patch.environment !== undefined) next.environment = patch.environment === "none" ? undefined : patch.environment;
      if (patch.readOnly !== undefined) next.readOnly = patch.readOnly || undefined;
      if (patch.autoConnect !== undefined) next.autoConnect = patch.autoConnect || undefined;
      await this.save(next);
      return;
    }
    const overlays = this.overlays();
    overlays[id] = { ...overlays[id], ...patch };
    await this.context.globalState.update(OVERLAYS_KEY, overlays);
    this._onDidChange.fire();
  }

  async hide(id: string): Promise<void> {
    const hidden = new Set(this.hiddenIds());
    hidden.add(id);
    await this.context.globalState.update(HIDDEN_KEY, [...hidden]);
    this._onDidChange.fire();
  }

  async unhide(ids: string[]): Promise<void> {
    await this.context.globalState.update(
      HIDDEN_KEY,
      this.hiddenIds().filter((h) => !ids.includes(h)),
    );
    this._onDidChange.fire();
  }

  /** Discovered profiles that are hidden or shadowed by a managed profile with the same name. */
  hiddenProfiles(): { profile: ConnectionProfile; reason: "hidden" | "shadowed" }[] {
    const hidden = new Set(this.hiddenIds());
    const names = new Set(this.managed().map((p) => p.name.toLowerCase()));
    return this.discovered
      .filter((d) => hidden.has(d.profile.id) || names.has(d.profile.name.toLowerCase()))
      .map((d) => ({ profile: this.applyOverlay(d.profile), reason: hidden.has(d.profile.id) ? ("hidden" as const) : ("shadowed" as const) }));
  }

  dispose(): void {
    this.contextWatcher?.dispose();
    this.disposables.forEach((d) => d.dispose());
    this._onDidChange.dispose();
  }
}
