import "./lib/styles.css";
import "./messaging.css";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { getInit, onEvent, rpc } from "./lib/vscode";
import { Badge, Button, Empty, ErrorBanner, Flash, fmtTime, Icon, Notice, SplitPane, useAsync, useFlash } from "./lib/ui";
import { PayloadView } from "./lib/PayloadView";
import type { MessageDTO } from "../src/shared/dto";

interface DeadLetter {
  id: string;
  kind: "max_deliveries" | "terminated";
  stream: string;
  consumer: string;
  streamSeq: number;
  deliveries: number;
  reason?: string;
  timestamp: string;
  raw: unknown;
}

interface Init {
  connectionName: string;
  subjects: string[];
}

const init = getInit<Init>();
const MAX_ROWS = 1000;

const KIND: Record<DeadLetter["kind"], { label: string; tone: "warn" | "danger"; title: string }> = {
  max_deliveries: { label: "max deliveries", tone: "warn", title: "Delivery attempts reached the consumer's max_deliver" },
  terminated: { label: "terminated", tone: "danger", title: "A client called term() on the message" },
};

function App() {
  const [rows, setRows] = useState<DeadLetter[]>([]);
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listening, setListening] = useState<boolean | null>(null);
  const [listenError, setListenError] = useState<string | undefined>();
  const [connState, setConnState] = useState("connected");

  useEffect(() => {
    const offs = [
      onEvent<DeadLetter[]>("advisories", (batch) => setRows((prev) => [...batch.reverse(), ...prev].slice(0, MAX_ROWS))),
      onEvent<{ state: string; listening?: boolean; error?: string }>("connection", (c) => {
        setConnState(c.state);
        if (c.listening !== undefined) setListening(c.listening);
        setListenError(c.error);
      }),
    ];
    void rpc<{ listening: boolean; error?: string; connected: boolean }>("ready").then((r) => {
      setListening(r.listening);
      setListenError(r.error);
      if (!r.connected) setConnState("disconnected");
    });
    return () => offs.forEach((o) => o());
  }, []);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? rows.filter((r) => r.stream.toLowerCase().includes(f) || r.consumer.toLowerCase().includes(f) || (r.reason ?? "").toLowerCase().includes(f)) : rows;
  }, [rows, filter]);
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const counts = useMemo(() => ({ max: rows.filter((r) => r.kind === "max_deliveries").length, term: rows.filter((r) => r.kind === "terminated").length }), [rows]);

  return (
    <>
      <header class="page-header">
        <div class="title">
          <Icon name="warning" />
          <h2>Dead Letters</h2>
          <span class="muted">{init.connectionName}</span>
        </div>
        <span class="row small" title={init.subjects.join("\n")}>
          <span class={`dot ${listening ? "dot-ok dot-pulse" : "dot-danger"}`} />
          <span class="muted">{listening === null ? "starting…" : listening ? "listening for advisories" : `not listening (${connState})`}</span>
        </span>
        <div class="spacer" />
        <Badge tone="warn" title={KIND.max_deliveries.title}>
          {counts.max} max deliveries
        </Badge>
        <Badge tone="danger" title={KIND.terminated.title}>
          {counts.term} terminated
        </Badge>
      </header>
      <div class="toolbar">
        <input class="input filter-input" placeholder="Filter by stream, consumer or reason…" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} aria-label="Filter" />
        <div class="spacer" />
        <Button
          icon="clear-all"
          disabled={!rows.length}
          onClick={() => {
            setRows([]);
            setSelectedId(null);
          }}
        >
          Clear
        </Button>
      </div>
      <ErrorBanner error={listenError ? `Cannot listen for advisories: ${listenError}` : null} />
      <SplitPane initial={55} storageKey="deadLetters">
        <div class="list">
          {rows.length === 0 ? (
            <Empty icon="shield" title="No dead letters yet">
              Listening on <code>$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.&gt;</code> and <code>…MSG_TERMINATED.&gt;</code>. A row appears when a message exceeds a consumer's{" "}
              <code>max_deliver</code> or a client terminates it with <code>term()</code>. Advisories are only seen while this panel is open.
            </Empty>
          ) : (
            <table class="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Kind</th>
                  <th>Stream</th>
                  <th>Consumer</th>
                  <th class="num">Seq</th>
                  <th class="num">Deliveries</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} class={`clickable ${r.id === selectedId ? "selected" : ""}`} onClick={() => setSelectedId(r.id)}>
                    <td class="mono muted">{fmtTime(r.timestamp).slice(11)}</td>
                    <td>
                      <Badge tone={KIND[r.kind].tone} title={KIND[r.kind].title}>
                        {KIND[r.kind].label}
                      </Badge>
                    </td>
                    <td class="mono">{r.stream}</td>
                    <td class="mono">{r.consumer}</td>
                    <td class="num">{r.streamSeq}</td>
                    <td class="num">{r.deliveries}</td>
                    <td class="preview">{r.reason ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {selected ? <Detail key={selected.id} row={selected} /> : <Empty icon="preview" title="Select a dead letter" />}
      </SplitPane>
    </>
  );
}

