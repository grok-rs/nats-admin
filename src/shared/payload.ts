// Payload inspection: format detection plus decoders for the views offered by
// the message/KV viewers (JSON, text, hex dump, base64, MessagePack and a
// schema-less Protobuf wire decoder).

import { decode as msgpackDecode } from "@msgpack/msgpack";
import { bytesToBase64, utf8DecodeStrict } from "./encoding";

export type PayloadFormat = "empty" | "json" | "text" | "binary";
export type ViewMode = "auto" | "json" | "text" | "hex" | "base64" | "msgpack" | "protobuf";

export interface Detection {
  format: PayloadFormat;
  /** Parsed JSON value when format === "json". */
  json?: unknown;
  /** Decoded text when the payload is valid UTF-8. */
  text?: string;
  /** True when the payload starts with the gzip magic bytes. */
  gzip: boolean;
  /** Short type label for UI badges: object, array, string, number, text, binary… */
  kind: string;
}

const PRINTABLE_RATIO = 0.9;

function isMostlyPrintable(s: string): boolean {
  if (s.length === 0) return true;
  let printable = 0;
  const n = Math.min(s.length, 4096);
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127 && c !== 0xfffd)) printable++;
  }
  return printable / n >= PRINTABLE_RATIO;
}

export function jsonKind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

export function detect(bytes: Uint8Array): Detection {
  const gzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (bytes.length === 0) return { format: "empty", gzip: false, kind: "empty" };
  const text = utf8DecodeStrict(bytes);
  if (text === null || !isMostlyPrintable(text)) return { format: "binary", gzip, kind: gzip ? "gzip" : "binary" };
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    const first = trimmed[0];
    // Only treat structured values or scalars that round-trip as JSON; a bare
    // word such as `hello` is text, a number like `5432` is still JSON.
    if (first === "{" || first === "[" || first === '"' || /^-?\d/.test(trimmed) || /^(true|false|null)$/.test(trimmed)) {
      try {
        const json = JSON.parse(trimmed);
        return { format: "json", json, text, gzip: false, kind: jsonKind(json) };
      } catch {
        /* not JSON */
      }
    }
  }
  return { format: "text", text, gzip: false, kind: "text" };
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** True when the text spans multiple lines (i.e. is already formatted). */
export function looksPretty(text: string): boolean {
  return /\n\s/.test(text.trim());
}

export function hexdump(bytes: Uint8Array, limit = 64 * 1024): string {
  const lines: string[] = [];
  const n = Math.min(bytes.length, limit);
  for (let off = 0; off < n; off += 16) {
    const row = bytes.subarray(off, Math.min(off + 16, n));
    let hex = "";
    let ascii = "";
    for (let i = 0; i < 16; i++) {
      if (i < row.length) {
        hex += row[i].toString(16).padStart(2, "0") + " ";
        ascii += row[i] >= 0x20 && row[i] < 0x7f ? String.fromCharCode(row[i]) : ".";
      } else {
        hex += "   ";
      }
      if (i === 7) hex += " ";
    }
    lines.push(`${off.toString(16).padStart(8, "0")}  ${hex} |${ascii}|`);
  }
  if (bytes.length > n) lines.push(`… ${bytes.length - n} more bytes`);
  return lines.join("\n");
}

/** Convert values produced by the msgpack decoder into JSON-friendly data. */
function toJsonFriendly(v: unknown): unknown {
  if (v instanceof Uint8Array) return { $binary: bytesToBase64(v) };
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Map) {
    const o: Record<string, unknown> = {};
    for (const [k, val] of v) o[String(k)] = toJsonFriendly(val);
    return o;
  }
  if (Array.isArray(v)) return v.map(toJsonFriendly);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) o[k] = toJsonFriendly(val);
    return o;
  }
  return v;
}

export function decodeMsgpack(bytes: Uint8Array): unknown {
  return toJsonFriendly(msgpackDecode(bytes, { useBigInt64: true }));
}

// --- schema-less protobuf -------------------------------------------------

export interface ProtoField {
  field: number;
  wire: "varint" | "i64" | "len" | "i32";
  value: string | number | ProtoField[];
  /** For len fields: how the bytes were interpreted. */
  as?: "message" | "string" | "bytes";
}

