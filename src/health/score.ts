// Health score, report assembly and the Markdown export. Pure (no vscode) — unit tested.

import { fmtBytes, fmtMillis, fmtNumber } from "../shared/format";
import { isTransientConsumer } from "./checks";
import {
  CATEGORIES,
  CATEGORY_LABEL,
  compareFindings,
  countBySeverity,
  countsText,
  KV_PREFIX,
  OBJ_PREFIX,
  scoreLabel,
  SEVERITIES,
  SEVERITY_LABEL,
  SEVERITY_PLURAL,
  targetKey,
  targetLabel,
  worstOf,
  type CategorySummary,
  type CheckThresholds,
  type Finding,
  type FindingTarget,
  type HealthReport,
  type HealthSnapshot,
  type ResourceRow,
  type Severity,
} from "./model";

/**
 * Penalty per severity saturates (cap) so many findings of one kind cannot dominate:
 * penalty = cap × (1 − e^(−Σweight × per / cap)). Warnings alone never go below 60
 * ("Degraded"); three errors reach "Critical".
 */
export const SEVERITY_PENALTY: Record<Severity, { per: number; cap: number }> = {
  error: { per: 22, cap: 70 },
  warning: { per: 6, cap: 40 },
  info: { per: 1, cap: 10 },
};

export function healthScore(findings: readonly Pick<Finding, "severity" | "weight">[]): number {
  const sums: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) sums[f.severity] += f.weight ?? 1;
  let penalty = 0;
  for (const s of SEVERITIES) {
    const { per, cap } = SEVERITY_PENALTY[s];
    penalty += cap * (1 - Math.exp((-sums[s] * per) / cap));
  }
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

function summarizeCategories(findings: readonly Finding[]): CategorySummary[] {
  return CATEGORIES.map((category) => {
    const list = findings.filter((f) => f.category === category);
    const c = countBySeverity(list);
    return { category, label: CATEGORY_LABEL[category], count: list.length, errors: c.error, warnings: c.warning, infos: c.info, score: healthScore(list) };
  });
}

function streamTarget(connId: string, name: string): FindingTarget {
  if (name.startsWith(KV_PREFIX)) return { kind: "kv", connId, bucket: name.slice(KV_PREFIX.length), stream: name };
  if (name.startsWith(OBJ_PREFIX)) return { kind: "objectstore", connId, bucket: name.slice(OBJ_PREFIX.length), stream: name };
  return { kind: "stream", connId, stream: name };
}

/** One row per analysed resource (healthy ones included) with its worst finding. */
export function resourceRows(snap: HealthSnapshot, findings: readonly Finding[]): ResourceRow[] {
  const byKey = new Map<string, Finding[]>();
  for (const f of findings) {
    const k = targetKey(f.target);
    const list = byKey.get(k);
    if (list) list.push(f);
    else byKey.set(k, [f]);
  }
  const rows = new Map<string, ResourceRow>();
  const add = (target: FindingTarget, name: string, summary: string, extra: Partial<ResourceRow> = {}) => {
    const key = targetKey(target);
    const list = byKey.get(key) ?? [];
    const c = countBySeverity(list);
    rows.set(key, { key, kind: target.kind, name, target, worst: worstOf(list), errors: c.error, warnings: c.warning, infos: c.info, summary, ...extra });
  };
  const connId = snap.connId;
  const s = snap.server;
  add({ kind: "server", connId }, s?.name ?? "server", [s ? `v${s.version}` : undefined, s?.cluster ? `cluster ${s.cluster}` : undefined, snap.rttMs !== undefined ? `RTT ${fmtMillis(snap.rttMs)}` : undefined].filter(Boolean).join(" · "));
  if (byKey.has("connection")) add({ kind: "connection", connId }, snap.connName, snap.connectedUrl ?? "");
  if (snap.account) {
    const a = snap.account;
    add({ kind: "account", connId }, "JetStream account", `${fmtBytes(a.storage)} file · ${fmtBytes(a.memory)} memory · ${count(a.streams, "stream")} · ${count(a.consumers, "consumer")}`, { bytes: a.storage + a.memory });
  } else if (byKey.has("account")) add({ kind: "account", connId }, "JetStream account", snap.jetstream.enabled ? "" : "JetStream not enabled");

  for (const si of snap.streams) {
    const t = streamTarget(connId, si.config.name);
    const st = si.state;
    const replicas = si.config.num_replicas || 1;
    if (t.kind === "kv") add(t, t.bucket!, `${fmtNumber(st.messages)} values · ${fmtBytes(st.bytes)} · R${replicas}`, { messages: st.messages, bytes: st.bytes, replicas });
    else if (t.kind === "objectstore") add(t, t.bucket!, `${fmtBytes(st.bytes)} · R${replicas}`, { bytes: st.bytes, messages: st.messages, replicas });
    else add(t, si.config.name, `${fmtNumber(st.messages)} msgs · ${fmtBytes(st.bytes)} · R${replicas} · ${String(si.config.retention ?? "limits")}`, { messages: st.messages, bytes: st.bytes, replicas });
    const internal = t.kind !== "stream";
    for (const ci of snap.consumers[si.config.name] ?? []) {
      const ct: FindingTarget = { kind: "consumer", connId, stream: si.config.name, consumer: ci.name };
      if ((internal || isTransientConsumer(ci)) && !byKey.has(targetKey(ct))) continue;
      add(ct, ci.name, `${ci.config.deliver_subject ? "push" : "pull"} · pending ${fmtNumber(ci.num_pending)} · ack pending ${fmtNumber(ci.num_ack_pending)}`, { parent: si.config.name, pending: ci.num_pending });
    }
  }
  // Findings about resources that are not in the snapshot (should not happen, but never hide a finding).
  for (const [key, list] of byKey) {
    if (rows.has(key)) continue;
    const t = list[0].target;
    add(t, t.consumer ?? t.bucket ?? t.stream ?? targetLabel(t), "", t.kind === "consumer" ? { parent: t.stream } : {});
  }
  return [...rows.values()];
}

