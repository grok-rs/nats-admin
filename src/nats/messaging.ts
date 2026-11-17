// Pure helpers for the messaging panels (Live Tail, Publisher, Dead Letters):
// payload encoding, advisory parsing, exports and playbook snippets.
// No vscode imports — unit tested in test/messaging.test.ts.

import type { MessageDTO } from "../shared/dto";
import { base64ToBytes, hexToBytes, utf8DecodeStrict, utf8Encode } from "../shared/encoding";

export type PayloadEncoding = "text" | "json" | "base64" | "hex";

/** Encode the publisher's payload text according to the chosen encoding. */
export function encodePayload(text: string, encoding: PayloadEncoding): Uint8Array {
  switch (encoding) {
    case "text":
      return utf8Encode(text);
    case "json":
      try {
        JSON.parse(text);
      } catch (e) {
        throw new Error(`Payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
      return utf8Encode(text);
    case "base64":
      if (/[^A-Za-z0-9+/=\s_-]/.test(text)) throw new Error("Payload is not valid base64");
      try {
        return base64ToBytes(text.replace(/-/g, "+").replace(/_/g, "/"));
      } catch {
        throw new Error("Payload is not valid base64");
      }
    case "hex":
      return hexToBytes(text);
  }
}

// --- JetStream dead-letter advisories ----------------------------------------------

export const ADVISORY_SUBJECTS = ["$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>", "$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.>"] as const;

export interface DeadLetter {
  id: string;
  kind: "max_deliveries" | "terminated";
  stream: string;
  consumer: string;
  streamSeq: number;
  deliveries: number;
  reason?: string;
  timestamp: string;
  /** The advisory's raw JSON body. */
  raw: unknown;
}

let dlCounter = 0;

/** Parse a $JS.EVENT.ADVISORY.CONSUMER.(MAX_DELIVERIES|MSG_TERMINATED).<stream>.<consumer> advisory. */
export function parseAdvisory(subject: string, data: Uint8Array): DeadLetter | null {
  const m = /^\$JS\.EVENT\.ADVISORY\.CONSUMER\.(MAX_DELIVERIES|MSG_TERMINATED)\.([^.]+)\.(.+)$/.exec(subject);
  if (!m) return null;
  let body: Record<string, unknown> = {};
  const text = utf8DecodeStrict(data);
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* keep defaults from the subject */
    }
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
  return {
    id: typeof body.id === "string" && body.id ? body.id : `dl-${++dlCounter}`,
    kind: m[1] === "MAX_DELIVERIES" ? "max_deliveries" : "terminated",
    stream: typeof body.stream === "string" ? body.stream : m[2],
    consumer: typeof body.consumer === "string" ? body.consumer : m[3],
    streamSeq: num(body.stream_seq),
    deliveries: num(body.deliveries),
    reason: typeof body.reason === "string" && body.reason ? body.reason : undefined,
    timestamp: typeof body.timestamp === "string" ? body.timestamp : new Date().toISOString(),
    raw: body,
  };
}

/** Headers that must not be copied when re-injecting a stored message. */
const REPUBLISH_STRIP = /^(Nats-Msg-Id|Nats-Expected-.*|Nats-Rollup|Nats-TTL)$/i;

export function republishHeaders(headers: [string, string][], origin: string): [string, string][] {
  return [...headers.filter(([k]) => !REPUBLISH_STRIP.test(k)), ["Nats-Admin-Republished-From", origin]];
}

// --- exports ---------------------------------------------------------------------

/** Payload as text for exports: UTF-8 when possible, otherwise "base64:<data>". */
export function exportPayload(m: MessageDTO): string {
  const text = utf8DecodeStrict(base64ToBytes(m.data));
  return text !== null ? text : `base64:${m.data}`;
}

function csvField(v: string | number | undefined): string {
  const s = v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function messagesToCsv(msgs: MessageDTO[]): string {
  const head = ["time", "subject", "seq", "reply", "size", "headers", "payload"];
  const rows = msgs.map((m) =>
    [m.time, m.subject, m.seq, m.reply, m.size, m.headers.map(([k, v]) => `${k}: ${v}`).join("; "), exportPayload(m)].map(csvField).join(","),
  );
  return [head.join(","), ...rows].join("\r\n") + "\r\n";
}

export function messagesToJson(msgs: MessageDTO[]): string {
  return (
    JSON.stringify(
      msgs.map((m) => {
        const payload = exportPayload(m);
        let json: unknown;
        try {
          json = payload.startsWith("base64:") ? undefined : JSON.parse(payload);
        } catch {
          json = undefined;
        }
        return {
          time: m.time,
          subject: m.subject,
          ...(m.seq !== undefined ? { seq: m.seq } : {}),
          ...(m.reply ? { reply: m.reply } : {}),
          headers: Object.fromEntries(groupHeaders(m.headers)),
          size: m.size,
          payload: json !== undefined && typeof json === "object" ? json : payload,
        };
      }),
      null,
      2,
    ) + "\n"
  );
}

function groupHeaders(h: [string, string][]): [string, string | string[]][] {
  const map = new Map<string, string[]>();
  for (const [k, v] of h) map.set(k, [...(map.get(k) ?? []), v]);
  return [...map].map(([k, v]) => [k, v.length === 1 ? v[0] : v]);
}

// --- playbook / subjects -----------------------------------------------------------

export interface PlaybookBlockInput {
  verb: "PUB" | "REQ";
  subject: string;
  headers: [string, string][];
  body: string;
  name?: string;
  options?: Record<string, string | number | undefined>;
}

/** Render a block in the `.nats` playbook format (see src/shared/playbook.ts). */
export function toPlaybookBlock(b: PlaybookBlockInput): string {
  const opts = Object.entries(b.options ?? {})
    .filter(([, v]) => v !== undefined && v !== "" && v !== null)
    .map(([k, v]) => `${k}=${/\s/.test(String(v)) ? JSON.stringify(String(v)) : v}`)
    .join(" ");
  const lines = [`### ${b.name ?? `${b.verb === "PUB" ? "Publish to" : "Request"} ${b.subject}`}`, `${b.verb} ${b.subject}${opts ? ` ${opts}` : ""}`];
  const hs = b.headers.filter(([k]) => k.trim());
  for (const [k, v] of hs) lines.push(`${k.trim()}: ${v}`);
  if (b.body) {
    // A blank line separates headers from the body (always safe to include).
    lines.push("", b.body);
  }
  return lines.join("\n") + "\n";
}

/** Turn a stream subject pattern into a concrete example subject for publishing. */
export function exampleSubject(pattern: string): string {
  return pattern
    .split(".")
    .map((t) => (t === "*" ? "x" : t === ">" ? "new" : t))
    .join(".");
}

const SUB_COLORS = ["#4daafc", "#3fb950", "#d29922", "#db61a2", "#a371f7", "#f0883e", "#39c5cf", "#f85149"];

export function subscriptionColor(index: number): string {
  return SUB_COLORS[index % SUB_COLORS.length];
}

/** Parse "Key: value" lines (used by the reply editor). */
export function parseHeaderLines(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^:\s][^:]*?)\s*:\s?(.*)$/.exec(line);
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}
