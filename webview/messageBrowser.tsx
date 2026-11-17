import "./lib/styles.css";
import "./messageBrowser.css";
import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { getInit, onEvent, rpc } from "./lib/vscode";
import { Badge, Button, CopyButton, Empty, ErrorBanner, Flash, Icon, Notice, Select, SplitPane, Spacer, cx, fmtTime, useFlash } from "./lib/ui";
import { PayloadView, payloadPreview } from "./lib/PayloadView";
import type { MessageDTO } from "../src/shared/dto";
import { fmtBytes, fmtNumber } from "../src/shared/format";

interface Init {
  profileId: string;
  connectionName: string;
  stream: string;
  filter?: string;
  seq?: number;
  pageSize: number;
}

interface Summary {
  name: string;
  description?: string;
  subjects: string[];
  storage: string;
  retention: string;
  replicas: number;
  messages: number;
  bytes: number;
  firstSeq: number;
  lastSeq: number;
  firstTs?: string;
  lastTs?: string;
  consumers: number;
  numSubjects?: number;
  numDeleted?: number;
  sealed?: boolean;
  denyDelete?: boolean;
}

interface Page {
  messages: MessageDTO[];
  firstSeq: number;
  lastSeq: number;
  total: number;
  partial?: boolean;
  atEnd: boolean;
  atStart: boolean;
}

interface Query {
  direction: "forward" | "backward";
  seq?: number;
  startTime?: string;
  filter?: string;
  limit: number;
}

const init = getInit<Init>();
const PAGE_SIZES = [10, 25, 50, 100, 250, 500, 1000];