export function buildReport(snap: HealthSnapshot, findings: readonly Finding[], thresholds: CheckThresholds): HealthReport {
  const sorted = [...findings].sort(compareFindings);
  const streams = snap.streams.filter((s) => !s.config.name.startsWith(KV_PREFIX) && !s.config.name.startsWith(OBJ_PREFIX));
  const consumers = streams.reduce((n, s) => n + (snap.consumers[s.config.name] ?? []).filter((c) => !isTransientConsumer(c)).length, 0);
  const a = snap.account;
  return {
    connId: snap.connId,
    connName: snap.connName,
    at: snap.at,
    durationMs: snap.durationMs,
    score: healthScore(sorted),
    counts: countBySeverity(sorted),
    findings: sorted,
    categories: summarizeCategories(sorted),
    resources: resourceRows(snap, sorted),
    server: snap.server,
    connectedUrl: snap.connectedUrl,
    rttMs: snap.rttMs,
    jetstream: snap.jetstream,
    account: a
      ? {
          memory: a.memory,
          storage: a.storage,
          maxMemory: a.limits?.max_memory ?? -1,
          maxStorage: a.limits?.max_storage ?? -1,
          streams: a.streams,
          maxStreams: a.limits?.max_streams ?? -1,
          consumers: a.consumers,
          maxConsumers: a.limits?.max_consumers ?? -1,
          apiTotal: a.api?.total ?? 0,
          apiErrors: a.api?.errors ?? 0,
        }
      : undefined,
    inventory: {
      streams: streams.length,
      consumers,
      kv: snap.streams.filter((s) => s.config.name.startsWith(KV_PREFIX)).length,
      obj: snap.streams.filter((s) => s.config.name.startsWith(OBJ_PREFIX)).length,
    },
    monitor: {
      url: snap.monitor.url,
      reachable: snap.monitor.reachable,
      error: snap.monitor.error,
      healthz: snap.monitor.healthz?.status,
      slowConsumers: snap.monitor.varz?.slow_consumers,
    },
    notes: snap.notes,
    thresholds,
  };
}

/** Summary for src/core/healthBus.ts (top = up to 5 most important findings). */
export function summarize(r: HealthReport): { connId: string; score: number; errors: number; warnings: number; infos: number; at: string; top: { severity: Severity; title: string }[] } {
  return {
    connId: r.connId,
    score: r.score,
    errors: r.counts.error,
    warnings: r.counts.warning,
    infos: r.counts.info,
    at: new Date(r.at).toISOString(),
    top: r.findings.slice(0, 5).map((f) => ({ severity: f.severity, title: `${f.title} (${targetLabel(f.target)})` })),
  };
}

// ---------------------------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------------------------

