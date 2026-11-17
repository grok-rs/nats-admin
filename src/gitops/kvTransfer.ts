// KV bucket export / import as a JSON object { "<key>": <value> }. No vscode imports.
//
// Value encoding (lossless):
//   JSON objects / arrays          → the parsed JSON (stored compact again on import; only
//                                    insignificant whitespace is normalised)
//   JSON numbers / booleans / null → the parsed value, when re-serialising gives the same text
//   other UTF-8 text               → a string (JSON string literals stay text, quotes included)
//   binary (not valid UTF-8)       → { "$base64": "..." }
// Anything that would not round-trip exactly (big integers, \u escapes, an object that looks
// like { "$base64": … }) is exported as a text string instead.

import { KvWatchInclude, type KV } from "@nats-io/kv";
import { base64ToBytes, bytesToBase64, utf8DecodeStrict, utf8Encode } from "../shared/encoding";
import { isPlainObject } from "./configFiles";

const KEY_RE = /^[-/=.\w]+$/;

export function validateKvKey(k: string): string | undefined {
  if (!k) return "empty key";
  if (k.startsWith(".") || k.endsWith(".") || k.includes("..")) return `invalid key "${k}" (empty token)`;
  if (!KEY_RE.test(k)) return `invalid key "${k}" (allowed: letters, digits, "-", "_", "/", "=", ".")`;
  return undefined;
}

/** JSON text with whitespace outside string literals removed. */
export function stripJsonWhitespace(text: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c !== " " && c !== "\n" && c !== "\r" && c !== "\t") {
      out += c;
    }
  }
  return out;
}

function isBase64Wrapper(v: unknown): v is { $base64: string } {
  return isPlainObject(v) && Object.keys(v).length === 1 && typeof v.$base64 === "string";
}

/** Encode a stored value for the export file. */
export function encodeKvValue(bytes: Uint8Array): unknown {
  if (bytes.length === 0) return "";
  const text = utf8DecodeStrict(bytes);
  if (text === null) return { $base64: bytesToBase64(bytes) };
  const t = text.trim();
  if (!t) return text;
  const first = t[0];
  // JSON string literals stay text so their quotes survive the round trip.
  if (first === '"') return text;
  if (first === "{" || first === "[" || /^(-?\d|true$|false$|null$)/.test(t)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text;
    }
    const compact = JSON.stringify(parsed);
    if (isBase64Wrapper(parsed)) return text;
    if (typeof parsed === "object" && parsed !== null) return compact === stripJsonWhitespace(text) ? parsed : text;
    return compact === text ? parsed : text;
  }
  return text;
}

/** Decode an export-file value back into bytes. */
export function decodeKvValue(v: unknown): Uint8Array {
  if (typeof v === "string") return utf8Encode(v);
  if (isBase64Wrapper(v)) return base64ToBytes(v.$base64);
  return utf8Encode(JSON.stringify(v));
}

export interface KvRecord {
  key: string;
  value: Uint8Array;
}

/** Sorted export object. */
export function buildKvExport(records: readonly KvRecord[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of [...records].sort((a, b) => a.key.localeCompare(b.key))) out[r.key] = encodeKvValue(r.value);
  return out;
}

export interface KvImportParse {
  records: KvRecord[];
  /** Keys that cannot be imported (invalid names). */
  invalid: string[];
}

/** Parse an export file (a flat JSON object). Throws on invalid JSON / wrong shape. */
export function parseKvImport(text: string): KvImportParse {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isPlainObject(json)) throw new Error('Expected a JSON object of { "key": value } pairs');
  const records: KvRecord[] = [];
  const invalid: string[] = [];
  for (const [key, v] of Object.entries(json)) {
    const err = validateKvKey(key);
    if (err) invalid.push(err);
    else records.push({ key, value: decodeKvValue(v) });
  }
  return { records, invalid };
}

/** Cancellation source (structurally compatible with vscode.CancellationToken). */
export interface CancelToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): unknown;
}

/** Latest value of every key (deleted keys excluded). */
export async function readAllEntries(
  kv: KV,
  opts: { max?: number; onProgress?: (n: number) => void; token?: CancelToken } = {},
): Promise<{ records: KvRecord[]; truncated: boolean; cancelled?: boolean }> {
  // values > 0 guarantees the unfiltered watch delivers at least one entry (with delta 0 last).
  const status = await kv.status();
  if (status.values === 0) return { records: [], truncated: false };
  if (opts.token?.isCancellationRequested) return { records: [], truncated: false, cancelled: true };
  const it = await kv.watch({ key: ">", include: KvWatchInclude.LastValue });
  // Stopping the watch ends the loop below, so a stalled watch never blocks forever.
  opts.token?.onCancellationRequested(() => it.stop());
  const map = new Map<string, Uint8Array>();
  let truncated = false;
  for await (const e of it) {
    if (opts.token?.isCancellationRequested) break;
    if (e.operation === "PUT") {
      if (opts.max === undefined || map.size < opts.max || map.has(e.key)) map.set(e.key, e.value);
      else truncated = true;
    } else {
      map.delete(e.key);
    }
    if (map.size % 200 === 0) opts.onProgress?.(map.size);
    if ((e.delta ?? 0) === 0) break;
  }
  it.stop();
  if (opts.token?.isCancellationRequested) return { records: [], truncated: false, cancelled: true };
  return { records: [...map].map(([key, value]) => ({ key, value })), truncated };
}

/** Current keys of a bucket (for "skip existing" previews). */
export async function existingKeys(kv: KV): Promise<Set<string>> {
  const out = new Set<string>();
  const status = await kv.status();
  if (status.values === 0) return out;
  for await (const k of await kv.keys()) out.add(k);
  return out;
}

export interface ImportResult {
  written: number;
  skipped: number;
  failed: { key: string; error: string }[];
}

/**
 * Write records. With `skipExisting`, keys are created with compare-and-set (`kv.create`), so
 * a key that appears concurrently is skipped, never overwritten.
 */
export async function importRecords(
  kv: KV,
  records: readonly KvRecord[],
  opts: { skipExisting: boolean; onProgress?: (done: number, total: number) => void; isCancelled?: () => boolean },
): Promise<ImportResult> {
  const res: ImportResult = { written: 0, skipped: 0, failed: [] };
  let done = 0;
  for (const r of records) {
    if (opts.isCancelled?.()) break;
    try {
      if (opts.skipExisting) await kv.create(r.key, r.value);
      else await kv.put(r.key, r.value);
      res.written++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (opts.skipExisting && /wrong last sequence|exists|10071/i.test(msg)) res.skipped++;
      else res.failed.push({ key: r.key, error: msg });
    }
    done++;
    opts.onProgress?.(done, records.length);
  }
  return res;
}