function App() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [filterInput, setFilterInput] = useState(init.filter ?? "");
  const [pageSize, setPageSize] = useState(PAGE_SIZES.includes(init.pageSize) ? init.pageSize : 50);
  const [seqInput, setSeqInput] = useState(init.seq ? String(init.seq) : "");
  const [timeInput, setTimeInput] = useState("");
  const [query, setQuery] = useState<Query>(() =>
    init.seq ? { direction: "forward", seq: init.seq, filter: init.filter, limit: pageSize } : { direction: "backward", filter: init.filter, limit: pageSize },
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newestFirst, setNewestFirst] = useState(true);
  const [follow, setFollow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connState, setConnState] = useState<string>("connected");
  const [confirmDelete, setConfirmDelete] = useState<{ seq: number; erase: boolean } | null>(null);
  const [flash, showFlash] = useFlash();
  const reqId = useRef(0);
  const tableRef = useRef<HTMLDivElement>(null);
  const pageSizeRef = useRef(pageSize);
  pageSizeRef.current = pageSize;

  const load = useCallback(async (q: Query, opts: { keepSelection?: boolean; quiet?: boolean } = {}) => {
    const id = ++reqId.current;
    if (!opts.quiet) setBusy(true);
    try {
      const res = await rpc<{ page: Page; summary: Summary }>("browse", q);
      if (id !== reqId.current) return;
      setSummary(res.summary);
      setPage(res.page);
      setQuery(q);
      setError(null);
      if (!opts.keepSelection) {
        const msgs = res.page.messages;
        // Select the newest message of a "newest" page, else the first.
        const pick = q.direction === "backward" ? msgs.at(-1) : msgs[0];
        setSelectedId(pick?.seq ?? null);
      }
    } catch (e) {
      if (id === reqId.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === reqId.current && !opts.quiet) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(query);
    const offApply = onEvent<{ filter?: string; seq?: number }>("apply", (o) => {
      const filter = o.filter ?? undefined;
      setFilterInput(filter ?? "");
      if (o.seq) setSeqInput(String(o.seq));
      void load(o.seq ? { direction: "forward", seq: o.seq, filter, limit: pageSizeRef.current } : { direction: "backward", filter, limit: pageSizeRef.current });
    });
    const offConn = onEvent<{ state: string }>("connection", (c) => setConnState(c.state));
    return () => {
      offApply();
      offConn();
    };
  }, []);

  const filter = filterInput.trim() || undefined;
  const msgs = page?.messages ?? [];
  const display = useMemo(() => (newestFirst ? [...msgs].reverse() : msgs), [msgs, newestFirst]);
  const selected = msgs.find((m) => m.seq === selectedId) ?? null;
  const onNewest = !!page && page.atEnd;

  // Follow mode: poll the newest page every 2s while it is shown.
  useEffect(() => {
    if (!follow || !onNewest || connState !== "connected") return;
    const t = setInterval(() => {
      void load({ direction: "backward", filter: query.filter, limit: query.limit }, { keepSelection: true, quiet: true });
    }, 2000);
    return () => clearInterval(t);
  }, [follow, onNewest, connState, query.filter, query.limit]);

  const go = {
    oldest: () => load({ direction: "forward", filter, limit: pageSize }),
    newest: () => load({ direction: "backward", filter, limit: pageSize }),
    older: () => msgs.length && load({ direction: "backward", seq: (msgs[0].seq ?? 1) - 1, filter, limit: pageSize }),
    newer: () => msgs.length && load({ direction: "forward", seq: (msgs[msgs.length - 1].seq ?? 0) + 1, filter, limit: pageSize }),
    refresh: () => load({ ...query, filter, limit: pageSize }, { keepSelection: true }),
    seq: () => {
      const n = Number(seqInput.trim());
      if (!Number.isInteger(n) || n < 1) return setError("Enter a positive sequence number");
      return load({ direction: "forward", seq: n, filter, limit: pageSize });
    },
    time: () => {
      if (!timeInput) return setError("Pick a start time");
      const d = new Date(timeInput);
      if (Number.isNaN(d.getTime())) return setError("Invalid time");
      return load({ direction: "forward", startTime: d.toISOString(), filter, limit: pageSize });
    },
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (!display.length) return;
    e.preventDefault();
    const idx = display.findIndex((m) => m.seq === selectedId);
    const next = e.key === "ArrowDown" ? Math.min(display.length - 1, idx + 1) : Math.max(0, idx - 1);
    setSelectedId(display[next].seq ?? null);
    tableRef.current?.querySelector(`[data-seq="${display[next].seq}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const doExport = async (format: "json" | "csv") => {
    try {
      const path = await rpc<string | null>("export", { format, messages: msgs });
      if (path) showFlash(`Exported ${msgs.length} messages`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    try {
      await rpc("deleteMessage", confirmDelete);
      showFlash(`Deleted #${confirmDelete.seq}`);
      setConfirmDelete(null);
      await load(query, { keepSelection: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConfirmDelete(null);
    }
  };

  const rangeText = msgs.length ? `#${msgs[0].seq}–#${msgs[msgs.length - 1].seq}` : "–";

  return (
    <>
      <header class="page-header">
        <div class="title">
          <Icon name="list-flat" />
          <h2 class="ellipsis">{init.stream}</h2>
          <span class="muted small">{init.connectionName}</span>
        </div>
        {summary && (
          <div class="row wrap mb-summary">
            <Badge tone="accent" title="Messages stored">
              {fmtNumber(summary.messages)} msgs
            </Badge>
            <Badge title="Bytes stored">{fmtBytes(summary.bytes)}</Badge>
            <Badge title="First / last stream sequence">
              seq {fmtNumber(summary.firstSeq)}…{fmtNumber(summary.lastSeq)}
            </Badge>
            <Badge title="Storage · retention · replicas">
              {summary.storage} · {summary.retention} · R{summary.replicas}
            </Badge>
            {summary.consumers > 0 && <Badge title="Consumers">{summary.consumers} consumers</Badge>}
            {!!summary.numDeleted && <Badge tone="warn" title="Deleted (interior) messages">{fmtNumber(summary.numDeleted)} deleted</Badge>}
            {summary.sealed && <Badge tone="warn">sealed</Badge>}
            <span class="mb-subjects" title={summary.subjects.join(", ")}>
              {summary.subjects.map((s) => (
                <code key={s} class="mb-subject" onClick={() => setFilterInput(s)} title="Use as filter">
                  {s}
                </code>
              ))}
            </span>
          </div>
        )}
        <Spacer />
        {connState !== "connected" && (
          <Badge tone="warn">
            <span class="dot dot-warn" /> {connState}
          </Badge>
        )}
      </header>

      <div class="toolbar">
        <div class="row mb-filter">
          <Icon name="filter" class="muted" />
          <input
            class="input mono"
            placeholder="Subject filter, e.g. orders.*.created or orders.>"
            value={filterInput}
            onInput={(e) => setFilterInput((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Enter" && void go.newest()}
            title="NATS subject filter (wildcards * and > allowed). Press Enter to apply."
          />
          {filterInput && <Button variant="ghost" small icon="close" title="Clear filter" onClick={() => (setFilterInput(""), void load({ direction: "backward", limit: pageSize }))} />}
        </div>
        <Select
          value={String(pageSize)}
          title="Page size"
          options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} / page` }))}
          onChange={(v) => setPageSize(Number(v))}
        />
        <div class="seg mb-nav" role="group" aria-label="Pagination">
          <button type="button" class="seg-btn" title="Oldest messages" disabled={busy} onClick={() => void go.oldest()}>
            <Icon name="debug-reverse-continue" /> Oldest
          </button>
          <button type="button" class="seg-btn" title="Older page" disabled={busy || !page || page.atStart || !msgs.length} onClick={() => void go.older()}>
            <Icon name="chevron-left" /> Older
          </button>
          <button type="button" class="seg-btn" title="Newer page" disabled={busy || !page || page.atEnd || !msgs.length} onClick={() => void go.newer()}>
            Newer <Icon name="chevron-right" />
          </button>
          <button type="button" class="seg-btn" title="Newest messages" disabled={busy} onClick={() => void go.newest()}>
            Newest <Icon name="debug-continue" />
          </button>
        </div>
        <div class="row">
          <input
            class="input mono mb-seq"
            placeholder="seq"
            inputMode="numeric"
            value={seqInput}
            onInput={(e) => setSeqInput((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Enter" && void go.seq()}
            title="Jump to a stream sequence"
          />
          <Button small icon="arrow-right" title="Jump to sequence" disabled={busy || !seqInput.trim()} onClick={() => void go.seq()} />
        </div>
        <div class="row">
          <input class="input mb-time" type="datetime-local" step="1" value={timeInput} onInput={(e) => setTimeInput((e.target as HTMLInputElement).value)} title="Start at time" />
          <Button small icon="calendar" title="Start at this time" disabled={busy || !timeInput} onClick={() => void go.time()} />
        </div>
        <Spacer />
        <label class="check" title="Poll for new messages every 2s while the newest page is shown">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow((e.target as HTMLInputElement).checked)} />
          Follow
        </label>
        <Button variant="ghost" small icon={newestFirst ? "arrow-down" : "arrow-up"} title={newestFirst ? "Newest first (click for oldest first)" : "Oldest first (click for newest first)"} onClick={() => setNewestFirst(!newestFirst)} />
        <Button variant="ghost" small icon="refresh" title="Refresh" busy={busy} onClick={() => void go.refresh()} />
        <Button variant="ghost" small icon="json" title="Export page as JSON" disabled={!msgs.length} onClick={() => void doExport("json")} />
        <Button variant="ghost" small icon="table" title="Export page as CSV" disabled={!msgs.length} onClick={() => void doExport("csv")} />
      </div>

      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      {page?.partial && <Notice tone="warn">Filtered scan stopped early — older matches may exist before #{msgs[0]?.seq ?? page.firstSeq}. Use Older to keep scanning.</Notice>}

      <SplitPane initial={55} storageKey="msgBrowser">
        <div class="grow scroll" ref={tableRef} tabIndex={0} onKeyDown={(e) => onKey(e as unknown as KeyboardEvent)}>
          {page && !msgs.length ? (
            <Empty icon="inbox" title={summary?.messages ? "No messages on this page" : "Stream is empty"}>
              {query.filter ? (
                <>
                  Nothing matches <code>{query.filter}</code> here.
                </>
              ) : summary?.messages ? (
                "Try another position."
              ) : (
                "Publish to one of the stream's subjects to see messages here."
              )}
            </Empty>
          ) : !page ? (
            <Empty icon="loading" title="Loading messages…" />
          ) : (
            <table class="table mb-table">
              <thead>
                <tr>
                  <th class="num">Seq</th>
                  <th>Time</th>
                  <th>Subject</th>
                  <th class="num">Size</th>
                  <th>Preview</th>
                </tr>
              </thead>
              <tbody>
                {display.map((m) => (
                  <tr key={m.seq} data-seq={m.seq} class={cx("clickable", m.seq === selectedId && "selected")} onClick={() => setSelectedId(m.seq ?? null)}>
                    <td class="num mono">{m.seq}</td>
                    <td class="mono muted" title={m.time}>
                      {fmtTime(m.time)}
                    </td>
                    <td class="mono mb-subj" title={m.subject}>
                      {m.subject}
                      {m.headers.length > 0 && <Icon name="tag" class="muted mb-hdr-icon" title={`${m.headers.length} header(s)`} />}
                    </td>
                    <td class="num muted">{fmtBytes(m.size)}</td>
                    <td class="preview">{payloadPreview(m.data)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div class="detail">
          {confirmDelete && (
            <div class="mb-confirm" role="dialog" aria-label="Confirm delete">
              <div class="row">
                <Icon name="warning" class="mb-warn" />
                <b>Delete message #{confirmDelete.seq} from {init.stream}?</b>
              </div>
              <p class="muted small">The message is removed from the stream permanently. Consumers that have not received it yet will skip it.</p>
              <label class="check">
                <input type="checkbox" checked={confirmDelete.erase} onChange={(e) => setConfirmDelete({ ...confirmDelete, erase: (e.target as HTMLInputElement).checked })} />
                Erase (overwrite the stored data with random bytes — slower)
              </label>
              <div class="row">
                <Button variant="danger" icon="trash" onClick={() => void doDelete()}>
                  Delete
                </Button>
                <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
              </div>
            </div>
          )}
          {selected ? (
            <MessageDetail
              m={selected}
              denyDelete={summary?.denyDelete}
              onRepublish={() => void rpc("republish", { message: selected }).catch((e) => setError(String(e?.message ?? e)))}
              onOpenJson={() => void rpc("openJson", { message: selected }).catch((e) => setError(String(e?.message ?? e)))}
              onDelete={() => setConfirmDelete({ seq: selected.seq!, erase: false })}
              onFilterSubject={() => (setFilterInput(selected.subject), void load({ direction: "backward", filter: selected.subject, limit: pageSize }))}
            />
          ) : (
            <Empty icon="mail" title="Select a message">
              Use <kbd>↑</kbd> <kbd>↓</kbd> to move through the page.
            </Empty>
          )}
        </div>
      </SplitPane>

      <div class="status-bar">
        <span>
          {msgs.length} on page {rangeText}
        </span>
        {query.filter && (
          <span>
            <Icon name="filter" /> {query.filter}
          </span>
        )}
        {query.startTime && <span>from {fmtTime(query.startTime)}</span>}
        {follow && onNewest && (
          <span>
            <span class="dot dot-ok dot-pulse" /> following
          </span>
        )}
        <Spacer />
        <Flash message={flash} />
        {summary?.lastTs && <span title="Last message time">last {fmtTime(summary.lastTs)}</span>}
      </div>
    </>
  );
}

function MessageDetail({
  m,
  denyDelete,
  onRepublish,
  onOpenJson,
  onDelete,
  onFilterSubject,
}: {
  m: MessageDTO;
  denyDelete?: boolean;
  onRepublish: () => void;
  onOpenJson: () => void;
  onDelete: () => void;
  onFilterSubject: () => void;
}) {
  return (
    <>
      <div class="detail-header">
        <span class="detail-title">#{m.seq}</span>
        <code class="mb-detail-subject">{m.subject}</code>
        <CopyButton text={m.subject} title="Copy subject" />
        <Spacer />
        <Button small icon="filter" title="Show only this subject" onClick={onFilterSubject} />
        <Button small icon="send" title="Republish (opens the publisher prefilled)" onClick={onRepublish}>
          Republish
        </Button>
        <Button small icon="go-to-file" title="Open as JSON document" onClick={onOpenJson} />
        <Button small variant="ghost" icon="trash" title={denyDelete ? "Stream denies message deletes" : "Delete message…"} disabled={denyDelete} onClick={onDelete} />
      </div>
      <table class="kv-table">
        <tbody>
          <tr>
            <th>Time</th>
            <td>
              {fmtTime(m.time)} <span class="muted">({m.time})</span>
            </td>
          </tr>
          <tr>
            <th>Size</th>
            <td>
              {fmtBytes(m.size)} ({fmtNumber(m.size)} bytes)
            </td>
          </tr>
          <tr>
            <th>Headers</th>
            <td>{m.headers.length || "none"}</td>
          </tr>
        </tbody>
      </table>
      <PayloadView data={m.data} headers={m.headers} />
    </>
  );
}

render(<App />, document.getElementById("root")!);
