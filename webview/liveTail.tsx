import "./lib/styles.css";
import "./messaging.css";
import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { getInit, onEvent, rpc } from "./lib/vscode";
import { Badge, Button, CopyButton, Empty, ErrorBanner, Flash, fmtClock, fmtTime, Icon, SplitPane, useAsync, useFlash } from "./lib/ui";
import { PayloadView, payloadPreview } from "./lib/PayloadView";
import type { MessageDTO } from "../src/shared/dto";
import { bytesToBase64, utf8Encode } from "../src/shared/encoding";
import { fmtBytes } from "../src/shared/format";
import { parseHeaderLines } from "../src/nats/messaging";

interface SubInfo {
  id: string;
  subject: string;
  queue?: string;
  color: string;
  count: number;
  error?: string;
  active: boolean;
}

interface Stats {
  rate: number;
  total: number;
  paused: boolean;
  pausedCount: number;
}

interface Init {
  connectionName: string;
  maxMessages: number;
}

const init = getInit<Init>();
const RENDER_LIMIT = 500;

function App() {
  const [subs, setSubs] = useState<SubInfo[]>([]);
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [stats, setStats] = useState<Stats>({ rate: 0, total: 0, paused: false, pausedCount: 0 });
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connState, setConnState] = useState("connected");
  const [subject, setSubject] = useState("");
  const [queue, setQueue] = useState("");
  const [showQueue, setShowQueue] = useState(false);
  const previews = useRef(new Map<string, string>());
  const { busy, error, setError, run } = useAsync();
  const [flash, setFlash] = useFlash();

  useEffect(() => {
    const offs = [
      onEvent<MessageDTO[]>("messages", (batch) => {
        for (const m of batch) previews.current.set(m.id, payloadPreview(m.data, 200));
        setMessages((prev) => {
          const next = [...batch.reverse(), ...prev];
          if (next.length > init.maxMessages) {
            for (const dropped of next.slice(init.maxMessages)) previews.current.delete(dropped.id);
            next.length = init.maxMessages;
          }
          return next;
        });
      }),
      onEvent<SubInfo[]>("subs", setSubs),
      onEvent<Stats>("stats", setStats),
      onEvent<{ state: string }>("connection", (c) => setConnState(c.state)),
    ];
    void rpc<{ subs: SubInfo[]; stats: Stats }>("ready").then((r) => {
      setSubs(r.subs);
      setStats(r.stats);
    });
    return () => offs.forEach((o) => o());
  }, []);

  const subById = useMemo(() => new Map(subs.map((s) => [s.id, s])), [subs]);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return messages;
    return messages.filter((m) => m.subject.toLowerCase().includes(f) || (previews.current.get(m.id) ?? "").toLowerCase().includes(f));
  }, [messages, filter]);

  const selected = useMemo(() => messages.find((m) => m.id === selectedId) ?? null, [messages, selectedId]);

  const subscribe = () =>
    void run(async () => {
      const r = await rpc<SubInfo[]>("subscribe", { subject: subject.trim() || ">", queue: queue.trim() || undefined });
      setSubs(r);
      setSubject("");
      setQueue("");
    });

  const exportAs = (format: "json" | "csv") =>
    void run(async () => {
      const path = await rpc<string | null>("export", { format, messages: [...filtered].reverse() });
      if (path) setFlash(`Exported ${filtered.length} messages`);
    });

  const moveSelection = (delta: number) => {
    const shown = filtered.slice(0, RENDER_LIMIT);
    if (!shown.length) return;
    const idx = shown.findIndex((m) => m.id === selectedId);
    const next = shown[Math.max(0, Math.min(shown.length - 1, idx < 0 ? 0 : idx + delta))];
    setSelectedId(next.id);
    document.getElementById(`row-${next.id}`)?.scrollIntoView({ block: "nearest" });
  };

  const disconnected = connState !== "connected" && connState !== "reconnecting";

  return (
    <>
      <header class="page-header">
        <div class="title">
          <Icon name="radio-tower" />
          <h2>Live Tail</h2>
          <span class="muted">{init.connectionName}</span>
        </div>
        <span class="row small" title={`Connection ${connState}`}>
          <span class={`dot ${connState === "connected" ? "dot-ok" : connState === "reconnecting" ? "dot-warn dot-pulse" : "dot-danger"}`} />
          <span class="muted">{connState}</span>
        </span>
        <div class="spacer" />
        <span class="muted small rate" title="Messages received per second">
          <Icon name="pulse" /> {stats.rate} msg/s
        </span>
        <span class="muted small">{stats.total.toLocaleString()} received</span>
        {stats.paused && (
          <Badge tone="warn" title="Messages keep arriving and are buffered while paused">
            paused · {stats.pausedCount} buffered
          </Badge>
        )}
      </header>

      <div class="toolbar">
        <input
          class="input mono sub-input"
          placeholder="Subject, e.g. orders.> (Enter to subscribe)"
          value={subject}
          onInput={(e) => setSubject((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === "Enter" && subscribe()}
          aria-label="Subject to subscribe to"
        />
        {showQueue && (
          <input
            class="input mono queue-input"
            placeholder="queue group (optional)"
            value={queue}
            onInput={(e) => setQueue((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Enter" && subscribe()}
            aria-label="Queue group"
          />
        )}
        <Button variant="ghost" small icon="organization" title={showQueue ? "Hide queue group" : "Subscribe with a queue group"} onClick={() => setShowQueue(!showQueue)} />
        <Button variant="primary" icon="add" busy={busy} onClick={subscribe} disabled={disconnected}>
          Subscribe
        </Button>
        <div class="chips">
          {subs.map((s) => (
            <span key={s.id} class={`chip ${s.active ? "" : "chip-inactive"}`} title={s.error ?? (s.active ? `${s.count} messages` : "inactive")}>
              <span class="chip-swatch" style={{ background: s.color }} />
              <span class="mono">{s.subject}</span>
              {s.queue && <span class="muted small">q:{s.queue}</span>}
              <span class="chip-count">{s.count.toLocaleString()}</span>
              {s.error && <Icon name="error" class="danger" />}
              <button type="button" class="chip-x" aria-label={`Unsubscribe ${s.subject}`} title="Unsubscribe" onClick={() => void run(async () => setSubs(await rpc<SubInfo[]>("unsubscribe", { id: s.id })))}>
                <Icon name="close" />
              </button>
            </span>
          ))}
        </div>
      </div>

      <div class="toolbar">
        <input class="input filter-input" placeholder="Filter by subject or payload…" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} aria-label="Filter messages" />
        <Button icon={stats.paused ? "debug-continue" : "debug-pause"} onClick={() => void run(async () => setStats({ ...stats, ...(await rpc<{ paused: boolean }>("pause", { paused: !stats.paused })) }))}>
          {stats.paused ? "Resume" : "Pause"}
        </Button>
        <Button
          icon="clear-all"
          onClick={() => {
            setMessages([]);
            previews.current.clear();
            setSelectedId(null);
            void rpc("clear");
          }}
        >
          Clear
        </Button>
        <div class="spacer" />
        <Flash message={flash} />
        <span class="muted small">
          {filter ? `${filtered.length.toLocaleString()} of ` : ""}
          {messages.length.toLocaleString()} kept (max {init.maxMessages.toLocaleString()})
        </span>
        <Button small icon="json" title="Export shown messages as JSON" disabled={!filtered.length} onClick={() => exportAs("json")}>
          JSON
        </Button>
        <Button small icon="table" title="Export shown messages as CSV" disabled={!filtered.length} onClick={() => exportAs("csv")}>
          CSV
        </Button>
      </div>

      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      {disconnected && <div class="banner banner-warn">Connection is {connState}. Subscriptions resume automatically when it reconnects.</div>}

      <SplitPane initial={55} storageKey="liveTail">
        <div
          class="list"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), moveSelection(1));
            if (e.key === "ArrowUp") (e.preventDefault(), moveSelection(-1));
          }}
        >
          {messages.length === 0 ? (
            subs.length === 0 ? (
              <Empty icon="radio-tower" title="No subscriptions">
                Enter a subject above — wildcards work: <code>orders.*</code> matches one token, <code>orders.&gt;</code> matches the rest.
              </Empty>
            ) : (
              <Empty icon="loading" title="Waiting for messages…">
                Subscribed to {subs.map((s) => s.subject).join(", ")}.
              </Empty>
            )
          ) : (
            <table class="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th />
                  <th>Subject</th>
                  <th class="num">Size</th>
                  <th>Payload</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, RENDER_LIMIT).map((m) => {
                  const sub = m.subId ? subById.get(m.subId) : undefined;
                  return (
                    <tr id={`row-${m.id}`} key={m.id} class={`clickable ${m.id === selectedId ? "selected" : ""}`} onClick={() => setSelectedId(m.id)}>
                      <td class="mono muted">{fmtClock(m.time)}</td>
                      <td>
                        <span class="chip-swatch" style={{ background: sub?.color ?? "transparent" }} title={sub?.subject} />
                      </td>
                      <td class="mono">
                        {m.subject}
                        {m.reply && <Icon name="reply" class="muted reply-icon" title={`expects a reply on ${m.reply}`} />}
                        {m.status && <Badge tone="warn">{m.status}</Badge>}
                      </td>
                      <td class="num muted">{fmtBytes(m.size)}</td>
                      <td class="preview">{previews.current.get(m.id)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {filtered.length > RENDER_LIMIT && <div class="muted small pad">Showing the newest {RENDER_LIMIT} of {filtered.length.toLocaleString()} — use the filter to narrow down.</div>}
        </div>
        {selected ? <Detail m={selected} sub={selected.subId ? subById.get(selected.subId) : undefined} /> : <Empty icon="preview" title="Select a message" />}
      </SplitPane>
    </>
  );
}

function Detail({ m, sub }: { m: MessageDTO; sub?: SubInfo }) {
  const { busy, error, setError, run } = useAsync();
  return (
    <div class="detail">
      <div class="detail-header">
        <span class="detail-title">{m.subject}</span>
        <CopyButton text={m.subject} title="Copy subject" />
        <div class="spacer" />
        <Button small icon="send" title="Open in the publisher with this subject, headers and payload" busy={busy} onClick={() => void run(() => rpc("republish", { message: m }))}>
          Republish…
        </Button>
      </div>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      <table class="kv-table">
        <tbody>
          <tr>
            <th>Received</th>
            <td>{fmtTime(m.time)}</td>
          </tr>
          {m.reply && (
            <tr>
              <th>Reply to</th>
              <td>{m.reply}</td>
            </tr>
          )}
          {sub && (
            <tr>
              <th>Subscription</th>
              <td>
                <span class="chip-swatch" style={{ background: sub.color }} /> {sub.subject}
                {sub.queue ? ` (queue ${sub.queue})` : ""}
              </td>
            </tr>
          )}
          {m.status && (
            <tr>
              <th>Status</th>
              <td>{m.status}</td>
            </tr>
          )}
        </tbody>
      </table>
      <PayloadView data={m.data} headers={m.headers} />
      {m.reply && <ReplyBox key={m.id} reply={m.reply} />}
    </div>
  );
}

function ReplyBox({ reply }: { reply: string }) {
  const [payload, setPayload] = useState("");
  const [headers, setHeaders] = useState("");
  const [serviceError, setServiceError] = useState(false);
  const [code, setCode] = useState("500");
  const [text, setText] = useState("");
  const [flash, setFlash] = useFlash();
  const { busy, error, setError, run } = useAsync();
  const send = () =>
    void run(async () => {
      const r = await rpc<{ bytes: number }>("reply", {
        subject: reply,
        data: bytesToBase64(utf8Encode(payload)),
        headers: parseHeaderLines(headers),
        serviceError: serviceError ? { code, text } : undefined,
      });
      setFlash(`Replied (${fmtBytes(r.bytes)})`);
    });
  return (
    <section class="section reply-box">
      <header class="section-header">
        <h3>
          <Icon name="reply" /> Reply manually
        </h3>
        <span class="muted small mono">{reply}</span>
      </header>
      <div class="section-body col">
        <textarea class="input" rows={4} placeholder="Reply payload" value={payload} onInput={(e) => setPayload((e.target as HTMLTextAreaElement).value)} />
        <textarea class="input header-lines" rows={2} placeholder="Headers, one per line — Key: value" value={headers} onInput={(e) => setHeaders((e.target as HTMLTextAreaElement).value)} />
        <div class="row wrap">
          <label class="check">
            <input type="checkbox" checked={serviceError} onChange={(e) => setServiceError((e.target as HTMLInputElement).checked)} />
            Service error reply
          </label>
          {serviceError && (
            <>
              <input class="input code-input" value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} title="Nats-Service-Error-Code" aria-label="Error code" />
              <input class="input grow" placeholder="Nats-Service-Error text" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} aria-label="Error text" />
            </>
          )}
          <div class="spacer" />
          <Flash message={flash} />
          <Button variant="primary" icon="reply" busy={busy} onClick={send}>
            Send reply
          </Button>
        </div>
        <ErrorBanner error={error} onDismiss={() => setError(null)} />
      </div>
    </section>
  );
}

render(<App />, document.getElementById("root")!);
