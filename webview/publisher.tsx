import "./lib/styles.css";
import "./messaging.css";
import { Fragment, render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { getInit, onEvent, rpc } from "./lib/vscode";
import { Badge, Button, Empty, ErrorBanner, Field, Flash, fmtClock, Icon, Notice, Section, Select, SplitPane, useAsync, useFlash } from "./lib/ui";
import { PayloadView } from "./lib/PayloadView";
import type { MessageDTO } from "../src/shared/dto";
import { renderTemplate, hasTemplate } from "../src/shared/template";
import { fmtBytes, fmtMillis } from "../src/shared/format";

type Mode = "publish" | "request";
type Encoding = "text" | "json" | "base64" | "hex";

interface Prefill {
  subject?: string;
  mode?: Mode;
  payload?: string;
  payloadEncoding?: Encoding;
  headers?: [string, string][];
  jetstream?: boolean;
}

interface Init {
  connectionName: string;
  defaultTimeout: number;
  templateHelp: [string, string][];
  prefill: Prefill | null;
}

interface Form {
  subject: string;
  reply: string;
  headers: [string, string][];
  payload: string;
  encoding: Encoding;
  count: number;
  intervalMs: number;
  jetstream: boolean;
  timeoutMs: number;
}

interface PublishResult {
  sent: number;
  bytes: number;
  durationMs: number;
  cancelled?: boolean;
  acks?: { stream: string; seq: number; duplicate: boolean; domain?: string }[];
  firstSubject: string;
}

interface RequestResult {
  reply: MessageDTO;
  latencyMs: number;
  requestBytes: number;
}

type Result = { kind: "publish"; r: PublishResult } | { kind: "request"; r: RequestResult };

interface Recent {
  mode: Mode;
  form: Form;
  at: string;
  ok: boolean;
}

const init = getInit<Init>();

function emptyForm(): Form {
  return { subject: "", reply: "", headers: [], payload: "", encoding: "text", count: 1, intervalMs: 0, jetstream: false, timeoutMs: init.defaultTimeout };
}

function applyPrefill(form: Form, p: Prefill): Form {
  return {
    ...form,
    subject: p.subject ?? form.subject,
    payload: p.payload ?? form.payload,
    encoding: p.payloadEncoding ?? (p.payload !== undefined ? guessEncoding(p.payload) : form.encoding),
    headers: p.headers ? p.headers.map(([k, v]) => [k, v] as [string, string]) : form.headers,
    jetstream: p.jetstream ?? form.jetstream,
  };
}

function guessEncoding(text: string): Encoding {
  const t = text.trim();
  if (/^[[{]/.test(t)) {
    try {
      JSON.parse(t);
      return "json";
    } catch {
      /* text */
    }
  }
  return "text";
}

function jsonStatus(form: Form): { ok: boolean; text: string } | null {
  if (form.encoding !== "json" && !(form.encoding === "text" && /^\s*[[{]/.test(form.payload))) return null;
  if (!form.payload.trim()) return null;
  const rendered = hasTemplate(form.payload) ? renderTemplate(form.payload, { seq: 1 }) : form.payload;
  try {
    JSON.parse(rendered);
    return { ok: true, text: hasTemplate(form.payload) ? "valid JSON (after templates)" : "valid JSON" };
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : String(e) };
  }
}

function App() {
  const [mode, setMode] = useState<Mode>(init.prefill?.mode ?? "publish");
  const [form, setForm] = useState<Form>(() => (init.prefill ? applyPrefill(emptyForm(), init.prefill) : emptyForm()));
  const [showHelp, setShowHelp] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [connState, setConnState] = useState("connected");
  const { busy, error, setError, run } = useAsync();
  const [flash, setFlash] = useFlash();

  useEffect(() => {
    const offs = [
      onEvent<Prefill>("prefill", (p) => {
        if (p.mode) setMode(p.mode);
        setForm((f) => applyPrefill(f, p));
        setResult(null);
      }),
      onEvent<{ sent: number; total: number }>("progress", setProgress),
      onEvent<{ state: string }>("connection", (c) => setConnState(c.state)),
    ];
    return () => offs.forEach((o) => o());
  }, []);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const status = useMemo(() => jsonStatus(form), [form.payload, form.encoding]);
  const subjectHasWildcard = /(^|\.)(\*|>)(\.|$)/.test(form.subject.trim());

  const send = () =>
    void run(async () => {
      setResult(null);
      setProgress(null);
      const payload = { ...form, subject: form.subject.trim(), count: mode === "publish" ? form.count : 1 };
      const snapshot: Recent = { mode, form: { ...form, headers: form.headers.map((h) => [...h] as [string, string]) }, at: new Date().toISOString(), ok: false };
      try {
        if (mode === "publish") {
          const r = await rpc<PublishResult>("publish", payload);
          setResult({ kind: "publish", r });
        } else {
          const r = await rpc<RequestResult>("request", payload);
          setResult({ kind: "request", r });
        }
        snapshot.ok = true;
      } finally {
        setProgress(null);
        setRecent((prev) => [snapshot, ...prev.filter((x) => !(x.mode === snapshot.mode && x.form.subject === snapshot.form.subject && x.form.payload === snapshot.form.payload))].slice(0, 25));
      }
    });

  const formatJson = () => {
    try {
      set("payload", JSON.stringify(JSON.parse(form.payload), null, 2));
      setError(null);
    } catch (e) {
      setError(hasTemplate(form.payload) ? "Cannot format: payload contains {{templates}} inside JSON values that aren't valid JSON yet." : `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const disconnected = connState !== "connected" && connState !== "reconnecting";

  return (
    <>
      <header class="page-header">
        <div class="title">
          <Icon name={mode === "publish" ? "send" : "arrow-swap"} />
          <h2>{mode === "publish" ? "Publish" : "Request / Reply"}</h2>
          <span class="muted">{init.connectionName}</span>
        </div>
        <div class="seg" role="tablist" aria-label="Mode">
          <button type="button" class={`seg-btn ${mode === "publish" ? "seg-active" : ""}`} onClick={() => (setMode("publish"), setResult(null), setError(null))}>
            Publish
          </button>
          <button type="button" class={`seg-btn ${mode === "request" ? "seg-active" : ""}`} onClick={() => (setMode("request"), setResult(null), setError(null))}>
            Request
          </button>
        </div>
        <div class="spacer" />
        {disconnected && <Badge tone="danger">{connState}</Badge>}
      </header>
      <SplitPane initial={55} storageKey="publisher">
        <div
          class="form"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") (e.preventDefault(), send());
          }}
        >
          <Field label="Subject" hint={subjectHasWildcard ? <span class="json-status bad">Wildcards can't be published to — use a concrete subject.</span> : "Templates like {{uuid}} work here too."}>
            <input class={`input mono ${subjectHasWildcard ? "invalid" : ""}`} value={form.subject} placeholder="orders.eu.created" onInput={(e) => set("subject", (e.target as HTMLInputElement).value)} />
          </Field>
          {mode === "publish" && (
            <Field label="Reply-to (optional)">
              <input class="input mono" value={form.reply} placeholder="_INBOX.my-replies" onInput={(e) => set("reply", (e.target as HTMLInputElement).value)} />
            </Field>
          )}
          <div class="field">
            <span class="field-label row">
              Headers
              <Button variant="ghost" small icon="add" title="Add header" onClick={() => set("headers", [...form.headers, ["", ""]])} />
              <Button variant="ghost" small title="Add Nats-Msg-Id header (deduplication)" onClick={() => set("headers", [...form.headers, ["Nats-Msg-Id", "{{uuid}}"]])}>
                + Nats-Msg-Id
              </Button>
            </span>
            {form.headers.map(([k, v], i) => (
              <div class="header-row" key={i}>
                <input class="input input-sm mono" placeholder="Name" value={k} onInput={(e) => set("headers", form.headers.map((h, j) => (j === i ? [(e.target as HTMLInputElement).value, h[1]] : h)))} />
                <input class="input input-sm mono" placeholder="Value" value={v} onInput={(e) => set("headers", form.headers.map((h, j) => (j === i ? [h[0], (e.target as HTMLInputElement).value] : h)))} />
                <Button variant="ghost" small icon="trash" title="Remove header" onClick={() => set("headers", form.headers.filter((_, j) => j !== i))} />
              </div>
            ))}
          </div>
          <div class="field grow" style={{ display: "flex" }}>
            <span class="field-label row wrap">
              Payload
              <Select<Encoding>
                value={form.encoding}
                onChange={(v) => set("encoding", v)}
                options={[
                  { value: "text", label: "Text (UTF-8)" },
                  { value: "json", label: "JSON" },
                  { value: "base64", label: "Base64" },
                  { value: "hex", label: "Hex" },
                ]}
                class="input-sm"
                title="How the payload text is turned into bytes"
              />
              <Button variant="ghost" small icon="symbol-structure" title="Pretty-print JSON" onClick={formatJson}>
                Format
              </Button>
              <Button variant="ghost" small icon="question" title="Template variables" onClick={() => setShowHelp(!showHelp)}>
                Templates
              </Button>
              {status && <span class={`json-status ${status.ok ? "ok" : "bad"}`}>{status.text}</span>}
            </span>
            {showHelp && (
              <div class="template-help">
                {init.templateHelp.map(([t, d]) => (
                  <Fragment key={t}>
                    <code title="Insert" onClick={() => set("payload", form.payload + t)}>
                      {t}
                    </code>
                    <span class="muted">{d}</span>
                  </Fragment>
                ))}
              </div>
            )}
            <textarea
              class="input payload-input"
              spellcheck={false}
              placeholder={form.encoding === "base64" ? "aGVsbG8=" : form.encoding === "hex" ? "68 65 6c 6c 6f" : '{"id": {{seq}}, "at": "{{timestamp}}"}'}
              value={form.payload}
              onInput={(e) => set("payload", (e.target as HTMLTextAreaElement).value)}
            />
          </div>
          <div class="opts">
            {mode === "publish" ? (
              <>
                <Field label="Count">
                  <input class="input" type="number" min={1} value={form.count} onInput={(e) => set("count", Math.max(1, Number((e.target as HTMLInputElement).value) || 1))} />
                </Field>
                <Field label="Interval (ms)">
                  <input class="input" type="number" min={0} value={form.intervalMs} onInput={(e) => set("intervalMs", Math.max(0, Number((e.target as HTMLInputElement).value) || 0))} />
                </Field>
                <label class="check" title="Publish through JetStream and wait for the stream's acknowledgement">
                  <input type="checkbox" checked={form.jetstream} onChange={(e) => set("jetstream", (e.target as HTMLInputElement).checked)} />
                  JetStream publish (wait for PubAck)
                </label>
              </>
            ) : (
              <Field label="Timeout (ms)">
                <input class="input" type="number" min={50} value={form.timeoutMs} onInput={(e) => set("timeoutMs", Math.max(50, Number((e.target as HTMLInputElement).value) || init.defaultTimeout))} />
              </Field>
            )}
          </div>
          <div class="row wrap">
            <Button variant="primary" icon={mode === "publish" ? "send" : "arrow-swap"} busy={busy} disabled={!form.subject.trim() || subjectHasWildcard || disconnected} onClick={send} title="Ctrl+Enter">
              {mode === "publish" ? (form.count > 1 ? `Publish ×${form.count}` : "Publish") : "Send request"}
            </Button>
            {busy && progress && (
              <Button icon="debug-stop" onClick={() => void rpc("cancel")}>
                Stop ({progress.sent}/{progress.total})
              </Button>
            )}
            <Button
              icon="notebook"
              title="Copy this message as a .nats playbook block"
              onClick={() =>
                void run(async () => {
                  await rpc("copyPlaybook", { mode, form });
                  setFlash("Playbook block copied");
                })
              }
            >
              Copy as playbook
            </Button>
            <Button
              variant="ghost"
              icon="discard"
              onClick={() => {
                setForm(emptyForm());
                setResult(null);
              }}
            >
              Reset
            </Button>
            <Flash message={flash} />
          </div>
          <ErrorBanner error={error} onDismiss={() => setError(null)} />
        </div>
        <div class="result">
          {result ? <ResultView result={result} /> : <Empty icon={mode === "publish" ? "send" : "arrow-swap"} title={mode === "publish" ? "Nothing sent yet" : "No reply yet"}>Fill in a subject and press <kbd>Ctrl</kbd>+<kbd>Enter</kbd>.</Empty>}
          {recent.length > 0 && (
            <Section title="Recent" actions={<Button variant="ghost" small icon="clear-all" title="Clear history" onClick={() => setRecent([])} />}>
              {recent.map((r, i) => (
                <div
                  class="recent-item"
                  key={i}
                  title="Restore this message into the form"
                  onClick={() => {
                    setMode(r.mode);
                    setForm(r.form);
                  }}
                >
                  <Icon name={r.mode === "publish" ? "send" : "arrow-swap"} />
                  <span class="mono ellipsis grow">{r.form.subject}</span>
                  {!r.ok && <Icon name="error" class="danger" />}
                  {r.mode === "publish" && r.form.count > 1 && <Badge>×{r.form.count}</Badge>}
                  <span class="muted small">{fmtClock(r.at).slice(0, 8)}</span>
                </div>
              ))}
            </Section>
          )}
        </div>
      </SplitPane>
    </>
  );
}

function ResultView({ result }: { result: Result }) {
  if (result.kind === "publish") {
    const r = result.r;
    return (
      <Section title="Published">
        <Notice tone={r.cancelled ? "warn" : "ok"}>
          {r.cancelled ? "Stopped after " : "Sent "}
          {r.sent.toLocaleString()} message{r.sent === 1 ? "" : "s"} ({fmtBytes(r.bytes)}) to <span class="mono">{r.firstSubject}</span>
          {r.sent > 1 ? "…" : ""} in {fmtMillis(r.durationMs)}
        </Notice>
        {r.acks && r.acks.length > 0 && (
          <table class="kv-table">
            <tbody>
              {r.acks.map((a, i) => (
                <tr key={i}>
                  <th>{r.acks!.length > 1 ? (i === 0 ? "First ack" : "Last ack") : "PubAck"}</th>
                  <td>
                    stream {a.stream} · seq {a.seq}
                    {a.domain ? ` · domain ${a.domain}` : ""} {a.duplicate && <Badge tone="warn">duplicate (deduplicated)</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    );
  }
  const { reply, latencyMs, requestBytes } = result.r;
  return (
    <Section
      title={
        <span class="row">
          Reply <Badge tone="ok">{fmtMillis(latencyMs)}</Badge>
          {reply.status && <Badge tone="warn">{reply.status}</Badge>}
        </span>
      }
      class="grow"
    >
      <table class="kv-table">
        <tbody>
          <tr>
            <th>Subject</th>
            <td>{reply.subject}</td>
          </tr>
          <tr>
            <th>Sizes</th>
            <td>
              request {fmtBytes(requestBytes)} → reply {fmtBytes(reply.size)}
            </td>
          </tr>
        </tbody>
      </table>
      <PayloadView data={reply.data} headers={reply.headers} />
    </Section>
  );
}

render(<App />, document.getElementById("root")!);
