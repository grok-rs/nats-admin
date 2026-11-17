// Pure playbook helpers (no vscode import) — connection resolution, block →
// message expansion, reply formatting and @connection editing. Unit tested.

import type { PlaybookBlock, PlaybookFile } from "../shared/playbook";
import { renderTemplate } from "../shared/template";
import { bytesToBase64, utf8DecodeStrict } from "../shared/encoding";
import { detect } from "../shared/payload";

export interface ExpandedMessage {
  subject: string;
  /** UTF-8 payload text after template rendering. */
  data: string;
  headers: [string, string][];
  reply?: string;
}

export interface ExpandedBlock {
  verb: PlaybookBlock["verb"];
  messages: ExpandedMessage[];
  /** Request timeout (REQ) or subscription duration (SUB), in ms. */
  timeoutMs: number;
  /** SUB: stop after this many messages (undefined = until timeout). */
  maxMessages?: number;
  queue?: string;
  /** PUB: publish through JetStream and wait for acks. */
  jetstream: boolean;
}

export const MAX_PUB_COUNT = 100_000;
export const DEFAULT_SUB_TIMEOUT = 60_000;

/** Parse a positive integer option; undefined when absent, throws when malformed. */
export function intOption(block: PlaybookBlock, name: string, min: number, max: number): number | undefined {
  const raw = block.options[name];
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) throw new Error(`Option ${name}=${raw} must be a whole number`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`Option ${name}=${raw} must be between ${min} and ${max}`);
  return n;
}

function boolOption(block: PlaybookBlock, name: string): boolean {
  const raw = block.options[name]?.toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/** The connection name a block should run on (block option, then file directive). */
export function effectiveConnectionName(file: PlaybookFile, block: PlaybookBlock): string | undefined {
  return block.connection?.trim() || file.connection?.trim() || undefined;
}

/** Render templates and options into concrete messages. */
export function expandBlock(block: PlaybookBlock, opts: { defaultRequestTimeout: number; now?: Date }): ExpandedBlock {
  const render = (s: string, seq: number) => renderTemplate(s, { seq, now: opts.now });
  const reply = block.options.reply;
  if (block.verb === "SUB") {
    return {
      verb: "SUB",
      messages: [{ subject: block.subject, data: "", headers: [] }],
      timeoutMs: intOption(block, "timeout", 1, 24 * 3_600_000) ?? DEFAULT_SUB_TIMEOUT,
      maxMessages: intOption(block, "count", 1, 10_000_000),
      queue: block.options.queue || undefined,
      jetstream: false,
    };
  }
  const count = block.verb === "PUB" ? (intOption(block, "count", 1, MAX_PUB_COUNT) ?? 1) : 1;
  const messages: ExpandedMessage[] = [];
  for (let seq = 1; seq <= count; seq++) {
    messages.push({
      subject: render(block.subject, seq),
      data: render(block.body, seq),
      headers: block.headers.map(([k, v]) => [k, render(v, seq)]),
      reply: reply ? render(reply, seq) : undefined,
    });
  }
  return {
    verb: block.verb,
    messages,
    timeoutMs: intOption(block, "timeout", 1, 3_600_000) ?? opts.defaultRequestTimeout,
    jetstream: block.verb === "PUB" && boolOption(block, "js"),
  };
}

/** Structured reply shown in the reply document. */
export function formatReply(r: {
  requestSubject: string;
  subject?: string;
  headers?: [string, string][];
  data?: Uint8Array;
  latencyMs: number;
  status?: string;
  error?: string;
  at?: Date;
}): string {
  const out: Record<string, unknown> = {
    request: r.requestSubject,
    at: (r.at ?? new Date()).toISOString(),
    latencyMs: Math.round(r.latencyMs * 100) / 100,
  };
  if (r.error) {
    out.status = "error";
    out.error = r.error;
    return JSON.stringify(out, null, 2);
  }
  out.status = r.status ?? "ok";
  if (r.subject) out.replySubject = r.subject;
  out.headers = Object.fromEntries(groupHeaders(r.headers ?? []));
  const data = r.data ?? new Uint8Array();
  out.size = data.length;
  const d = detect(data);
  if (d.format === "json") out.data = d.json;
  else if (d.format === "text") out.data = d.text;
  else if (d.format === "empty") out.data = null;
  else {
    out.encoding = "base64";
    out.data = bytesToBase64(data);
  }
  return JSON.stringify(out, null, 2);
}

function groupHeaders(h: [string, string][]): [string, string | string[]][] {
  const m = new Map<string, string[]>();
  for (const [k, v] of h) m.set(k, [...(m.get(k) ?? []), v]);
  return [...m].map(([k, vs]) => [k, vs.length === 1 ? vs[0] : vs]);
}

/** One readable log entry for a received message (SUB output). */
export function describeMessage(n: number, m: { subject: string; reply?: string; headers: [string, string][]; data: Uint8Array }, maxChars = 4000): string {
  const lines = [`#${n} ${m.subject}${m.reply ? ` (reply → ${m.reply})` : ""} · ${m.data.length} B`];
  for (const [k, v] of m.headers) lines.push(`    ${k}: ${v}`);
  const d = detect(m.data);
  let body: string;
  if (d.format === "json") body = JSON.stringify(d.json, null, 2);
  else if (d.format === "binary") body = `‹binary› ${bytesToBase64(m.data)}`;
  else body = d.text ?? utf8DecodeStrict(m.data) ?? "";
  if (body.length > maxChars) body = `${body.slice(0, maxChars)}… (${body.length - maxChars} more chars)`;
  if (body) lines.push(...body.split("\n").map((l) => `    ${l}`));
  return lines.join("\n");
}

/**
 * Compute the edit that sets the file's `@connection` directive: replace the
 * existing line, or insert after the leading comment block.
 */
export function connectionDirectiveEdit(text: string, name: string): { line: number; replace: boolean; text: string } {
  const lines = text.split(/\r?\n/);
  const existing = lines.findIndex((l) => /^\s*@connection\b/i.test(l));
  if (existing >= 0) return { line: existing, replace: true, text: `@connection ${name}` };
  let i = 0;
  while (i < lines.length && /^\s*(#(?!##)|\/\/)/.test(lines[i])) i++;
  const needsBlankBefore = i > 0;
  const nextIsBlank = i >= lines.length || lines[i].trim() === "";
  return {
    line: i,
    replace: false,
    text: `${needsBlankBefore ? "\n" : ""}@connection ${name}\n${nextIsBlank ? "" : "\n"}`,
  };
}

export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/\.nats$/i, "").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 60) || "playbook";
}
