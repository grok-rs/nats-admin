// Serialize message pages for export (JSON / CSV) and single-message JSON docs.
// Pure module — no vscode imports.

import type { MessageDTO } from "../shared/dto";
import { base64ToBytes } from "../shared/encoding";
import { detect } from "../shared/payload";

/** Payload as JSON value when JSON, text when UTF-8, else `{ base64 }`. */
export function exportPayload(m: MessageDTO): { payload: unknown; encoding: "json" | "text" | "base64" } {
  const bytes = base64ToBytes(m.data);
  const d = detect(bytes);
  if (d.format === "json") return { payload: d.json, encoding: "json" };
  if (d.format === "text" || d.format === "empty") return { payload: d.text ?? "", encoding: "text" };
  return { payload: m.data, encoding: "base64" };
}

function headersObject(h: [string, string][]): Record<string, string | string[]> | undefined {
  if (!h.length) return undefined;
  const o: Record<string, string | string[]> = {};
  for (const [k, v] of h) {
    const cur = o[k];
    o[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  return o;
}

export function messageRecord(m: MessageDTO): Record<string, unknown> {
  const { payload, encoding } = exportPayload(m);
  return {
    seq: m.seq,
    subject: m.subject,
    time: m.time,
    size: m.size,
    headers: headersObject(m.headers),
    encoding,
    payload,
  };
}

export function messagesToJson(stream: string, messages: MessageDTO[]): string {
  return JSON.stringify({ stream, exportedAt: new Date().toISOString(), count: messages.length, messages: messages.map(messageRecord) }, null, 2) + "\n";
}

function csvField(v: unknown): string {
  const s = v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function messagesToCsv(messages: MessageDTO[]): string {
  const rows = [["seq", "time", "subject", "size", "headers", "encoding", "payload"].join(",")];
  for (const m of messages) {
    const { payload, encoding } = exportPayload(m);
    const hdrs = headersObject(m.headers);
    rows.push(
      [m.seq ?? "", m.time, m.subject, m.size, hdrs ? JSON.stringify(hdrs) : "", encoding, encoding === "json" ? JSON.stringify(payload) : payload]
        .map(csvField)
        .join(","),
    );
  }
  return rows.join("\r\n") + "\r\n";
}

export function messageToJsonDoc(stream: string, m: MessageDTO): string {
  return JSON.stringify({ stream, ...messageRecord(m) }, null, 2) + "\n";
}
