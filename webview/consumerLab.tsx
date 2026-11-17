import "./lib/styles.css";
import "./consumerLab.css";
import { render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { getInit, onEvent, rpc } from "./lib/vscode";
import { Badge, Button, CopyButton, Empty, ErrorBanner, Field, Flash, Icon, Notice, SplitPane, Spacer, Stat, cx, fmtTime, useFlash } from "./lib/ui";
import { PayloadView, payloadPreview } from "./lib/PayloadView";
import type { MessageDTO } from "../src/shared/dto";
import { fmtBytes, fmtNanos, fmtNumber, fmtAgo } from "../src/shared/format";

interface Init {
  profileId: string;
  connectionName: string;
  stream: string;
  consumer: string;
}

interface ConsumerView {
  name: string;
  stream: string;
  description?: string;
  durable: boolean;
  push: boolean;
  deliverSubject?: string;
  deliverGroup?: string;
  filterSubjects: string[];
  deliverPolicy: string;
  ackPolicy: string;
  replayPolicy: string;
  ackWaitNs?: number;
  maxDeliver: number;
  maxAckPending?: number;
  maxWaiting?: number;
  numPending: number;
  numAckPending: number;
  numRedelivered: number;
  numWaiting: number;
  deliveredStreamSeq: number;
  deliveredConsumerSeq: number;
  ackFloorStreamSeq: number;
  ackFloorConsumerSeq: number;
  lastActive?: string;
  streamFirstSeq?: number;
  streamLastSeq?: number;
  streamMessages?: number;
  paused?: boolean;
  created: string;
}

type AckAction = "ack" | "nak" | "term" | "working";
type AckState = NonNullable<MessageDTO["ackState"]>;
interface ActResult {
  id: string;
  state: AckState;
  error?: string;
}

const init = getInit<Init>();

const STATE_META: Record<AckState, { label: string; tone: "neutral" | "info" | "ok" | "warn" | "danger" }> = {
  pending: { label: "pending", tone: "info" },
  working: { label: "in progress", tone: "neutral" },
  ack: { label: "acked", tone: "ok" },
  nak: { label: "nak'd", tone: "warn" },
  term: { label: "terminated", tone: "danger" },
};

const isOpen = (m: MessageDTO) => m.ackState === "pending" || m.ackState === "working";

function App() {
  const [info, setInfo] = useState<ConsumerView | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [batch, setBatch] = useState("10");
  const [expires, setExpires] = useState("2000");
  const [nakDelay, setNakDelay] = useState("");
  const [termReason, setTermReason] = useState("");
  const [fetching, setFetching] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [visible, setVisible] = useState(true);
  const [connState, setConnState] = useState("connected");
  const [flash, showFlash] = useFlash();
  const [lastFetch, setLastFetch] = useState<{ n: number; at: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const refreshInfo = useCallback(async () => {
    try {
      setInfo(await rpc<ConsumerView>("info"));
      setInfoError(null);
    } catch (e) {
      setInfoError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refreshInfo();
    const offVis = onEvent<{ visible: boolean }>("visibility", (v) => setVisible(v.visible));
    const offConn = onEvent<{ state: string }>("connection", (c) => {
      setConnState(c.state);
      if (c.state === "disconnected" || c.state === "error") {
        // Messages fetched on the old connection can no longer be settled.
        setMessages((ms) => ms.map((m) => (isOpen(m) ? { ...m, ackState: "nak" as const, status: "released (disconnected)" } : m)));
      }
      if (c.state === "connected") void refreshInfo();
    });
    return () => {
      offVis();
      offConn();
    };
  }, []);

  useEffect(() => {
    if (!visible || connState !== "connected") return;
    const t = setInterval(() => void refreshInfo(), 3000);
    return () => clearInterval(t);
  }, [visible, connState]);

  const doFetch = async () => {
    setFetching(true);
    setError(null);
    try {
      const res = await rpc<{ messages: MessageDTO[]; warnings: string[] }>("fetch", { batch: Number(batch) || 10, expires: Number(expires) || 2000 });
      setWarnings(res.warnings);
      setMessages((ms) => [...ms, ...res.messages]);
      setLastFetch({ n: res.messages.length, at: new Date().toISOString() });
      if (res.messages.length && !selectedId) setSelectedId(res.messages[0].id);
      if (!res.messages.length && !res.warnings.length) showFlash("No messages available");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
      void refreshInfo();
    }
  };

  const act = async (ids: string[], action: AckAction) => {
    if (!ids.length) return;
    setActing(true);
    setError(null);
    try {
      const results = await rpc<ActResult[]>("act", {
        ids,
        action,
        delayMs: action === "nak" ? Number(nakDelay) || undefined : undefined,
        reason: action === "term" ? termReason : undefined,
      });
      const byId = new Map(results.map((r) => [r.id, r]));
      setMessages((ms) => ms.map((m) => (byId.has(m.id) ? { ...m, ackState: byId.get(m.id)!.state, status: byId.get(m.id)!.error } : m)));
      const failed = results.filter((r) => r.error);
      if (failed.length) setError(`${failed.length} of ${results.length} failed: ${failed[0].error}`);
      else showFlash(`${action === "working" ? "Marked in progress" : action === "ack" ? "Acked" : action === "nak" ? "Nak'd" : "Terminated"} ${results.length} message${results.length === 1 ? "" : "s"}`);
      // Move selection to the next open message after settling the selected one.
      if (action !== "working" && ids.length === 1 && ids[0] === selectedId) {
        setMessages((ms) => {
          const idx = ms.findIndex((m) => m.id === selectedId);
          const next = ms.slice(idx + 1).find(isOpen) ?? ms.find(isOpen);
          if (next) setSelectedId(next.id);
          return ms;
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(false);
      void refreshInfo();
    }
  };

  const clearSettled = () => {
    const settled = messages.filter((m) => !isOpen(m)).map((m) => m.id);
    void rpc("forget", { ids: settled });
    setMessages((ms) => ms.filter(isOpen));
    if (selectedId && settled.includes(selectedId)) setSelectedId(null);
  };

  const openIds = messages.filter(isOpen).map((m) => m.id);
  const selected = messages.find((m) => m.id === selectedId) ?? null;

  const onKey = (e: KeyboardEvent) => {
    if (!messages.length) return;
    const idx = messages.findIndex((m) => m.id === selectedId);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? Math.min(messages.length - 1, idx + 1) : Math.max(0, idx - 1);
      setSelectedId(messages[next].id);
      listRef.current?.querySelector(`[data-id="${messages[next].id}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (selected && isOpen(selected) && !acting) {
      if (e.key === "a") void act([selected.id], "ack");
      if (e.key === "n") void act([selected.id], "nak");
      if (e.key === "t") void act([selected.id], "term");
      if (e.key === "w") void act([selected.id], "working");
    }
  };

  return (
    <>
      <header class="page-header">
        <div class="title">
          <Icon name="beaker" />
          <h2 class="ellipsis">
            {init.stream} <span class="muted">›</span> {init.consumer}
          </h2>
          <span class="muted small">{init.connectionName}</span>
        </div>
        {info && (
          <div class="row wrap cl-badges">
            <Badge tone="accent">{info.push ? "push" : "pull"}</Badge>
            <Badge>{info.durable ? "durable" : "ephemeral"}</Badge>
            {info.paused && <Badge tone="warn">paused</Badge>}
            {info.filterSubjects.map((f) => (
              <Badge key={f} title="Filter subject">
                <Icon name="filter" /> {f}
              </Badge>
            ))}
          </div>
        )}
        <Spacer />
        {connState !== "connected" && (
          <Badge tone="warn">
            <span class="dot dot-warn" /> {connState}
          </Badge>
        )}
        <Button variant="ghost" small icon="refresh" title="Refresh consumer state" onClick={() => void refreshInfo()} />
      </header>

      <ErrorBanner error={infoError} />
      {info && <ConsumerSummary info={info} />}

      {info?.push ? (
        <div class="pad col">
          <Notice>
            <b>{info.name}</b> is a <b>push</b> consumer: the server delivers its messages to the subject <code>{info.deliverSubject}</code>
            {info.deliverGroup && (
              <>
                {" "}
                (queue group <code>{info.deliverGroup}</code>)
              </>
            )}{" "}
            instead of waiting to be fetched. Subscribe to that subject to watch deliveries. Note that messages delivered to a Live Tail are not acknowledged and will be redelivered after the ack wait ({fmtNanos(info.ackWaitNs)}).
          </Notice>
          <div class="row">
            <Button variant="primary" icon="radio-tower" onClick={() => void rpc("openLiveTail", { subject: info.deliverSubject, queue: info.deliverGroup }).catch((e) => setError(String(e?.message ?? e)))}>
              Open Live Tail on {info.deliverSubject}
            </Button>
            {info.deliverSubject && <CopyButton text={info.deliverSubject} title="Copy deliver subject" small={false} />}
          </div>
          <ErrorBanner error={error} onDismiss={() => setError(null)} />
        </div>
      ) : (
        <>
          <div class="toolbar">
            <Field label="Batch" class="cl-num">
              <input class="input" inputMode="numeric" value={batch} onInput={(e) => setBatch((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && void doFetch()} />
            </Field>
            <Field label="Expires (ms)" class="cl-num">
              <input class="input" inputMode="numeric" value={expires} onInput={(e) => setExpires((e.target as HTMLInputElement).value)} />
            </Field>
            <Button variant="primary" icon="cloud-download" busy={fetching} disabled={!info || connState !== "connected"} onClick={() => void doFetch()} class="cl-fetch">
              Fetch
            </Button>
            <div class="cl-sep" />
            <Button icon="check-all" disabled={!openIds.length || acting} onClick={() => void act(openIds, "ack")} title="Ack every pending message">
              Ack all ({openIds.length})
            </Button>
            <Button icon="debug-restart" disabled={!openIds.length || acting} onClick={() => void act(openIds, "nak")} title="Nak every pending message (uses the nak delay below)">
              Nak all
            </Button>
            <Button variant="ghost" icon="clear-all" disabled={messages.length === openIds.length} onClick={clearSettled} title="Remove settled messages from the list">
              Clear settled
            </Button>
            <Spacer />
            <Field label="Nak delay (ms)" class="cl-num">
              <input class="input" inputMode="numeric" placeholder="0" value={nakDelay} onInput={(e) => setNakDelay((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="Term reason" class="cl-reason">
              <input class="input" placeholder="optional" value={termReason} onInput={(e) => setTermReason((e.target as HTMLInputElement).value)} />
            </Field>
          </div>
          <ErrorBanner error={error} onDismiss={() => setError(null)} />
          {warnings.map((w) => (
            <Notice key={w} tone="warn">
              {w}
            </Notice>
          ))}
          <SplitPane initial={50} storageKey="consumerLab">
            <div class="grow scroll" ref={listRef} tabIndex={0} onKeyDown={(e) => onKey(e as unknown as KeyboardEvent)}>
              {messages.length === 0 ? (
                <Empty icon="cloud-download" title="No messages fetched yet">
                  Fetch a batch to pull messages from <b>{init.consumer}</b>. Fetched messages stay unacknowledged until you ack, nak or terminate them; unsettled ones are redelivered after the ack wait
                  {info?.ackWaitNs ? ` (${fmtNanos(info.ackWaitNs)})` : ""}.
                </Empty>
              ) : (
                <table class="table cl-table">
                  <thead>
                    <tr>
                      <th class="num">Seq</th>
                      <th>Subject</th>
                      <th class="num" title="Delivery count">Dlv</th>
                      <th>State</th>
                      <th>Preview</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {messages.map((m) => {
                      const meta = STATE_META[m.ackState ?? "pending"];
                      const open = isOpen(m);
                      return (
                        <tr key={m.id} data-id={m.id} class={cx("clickable", m.id === selectedId && "selected", !open && "cl-settled")} onClick={() => setSelectedId(m.id)}>
                          <td class="num mono">{m.seq}</td>
                          <td class="mono cl-subj" title={m.subject}>
                            {m.subject}
                          </td>
                          <td class={cx("num", (m.deliveryCount ?? 1) > 1 && "cl-redelivered")} title={m.redelivered ? "Redelivered" : "First delivery"}>
                            {m.deliveryCount ?? 1}
                            {m.redelivered && <Icon name="history" class="cl-mini" />}
                          </td>
                          <td>
                            <Badge tone={meta.tone} title={m.status}>
                              {m.status?.startsWith("released") ? "released" : meta.label}
                              {m.status && <Icon name="warning" />}
                            </Badge>
                          </td>
                          <td class="preview">{payloadPreview(m.data, 80)}</td>
                          <td class="cl-actions" onClick={(e) => e.stopPropagation()}>
                            <AckButtons disabled={!open || acting} onAct={(a) => void act([m.id], a)} small />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div class="detail">
              {selected ? (
                <>
                  <div class="detail-header">
                    <span class="detail-title">#{selected.seq}</span>
                    <code>{selected.subject}</code>
                    <CopyButton text={selected.subject} title="Copy subject" />
                    <Badge tone={STATE_META[selected.ackState ?? "pending"].tone}>{STATE_META[selected.ackState ?? "pending"].label}</Badge>
                    <Spacer />
                    <AckButtons disabled={!isOpen(selected) || acting} onAct={(a) => void act([selected.id], a)} labels />
                  </div>
                  {selected.status && (
                    <Notice tone="warn">{selected.status}</Notice>
                  )}
                  <table class="kv-table">
                    <tbody>
                      <tr>
                        <th>Stream seq</th>
                        <td>{selected.seq}</td>
                      </tr>
                      <tr>
                        <th>Delivery</th>
                        <td>
                          #{selected.deliveryCount ?? 1}
                          {selected.redelivered ? " (redelivered)" : ""}
                          {info && info.maxDeliver > 0 ? ` of max ${info.maxDeliver}` : ""}
                        </td>
                      </tr>
                      <tr>
                        <th>Pending after</th>
                        <td>{selected.pending ?? "–"}</td>
                      </tr>
                      <tr>
                        <th>Stored</th>
                        <td>{fmtTime(selected.time)}</td>
                      </tr>
                      <tr>
                        <th>Size</th>
                        <td>{fmtBytes(selected.size)}</td>
                      </tr>
                    </tbody>
                  </table>
                  <PayloadView data={selected.data} headers={selected.headers} />
                </>
              ) : (
                <Empty icon="mail" title="Select a message">
                  Shortcuts: <kbd>a</kbd> ack · <kbd>n</kbd> nak · <kbd>t</kbd> term · <kbd>w</kbd> in progress · <kbd>↑</kbd>
                  <kbd>↓</kbd> move
                </Empty>
              )}
            </div>
          </SplitPane>
        </>
      )}

      <div class="status-bar">
        <span>
          {messages.length} fetched · {openIds.length} unsettled
        </span>
        {lastFetch && (
          <span>
            last fetch: {lastFetch.n} msg{lastFetch.n === 1 ? "" : "s"} at {fmtTime(lastFetch.at).slice(11, 19)}
          </span>
        )}
        <Spacer />
        <Flash message={flash} />
        {info?.lastActive && <span title={info.lastActive}>last delivery {fmtAgo(info.lastActive)}</span>}
      </div>
    </>
  );
}

function AckButtons({ disabled, onAct, small, labels }: { disabled: boolean; onAct: (a: AckAction) => void; small?: boolean; labels?: boolean }) {
  const btn = (a: AckAction, icon: string, label: string, title: string, variant: "primary" | "secondary" | "ghost" = "ghost") => (
    <Button small={small || labels} variant={labels ? variant : "ghost"} icon={icon} title={title} disabled={disabled} onClick={() => onAct(a)}>
      {labels ? label : undefined}
    </Button>
  );
  return (
    <span class="row cl-ackbtns">
      {btn("ack", "check", "Ack", "Acknowledge (a)", "primary")}
      {btn("nak", "debug-restart", "Nak", "Negative ack — redeliver (n)", "secondary")}
      {btn("term", "circle-slash", "Term", "Terminate — never redeliver (t)", "secondary")}
      {btn("working", "watch", "In progress", "Reset the ack wait timer (w)", "secondary")}
    </span>
  );
}

function ConsumerSummary({ info }: { info: ConsumerView }) {
  const first = info.streamFirstSeq ?? 0;
  const last = info.streamLastSeq ?? 0;
  const span = Math.max(1, last - first + 1);
  const pos = (seq: number) => Math.min(100, Math.max(0, ((seq - first + 1) / span) * 100));
  const ackPct = last ? pos(info.ackFloorStreamSeq) : 0;
  const dlvPct = last ? pos(info.deliveredStreamSeq) : 0;
  const ackPendingFull = info.maxAckPending !== undefined && info.maxAckPending > 0 && info.numAckPending >= info.maxAckPending;
  return (
    <div class="cl-summary">
      <div class="stats">
        <Stat label="Pending" value={fmtNumber(info.numPending)} sub="not yet delivered" />
        <Stat
          label="Ack pending"
          value={fmtNumber(info.numAckPending)}
          sub={info.maxAckPending && info.maxAckPending > 0 ? `max ${fmtNumber(info.maxAckPending)}` : "delivered, unacked"}
          tone={ackPendingFull ? "danger" : info.numAckPending > 0 ? "warn" : undefined}
        />
        <Stat label="Redelivered" value={fmtNumber(info.numRedelivered)} tone={info.numRedelivered > 0 ? "warn" : undefined} />
        <Stat label="Waiting pulls" value={fmtNumber(info.numWaiting)} sub={info.maxWaiting ? `max ${info.maxWaiting}` : undefined} />
      </div>
      {ackPendingFull && <Notice tone="warn">Max ack pending reached — the server won't deliver more until outstanding messages are acked, nak'd or time out.</Notice>}
      {last > 0 && (
        <div class="cl-progress" title={`stream ${first}…${last} · ack floor ${info.ackFloorStreamSeq} · delivered ${info.deliveredStreamSeq}`}>
          <div class="cl-bar">
            <div class="cl-bar-acked" style={{ width: `${ackPct}%` }} />
            <div class="cl-bar-inflight" style={{ left: `${ackPct}%`, width: `${Math.max(0, dlvPct - ackPct)}%` }} />
          </div>
          <div class="cl-legend">
            <span>
              <span class="cl-swatch cl-sw-acked" /> ack floor <b>#{info.ackFloorStreamSeq}</b>
            </span>
            <span>
              <span class="cl-swatch cl-sw-inflight" /> delivered <b>#{info.deliveredStreamSeq}</b>
            </span>
            <span>
              <span class="cl-swatch cl-sw-rest" /> stream <b>#{first}…#{last}</b>
            </span>
          </div>
        </div>
      )}
      <div class="cl-config">
        <span>
          deliver <b>{info.deliverPolicy}</b>
        </span>
        <span>
          ack <b>{info.ackPolicy}</b>
        </span>
        <span>
          ack wait <b>{fmtNanos(info.ackWaitNs)}</b>
        </span>
        <span>
          max deliver <b>{info.maxDeliver > 0 ? info.maxDeliver : "∞"}</b>
        </span>
        <span>
          max ack pending <b>{info.maxAckPending && info.maxAckPending > 0 ? fmtNumber(info.maxAckPending) : "∞"}</b>
        </span>
        <span>
          replay <b>{info.replayPolicy}</b>
        </span>
        {info.description && <span class="muted">{info.description}</span>}
      </div>
    </div>
  );
}

render(<App />, document.getElementById("root")!);