const count = (n: number, one: string): string => `${fmtNumber(n)} ${n === 1 ? one : `${one}s`}`;
const cell = (s: string | number | undefined): string => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function toMarkdown(r: HealthReport, opts: { environment?: string } = {}): string {
  const L: string[] = [];
  const when = new Date(r.at);
  const iso = when.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  L.push(`# NATS health report: ${r.connName}`, "");
  L.push(`**Score ${r.score}/100 (${scoreLabel(r.score)})** · ${countsText(r.counts)}`, "");
  const facts: [string, string][] = [
    ["Checked", `${iso} (took ${fmtMillis(r.durationMs)})`],
    ["Connection", `${r.connName}${opts.environment ? ` (${opts.environment})` : ""}${r.connectedUrl ? ` · \`${r.connectedUrl}\`` : ""}`],
  ];
  if (r.server) facts.push(["Server", `\`${r.server.name}\` v${r.server.version}${r.server.cluster ? ` · cluster \`${r.server.cluster}\`` : ""}`]);
  if (r.rttMs !== undefined) facts.push(["RTT", fmtMillis(r.rttMs)]);
  facts.push(["JetStream", r.jetstream.enabled ? `enabled · ${r.inventory.streams} streams · ${r.inventory.consumers} consumers · ${r.inventory.kv} KV buckets · ${r.inventory.obj} object stores` : `not available${r.jetstream.reason ? ` (${r.jetstream.reason})` : ""}`]);
  if (r.account) facts.push(["Account storage", `${fmtBytes(r.account.storage)} file${r.account.maxStorage > 0 ? ` of ${fmtBytes(r.account.maxStorage)}` : ""} · ${fmtBytes(r.account.memory)} memory${r.account.maxMemory > 0 ? ` of ${fmtBytes(r.account.maxMemory)}` : ""}`]);
  facts.push(["Monitoring", r.monitor.url ? `${r.monitor.url} · ${r.monitor.reachable ? `reachable${r.monitor.healthz ? ` · healthz ${r.monitor.healthz}` : ""}` : "unreachable"}` : "not configured"]);
  L.push("| | |", "| --- | --- |", ...facts.map(([k, v]) => `| ${k} | ${cell(v)} |`), "");

  L.push("## Summary by category", "", "| Category | Errors | Warnings | Info | Score |", "| --- | ---: | ---: | ---: | ---: |");
  for (const c of r.categories) L.push(`| ${c.label} | ${c.errors} | ${c.warnings} | ${c.infos} | ${c.score} |`);
  L.push("");

  L.push("## Findings", "");
  if (!r.findings.length) L.push("No problems found. All checks passed.", "");
  let n = 0;
  for (const sev of SEVERITIES) {
    const list = r.findings.filter((f) => f.severity === sev);
    if (!list.length) continue;
    L.push(`### ${SEVERITY_PLURAL[sev]} (${list.length})`, "");
    for (const f of list) {
      n++;
      L.push(`#### ${n}. ${f.title}: \`${targetLabel(f.target)}\``, "");
      L.push(`- **Severity:** ${SEVERITY_LABEL[f.severity]} · **Category:** ${CATEGORY_LABEL[f.category]} · **Check:** \`${f.id}\``);
      L.push(`- **Observed:** ${f.detail}`);
      L.push(`- **Why it matters / best practice:** ${f.recommendation}`);
      if (f.fix) L.push(`- **Suggested action:** ${f.fix.label} (\`${f.fix.command}\`)`);
      if (f.docs) L.push(`- **Docs:** ${f.docs}`);
      L.push("");
    }
  }

  const affected = r.resources.filter((x) => x.worst);
  L.push("## Resources with findings", "");
  if (!affected.length) L.push("None.", "");
  else {
    L.push("| Resource | Kind | Worst | Errors | Warnings | Info | Summary |", "| --- | --- | --- | ---: | ---: | ---: | --- |");
    for (const x of affected.sort((a, b) => (a.worst === b.worst ? 0 : SEVERITIES.indexOf(a.worst!) - SEVERITIES.indexOf(b.worst!)))) {
      L.push(`| \`${cell(x.parent ? `${x.parent} › ${x.name}` : x.name)}\` | ${x.kind} | ${SEVERITY_LABEL[x.worst!]} | ${x.errors} | ${x.warnings} | ${x.infos} | ${cell(x.summary)} |`);
    }
    L.push("");
  }

  if (r.notes.length) {
    L.push("## Collection notes", "");
    for (const note of r.notes) L.push(`- **${note.scope}${note.stream ? ` (${note.stream})` : ""}:** ${note.message}`);
    L.push("");
  }

  const t = r.thresholds;
  L.push(
    "## Thresholds",
    "",
    `Pending warning ${fmtNumber(t.pendingWarning)} msgs · ack pending ${Math.round(t.ackPendingRatio * 100)}% of max_ack_pending · storage warning ${Math.round(t.storageWarningRatio * 100)}% / error ${Math.round(t.storageErrorRatio * 100)}% · RTT warning ${fmtMillis(t.rttWarningMs)} · idle pull consumer ${fmtMillis(t.idleConsumerMs)} · minimum server version ${t.minServerVersion}.`,
    "",
    "_Generated by NATS Admin for VS Code._",
    "",
  );
  return L.join("\n");
}
