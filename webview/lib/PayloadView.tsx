// Multi-format payload viewer: structure tree, pretty JSON, text, hex dump,
// base64, MessagePack, schema-less Protobuf, plus gzip inflation.

import { useEffect, useMemo, useState } from "preact/hooks";
import { base64ToBytes } from "../../src/shared/encoding";
import { detect, render, type ViewMode } from "../../src/shared/payload";
import { fmtBytes } from "../../src/shared/format";
import { JsonTree } from "./JsonTree";
import { Badge, CopyButton, cx, Icon } from "./ui";

export type PayloadMode = ViewMode | "tree";

const MODES: { id: PayloadMode; label: string; title: string }[] = [
  { id: "tree", label: "Tree", title: "Collapsible JSON structure" },
  { id: "auto", label: "Auto", title: "Pretty JSON, text, or hex dump depending on content" },
  { id: "text", label: "Text", title: "Raw UTF-8 text" },
  { id: "hex", label: "Hex", title: "Hex dump" },
  { id: "base64", label: "Base64", title: "Base64-encoded bytes" },
  { id: "msgpack", label: "MsgPack", title: "Decode as MessagePack" },
  { id: "protobuf", label: "Protobuf", title: "Schema-less protobuf wire decode" },
];

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export function PayloadView({
  data,
  headers,
  initialMode,
  maxHeight,
  showHeaders = true,
  toolbarExtra,
}: {
  data: string;
  headers?: [string, string][];
  initialMode?: PayloadMode;
  maxHeight?: string;
  showHeaders?: boolean;
  toolbarExtra?: preact.ComponentChildren;
}) {
  const raw = useMemo(() => base64ToBytes(data), [data]);
  const [inflated, setInflated] = useState<Uint8Array | null>(null);
  const [inflateErr, setInflateErr] = useState<string | null>(null);
  const bytes = inflated ?? raw;
  const det = useMemo(() => detect(bytes), [bytes]);
  const [mode, setMode] = useState<PayloadMode>(initialMode ?? "auto");

  // Default to the structure tree for JSON objects/arrays the first time.
  useEffect(() => {
    if (!initialMode) setMode(det.format === "json" && (det.kind === "object" || det.kind === "array") ? "tree" : "auto");
    setInflated(null);
    setInflateErr(null);
  }, [data]);

  const rendered = useMemo((): { text?: string; error?: string } => {
    if (mode === "tree") return {};
    try {
      return { text: render(bytes, mode).text };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [bytes, mode]);

  const treeAvailable = det.format === "json";
  const effectiveMode = mode === "tree" && !treeAvailable ? "auto" : mode;
  const text = effectiveMode === "tree" ? JSON.stringify(det.json, null, 2) : (rendered.text ?? "");

  return (
    <div class="payload">
      <div class="payload-toolbar">
        <div class="seg">
          {MODES.map((m) => (
            <button
              type="button"
              key={m.id}
              class={cx("seg-btn", effectiveMode === m.id && "seg-active")}
              disabled={m.id === "tree" && !treeAvailable}
              title={m.title}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <Badge tone={det.format === "binary" ? "warn" : det.format === "json" ? "accent" : "neutral"}>{det.kind}</Badge>
        <span class="muted small">{fmtBytes(raw.length)}</span>
        {det.gzip && !inflated && (
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            title="Payload is gzip-compressed — inflate it"
            onClick={() =>
              void gunzip(raw)
                .then(setInflated)
                .catch((e) => setInflateErr(String(e)))
            }
          >
            <Icon name="unfold" /> <span>gunzip</span>
          </button>
        )}
        {inflated && <Badge tone="info">inflated {fmtBytes(inflated.length)}</Badge>}
        <div class="spacer" />
        {toolbarExtra}
        <CopyButton text={() => text} title="Copy as shown" />
      </div>
      {inflateErr && <div class="banner banner-error">{inflateErr}</div>}
      {showHeaders && headers && headers.length > 0 && (
        <table class="kv-table headers-table">
          <tbody>
            {headers.map(([k, v], i) => (
              <tr key={i}>
                <th>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div class="payload-body" style={maxHeight ? { maxHeight } : undefined}>
        {raw.length === 0 ? (
          <div class="muted payload-empty">(empty payload)</div>
        ) : effectiveMode === "tree" ? (
          <JsonTree value={det.json} />
        ) : rendered.error ? (
          <div class="banner banner-warn">
            <Icon name="warning" /> {rendered.error}
          </div>
        ) : (
          <pre class={cx("code", effectiveMode === "auto" && det.format === "json" && "code-json")}>{text}</pre>
        )}
      </div>
    </div>
  );
}

/** One-line preview of a payload for tables. */
export function payloadPreview(b64: string, max = 160): string {
  const bytes = base64ToBytes(b64);
  if (bytes.length === 0) return "";
  const d = detect(bytes);
  if (d.format === "json") return JSON.stringify(d.json).slice(0, max);
  if (d.format === "text") return (d.text ?? "").replace(/\s+/g, " ").slice(0, max);
  return `‹binary ${fmtBytes(bytes.length)}›`;
}