function Detail({ row }: { row: DeadLetter }) {
  const [msg, setMsg] = useState<MessageDTO | null | undefined>(undefined);
  const [confirm, setConfirm] = useState<"republish" | "delete" | null>(null);
  const [gone, setGone] = useState(false);
  const { busy, error, setError, run } = useAsync();
  const [flash, setFlash] = useFlash(4000);

  const load = () =>
    void run(async () => {
      const m = await rpc<MessageDTO | null>("getMessage", { stream: row.stream, seq: row.streamSeq });
      setMsg(m);
    });
  useEffect(load, [row.id]);

  const act = (what: "republish" | "delete") =>
    void run(async () => {
      setConfirm(null);
      if (what === "republish") {
        const r = await rpc<{ subject: string; stream?: string; seq?: number; duplicate?: boolean }>("republish", { stream: row.stream, seq: row.streamSeq });
        setFlash(r.stream ? `Republished to ${r.subject} → ${r.stream} #${r.seq}${r.duplicate ? " (duplicate!)" : ""}` : `Published to ${r.subject}`);
      } else {
        await rpc("deleteMessage", { stream: row.stream, seq: row.streamSeq });
        setGone(true);
        setMsg(null);
        setFlash(`Deleted #${row.streamSeq} from ${row.stream}`);
      }
    });

  return (
    <div class="detail">
      <div class="detail-header">
        <Badge tone={KIND[row.kind].tone}>{KIND[row.kind].label}</Badge>
        <span class="detail-title">
          {row.stream} #{row.streamSeq}
        </span>
        <div class="spacer" />
        <Button small variant="ghost" icon="refresh" title="Reload the stored message" onClick={load} />
      </div>
      <table class="kv-table">
        <tbody>
          <tr>
            <th>Consumer</th>
            <td>{row.consumer}</td>
          </tr>
          <tr>
            <th>Deliveries</th>
            <td>{row.deliveries}</td>
          </tr>
          {row.reason && (
            <tr>
              <th>Reason</th>
              <td>{row.reason}</td>
            </tr>
          )}
          <tr>
            <th>Advisory time</th>
            <td>{fmtTime(row.timestamp)}</td>
          </tr>
        </tbody>
      </table>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      {msg === undefined ? (
        <div class="muted">
          <Icon name="loading" spin /> Loading the original message…
        </div>
      ) : msg === null ? (
        <Notice tone="warn">{gone ? "Message deleted from the stream." : `Message #${row.streamSeq} is no longer in stream ${row.stream} (acked under work-queue retention, purged, or aged out).`}</Notice>
      ) : (
        <>
          <div class="row wrap">
            <span class="mono">{msg.subject}</span>
            <span class="muted small">stored {fmtTime(msg.time)}</span>
            <div class="spacer" />
            <Flash message={flash} />
            {confirm ? (
              <span class="confirm-row">
                <span class="small">{confirm === "republish" ? `Publish again to ${msg.subject}?` : `Delete #${row.streamSeq} permanently?`}</span>
                <Button small variant={confirm === "delete" ? "danger" : "primary"} busy={busy} onClick={() => act(confirm)}>
                  Confirm
                </Button>
                <Button small onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
              </span>
            ) : (
              <>
                <Button small icon="redo" title="Re-inject the message on its original subject (Nats-Msg-Id is dropped so it isn't deduplicated)" onClick={() => setConfirm("republish")}>
                  Republish
                </Button>
                <Button small icon="trash" title="Delete the message from the stream" onClick={() => setConfirm("delete")}>
                  Delete
                </Button>
              </>
            )}
          </div>
          <PayloadView data={msg.data} headers={msg.headers} />
        </>
      )}
      {flash && msg === null && <Flash message={flash} />}
      <details>
        <summary class="muted small">Raw advisory</summary>
        <pre class="code">{JSON.stringify(row.raw, null, 2)}</pre>
      </details>
    </div>
  );
}

render(<App />, document.getElementById("root")!);
