import "./lib/styles.css";
import "./plan.css";
import { render, type ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { getInit, getState, onEvent, rpc, setState } from "./lib/vscode";
import { Button, cx, Icon, Kbd, VisuallyHidden } from "./lib/ui";
import { Card, Cell, Chip, ConnectionBanner, DashboardHeader, DashboardPage, DataTable, EmptyState, fmtAgoShort, Grid, KeyValueGrid, KpiRow, KpiTile, type Column, type Tone } from "./lib/dashboard";
import { BarList, ItemsTable, Meter, SegmentBar, useNow } from "./lib/charts";
import { ACTION_MARKER, KIND_LABEL, PLAN_ACTIONS, type ApplyProgress, type ApplySummary, type ConfigChange, type PlanAction, type PlanConnection, type PlanInit, type PlanItem, type PlanResult, type ResourceKind } from "../src/gitops/types";
import { fmtRaw, humanize, listDelta } from "../src/gitops/valueFormat";

const init = getInit<PlanInit>();

const ACTION_TONE: Record<PlanAction, Tone> = { create: "ok", update: "warn", unchanged: "neutral", drift: "info", error: "danger" };
const ACTION_TEXT: Record<PlanAction, string> = { create: "create", update: "update", unchanged: "unchanged", drift: "drift", error: "error" };
const KIND_GROUP: Record<ResourceKind, string> = { stream: "Streams", kv: "Key-Value buckets", consumer: "Consumers" };
const KIND_ORDER: ResourceKind[] = ["stream", "kv", "consumer"];

interface UiState {
  query: string;
  actions: PlanAction[];
  kinds: ResourceKind[];
  showUnchanged: boolean;
}

const saved = getState<UiState>();

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function resourceLabel(i: PlanItem): string {
  return i.kind === "consumer" && i.stream ? `${i.stream} › ${i.name}` : i.name;
}

function isApplicable(i: PlanItem): boolean {
  return (i.action === "create" || i.action === "update") && !i.blocked;
}

function statusOf(c: PlanConnection | undefined): { tone: Tone; label: string; pulse?: boolean } | undefined {
  if (!c) return undefined;
  switch (c.state) {
    case "connected":
      return { tone: "ok", label: "Connected" };
    case "connecting":
      return { tone: "info", label: "Connecting", pulse: true };
    case "reconnecting":
      return { tone: "warn", label: "Reconnecting", pulse: true };
    case "error":
      return { tone: "danger", label: "Connection error" };
    default:
      return { tone: "neutral", label: "Disconnected" };
  }
}

// ---------------------------------------------------------------------------------------------
// Diff rendering
// ---------------------------------------------------------------------------------------------

function Value({ v, unit, path, cls }: { v: unknown; unit?: ConfigChange["unit"]; path: string; cls: string }) {
  const raw = fmtRaw(v, 160);
  const full = fmtRaw(v, 100000);
  return (
    <span class={cls} title={full !== raw ? full : undefined}>
      {raw}
    </span>
  );
}

function Hint({ c, side }: { c: ConfigChange; side?: "pair" }) {
  const to = humanize(c.to, c.unit, c.path);
  if (side === "pair") {
    const from = humanize(c.from, c.unit, c.path);
    if (!to && !from) return null;
    return (
      <span class="pl-hint">
        {from ?? fmtRaw(c.from, 24)} → {to ?? fmtRaw(c.to, 24)}
      </span>
    );
  }
  return to ? <span class="pl-hint">{to}</span> : null;
}

function DiffRow({ c, mode }: { c: ConfigChange; mode: "change" | "create" | "server" }) {
  const marker = mode === "server" ? "·" : c.op === "add" ? "+" : "~";
  const delta = mode === "change" && c.op === "change" ? listDelta(c.from, c.to) : undefined;
  const markTone = mode === "server" ? "neutral" : c.immutable ? "danger" : c.op === "add" ? "ok" : "warn";
  return (
    <>
      <tr class={cx("pl-line", c.immutable && "pl-line-blocked")}>
        <td class={cx("pl-m", `pl-tone-${markTone}`)} aria-hidden="true">
          {marker}
        </td>
        <th scope="row" class="pl-k mono">
          <VisuallyHidden>{mode === "server" ? "server value " : c.op === "add" ? "add " : "change "}</VisuallyHidden>
          {c.path}
        </th>
        <td class="pl-v">
          {mode === "change" && c.op === "change" ? (
            delta && (delta.added.length || delta.removed.length) && Array.isArray(c.from) ? (
              <span class="pl-delta">
                {delta.added.map((s) => (
                  <span key={`+${s}`} class="pl-delta-item pl-tone-ok mono">
                    <span aria-hidden="true">+</span>
                    <VisuallyHidden>added </VisuallyHidden>
                    {JSON.stringify(s)}
                  </span>
                ))}
                {delta.removed.map((s) => (
                  <span key={`-${s}`} class="pl-delta-item pl-tone-danger mono">
                    <span aria-hidden="true">−</span>
                    <VisuallyHidden>removed </VisuallyHidden>
                    {JSON.stringify(s)}
                  </span>
                ))}
              </span>
            ) : (
              <span class="pl-pair">
                <Value v={c.from} unit={c.unit} path={c.path} cls="pl-from mono" />
                <Icon name="arrow-right" class="pl-arrow" />
                <VisuallyHidden> to </VisuallyHidden>
                <Value v={c.to} unit={c.unit} path={c.path} cls="pl-to mono" />
                <Hint c={c} side="pair" />
              </span>
            )
          ) : (
            <span class="pl-pair">
              <Value v={c.to} unit={c.unit} path={c.path} cls={mode === "server" ? "pl-from mono" : "pl-to mono"} />
              <Hint c={c} />
            </span>
          )}
        </td>
      </tr>
      {(c.immutable || c.risk) && (
        <tr class="pl-note-row">
          <td />
          <td colSpan={2}>
            {c.immutable && (
              <div class="pl-note pl-tone-danger">
                <Icon name="lock" />
                <span>
                  <b>Immutable.</b> {c.immutable}
                </span>
              </div>
            )}
            {c.risk && (
              <div class="pl-note pl-tone-warn">
                <Icon name="warning" />
                <span>{c.risk}</span>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function DiffTable({ item, lines, mode }: { item: PlanItem; lines: ConfigChange[]; mode: "change" | "create" | "server" }) {
  const [all, setAll] = useState(false);
  const LIMIT = mode === "change" ? 40 : 10;
  const shown = all ? lines : lines.slice(0, LIMIT);
  return (
    <div class="pl-diff-wrap">
      <table class="pl-diff">
        <caption class="sr-only">
          {mode === "change" ? "Changes" : mode === "create" ? "Fields to create" : "Server configuration"} for {KIND_LABEL[item.kind ?? "stream"]} {resourceLabel(item)}
        </caption>
        <tbody>
          {shown.map((c) => (
            <DiffRow key={c.path} c={c} mode={mode} />
          ))}
        </tbody>
      </table>
      {lines.length > shown.length && (
        <button type="button" class="ds-link pl-more" onClick={() => setAll(true)}>
          Show all {lines.length} fields
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Resource block
// ---------------------------------------------------------------------------------------------

function ProgressBadge({ p }: { p: ApplyProgress | undefined }) {
  if (!p) return null;
  switch (p.state) {
    case "pending":
      return (
        <span class="pl-prog pl-tone-neutral">
          <Icon name="clock" /> Queued
        </span>
      );
    case "running":
      return (
        <span class="pl-prog pl-tone-info" role="status">
          <Icon name="loading" spin /> Applying…
        </span>
      );
    case "done":
      return (
        <span class="pl-prog pl-tone-ok" role="status">
          <Icon name="pass" /> {p.message === "created" ? "Created" : p.message === "updated" ? "Updated" : "Already in sync"}
        </span>
      );
    case "failed":
      return (
        <span class="pl-prog pl-tone-danger" role="status" title={p.message}>
          <Icon name="error" /> Failed
        </span>
      );
    default:
      return (
        <span class="pl-prog pl-tone-neutral" title={p.message}>
          <Icon name="circle-slash" /> Skipped
        </span>
      );
  }
}

interface BlockProps {
  item: PlanItem;
  open: boolean;
  onToggle: () => void;
  progress?: ApplyProgress;
  canApply: boolean;
  applyBlockedReason?: string;
  busy: boolean;
  onApply: () => void;
  onCompare: () => void;
  onOpen: () => void;
  onAdopt: () => void;
  onView: () => void;
}

function summaryText(i: PlanItem): string {
  switch (i.action) {
    case "create":
      return `new · ${plural(i.fields?.length ?? 0, "field")}`;
    case "update":
      return plural(i.changes.length, "change");
    case "unchanged":
      return "in sync";
    case "drift":
      return "on server only";
    default:
      return "invalid";
  }
}

function ResourceBlock({ item: i, open, onToggle, progress, canApply, applyBlockedReason, busy, onApply, onCompare, onOpen, onAdopt, onView }: BlockProps) {
  const bodyId = `pl-body-${i.id.replace(/[^\w-]/g, "_")}`;
  const risks = i.changes.filter((c) => c.risk).length;
  const hasBody = i.action !== "unchanged" || i.warnings.length > 0 || progress?.state === "failed";
  const applyTitle = i.blocked ? `Blocked: ${i.blocked}` : (applyBlockedReason ?? `${i.action === "create" ? "Create" : "Update"} ${resourceLabel(i)} on the server`);
  return (
    <li class={cx("pl-res", `pl-act-${i.action}`, open && hasBody && "pl-open", progress && `pl-prog-${progress.state}`)}>
      <div class="pl-res-head">
        <button type="button" class="pl-res-toggle" aria-expanded={hasBody ? open : undefined} aria-controls={hasBody ? bodyId : undefined} onClick={hasBody ? onToggle : undefined} aria-disabled={!hasBody || undefined}>
          <Icon name={hasBody ? (open ? "chevron-down" : "chevron-right") : "blank"} class="pl-chev" />
          <span class={cx("pl-mark", `pl-tone-${ACTION_TONE[i.action]}`)} aria-hidden="true">
            {ACTION_MARKER[i.action]}
          </span>
          <VisuallyHidden>{ACTION_TEXT[i.action]}: </VisuallyHidden>
          <span class="pl-kind">{i.kind ? KIND_LABEL[i.kind] : "file"}</span>
          <span class="pl-name mono">
            {i.kind === "consumer" && i.stream ? (
              <>
                <span class="pl-parent">{i.stream} › </span>
                {i.name}
              </>
            ) : (
              i.name
            )}
          </span>
          <span class={cx("pl-summary", i.action === "error" && "pl-tone-danger")}>{summaryText(i)}</span>
        </button>
        <span class="pl-tags">
          {i.blocked && (
            <Chip size="sm" tone="danger" icon="lock" title={i.blocked}>
              immutable
            </Chip>
          )}
          {risks > 0 && (
            <Chip size="sm" tone="warn" icon="warning" title={i.changes.filter((c) => c.risk).map((c) => `${c.path}: ${c.risk}`).join("\n")}>
              {plural(risks, "risk")}
            </Chip>
          )}
          {i.unsaved && (
            <Chip size="sm" tone="info" icon="circle-filled" title="Planned from unsaved editor content">
              unsaved
            </Chip>
          )}
          {i.dependsOn && (
            <Chip size="sm" icon="link" title={`Applied after ${i.dependsOn.replace(":", " ")} (included automatically)`}>
              after {i.stream}
            </Chip>
          )}
          <ProgressBadge p={progress} />
        </span>
        <span class="pl-actions">
          {(i.action === "create" || i.action === "update") && (
            <Button small variant="secondary" icon="cloud-upload" disabled={!canApply || !!i.blocked || busy} title={applyTitle} aria-label={`Apply ${resourceLabel(i)}`} onClick={onApply}>
              Apply
            </Button>
          )}
          {i.action === "drift" && (
            <Button small variant="secondary" icon="desktop-download" title={`Write ${resourceLabel(i)} into this folder as a config file`} onClick={onAdopt}>
              Add to folder
            </Button>
          )}
          {(i.action === "update" || i.action === "unchanged") && <Button small variant="ghost" icon="diff" title="Compare with server (diff editor)" aria-label={`Compare ${resourceLabel(i)} with server`} onClick={onCompare} />}
          {i.action === "drift" && <Button small variant="ghost" icon="eye" title="View the server definition" aria-label={`View ${resourceLabel(i)} on server`} onClick={onView} />}
          {i.file && <Button small variant="ghost" icon="go-to-file" title={`Open ${i.file}`} aria-label={`Open ${i.file}`} onClick={onOpen} />}
        </span>
      </div>
      {i.file && <div class="pl-file mono" title={i.file}>{i.file}</div>}
      {open && hasBody && (
        <div class="pl-res-body" id={bodyId}>
          {i.error && (
            <div class="pl-callout pl-tone-danger" role="alert">
              <Icon name="error" />
              <span>{i.error}</span>
            </div>
          )}
          {i.blocked && (
            <div class="pl-callout pl-tone-danger">
              <Icon name="lock" />
              <span>
                <b>Cannot be applied as-is:</b> {i.blocked}. Revert those fields in the file, or recreate the resource.
              </span>
            </div>
          )}
          {progress?.state === "failed" && (
            <div class="pl-callout pl-tone-danger" role="alert">
              <Icon name="error" />
              <span>
                <b>Apply failed:</b> {progress.message}
              </span>
            </div>
          )}
          {i.action === "update" && <DiffTable item={i} lines={i.changes} mode="change" />}
          {i.action === "create" && i.fields && <DiffTable item={i} lines={i.fields} mode="create" />}
          {i.action === "drift" && (
            <>
              <p class="pl-drift-note">
                Exists on the server but has no file in this folder. Apply never deletes it — add it to the folder to manage it here.
              </p>
              {i.fields && <DiffTable item={i} lines={i.fields} mode="server" />}
            </>
          )}
          {i.warnings.map((w) => (
            <div key={w} class="pl-note pl-tone-warn">
              <Icon name="warning" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Side cards
// ---------------------------------------------------------------------------------------------

function SubfolderChips({ dirs, onPlan }: { dirs: string[]; onPlan: (dir: string) => void }) {
  return (
    <span class="pl-subfolders">
      {dirs.map((d) => (
        <Chip key={d} size="sm" mono icon="folder" title={`Plan ${d} (opens its own plan)`} onClick={() => onPlan(d)}>
          {d}
        </Chip>
      ))}
    </span>
  );
}

function TargetCard({ plan, conn, onPlanSubfolder }: { plan: PlanResult; conn: PlanConnection; onPlanSubfolder: (dir: string) => void }) {
  const now = useNow(5000);
  const subs = plan.subfolders ?? [];
  return (
    <Card title="Target" icon="server-environment">
      <KeyValueGrid
        dense
        columns={1}
        items={[
          { label: "Connection", value: conn.name, mono: true, hint: "Remembered for this folder. Change it with the plug button in the header." },
          { label: "Environment", value: conn.env ? { dev: "Development", test: "Test", staging: "Staging", prod: "Production" }[conn.env] : "Not set", tone: conn.env === "prod" ? "danger" : undefined },
          { label: "Server", value: conn.server, mono: true },
          { label: "URL", value: conn.url, mono: true, copy: conn.url },
          { label: "Folder", value: plan.folderLabel, mono: true, copy: plan.folder },
          { label: "Files", value: `${plan.files} config file${plan.files === 1 ? "" : "s"}` },
          { label: "Planned", value: `${new Date(plan.generatedAt).toLocaleTimeString()} · ${fmtAgoShort(plan.generatedAt, now)}`, hint: `Computed in ${plan.durationMs} ms` },
          ...(subs.length
            ? [{ label: "Subfolders", value: <SubfolderChips dirs={subs} onPlan={onPlanSubfolder} />, hint: "These subfolders have config files of their own. They are not part of this plan: each folder is planned against its own target connection." }]
            : []),
        ]}
      />
    </Card>
  );
}

function CompositionCard({ plan }: { plan: PlanResult }) {
  const segs = PLAN_ACTIONS.map((a) => ({ id: a, label: `${ACTION_MARKER[a]} ${a === "error" ? "errors" : a === "drift" ? "drift" : `${ACTION_TEXT[a]}`}`, value: plan.counts[a], tone: ACTION_TONE[a], hint: ACTION_HINT[a] })).filter((s) => s.value > 0);
  return (
    <Card title="Composition" subtitle="resources by action" icon="pie-chart" tableView={() => <ItemsTable items={segs.map((s) => ({ label: s.label, value: s.value }))} labelHeader="Action" valueHeader="Resources" caption="Resources by plan action" />}>
      <SegmentBar label="Plan composition: resources by action" segments={segs} unit="count" variant="tall" print="value" legend="values" />
    </Card>
  );
}

function FieldsCard({ plan }: { plan: PlanResult }) {
  const items = useMemo(() => {
    // Distinct resources per top-level field (metadata.a + metadata.b in one stream count once).
    const byField = new Map<string, Set<string>>();
    for (const i of plan.items) {
      if (i.action !== "update") continue;
      for (const c of i.changes) {
        const field = c.path.split(/[.[]/)[0];
        if (!byField.has(field)) byField.set(field, new Set());
        byField.get(field)!.add(i.id);
      }
    }
    return [...byField].map(([label, ids]) => ({ id: label, label, value: ids.size }));
  }, [plan]);
  // "Other" sums the folded fields, so the unit is field changes (one per field and resource).
  return (
    <Card title="Changed fields" subtitle="field changes across updated resources" icon="symbol-field" tableView={items.length ? () => <ItemsTable items={items} labelHeader="Field" valueHeader="Resources changing it" mono caption="Changed fields" /> : undefined}>
      {items.length ? (
        <BarList items={items} label="Changed fields: number of updated resources that change each field" mono limit={8} format={(v) => plural(v, "change")} />
      ) : (
        <EmptyState compact kind="success" title="No field changes">
          No existing resource needs an update.
        </EmptyState>
      )}
    </Card>
  );
}

const ACTION_HINT: Record<PlanAction, string> = {
  create: "Defined in the folder, missing on the server: Apply creates it",
  update: "Differs from the server: only the keys present in the file are compared",
  unchanged: "Matches the server",
  drift: "On the server but not in this folder: Apply never deletes it",
  error: "The file is invalid or cannot be planned: fix it and re-plan",
};

function LegendCard() {
  return (
    <Card title="Reading the plan" icon="book" collapsible>
      <ul class="pl-legend">
        {PLAN_ACTIONS.map((a) => (
          <li key={a}>
            <span class={cx("pl-mark", `pl-tone-${ACTION_TONE[a]}`)} aria-hidden="true">
              {ACTION_MARKER[a]}
            </span>
            <span>
              <b>{a === "error" ? "Error" : a[0].toUpperCase() + a.slice(1)}</b> — {ACTION_HINT[a]}.
            </span>
          </li>
        ))}
      </ul>
      <ul class="pl-tips">
        <li>Fields you omit from a file keep their server value.</li>
        <li>
          Durations in <span class="mono">*.stream.json</span> / <span class="mono">*.consumer.json</span> are nanoseconds; KV <span class="mono">ttl</span> accepts <span class="mono">"24h"</span>.
        </li>
        <li>
          <Icon name="lock" /> Immutable changes (storage, retention ↔ workqueue, ack policy…) block the apply.
        </li>
        <li>
          Shortcuts: <Kbd>R</Kbd> re-plan · <Kbd>/</Kbd> filter · <Kbd>E</Kbd> expand all
        </li>
      </ul>
    </Card>
  );
}

function ApplyCard({ summary, progress, total, onDismiss, items }: { summary: ApplySummary | null; progress: Record<string, ApplyProgress>; total: number; onDismiss: () => void; items: Map<string, PlanItem> }) {
  const vals = Object.values(progress);
  const done = vals.filter((p) => p.state === "done" || p.state === "failed" || p.state === "skipped").length;
  // The host can add items (a stream that a selected consumer depends on), so count what it reports.
  total = Math.max(total, vals.length);
  if (!summary) {
    const running = vals.find((p) => p.state === "running");
    const runningItem = running ? items.get(running.id) : undefined;
    return (
      <Card title="Applying changes…" icon="cloud-upload" tone="info">
        <div class="pl-apply-progress" role="status" aria-live="polite">
          <Meter value={done} max={Math.max(total, 1)} label={runningItem ? `Applying ${resourceLabel(runningItem)}` : "Waiting for confirmation"} show="none" tone="info" size="sm" />
          <span class="pl-apply-count tabular">
            {done} / {total}
          </span>
        </div>
      </Card>
    );
  }
  const tone: Tone = summary.failed ? "danger" : summary.skipped ? "warn" : "ok";
  const rows = summary.results.map((r) => ({ ...r, item: items.get(r.id) }));
  const cols: Column<(typeof rows)[number]>[] = [
    { key: "resource", header: "Resource", mono: true, value: (r) => (r.item ? resourceLabel(r.item) : r.id) },
    { key: "kind", header: "Kind", value: (r) => (r.item?.kind ? KIND_LABEL[r.item.kind] : ""), hideBelow: "sm" },
    {
      key: "state",
      header: "Result",
      value: (r) => r.state,
      render: (r) => <ProgressBadge p={r} />,
    },
    { key: "message", header: "Details", value: (r) => (r.state === "done" ? "" : (r.message ?? "")), render: (r) => <span class={cx(r.state === "failed" && "tone-danger")}>{r.state === "done" ? "" : r.message}</span> },
  ];
  return (
    <Card
      title={summary.failed ? "Apply finished with errors" : "Apply complete"}
      subtitle={`${summary.applied} applied · ${summary.failed} failed · ${summary.skipped} skipped · ${(summary.durationMs / 1000).toFixed(1)} s`}
      icon={summary.failed ? "error" : "pass"}
      tone={tone}
      flush
      actions={<Button variant="ghost" small icon="close" title="Dismiss" aria-label="Dismiss apply summary" onClick={onDismiss} />}
    >
      <DataTable label="Apply results" columns={cols} rows={rows} rowKey={(r) => r.id} dense maxHeight={220} rowTone={(r) => (r.state === "failed" ? "danger" : r.state === "skipped" ? "warn" : undefined)} />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------------------------

function App() {
  const [conn, setConn] = useState<PlanConnection | undefined>(init.connection);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [progress, setProgress] = useState<Record<string, ApplyProgress>>({});
  const [applying, setApplying] = useState<{ total: number } | null>(null);
  const [summary, setSummary] = useState<ApplySummary | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [query, setQuery] = useState(saved?.query ?? "");
  const [actions, setActions] = useState<Set<PlanAction>>(new Set(saved?.actions ?? []));
  const [kinds, setKinds] = useState<Set<ResourceKind>>(new Set(saved?.kinds ?? []));
  const [showUnchanged, setShowUnchanged] = useState(saved?.showUnchanged ?? false);
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const filterRef = useRef<HTMLInputElement>(null);
  const planSeq = useRef(0);
  const connRef = useRef(conn);
  connRef.current = conn;
  const planRef = useRef(plan);
  planRef.current = plan;

  useEffect(() => setState<UiState>({ query, actions: [...actions], kinds: [...kinds], showUnchanged }), [query, actions, kinds, showUnchanged]);

  const connected = conn?.state === "connected";

  const runPlan = async () => {
    const seq = ++planSeq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await rpc<PlanResult>("plan");
      if (seq !== planSeq.current) return;
      setPlan(r);
      setConn(r.connection);
      setStale(false);
    } catch (e) {
      if (seq === planSeq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === planSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    const offs = [
      onEvent<PlanConnection | undefined>("connection", (c) => {
        const prev = connRef.current;
        connRef.current = c;
        setConn(c);
        // Another target: the old plan describes a different server, never show it under the new name.
        if (prev?.id !== c?.id) {
          planSeq.current++;
          setPlan(null);
          setError(null);
          setLoading(false);
          setSummary(null);
          setProgress({});
        }
        if (c?.state === "connected" && (prev?.state !== "connected" || prev?.id !== c.id)) void runPlan();
      }),
      onEvent("filesChanged", () => {
        // An empty folder just got files (e.g. "Export from …"): plan them right away.
        if (planRef.current?.files === 0 && connRef.current?.state === "connected") void runPlan();
        else setStale(true);
      }),
      onEvent("replan", () => void runPlan()),
      onEvent<ApplyProgress>("progress", (p) => setProgress((prev) => ({ ...prev, [p.id]: p }))),
    ];
    if (init.connection?.state === "connected") void runPlan();
    return () => offs.forEach((o) => o());
  }, []);

  const showFlash = (m: string) => {
    setFlash(m);
    setTimeout(() => setFlash((cur) => (cur === m ? null : cur)), 3500);
  };

  const call = async (method: string, params?: unknown) => {
    try {
      return await rpc(method, params);
    } catch (e) {
      showFlash(e instanceof Error ? e.message : String(e));
      return undefined;
    }
  };

  const selectConnection = async () => {
    const c = (await call("selectConnection")) as PlanConnection | null | undefined;
    if (c) {
      const changed = connRef.current?.id !== c.id;
      connRef.current = c;
      setConn(c);
      if (changed) {
        setPlan(null);
        setSummary(null);
        setProgress({});
      }
      // The host also pushes a "connection" event for a new target, which already re-plans.
      if (changed && c.state === "connected") void runPlan();
    }
  };
  const connect = async () => {
    const c = await call("connect");
    if (c) {
      setConn(c as PlanConnection);
      void runPlan();
    }
  };

  const applyIds = async (ids: string[]) => {
    if (!ids.length) return;
    setSummary(null);
    setProgress({});
    setApplying({ total: ids.length });
    try {
      const r = await rpc<ApplySummary>("apply", { ids });
      if (r.cancelled) {
        setProgress({});
        return;
      }
      setSummary(r);
      await runPlan();
    } catch (e) {
      showFlash(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(null);
    }
  };

  const planSubfolder = (dir: string) => void call("planSubfolder", { dir });

  const adopt = async (ids: string[]) => {
    const files = (await call("adopt", { ids })) as string[] | undefined;
    if (files?.length) {
      showFlash(`Added ${files.join(", ")}`);
      await runPlan();
    }
  };

  // KpiTile has no pressed state: expose the filter toggle state of the KPI buttons to assistive tech.
  useEffect(() => {
    document.querySelectorAll<HTMLElement>("button.pl-kpi").forEach((b) => b.setAttribute("aria-pressed", String(b.classList.contains("pl-kpi-on"))));
  });

  // Keyboard shortcuts (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        if (connected && !applying) void runPlan();
      } else if (e.key === "/") {
        e.preventDefault();
        filterRef.current?.focus();
      } else if (e.key === "e" || e.key === "E") {
        e.preventDefault();
        expandAll(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const items = plan?.items ?? [];
  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [plan]);
  const applicable = items.filter(isApplicable);
  const readOnly = !!conn?.readOnly;
  const prod = conn?.env === "prod";
  const canApply = connected && !readOnly && !applying;
  const applyReason = readOnly ? "Read-only connection: applying is blocked" : !connected ? "Not connected" : applying ? "An apply is running" : undefined;

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = items.filter((i) => {
    if (actions.size ? !actions.has(i.action) : !showUnchanged && i.action === "unchanged") return false;
    if (kinds.size && (!i.kind || !kinds.has(i.kind))) return false;
    if (!terms.length) return true;
    const hay = [i.name, i.stream, i.file, i.kind, i.action, ...i.changes.map((c) => c.path)].filter(Boolean).join(" ").toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  const isOpen = (i: PlanItem) => overrides.get(i.id) ?? (i.action === "update" || i.action === "error" || (i.action === "create" && (i.fields?.length ?? 0) <= 14));
  const toggle = (i: PlanItem) => setOverrides((m) => new Map(m).set(i.id, !isOpen(i)));
  const expandAll = (open: boolean) => setOverrides(new Map(visible.map((i) => [i.id, open])));
  const toggleIn = <T,>(set: Set<T>, v: T, apply: (s: Set<T>) => void) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    apply(n);
  };
  const clearFilters = () => {
    setQuery("");
    setActions(new Set());
    setKinds(new Set());
  };

  const kindCount = (k: ResourceKind) => items.filter((i) => i.kind === k).length;
  const breakdown = (a: PlanAction) => {
    const parts = KIND_ORDER.map((k) => [k, items.filter((i) => i.action === a && i.kind === k).length] as const).filter(([, n]) => n);
    return parts.length ? parts.map(([k, n]) => (k === "kv" ? `${n} KV` : plural(n, k))).join(" · ") : "none";
  };

  const applyAllLabel = applicable.length ? `Apply ${applicable.length} change${applicable.length === 1 ? "" : "s"}` : "Apply";
  const header = (
    <DashboardHeader
      icon="checklist"
      title="Config plan"
      subtitle={
        <>
          <span class="mono">{init.folderLabel}</span>
          <Icon name="arrow-right" class="pl-sub-arrow" />
          <span class="mono">{conn?.name ?? "no connection"}</span>
          {conn?.server && <span class="muted"> · {conn.server}</span>}
        </>
      }
      env={conn?.env}
      readOnly={readOnly}
      connectionName={conn?.name}
      status={statusOf(conn)}
      prodMessage={readOnly ? "Read-only — you can review the plan but not apply it." : "Apply changes the live JetStream configuration — you will be asked to type the name to confirm."}
      actions={
        <>
          <Button variant="ghost" small icon="plug" title="Change the target connection for this folder" onClick={selectConnection}>
            Connection
          </Button>
          <Button variant="ghost" small icon="refresh" title="Re-plan (R)" aria-label="Re-plan" busy={loading} disabled={!connected || !!applying} onClick={() => void runPlan()} />
          <Button
            variant={prod ? "danger" : "primary"}
            small
            icon={prod ? "flame" : "cloud-upload"}
            busy={!!applying}
            disabled={!plan || !applicable.length || !canApply}
            title={applyReason ?? (applicable.length ? `Create / update ${applicable.length} resources on ${conn?.name}` : "Nothing to apply")}
            onClick={() => void applyIds(applicable.map((i) => i.id))}
          >
            {applyAllLabel}
          </Button>
        </>
      }
    />
  );

  let body: ComponentChildren;
  if (!conn) {
    body = (
      <EmptyState kind="no-connection" title="No target connection" primary={{ label: "Choose connection", icon: "plug", onClick: () => void selectConnection() }}>
        Pick the NATS connection that the config files in <span class="mono">{init.folderLabel}</span> are compared with and applied to.
      </EmptyState>
    );
  } else if (!connected && !plan) {
    body = (
      <EmptyState
        kind="no-connection"
        title={conn.state === "connecting" ? "Connecting…" : `Not connected to ${conn.name}`}
        primary={{ label: "Connect", icon: "plug", onClick: () => void connect() }}
        secondary={{ label: "Choose another connection", icon: "arrow-swap", onClick: () => void selectConnection() }}
      >
        The plan compares <span class="mono">{init.folderLabel}</span> with the live server, so it needs a connection.
      </EmptyState>
    );
  } else if (!plan && error) {
    body = (
      <EmptyState kind="error" title="Could not compute the plan" primary={{ label: "Retry", icon: "refresh", onClick: () => void runPlan() }}>
        {error}
      </EmptyState>
    );
  } else if (!plan) {
    body = (
      <>
        <KpiRow min={150} label="Plan summary">
          {["To create", "To update", "Unchanged", "Drift", "Errors"].map((l) => (
            <KpiTile key={l} label={l} value={null} loading />
          ))}
        </KpiRow>
        <Grid>
          <Card span={8} title="Resources" loading minHeight={320} />
          <Cell span={4}>
            <Card title="Target" loading minHeight={200} />
          </Cell>
        </Grid>
      </>
    );
  } else if (plan.files === 0) {
    body = (
      <EmptyState
        kind="no-data"
        title={`No config files in ${plan.folderLabel}`}
        primary={{ label: `Export from ${conn.name}`, icon: "desktop-download", onClick: () => void call("exportHere") }}
        secondary={{ label: "Reveal folder", icon: "folder-opened", onClick: () => void call("revealFolder") }}
      >
        {plan.subfolders?.length ? (
          <>
            This folder has no config files of its own, but {plan.subfolders.length === 1 ? "this subfolder does" : "these subfolders do"}. Each folder is planned separately against its own target connection: open one, or export into this folder.
            <div class="pl-subfolders-empty">
              <SubfolderChips dirs={plan.subfolders} onPlan={planSubfolder} />
            </div>
          </>
        ) : (
          <>
            Add <span class="mono">&lt;STREAM&gt;.stream.json</span>, <span class="mono">&lt;STREAM&gt;.&lt;CONSUMER&gt;.consumer.json</span> or <span class="mono">&lt;BUCKET&gt;.kv.json</span> files, or export the current server configuration to start from.
          </>
        )}
      </EmptyState>
    );
  } else {
    const c = plan.counts;
    const inSync = c.create + c.update + c.error === 0;
    const kpi = (a: PlanAction, label: string, tone: Tone | undefined, hint: string) => (
      <KpiTile
        label={label}
        value={c[a]}
        unit="count"
        tone={c[a] ? tone : undefined}
        hint={hint}
        sub={breakdown(a)}
        onClick={() => toggleIn(actions, a, setActions)}
        class={cx("pl-kpi", actions.has(a) && "pl-kpi-on")}
      />
    );
    const groups = KIND_ORDER.map((k) => [k, visible.filter((i) => i.kind === k)] as const).filter(([, list]) => list.length);
    const loose = visible.filter((i) => !i.kind);
    body = (
      <>
        {stale && (
          <div class="banner banner-info pl-banner" role="status">
            <Icon name="info" />
            <span class="banner-text">Config files changed since this plan was computed.</span>
            <Button small variant="secondary" icon="refresh" onClick={() => void runPlan()} disabled={!connected}>
              Re-plan
            </Button>
          </div>
        )}
        {!plan.jetstream && (
          <div class="banner banner-warn pl-banner" role="alert">
            <Icon name="warning" />
            <span class="banner-text">
              JetStream is not enabled for this account on <span class="mono">{conn.name}</span>: nothing can be planned.
            </span>
          </div>
        )}
        {(applying || summary) && <ApplyCard summary={summary} progress={progress} total={applying?.total ?? 0} items={itemMap} onDismiss={() => setSummary(null)} />}
        <KpiRow min={150} label="Plan summary">
          {kpi("create", "To create", "ok", "Defined in the folder, missing on the server. Click to filter.")}
          {kpi("update", "To update", "warn", "Differs from the server (only keys present in the file are compared). Click to filter.")}
          {kpi("unchanged", "Unchanged", undefined, "Matches the server. Click to filter.")}
          {kpi("drift", "Drift", "info", "On the server but not in this folder. Apply never deletes them. Click to filter.")}
          {kpi("error", "Errors", "danger", "Invalid files or resources that cannot be planned. Click to filter.")}
        </KpiRow>
        <Grid>
          <Card
            span={8}
            title="Resources"
            icon="list-tree"
            subtitle={`${visible.length} of ${items.length} shown`}
            flush
            stale={loading || !connected}
            actions={
              <>
                <Button variant="ghost" small icon="expand-all" title="Expand all (E)" aria-label="Expand all" onClick={() => expandAll(true)} />
                <Button variant="ghost" small icon="collapse-all" title="Collapse all" aria-label="Collapse all" onClick={() => expandAll(false)} />
              </>
            }
          >
            <div class="pl-resources">
            <div class="pl-filters" role="toolbar" aria-label="Filter resources">
              <label class="pl-search">
                <Icon name="filter" />
                <input ref={filterRef} class="input input-sm" type="search" name="plan-filter" value={query} placeholder="Filter by name, file or field  ( / )" aria-label="Filter resources" onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
              </label>
              {KIND_ORDER.filter((k) => kindCount(k)).map((k) => (
                <Chip key={k} size="sm" selected={kinds.has(k)} onClick={() => toggleIn(kinds, k, setKinds)} title={`Show only ${KIND_GROUP[k].toLowerCase()}`}>
                  {KIND_GROUP[k]} {kindCount(k)}
                </Chip>
              ))}
              {c.unchanged > 0 && !actions.size && (
                <Chip size="sm" icon={showUnchanged ? "eye" : "eye-closed"} selected={showUnchanged} onClick={() => setShowUnchanged((v) => !v)} title="Show resources that already match the server">
                  Unchanged {c.unchanged}
                </Chip>
              )}
              {(actions.size > 0 || kinds.size > 0 || query) && (
                <button type="button" class="ds-link pl-clear" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </div>
            {inSync && !actions.size && !query && (
              <div class="pl-insync">
                <EmptyState compact kind="success" title="Everything is in sync">
                  {conn.name} matches all {plan.files} config file{plan.files === 1 ? "" : "s"}
                  {c.drift ? ` · ${c.drift} server resource${c.drift === 1 ? " is" : "s are"} not in the folder (drift)` : ""}.
                </EmptyState>
              </div>
            )}
            {!visible.length && !(inSync && !actions.size && !query) && (
              <EmptyState compact kind="search" title="No resources match" secondary={{ label: "Clear filters", icon: "clear-all", onClick: clearFilters }}>
                {c.unchanged && !showUnchanged && !actions.size ? `${c.unchanged} unchanged resource${c.unchanged === 1 ? " is" : "s are"} hidden.` : "Try a different filter."}
              </EmptyState>
            )}
            {groups.map(([k, list]) => (
              <section key={k} class="pl-group" aria-label={KIND_GROUP[k]}>
                <h3 class="pl-group-title">
                  {KIND_GROUP[k]} <span class="pl-group-count">{list.length}</span>
                </h3>
                <ul class="pl-list">
                  {list.map((i) => (
                    <ResourceBlock
                      key={i.id}
                      item={i}
                      open={isOpen(i)}
                      onToggle={() => toggle(i)}
                      progress={progress[i.id]}
                      canApply={canApply}
                      applyBlockedReason={applyReason}
                      busy={!!applying}
                      onApply={() => void applyIds([i.id])}
                      onCompare={() => void call("compare", { id: i.id })}
                      onOpen={() => i.file && void call("openFile", { file: i.file })}
                      onAdopt={() => void adopt([i.id])}
                      onView={() => void call("viewServer", { id: i.id })}
                    />
                  ))}
                </ul>
              </section>
            ))}
            {loose.length > 0 && (
              <section class="pl-group" aria-label="Unreadable files">
                <h3 class="pl-group-title">
                  Files <span class="pl-group-count">{loose.length}</span>
                </h3>
                <ul class="pl-list">
                  {loose.map((i) => (
                    <ResourceBlock key={i.id} item={i} open={isOpen(i)} onToggle={() => toggle(i)} canApply={false} busy={false} onApply={() => undefined} onCompare={() => undefined} onOpen={() => i.file && void call("openFile", { file: i.file })} onAdopt={() => undefined} onView={() => undefined} />
                  ))}
                </ul>
              </section>
            )}
            </div>
          </Card>
          <Cell span={4} class="pl-side-cell">
            <div class="pl-side">
              <TargetCard plan={plan} conn={conn} onPlanSubfolder={planSubfolder} />
              <CompositionCard plan={plan} />
              <FieldsCard plan={plan} />
              <LegendCard />
            </div>
          </Cell>
        </Grid>
      </>
    );
  }

  return (
    <DashboardPage header={header} label="Config plan">
      {conn && conn.state !== "connected" && (plan || conn.state === "reconnecting") && <ConnectionBanner state={conn.state} since={plan?.generatedAt} onRetry={conn.state === "disconnected" || conn.state === "error" ? () => void connect() : undefined} />}
      {flash && (
        <div class="banner banner-info pl-banner pl-flash" role="status">
          <Icon name="info" />
          <span class="banner-text">{flash}</span>
          <Button variant="ghost" small icon="close" title="Dismiss" aria-label="Dismiss" onClick={() => setFlash(null)} />
        </div>
      )}
      {body}
    </DashboardPage>
  );
}

render(<App />, document.getElementById("root")!);
