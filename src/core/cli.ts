// nats CLI interop: terminal environment for a profile and ready-to-copy
// commands for explorer resources. Pure module (unit tested).

import { expandHome, type ConnectionProfile, type ProfileSecrets } from "./profile";

/** Environment variables understood by the nats CLI for this profile. */
export function cliEnvironment(p: ConnectionProfile, secrets: ProfileSecrets): { env: Record<string, string>; notes: string[] } {
  const notes: string[] = [];
  if (p.origin === "nats-context" && p.contextName) return { env: { NATS_CONTEXT: p.contextName }, notes };
  const env: Record<string, string> = { NATS_URL: p.servers.join(",") };
  switch (p.auth.kind) {
    case "userpass":
      if (p.auth.username) env.NATS_USER = p.auth.username;
      if (secrets.password) env.NATS_PASSWORD = secrets.password;
      break;
    case "token":
      // The CLI accepts a token as the user.
      if (secrets.token) env.NATS_USER = secrets.token;
      break;
    case "creds":
      if (p.auth.credsFile) env.NATS_CREDS = expandHome(p.auth.credsFile);
      break;
    case "nkey":
      if (p.auth.nkeyFile) env.NATS_NKEY = expandHome(p.auth.nkeyFile);
      else notes.push("The NKey seed is stored in the keychain only — the CLI needs a seed file (NATS_NKEY).");
      break;
  }
  if (p.tls?.enabled) {
    if (p.tls.caFile) env.NATS_CA = expandHome(p.tls.caFile);
    if (p.tls.certFile) env.NATS_CERT = expandHome(p.tls.certFile);
    if (p.tls.keyFile) env.NATS_KEY = expandHome(p.tls.keyFile);
  }
  if (p.inboxPrefix) env.NATS_INBOX_PREFIX = p.inboxPrefix;
  if (p.jsDomain) env.NATS_JSM_DOMAIN = p.jsDomain;
  return { env, notes };
}

/** Connection flag to append to copied commands. */
export function cliConnectionFlag(p: ConnectionProfile): string {
  if (p.origin === "nats-context" && p.contextName) return ` --context ${shellQuote(p.contextName)}`;
  return ` --server ${shellQuote(p.servers.join(","))}`;
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:@,=+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

export type CliTarget =
  | { kind: "stream"; stream: string }
  | { kind: "consumer"; stream: string; consumer: string }
  | { kind: "kv"; bucket: string }
  | { kind: "obj"; bucket: string };

/** Common nats CLI commands for a resource (label → command without the connection flag). */
export function cliCommands(t: CliTarget): { label: string; command: string }[] {
  const q = shellQuote;
  switch (t.kind) {
    case "stream":
      return [
        { label: "Stream info", command: `nats stream info ${q(t.stream)}` },
        { label: "View messages", command: `nats stream view ${q(t.stream)}` },
        { label: "Subjects with counts", command: `nats stream subjects ${q(t.stream)}` },
        { label: "Consumer report", command: `nats consumer report ${q(t.stream)}` },
        { label: "Stream report (all streams)", command: "nats stream report" },
        { label: "Backup", command: `nats stream backup ${q(t.stream)} ./backup-${t.stream}` },
        { label: "Export config", command: `nats stream info ${q(t.stream)} --json > ${t.stream}.stream.json` },
      ];
    case "consumer":
      return [
        { label: "Consumer info", command: `nats consumer info ${q(t.stream)} ${q(t.consumer)}` },
        { label: "Fetch next message (acks it)", command: `nats consumer next ${q(t.stream)} ${q(t.consumer)}` },
        { label: "Consumer report", command: `nats consumer report ${q(t.stream)}` },
        { label: "Export config", command: `nats consumer info ${q(t.stream)} ${q(t.consumer)} --json` },
      ];
    case "kv":
      return [
        { label: "Bucket status", command: `nats kv status ${q(t.bucket)}` },
        { label: "List keys", command: `nats kv ls ${q(t.bucket)}` },
        { label: "Watch changes", command: `nats kv watch ${q(t.bucket)}` },
        { label: "Get a key", command: `nats kv get ${q(t.bucket)} <key>` },
        { label: "Put a key", command: `nats kv put ${q(t.bucket)} <key> <value>` },
      ];
    case "obj":
      return [
        { label: "List objects", command: `nats object ls ${q(t.bucket)}` },
        { label: "Bucket info", command: `nats object info ${q(t.bucket)}` },
        { label: "Download an object", command: `nats object get ${q(t.bucket)} <name>` },
        { label: "Upload a file", command: `nats object put ${q(t.bucket)} <file>` },
      ];
  }
}
