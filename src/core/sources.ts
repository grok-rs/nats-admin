// Connection sources besides the profiles stored by the extension:
//   - NATS CLI contexts (~/.config/nats/context/*.json), live from disk
//   - workspace connections (setting nats.connections, no secrets)
//   - the process environment (NATS_URL & friends)
// Pure module (no vscode import) so it can be unit tested.

import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { natsContextDir } from "./natsContexts";
import { guessEnvironment, normalizeServers, type AuthKind, type ConnectionProfile, type Environment, type ProfileSecrets, type TlsSettings } from "./profile";

/** Raw NATS CLI context file (subset of fields we understand). */
export interface CliContext {
  description?: string;
  url?: string;
  user?: string;
  password?: string;
  creds?: string;
  nkey?: string;
  token?: string;
  cert?: string;
  key?: string;
  ca?: string;
  tls_first?: boolean;
  inbox_prefix?: string;
  jetstream_domain?: string;
  jetstream_api_prefix?: string;
  user_jwt?: string;
  nsc?: string;
  socks_proxy?: string;
  color_scheme?: string;
}

export function stableId(prefix: string, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "x";
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 6);
  return `${prefix}-${slug}-${hash}`;
}

/** Map a CLI context to a profile; secrets stay in the file and are read at connect time. */
export function cliContextProfile(name: string, file: string, ctx: CliContext): ConnectionProfile {
  const auth: ConnectionProfile["auth"] = { kind: "none" };
  if (ctx.creds) {
    auth.kind = "creds";
    auth.credsFile = ctx.creds;
  } else if (ctx.nkey) {
    auth.kind = "nkey";
    auth.nkeyFile = ctx.nkey;
    if (ctx.user_jwt) auth.userJwt = ctx.user_jwt;
  } else if (ctx.token) {
    auth.kind = "token";
  } else if (ctx.user) {
    auth.kind = "userpass";
    auth.username = ctx.user;
  }
  let tls: TlsSettings | undefined;
  if (ctx.cert || ctx.key || ctx.ca || ctx.tls_first) {
    tls = { enabled: true, caFile: ctx.ca || undefined, certFile: ctx.cert || undefined, keyFile: ctx.key || undefined, handshakeFirst: ctx.tls_first || undefined };
  }
  return {
    id: stableId("ctx", name),
    name,
    servers: normalizeServers(ctx.url || "nats://127.0.0.1:4222"),
    auth,
    tls,
    inboxPrefix: ctx.inbox_prefix || undefined,
    jsDomain: ctx.jetstream_domain || undefined,
    jsApiPrefix: ctx.jetstream_api_prefix || undefined,
    origin: "nats-context",
    contextName: name,
    contextFile: file,
    description: ctx.description || undefined,
    environment: guessEnvironment(`${name} ${ctx.description ?? ""}`),
  };
}

export function cliContextSecrets(ctx: CliContext): ProfileSecrets {
  return { password: ctx.password || undefined, token: ctx.token || undefined };
}

export interface DiscoveredContext {
  profile: ConnectionProfile;
  raw: CliContext;
  /** Problems that will prevent connecting (e.g. nsc:// contexts). */
  warning?: string;
}

export async function discoverCliContexts(dir = natsContextDir()): Promise<DiscoveredContext[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: DiscoveredContext[] = [];
  for (const f of files) {
    const file = join(dir, f);
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as CliContext;
      const name = f.replace(/\.json$/, "");
      const d: DiscoveredContext = { profile: cliContextProfile(name, file, raw), raw };
      if (raw.nsc) d.warning = "nsc:// contexts are not supported — export a .creds file and reference it with `creds`";
      if (raw.socks_proxy) d.warning = "SOCKS proxies are not supported by the extension";
      out.push(d);
    } catch {
      /* unreadable or invalid JSON: skip */
    }
  }
  return out;
}

/** Name of the context selected with `nats context select` (context.txt), or NATS_CONTEXT. */
export async function selectedCliContext(dir = natsContextDir(), env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (env.NATS_CONTEXT) return env.NATS_CONTEXT;
  try {
    const txt = (await readFile(join(dir, "..", "context.txt"), "utf8")).trim();
    return txt || undefined;
  } catch {
    return undefined;
  }
}

/** A team connection from the nats.connections setting. */
export interface WorkspaceConnection {
  name: string;
  servers: string | string[];
  auth?: { kind?: AuthKind; username?: string; credsFile?: string; nkeyFile?: string };
  tls?: TlsSettings;
  monitorUrl?: string;
  environment?: Environment;
  readOnly?: boolean;
  jsDomain?: string;
  jsApiPrefix?: string;
  inboxPrefix?: string;
  description?: string;
}

export function workspaceProfiles(entries: unknown): ConnectionProfile[] {
  if (!Array.isArray(entries)) return [];
  const out: ConnectionProfile[] = [];
  for (const e of entries as WorkspaceConnection[]) {
    if (!e || typeof e.name !== "string" || !e.name.trim() || !e.servers) continue;
    out.push({
      id: stableId("ws", e.name),
      name: e.name.trim(),
      servers: normalizeServers(e.servers),
      auth: { kind: e.auth?.kind ?? "none", username: e.auth?.username, credsFile: e.auth?.credsFile, nkeyFile: e.auth?.nkeyFile },
      tls: e.tls,
      monitorUrl: e.monitorUrl,
      environment: e.environment ?? guessEnvironment(e.name),
      readOnly: e.readOnly,
      jsDomain: e.jsDomain,
      jsApiPrefix: e.jsApiPrefix,
      inboxPrefix: e.inboxPrefix,
      description: e.description,
      origin: "workspace",
    });
  }
  return out;
}

export const ENV_PROFILE_ID = "env-nats-url";

/** Profile built from NATS_URL / NATS_USER / NATS_PASSWORD / NATS_CREDS / NATS_NKEY / NATS_CA / NATS_CERT / NATS_KEY. */
export function environmentProfile(env: NodeJS.ProcessEnv = process.env): { profile: ConnectionProfile; secrets: ProfileSecrets } | undefined {
  if (!env.NATS_URL?.trim()) return undefined;
  const auth: ConnectionProfile["auth"] = { kind: "none" };
  const secrets: ProfileSecrets = {};
  if (env.NATS_CREDS) {
    auth.kind = "creds";
    auth.credsFile = env.NATS_CREDS;
  } else if (env.NATS_NKEY) {
    auth.kind = "nkey";
    auth.nkeyFile = env.NATS_NKEY;
  } else if (env.NATS_USER && env.NATS_PASSWORD) {
    auth.kind = "userpass";
    auth.username = env.NATS_USER;
    secrets.password = env.NATS_PASSWORD;
  } else if (env.NATS_USER) {
    // The nats CLI treats a lone NATS_USER as a token.
    auth.kind = "token";
    secrets.token = env.NATS_USER;
  }
  const tls = env.NATS_CA || env.NATS_CERT || env.NATS_KEY ? { enabled: true, caFile: env.NATS_CA, certFile: env.NATS_CERT, keyFile: env.NATS_KEY } : undefined;
  return {
    profile: {
      id: ENV_PROFILE_ID,
      name: "NATS_URL (environment)",
      servers: normalizeServers(env.NATS_URL),
      auth,
      tls,
      origin: "env",
      environment: guessEnvironment(env.NATS_URL),
      description: "From the VS Code process environment",
    },
    secrets,
  };
}
