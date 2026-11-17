// Connection profiles and the translation into nats.js connect options.
// Pure module (no vscode import) so it can be unit tested.

import { readFile } from "node:fs/promises";
import type { NodeConnectionOptions } from "@nats-io/transport-node";
import { credsAuthenticator, jwtAuthenticator, nkeyAuthenticator } from "@nats-io/nats-core";

export type AuthKind = "none" | "userpass" | "token" | "creds" | "nkey";

/** Deployment environment label; "prod" turns on extra safety (typed confirmations, red accents). */
export type Environment = "dev" | "test" | "staging" | "prod";

export const ENVIRONMENTS: { id: Environment; label: string; color: string; themeColor: string }[] = [
  { id: "dev", label: "Development", color: "#3fb950", themeColor: "charts.green" },
  { id: "test", label: "Test", color: "#3794ff", themeColor: "charts.blue" },
  { id: "staging", label: "Staging", color: "#d29922", themeColor: "charts.yellow" },
  { id: "prod", label: "Production", color: "#f85149", themeColor: "charts.red" },
];

/** Where a profile is defined. Only "manual" profiles are stored by the extension itself. */
export type ProfileOrigin = "manual" | "nats-context" | "workspace" | "env";

export interface TlsSettings {
  enabled: boolean;
  caFile?: string;
  certFile?: string;
  keyFile?: string;
  insecureSkipVerify?: boolean;
  handshakeFirst?: boolean;
  serverName?: string;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  servers: string[];
  auth: {
    kind: AuthKind;
    username?: string;
    /** Path to a .creds file (JWT + nkey seed). */
    credsFile?: string;
    /** Path to a file containing an nkey seed (alternative to storing the seed as a secret). */
    nkeyFile?: string;
    /** User JWT used together with the nkey seed (NATS CLI contexts with user_jwt). */
    userJwt?: string;
  };
  tls?: TlsSettings;
  /** HTTP monitoring endpoint, e.g. http://localhost:8222. Derived from the first server when empty. */
  monitorUrl?: string;
  jsDomain?: string;
  jsApiPrefix?: string;
  inboxPrefix?: string;
  connectTimeoutMs?: number;
  maxReconnectAttempts?: number;
  reconnectTimeWaitMs?: number;
  noEcho?: boolean;
  /** Where the profile is defined (see ProfileOrigin). */
  origin?: ProfileOrigin;
  /** NATS CLI context name / file for nats-context profiles. */
  contextName?: string;
  contextFile?: string;
  /** Deployment environment label (prod enables typed confirmations). */
  environment?: Environment;
  /** Block every write operation (publish, put, delete, purge, config changes, acks). */
  readOnly?: boolean;
  /** Connect automatically when VS Code starts. */
  autoConnect?: boolean;
  description?: string;
}

/** Guess an environment from a name/description when none is set explicitly. */
export function guessEnvironment(text: string): Environment | undefined {
  const t = text.toLowerCase();
  if (/(^|[^a-z])(prod|production|prd|live)([^a-z]|$)/.test(t)) return "prod";
  if (/(^|[^a-z])(stag|staging|stg|preprod|uat)/.test(t)) return "staging";
  if (/(^|[^a-z])(test|qa)([^a-z]|$)/.test(t)) return "test";
  if (/(^|[^a-z])(dev|local|localhost|sandbox)/.test(t)) return "dev";
  return undefined;
}

/** Secrets never stored with the profile; they live in VS Code SecretStorage. */
export interface ProfileSecrets {
  password?: string;
  token?: string;
  nkeySeed?: string;
}

export function newProfileId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeServers(input: string | string[]): string[] {
  const list = Array.isArray(input) ? input : input.split(/[,\s]+/);
  return list.map((s) => s.trim()).filter(Boolean);
}

export function describeServers(p: ConnectionProfile): string {
  return p.servers.join(", ") || "nats://127.0.0.1:4222";
}

/** Best-effort monitoring URL: explicit setting, else http://<first host>:8222. */
export function deriveMonitorUrl(p: ConnectionProfile): string | undefined {
  if (p.monitorUrl?.trim()) return p.monitorUrl.trim().replace(/\/+$/, "");
  const first = p.servers[0] ?? "nats://127.0.0.1:4222";
  try {
    const u = new URL(first.includes("://") ? first : `nats://${first}`);
    if (u.protocol === "ws:" || u.protocol === "wss:") return undefined;
    const host = u.hostname === "0.0.0.0" ? "127.0.0.1" : u.hostname;
    return `http://${host.includes(":") ? `[${host}]` : host}:8222`;
  } catch {
    return undefined;
  }
}

export async function buildConnectOptions(p: ConnectionProfile, secrets: ProfileSecrets): Promise<NodeConnectionOptions> {
  const opts: NodeConnectionOptions = {
    servers: p.servers.length ? p.servers : ["nats://127.0.0.1:4222"],
    name: "NATS Admin (VS Code)",
    timeout: p.connectTimeoutMs ?? 5000,
    maxReconnectAttempts: p.maxReconnectAttempts ?? -1,
    reconnectTimeWait: p.reconnectTimeWaitMs ?? 2000,
    noEcho: p.noEcho ?? false,
    waitOnFirstConnect: false,
  };
  if (p.inboxPrefix) opts.inboxPrefix = p.inboxPrefix;

  switch (p.auth.kind) {
    case "userpass":
      opts.user = p.auth.username ?? "";
      opts.pass = secrets.password ?? "";
      break;
    case "token":
      opts.token = secrets.token ?? "";
      break;
    case "creds": {
      if (!p.auth.credsFile) throw new Error("No credentials file configured for this connection");
      const creds = await readFile(expandHome(p.auth.credsFile));
      opts.authenticator = credsAuthenticator(new Uint8Array(creds));
      break;
    }
    case "nkey": {
      let seed = secrets.nkeySeed?.trim();
      if (!seed && p.auth.nkeyFile) seed = extractSeed(await readFile(expandHome(p.auth.nkeyFile), "utf8"));
      if (!seed) throw new Error("No nkey seed configured for this connection");
      opts.authenticator = p.auth.userJwt
        ? jwtAuthenticator(p.auth.userJwt, new TextEncoder().encode(seed))
        : nkeyAuthenticator(new TextEncoder().encode(seed));
      break;
    }
    case "none":
      break;
  }

  if (p.tls?.enabled) {
    const tls: NonNullable<NodeConnectionOptions["tls"]> = {};
    if (p.tls.caFile) tls.caFile = expandHome(p.tls.caFile);
    if (p.tls.certFile) tls.certFile = expandHome(p.tls.certFile);
    if (p.tls.keyFile) tls.keyFile = expandHome(p.tls.keyFile);
    if (p.tls.handshakeFirst) tls.handshakeFirst = true;
    const nodeTls = tls as Record<string, unknown>;
    if (p.tls.insecureSkipVerify) nodeTls.rejectUnauthorized = false;
    if (p.tls.serverName) nodeTls.servername = p.tls.serverName;
    opts.tls = tls;
  }
  return opts;
}

/** Pull the first nkey seed (S...) out of a file that may contain other text. */
export function extractSeed(text: string): string | undefined {
  const m = /\bS[UOANCPX][A-Z2-7]{54,}\b/.exec(text);
  return m?.[0];
}

export function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return home + p.slice(1);
  }
  return p;
}

/** Strip secrets / internal fields before showing a profile as JSON. */
export function redactProfile(p: ConnectionProfile): ConnectionProfile {
  return JSON.parse(JSON.stringify(p)) as ConnectionProfile;
}
