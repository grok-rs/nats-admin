// Decode the user JWT inside a NATS .creds file (no signature verification —
// only used to show identity and expiry to the user).

import { readFile } from "node:fs/promises";
import { expandHome } from "./profile";

export interface JwtInfo {
  name?: string;
  subject?: string;
  issuer?: string;
  account?: string;
  issuedAt?: Date;
  expires?: Date;
}

function b64urlJson(part: string): Record<string, unknown> {
  const pad = part.length % 4 === 0 ? "" : "=".repeat(4 - (part.length % 4));
  const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

export function decodeJwt(jwt: string): JwtInfo | undefined {
  const parts = jwt.trim().split(".");
  if (parts.length < 2) return undefined;
  try {
    const p = b64urlJson(parts[1]);
    const nats = (p.nats ?? {}) as Record<string, unknown>;
    return {
      name: typeof p.name === "string" ? p.name : undefined,
      subject: typeof p.sub === "string" ? p.sub : undefined,
      issuer: typeof p.iss === "string" ? p.iss : undefined,
      account: typeof nats.issuer_account === "string" ? nats.issuer_account : typeof p.iss === "string" ? p.iss : undefined,
      issuedAt: typeof p.iat === "number" ? new Date(p.iat * 1000) : undefined,
      expires: typeof p.exp === "number" && p.exp > 0 ? new Date(p.exp * 1000) : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Extract the JWT block from .creds text. */
export function jwtFromCreds(text: string): string | undefined {
  const m = /-{3,}BEGIN NATS USER JWT-{3,}\s*([A-Za-z0-9_\-.=]+)\s*-{3,}END NATS USER JWT-{3,}/.exec(text);
  return m?.[1];
}

export async function credsInfo(path: string): Promise<JwtInfo | undefined> {
  try {
    const jwt = jwtFromCreds(await readFile(expandHome(path), "utf8"));
    return jwt ? decodeJwt(jwt) : undefined;
  } catch {
    return undefined;
  }
}

/** Human summary of an expiry: undefined when far away / no expiry. */
export function expiryStatus(expires: Date | undefined, now = Date.now(), warnDays = 7): { level: "expired" | "soon"; text: string } | undefined {
  if (!expires) return undefined;
  const ms = expires.getTime() - now;
  if (ms <= 0) return { level: "expired", text: `credentials expired ${expires.toLocaleString()}` };
  if (ms < warnDays * 86_400_000) {
    const days = Math.floor(ms / 86_400_000);
    const hours = Math.floor((ms % 86_400_000) / 3_600_000);
    return { level: "soon", text: `credentials expire in ${days ? `${days}d ` : ""}${hours}h (${expires.toLocaleString()})` };
  }
  return undefined;
}