function readVarint(b: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (pos >= b.length) throw new Error("truncated varint");
    const byte = b[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
  throw new Error("varint too long");
}

function parseProto(b: Uint8Array, depth: number): ProtoField[] {
  const fields: ProtoField[] = [];
  let pos = 0;
  while (pos < b.length) {
    const [tag, p1] = readVarint(b, pos);
    pos = p1;
    const field = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (field <= 0) throw new Error("invalid field number");
    switch (wt) {
      case 0: {
        const [v, p] = readVarint(b, pos);
        pos = p;
        fields.push({ field, wire: "varint", value: v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString() });
        break;
      }
      case 1: {
        if (pos + 8 > b.length) throw new Error("truncated fixed64");
        const dv = new DataView(b.buffer, b.byteOffset + pos, 8);
        const asInt = dv.getBigUint64(0, true);
        const asDouble = dv.getFloat64(0, true);
        pos += 8;
        const plausibleDouble = Number.isFinite(asDouble) && Math.abs(asDouble) > 1e-9 && Math.abs(asDouble) < 1e15;
        fields.push({ field, wire: "i64", value: plausibleDouble ? asDouble : asInt.toString() });
        break;
      }
      case 2: {
        const [lenBig, p] = readVarint(b, pos);
        pos = p;
        const len = Number(lenBig);
        if (pos + len > b.length) throw new Error("truncated length-delimited field");
        const sub = b.subarray(pos, pos + len);
        pos += len;
        let decoded: ProtoField | undefined;
        if (depth < 8 && len > 0) {
          try {
            const nested = parseProto(sub, depth + 1);
            if (nested.length > 0) decoded = { field, wire: "len", value: nested, as: "message" };
          } catch {
            /* not a nested message */
          }
        }
        if (!decoded) {
          const s = utf8DecodeStrict(sub);
          decoded =
            s !== null && isMostlyPrintable(s)
              ? { field, wire: "len", value: s, as: "string" }
              : { field, wire: "len", value: bytesToBase64(sub), as: "bytes" };
        }
        fields.push(decoded);
        break;
      }
      case 5: {
        if (pos + 4 > b.length) throw new Error("truncated fixed32");
        const dv = new DataView(b.buffer, b.byteOffset + pos, 4);
        pos += 4;
        const f = dv.getFloat32(0, true);
        fields.push({ field, wire: "i32", value: Number.isFinite(f) && Math.abs(f) > 1e-6 && Math.abs(f) < 1e9 ? f : dv.getUint32(0, true) });
        break;
      }
      default:
        throw new Error(`unsupported wire type ${wt}`);
    }
  }
  return fields;
}

/** Decode protobuf wire format without a schema. Throws if the bytes are not protobuf-shaped. */
export function decodeProtobuf(bytes: Uint8Array): ProtoField[] {
  if (bytes.length === 0) return [];
  return parseProto(bytes, 0);
}

/** Render decoded protobuf fields as an indented, human readable tree. */
export function formatProtobuf(fields: ProtoField[], indent = ""): string {
  return fields
    .map((f) => {
      const head = `${indent}${f.field} (${f.wire}${f.as && f.as !== "message" ? `:${f.as}` : ""})`;
      if (Array.isArray(f.value)) return `${head} {\n${formatProtobuf(f.value, indent + "  ")}\n${indent}}`;
      return `${head}: ${typeof f.value === "string" && f.as === "string" ? JSON.stringify(f.value) : f.value}`;
    })
    .join("\n");
}

/** Render bytes for a given view mode. Throws with a readable message when the mode doesn't fit. */
export function render(bytes: Uint8Array, mode: ViewMode): { text: string; language: "json" | "text" } {
  switch (mode) {
    case "auto": {
      const d = detect(bytes);
      if (d.format === "json") return { text: prettyJson(d.json), language: "json" };
      if (d.format === "text") return { text: d.text ?? "", language: "text" };
      if (d.format === "empty") return { text: "", language: "text" };
      return { text: hexdump(bytes), language: "text" };
    }
    case "json": {
      const d = detect(bytes);
      if (d.format !== "json") throw new Error("Payload is not valid JSON");
      return { text: prettyJson(d.json), language: "json" };
    }
    case "text": {
      const s = utf8DecodeStrict(bytes);
      return { text: s ?? new TextDecoder().decode(bytes), language: "text" };
    }
    case "hex":
      return { text: hexdump(bytes), language: "text" };
    case "base64":
      return { text: bytesToBase64(bytes), language: "text" };
    case "msgpack":
      return { text: prettyJson(decodeMsgpack(bytes)), language: "json" };
    case "protobuf":
      return { text: formatProtobuf(decodeProtobuf(bytes)), language: "text" };
  }
}
