// Import connection profiles from NATS CLI contexts
// (~/.config/nats/context/*.json, honoring XDG_CONFIG_HOME).

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeServers, type ConnectionProfile, type ProfileSecrets } from "./profile";

interface NatsCliContext {
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
}

export interface ImportedContext {
  name: string;
  file: string;
  profile: Omit<ConnectionProfile, "id">;
  secrets: ProfileSecrets;
}

export function natsContextDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "nats", "context");
}

export function contextToProfile(name: string, ctx: NatsCliContext): { profile: Omit<ConnectionProfile, "id">; secrets: ProfileSecrets } {
  const profile: Omit<ConnectionProfile, "id"> = {
    name,
    servers: normalizeServers(ctx.url || "nats://127.0.0.1:4222"),
    auth: { kind: "none" },
    origin: "nats-context",
  };
  const secrets: ProfileSecrets = {};
  if (ctx.creds) {
    profile.auth = { kind: "creds", credsFile: ctx.creds };
  } else if (ctx.nkey) {
    profile.auth = { kind: "nkey", nkeyFile: ctx.nkey };
  } else if (ctx.token) {
    profile.auth = { kind: "token" };
    secrets.token = ctx.token;
  } else if (ctx.user) {
    profile.auth = { kind: "userpass", username: ctx.user };
    secrets.password = ctx.password ?? "";
  }
  if (ctx.cert || ctx.key || ctx.ca || ctx.tls_first) {
    profile.tls = {
      enabled: true,
      caFile: ctx.ca || undefined,
      certFile: ctx.cert || undefined,
      keyFile: ctx.key || undefined,
      handshakeFirst: ctx.tls_first || undefined,
    };
  }
  if (ctx.inbox_prefix) profile.inboxPrefix = ctx.inbox_prefix;
  if (ctx.jetstream_domain) profile.jsDomain = ctx.jetstream_domain;
  if (ctx.jetstream_api_prefix) profile.jsApiPrefix = ctx.jetstream_api_prefix;
  return { profile, secrets };
}

export async function readNatsContexts(dir = natsContextDir()): Promise<ImportedContext[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: ImportedContext[] = [];
  for (const f of files.sort()) {
    try {
      const ctx = JSON.parse(await readFile(join(dir, f), "utf8")) as NatsCliContext;
      const name = f.replace(/\.json$/, "");
      out.push({ name, file: join(dir, f), ...contextToProfile(name, ctx) });
    } catch {
      /* skip unreadable context */
    }
  }
  return out;
}
