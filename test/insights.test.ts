// Stream & KV insights: subject counting / hierarchy, dashboard model (rates, consumer status,
// limits), KV overview helpers and command arguments. The live suite spawns a throwaway
// nats-server -js (skipped when nats-server is not on PATH).

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { AckPolicy, DiscardPolicy, RetentionPolicy, jetstream, jetstreamManager, type ConsumerInfo, type JetStreamClient, type JetStreamManager, type StreamInfo } from "@nats-io/jetstream";
import {
  buildSubjectTree,
  fetchSubjectCounts,
  findSubjectNode,
  folderFilter,
  share,
  subjectTreemap,
  tileFilter,
  topSubjects,
  treemapStart,
  type SubjectCount,
  type TreemapNode,
} from "../src/nats/subjects";
import {
  consumerRow,
  consumerStatus,
  deriveRates,
  discardNote,
  lagSegments,
  limitTone,
  limitUsages,
  retentionNote,
  streamStatus,
  streamView,
  timeToLimit,
  type ConsumerRow,
  type StreamSnapshot,
  type StreamView,
} from "../src/insights/model";
import { activityWindow, kindSlot, prefixTreemap, stepLabel, tileKey, VALUE_KINDS } from "../src/insights/kvInsights";
import { streamArgOf, subjectTargetOf } from "../src/insights/args";
import { recentMessages } from "../src/insights/recent";

const counts: SubjectCount[] = [
  { subject: "orders.eu.created", messages: 50 },
  { subject: "orders.eu.paid", messages: 30 },
  { subject: "orders.us.created", messages: 15 },
  { subject: "orders.eu", messages: 5 },
  { subject: "audit", messages: 2 },
];

const sum = (t: TreemapNode): number => (t.children?.length ? t.children.reduce((a, c) => a + sum(c), 0) : (t.value ?? 0));

describe("subject hierarchy (pure)", () => {
  test("topSubjects ranks by messages, ties in natural order", () => {
    const ranked = topSubjects([...counts, { subject: "orders.us.paid", messages: 15 }], 4);
    assert.deepEqual(
      ranked.map((s) => s.subject),
      ["orders.eu.created", "orders.eu.paid", "orders.us.created", "orders.us.paid"],
    );
    assert.equal(topSubjects(counts, 0).length, 0);
  });

  test("buildSubjectTree sums messages and subjects per token folder", () => {
    const root = buildSubjectTree(counts);
    assert.equal(root.messages, 102);
    assert.equal(root.subjects, 5);
    const orders = findSubjectNode(root, "orders")!;
    assert.equal(orders.messages, 100);
    assert.equal(orders.subjects, 4);
    assert.equal(orders.isSubject, false);
    const eu = findSubjectNode(root, "orders.eu")!;
    assert.equal(eu.isSubject, true, "orders.eu is a subject and a folder");
    assert.equal(eu.own, 5);
    assert.equal(eu.messages, 85);
    assert.deepEqual(
      eu.children.map((c) => c.name),
      ["created", "paid"],
    );
    // folders first, then leaves
    assert.deepEqual(
      root.children.map((c) => c.name),
      ["orders", "audit"],
    );
    assert.equal(findSubjectNode(root, "orders.nope"), undefined);
    assert.equal(findSubjectNode(root, ""), root);
  });

  test("folderFilter and share", () => {
    assert.equal(folderFilter("orders.eu"), "orders.eu.>");
    assert.equal(folderFilter(""), ">");
    assert.equal(share(25, 100), 0.25);
    assert.equal(share(1, 0), 0);
  });

  test("subjectTreemap keeps totals, adds (exact) tiles and folds the tail", () => {
    const root = buildSubjectTree(counts);
    const tiles = subjectTreemap(root);
    assert.equal(tiles.reduce((a, t) => a + sum(t), 0), 102, "treemap preserves the total");
    const orders = tiles.find((t) => t.id === "orders")!;
    const eu = orders.children!.find((t) => t.id === "orders.eu")!;
    const exact = eu.children!.find((t) => t.label === "(exact)")!;
    assert.equal(exact.value, 5);
    assert.equal(tileFilter(exact), "orders.eu");
    assert.equal(tileFilter(eu), "orders.eu.>");
    assert.equal(tileFilter({ id: "orders.eu.paid" }), "orders.eu.paid");

    const many: SubjectCount[] = Array.from({ length: 40 }, (_, i) => ({ subject: `t.s${i}`, messages: 40 - i }));
    const folded = subjectTreemap(buildSubjectTree(many), { maxChildren: 10 })[0];
    assert.equal(folded.children!.length, 10);
    const other = folded.children!.at(-1)!;
    assert.match(other.label, /^Other \(31\)$/);
    assert.equal(tileFilter(other), undefined, "Other tiles are not browsable");
    assert.equal(sum(folded), many.reduce((a, s) => a + s.messages, 0));

    const shallow = subjectTreemap(root, { maxDepth: 1 });
    const summarised = shallow.find((t) => t.id === "orders.>")!;
    assert.equal(summarised.value, 100, "folders below maxDepth are summarised with their wildcard id");
    assert.equal(tileFilter(summarised), "orders.>");
  });

  test("treemapStart skips a single top-level folder chain", () => {
    const one = buildSubjectTree([
      { subject: "app.orders.eu", messages: 1 },
      { subject: "app.orders.us", messages: 2 },
    ]);
    assert.equal(treemapStart(one).path, "app.orders");
    const mixed = buildSubjectTree(counts);
    assert.equal(treemapStart(mixed).path, "", "two top-level tokens: start at the root");
  });
});

// ---------------------------------------------------------------------------------------------

function fakeStreamInfo(over: Partial<StreamInfo["config"]> = {}, state: Partial<StreamInfo["state"]> = {}): StreamInfo {
  return {
    config: {
      name: "ORDERS",
      subjects: ["orders.>"],
      retention: "limits",
      storage: "file",
      num_replicas: 3,
      discard: "old",
      discard_new_per_subject: false,
      max_msgs: 1000,
      max_bytes: -1,
      max_age: 3_600_000_000_000,
      max_msgs_per_subject: -1,
      max_msg_size: -1,
      max_consumers: -1,
      duplicate_window: 120_000_000_000,
      sealed: false,
      deny_delete: false,
      deny_purge: false,
      allow_rollup_hdrs: false,
      allow_direct: true,
      mirror_direct: false,
      ...over,
    },
    created: "2026-11-01T00:00:00Z",
    state: {
      messages: 800,
      bytes: 80_000,
      first_seq: 201,
      first_ts: "2026-11-17T10:00:00Z",
      last_seq: 1000,
      last_ts: "2026-11-17T10:30:00Z",
      num_deleted: 0,
      deleted: [],
      lost: { msgs: null, bytes: 0 },
      consumer_count: 1,
      num_subjects: 3,
      ...state,
    },
    cluster: { name: "eu", leader: "n1", replicas: [{ name: "n2", current: true, offline: false, active: 5_000_000, lag: 0 }, { name: "n3", current: false, offline: false, active: 2_000_000_000, lag: 7 }] },
    sources: [{ name: "SRC", lag: 3, active: -1 }],
    ts: "2026-11-17T10:30:01Z",
  } as unknown as StreamInfo;
}

function row(over: Partial<ConsumerRow> = {}): ConsumerRow {
  return {
    name: "c",
    kind: "pull",
    durable: true,
    paused: false,
    pushBound: false,
    filters: [],
    ackPolicy: "explicit",
    deliverPolicy: "all",
    numPending: 0,
    numAckPending: 0,
    numRedelivered: 0,
    numWaiting: 0,
    maxAckPending: 1000,
    maxDeliver: -1,
    ackWaitMs: 30_000,
    deliveredStreamSeq: 0,
    deliveredConsumerSeq: 0,
    ackFloorStreamSeq: 0,
    ackFloorConsumerSeq: 0,
    created: "2026-11-01T00:00:00Z",
    ...over,
  };
}

function snap(at: number, view: StreamView, consumers: ConsumerRow[] = []): StreamSnapshot {
  return { at, stream: view, consumers, consumersTotal: consumers.length };
}

describe("stream dashboard model (pure)", () => {
  const NOW = Date.parse("2026-11-17T10:30:01Z");

  test("streamView maps config, state, cluster and sources", () => {
    const v = streamView(fakeStreamInfo());
    assert.equal(v.config.maxAgeMs, 3_600_000);
    assert.equal(v.config.duplicateWindowMs, 120_000);
    assert.equal(v.config.maxBytes, -1);
    assert.equal(v.state.firstSeq, 201);
    assert.equal(v.cluster?.peers.length, 3);
    assert.equal(v.cluster?.peers[0].leader, true);
    assert.equal(v.cluster?.peers[2].lag, 7);
    assert.equal(v.cluster?.peers[2].activeMs, 2000);
    assert.equal(v.sources[0].activeMs, undefined, "active -1 = never");
    const empty = streamView(fakeStreamInfo({}, { messages: 0, first_ts: "0001-01-01T00:00:00Z" }));
    assert.equal(empty.state.firstTs, undefined);
  });

  test("consumerRow maps filters, push/pull and last activity", () => {
    const ci = {
      name: "billing",
      stream_name: "ORDERS",
      created: "2026-11-01T00:00:00Z",
      config: { durable_name: "billing", ack_policy: "explicit", deliver_policy: "all", filter_subjects: ["a.>", "b.>"], max_ack_pending: 50, ack_wait: 30_000_000_000 },
      delivered: { consumer_seq: 10, stream_seq: 900, last_active: "2026-11-17T10:29:00Z" },
      ack_floor: { consumer_seq: 8, stream_seq: 880, last_active: "0001-01-01T00:00:00Z" },
      num_ack_pending: 2,
      num_redelivered: 1,
      num_waiting: 3,
      num_pending: 100,
      push_bound: false,
    } as unknown as ConsumerInfo;
    const r = consumerRow(ci);
    assert.equal(r.kind, "pull");
    assert.deepEqual(r.filters, ["a.>", "b.>"]);
    assert.equal(r.ackWaitMs, 30_000);
    assert.equal(r.lastActive, "2026-11-17T10:29:00Z");
    const push = consumerRow({ ...ci, config: { ...ci.config, deliver_subject: "deliver.x", filter_subjects: undefined, filter_subject: "a.b" }, push_bound: true } as unknown as ConsumerInfo);
    assert.equal(push.kind, "push");
    assert.deepEqual(push.filters, ["a.b"]);
  });

  test("deriveRates: ingest from last_seq, deliveries per consumer, resets and estimates", () => {
    const v1 = streamView(fakeStreamInfo());
    const v2 = streamView(fakeStreamInfo({}, { last_seq: 1100, messages: 900, bytes: 90_000 }));
    const a = snap(1000, v1, [row({ name: "x", deliveredConsumerSeq: 100 }), row({ name: "gone" })]);
    const b = snap(3000, v2, [row({ name: "x", deliveredConsumerSeq: 140 }), row({ name: "new" })]);
    const r = deriveRates(a, b)!;
    assert.equal(r.dt, 2);
    assert.equal(r.ingest, 50);
    assert.equal(r.ingestBytes, 50 * 100, "ingest × average size (90000 / 900)");
    assert.equal(r.storedBytes, 5000);
    assert.equal(r.delivered.x, 20);
    assert.equal("new" in r.delivered, false, "consumers without a previous sample have no rate");
    assert.equal(deriveRates(undefined, b), undefined);
    assert.equal(deriveRates(b, b), undefined, "no elapsed time");
    const reset = snap(5000, streamView(fakeStreamInfo({}, { last_seq: 3 })));
    assert.equal(deriveRates(b, reset)!.ingest, null, "sequence reset leaves a gap");
    // recreated consumer (different created time): no rate
    const c = snap(5000, v2, [row({ name: "x", deliveredConsumerSeq: 1, created: "2026-11-17T00:00:00Z" })]);
    assert.equal("x" in deriveRates(b, c)!.delivered, false);
    // server timestamps win over host time
    const s1 = { ...a, serverAt: 10_000 };
    const s2 = { ...b, serverAt: 14_000 };
    assert.equal(deriveRates(s1, s2)!.dt, 4);
  });

  test("timeToLimit", () => {
    assert.equal(timeToLimit(50, 100, 10), 5);
    assert.equal(timeToLimit(50, -1, 10), undefined);
    assert.equal(timeToLimit(50, 100, 0), undefined);
    assert.equal(timeToLimit(100, 100, 5), undefined);
    assert.equal(timeToLimit(50, 100, null), undefined);
  });

  test("consumerStatus covers blocked, unbound, stalled, near limit, redelivering, caught up", () => {
    const now = NOW;
    const recent = new Date(now - 1000).toISOString();
    assert.equal(consumerStatus(row({ paused: true, numPending: 5 }), now).label, "Paused");
    const blocked = consumerStatus(row({ numAckPending: 1000, maxAckPending: 1000, lastActive: recent }), now);
    assert.equal(blocked.label, "Blocked");
    assert.equal(blocked.tone, "danger");
    assert.equal(consumerStatus(row({ kind: "push", pushBound: false, numPending: 3, lastActive: recent }), now).label, "No subscriber");
    assert.equal(consumerStatus(row({ numPending: 3, lastActive: new Date(now - 10 * 60_000).toISOString() }), now).label, "Stalled");
    assert.equal(consumerStatus(row({ numPending: 3 }), now).label, "Stalled", "never delivered");
    const fresh = consumerStatus(row({ numPending: 3, created: new Date(now - 30_000).toISOString() }), now);
    assert.equal(fresh.label, "Not started", "a consumer created 30 s ago is not stalled yet");
    assert.ok(fresh.severity < 2, "not an attention-level status");
    assert.equal(consumerStatus(row({ numPending: 3, created: new Date(now - 6 * 60_000).toISOString() }), now).label, "Stalled", "grace ends after 5 minutes");
    assert.equal(consumerStatus(row({ numAckPending: 850, lastActive: recent }), now).label, "Near ack limit");
    assert.equal(consumerStatus(row({ numRedelivered: 2, lastActive: recent }), now).label, "Redelivering");
    const ok = consumerStatus(row(), now);
    assert.equal(ok.label, "Caught up");
    assert.equal(ok.tone, "ok");
    assert.equal(consumerStatus(row({ numPending: 4, lastActive: recent }), now).label, "Processing");
    assert.ok(blocked.severity > ok.severity);
  });

  test("lagSegments: acked up to the ack floor within the stored range", () => {
    const st = streamView(fakeStreamInfo()).state; // first 201, last 1000
    assert.deepEqual(lagSegments(row({ ackFloorStreamSeq: 900, numAckPending: 20, numPending: 80 }), st), { acked: 700, ackPending: 20, pending: 80, total: 800 });
    assert.equal(lagSegments(row({ ackFloorStreamSeq: 50 }), st).acked, 0, "ack floor before the first stored message");
    assert.equal(lagSegments(row({ ackFloorStreamSeq: 5000 }), st).acked, 800, "clamped to the range");
    const empty = streamView(fakeStreamInfo({}, { messages: 0, first_seq: 1001, last_seq: 1000 })).state;
    assert.equal(lagSegments(row({ ackFloorStreamSeq: 1000 }), empty).total, 0);
  });

  test("limitUsages: discard old limits are rolling, discard new are alarming", () => {
    const v = streamView(fakeStreamInfo({ max_msgs_per_subject: 10, max_consumers: 4 }));
    const u = limitUsages(v, NOW, 9);
    const byId = Object.fromEntries(u.map((x) => [x.id, x]));
    assert.equal(byId.msgs.value, 800);
    assert.equal(byId.msgs.max, 1000);
    assert.equal(byId.msgs.rolling, true);
    assert.equal(byId.age.value, NOW - Date.parse("2026-11-17T10:00:00Z"));
    assert.equal(byId.age.max, 3_600_000);
    assert.equal(byId.perSubject.value, 9);
    assert.equal(byId.consumers.rolling, false);
    assert.equal(limitTone(byId.msgs), "info");
    assert.equal(limitTone(byId.bytes), "info", "unlimited");
    assert.equal(limitTone(byId.consumers), undefined, "derived from thresholds");
    const strict = limitUsages(streamView(fakeStreamInfo({ discard: DiscardPolicy.New, max_msgs_per_subject: 10, discard_new_per_subject: true })), NOW);
    assert.equal(strict.find((x) => x.id === "msgs")!.rolling, false);
    assert.equal(strict.find((x) => x.id === "perSubject")!.rolling, false);
    assert.equal(strict.find((x) => x.id === "age")!.rolling, true, "max_age always expires");
  });

  test("policy notes and stream status", () => {
    const v = streamView(fakeStreamInfo());
    assert.match(discardNote(v.config), /oldest messages are removed/);
    assert.match(discardNote({ ...v.config, discard: "new" }), /rejected/);
    assert.match(discardNote({ ...v.config, discard: "new", discardNewPerSubject: true }), /max_msgs_per_subject/);
    assert.match(retentionNote({ ...v.config, retention: "workqueue" }), /acknowledges/);
    assert.match(retentionNote({ ...v.config, retention: "interest" }), /every consumer/);
    assert.match(retentionNote(v.config), /Limits retention/);
    const recent = new Date(NOW - 1000).toISOString();
    assert.equal(streamStatus(snap(NOW, v, [row({ lastActive: recent })]), NOW).label, "Replica behind", "n3 is not current");
    const healthy = streamView(fakeStreamInfo());
    healthy.cluster = undefined;
    assert.equal(streamStatus(snap(NOW, healthy, [row()]), NOW).tone, "ok");
    assert.equal(streamStatus(snap(NOW, healthy, [row({ numAckPending: 1000, lastActive: recent })]), NOW).tone, "danger");
    healthy.sources = [{ name: "S", lag: 0, error: "boom" }];
    assert.equal(streamStatus(snap(NOW, healthy, []), NOW).label, "Source error");
  });
});

// ---------------------------------------------------------------------------------------------

describe("KV overview helpers (pure)", () => {
  const entries = [
    { key: "app.db.host", size: 10 },
    { key: "app.db.port", size: 4 },
    { key: "app.db", size: 60 },
    { key: "app.name", size: 12 },
    { key: "users.alice", size: 100 },
    { key: "users.bob", size: 80 },
    { key: "flags", size: 7 },
  ];

  test("prefixTreemap by keys and bytes", () => {
    const byKeys = prefixTreemap(entries, ".", "keys");
    assert.equal(byKeys.reduce((a, t) => a + sum(t), 0), 7);
    const app = byKeys.find((t) => t.id === "app")!;
    assert.equal(sum(app), 4);
    const db = app.children!.find((t) => t.id === "app.db")!;
    const own = db.children!.find((t) => t.label === "(value)")!;
    assert.equal(tileKey(own.id), "app.db", "a key that is also a prefix keeps its own tile");
    const byBytes = prefixTreemap(entries, ".", "bytes");
    assert.equal(byBytes.reduce((a, t) => a + sum(t), 0), 273);
    assert.equal(byBytes[0].id, "users", "largest first");
    assert.equal(tileKey("users.alice"), "users.alice");
    assert.equal(tileKey("users\u0000other"), undefined);
    const flat = prefixTreemap(entries, "", "keys");
    assert.equal(flat.length, 7);
    const summarised = prefixTreemap(entries, ".", "keys", { maxDepth: 1 });
    assert.equal(summarised.find((t) => t.label === "app.*")!.value, 4);
    assert.equal(tileKey(summarised.find((t) => t.label === "app.*")!.id), undefined);
    const many = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, size: 1 }));
    const folded = prefixTreemap(many, ".", "keys", { maxChildren: 5 });
    assert.equal(folded.length, 5);
    assert.match(folded[4].label, /Other \(26\)/);
  });

  test("activityWindow picks aligned buckets that cover the span", () => {
    const now = Date.parse("2026-11-17T12:00:30Z");
    const w = activityWindow([now - 30 * 60_000, now - 5_000], now)!;
    assert.equal(w.bucketMs, 60_000);
    assert.ok(w.start <= now - 30 * 60_000 && w.end > now);
    assert.equal(w.start % w.bucketMs, 0);
    assert.ok(w.buckets <= 60);
    assert.equal(w.clipped, 0);
    const wide = activityWindow([now - 20 * 86_400_000, now], now)!;
    assert.equal(wide.bucketMs, 43_200_000, "20 days → 12 h buckets");
    assert.ok(wide.buckets <= 60);
    const single = activityWindow([now], now)!;
    assert.ok(single.buckets >= 12, "a single event still renders a strip");
    const huge = activityWindow([now - 10 * 365 * 86_400_000, now], now)!;
    assert.ok(huge.clipped >= 1, "older events are clipped");
    assert.equal(activityWindow([], now), undefined);
    const ahead = activityWindow([now - 10 * 60_000, now + 3 * 60_000], now)!;
    assert.ok(ahead.end > now + 3 * 60_000, "writes stamped by a server clock ahead of ours stay inside the window");
    const big = Array.from({ length: 300_000 }, (_, i) => now - i * 1000);
    const bw = activityWindow(big, now)!;
    assert.ok(bw.buckets <= 60, "large buckets do not overflow the call stack");
    assert.equal(activityWindow([Number.NaN, now], now)!.clipped, 0, "non-finite times are ignored");
    assert.equal(stepLabel(300_000), "5 min");
    assert.equal(stepLabel(3_600_000), "1 h");
    assert.equal(stepLabel(86_400_000), "1 d");
  });

  test("kindSlot is stable per kind", () => {
    assert.equal(kindSlot("object"), 0);
    assert.equal(kindSlot("binary"), VALUE_KINDS.indexOf("binary"));
    assert.equal(kindSlot("weird"), VALUE_KINDS.length);
  });
});

describe("command arguments (pure)", () => {
  test("subjectTargetOf accepts tree nodes and plain objects", () => {
    assert.deepEqual(subjectTargetOf({ target: { connId: "c", stream: "S", filter: "a.>" } }), { connId: "c", stream: "S", filter: "a.>" });
    assert.deepEqual(subjectTargetOf({ connId: "c", stream: "S", filter: " > " }), { connId: "c", stream: "S", filter: undefined });
    assert.deepEqual(subjectTargetOf({ connId: "c", stream: "S" }), { connId: "c", stream: "S", filter: undefined });
    assert.equal(subjectTargetOf({ connId: "c" }), undefined);
    assert.equal(subjectTargetOf(undefined), undefined);
    assert.equal(subjectTargetOf("x"), undefined);
    assert.deepEqual(subjectTargetOf({ profileId: "c", stream: "S", subject: "a.b" }), { connId: "c", stream: "S", filter: "a.b" }, "subject alias and profileId");
    assert.deepEqual(subjectTargetOf({ profile: { id: "c" }, stream: "S" }), { connId: "c", stream: "S", filter: undefined });
  });

  test("streamArgOf accepts stream nodes, { connId, stream } and profile ids", () => {
    assert.deepEqual(streamArgOf({ connId: "c", name: "S", info: { config: { name: "S" } } }), { connId: "c", stream: "S" });
    assert.deepEqual(streamArgOf({ connId: "c", stream: "S" }), { connId: "c", stream: "S" });
    assert.deepEqual(streamArgOf("c"), { connId: "c" });
    assert.deepEqual(streamArgOf({ connId: "c", name: "folder" }), { connId: "c", stream: undefined }, "a name without stream info is not a stream");
    assert.deepEqual(streamArgOf(undefined), {});
    assert.deepEqual(streamArgOf({ connId: "c", stream: "S", name: "billing" }), { connId: "c", stream: "S" }, "consumer node → its stream");
    assert.deepEqual(streamArgOf({ profileId: "c", stream: "S" }), { connId: "c", stream: "S" });
    assert.deepEqual(streamArgOf({ scheme: "nats-node", authority: "c", path: "/stream/ORDERS" }), { connId: "c", stream: "ORDERS" }, "explorer resource URI");
    assert.deepEqual(streamArgOf({ scheme: "nats-node", authority: "c", path: "/consumer/ORDERS/billing" }), { connId: "c", stream: "ORDERS" });
    assert.deepEqual(streamArgOf({ scheme: "nats-node", authority: "c", path: "/server" }), { connId: "c", stream: undefined });
  });
});

// ---------------------------------------------------------------------------------------------

const hasServer = spawnSync("nats-server", ["--version"]).status === 0;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

describe("insights (live server)", { skip: !hasServer && "nats-server not installed" }, () => {
  let server: ChildProcess;
  let dir: string;
  let nc: NatsConnection;
  let jsm: JetStreamManager;
  let js: JetStreamClient;
  const enc = new TextEncoder();

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "nats-admin-insights-"));
    const port = await freePort();
    server = spawn("nats-server", ["-js", "-sd", dir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      try {
        nc = await connect({ servers: `nats://127.0.0.1:${port}`, timeout: 500 });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.ok(nc, "connected to test server");
    jsm = await jetstreamManager(nc);
    js = jetstream(nc);
    await jsm.streams.add({ name: "EVENTS", subjects: ["ev.>"], max_msgs: 10_000, max_msgs_per_subject: 500 });
    const regions = ["eu", "us", "apac"];
    const kinds = ["created", "paid", "shipped", "cancelled"];
    const pubs: Promise<unknown>[] = [];
    for (let i = 0; i < 240; i++) {
      const r = regions[i % 3];
      const k = kinds[Math.floor(i / 3) % 4];
      // eu gets more traffic: duplicates of eu events
      pubs.push(js.publish(`ev.${r}.${k}`, enc.encode(`{"i":${i}}`)));
      if (r === "eu") pubs.push(js.publish(`ev.eu.${k}`, enc.encode(`{"i":${i},"dup":true}`)));
    }
    pubs.push(js.publish("ev.eu", enc.encode("self")));
    await Promise.all(pubs);
    await jsm.streams.add({ name: "EMPTY", subjects: ["empty.>"] });
    await jsm.consumers.add("EVENTS", { durable_name: "proc", ack_policy: AckPolicy.Explicit, filter_subject: "ev.eu.>", max_ack_pending: 5 });
  });

  after(async () => {
    await nc?.close();
    server?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  test("fetchSubjectCounts returns every subject with counts", async () => {
    const c = await fetchSubjectCounts(jsm, "EVENTS", { max: 1000 });
    assert.equal(c.total, 13, "12 region/kind subjects + ev.eu");
    assert.equal(c.truncated, false);
    assert.equal(c.subjects.length, 13);
    assert.equal(c.streamMessages, 241 + 80);
    assert.equal(c.keptMessages, c.streamMessages);
    assert.equal(c.subjects[0].subject.startsWith("ev.eu."), true, "eu subjects have the most messages");
    assert.ok(c.subjects.every((s, i, a) => i === 0 || a[i - 1].messages >= s.messages), "sorted by messages");
    const tree = buildSubjectTree(c.subjects);
    assert.equal(findSubjectNode(tree, "ev.eu")!.messages, 161);
    assert.equal(findSubjectNode(tree, "ev.eu")!.own, 1);
  });

  test("fetchSubjectCounts caps at max and reports truncation", async () => {
    const c = await fetchSubjectCounts(jsm, "EVENTS", { max: 3 });
    assert.equal(c.subjects.length, 3);
    assert.equal(c.total, 13);
    assert.equal(c.truncated, true);
    assert.equal(c.scanned, 13, "one server page holds every subject, so all were ranked");
    assert.ok(c.subjects.every((s) => s.subject.startsWith("ev.eu.")), "keeps the busiest subjects");
    assert.ok(c.keptMessages < c.streamMessages);
  });

  test("fetchSubjectCounts honours a folder filter and empty streams", async () => {
    const us = await fetchSubjectCounts(jsm, "EVENTS", { filter: "ev.us.>", max: 100 });
    assert.equal(us.total, 4);
    assert.ok(us.subjects.every((s) => s.subject.startsWith("ev.us.")));
    const empty = await fetchSubjectCounts(jsm, "EMPTY", { max: 100 });
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.subjects, []);
    assert.equal(empty.truncated, false);
  });

  test("fetchSubjectCounts falls back to streams.info without the raw request API", async () => {
    const plain = { streams: { info: (name: string, opts: unknown) => jsm.streams.info(name, opts as never) } } as unknown as JetStreamManager;
    const c = await fetchSubjectCounts(plain, "EVENTS", { max: 5 });
    assert.equal(c.subjects.length, 5);
    assert.equal(c.total, 13);
    assert.equal(c.truncated, true);
  });

  test("recentMessages reads the newest messages without creating a consumer", async () => {
    const before = (await jsm.streams.info("EVENTS")).state;
    const r = await recentMessages(jsm, "EVENTS", { limit: 10 });
    assert.equal(r.messages.length, 10);
    assert.equal(r.messages[0].seq, before.last_seq, "newest first");
    assert.ok(r.messages.every((m, i, a) => i === 0 || a[i - 1].seq! > m.seq!), "descending sequences");
    assert.equal(r.partial, false);
    assert.ok(r.messages[0].size > 0 && r.messages[0].data.length > 0);
    assert.equal((await jsm.streams.info("EVENTS")).state.consumer_count, before.consumer_count, "no consumer was created");
    const none = await recentMessages(jsm, "EMPTY", { limit: 10 });
    assert.deepEqual(none.messages, []);
    assert.equal(none.partial, false);
  });

  test("recentMessages works on work-queue streams and skips deleted sequences", async () => {
    await jsm.streams.add({ name: "JOBS", subjects: ["jobs.>"], retention: RetentionPolicy.Workqueue });
    await jsm.consumers.add("JOBS", { durable_name: "worker", ack_policy: AckPolicy.Explicit });
    for (let i = 1; i <= 30; i++) await js.publish(`jobs.t${i % 4}`, enc.encode(`job ${i}`));
    // delete every other sequence at the tail (gaps the feed must step over)
    for (let seq = 30; seq > 20; seq -= 2) await jsm.streams.deleteMessage("JOBS", seq, false);
    const r = await recentMessages(jsm, "JOBS", { limit: 8 });
    assert.equal(r.messages.length, 8);
    assert.deepEqual(
      r.messages.map((m) => m.seq),
      [29, 27, 25, 23, 21, 20, 19, 18],
    );
    assert.equal(new TextDecoder().decode(Uint8Array.from(atob(r.messages[0].data), (c) => c.charCodeAt(0))), "job 29");
    assert.equal((await jsm.streams.info("JOBS")).state.consumer_count, 1, "only the worker consumer exists");
    // a probe budget smaller than the gaps reports a partial result
    const sparse = await recentMessages(jsm, "JOBS", { limit: 8, maxProbes: 8 });
    assert.equal(sparse.partial, true);
    assert.equal(sparse.messages.length, 4);
    assert.equal(sparse.probed, 8);
  });

  test("dashboard model from real stream and consumer info", async () => {
    const si = await jsm.streams.info("EVENTS");
    const v = streamView(si);
    assert.equal(v.state.messages, 321);
    assert.equal(v.config.maxMsgsPerSubject, 500);
    assert.equal(v.config.retention, "limits");
    assert.ok(v.state.firstTs, "first message timestamp parsed");
    const ci = await jsm.consumers.info("EVENTS", "proc");
    const r = consumerRow(ci);
    assert.equal(r.numPending, 160, "ev.eu.> excludes ev.eu itself");
    assert.deepEqual(r.filters, ["ev.eu.>"]);
    assert.equal(r.lastActive, undefined, "never delivered");
    assert.equal(consumerStatus(r, Date.now()).label, "Not started", "created just now, nothing delivered yet");
    assert.equal(consumerStatus(r, Date.now() + 6 * 60_000).label, "Stalled", "still nothing delivered after 5 minutes");

    // pull a few without acking → ack pending reaches max_ack_pending (5) → blocked
    const consumer = await js.consumers.get("EVENTS", "proc");
    const iter = await consumer.fetch({ max_messages: 5, expires: 1000 });
    for await (const m of iter) void m;
    const r2 = consumerRow(await jsm.consumers.info("EVENTS", "proc"));
    assert.equal(r2.numAckPending, 5);
    assert.ok(r2.lastActive, "last delivery time is set");
    assert.equal(consumerStatus(r2, Date.now()).label, "Blocked");
    const seg = lagSegments(r2, v.state);
    assert.equal(seg.total, 321);
    assert.equal(seg.ackPending, 5);

    const s1: StreamSnapshot = { at: Date.now(), stream: v, consumers: [r], consumersTotal: 1 };
    await js.publish("ev.us.created", enc.encode("x"));
    await js.publish("ev.us.created", enc.encode("y"));
    const v2 = streamView(await jsm.streams.info("EVENTS"));
    const rates = deriveRates(s1, { at: s1.at + 1000, stream: v2, consumers: [r2], consumersTotal: 1 })!;
    assert.equal(rates.ingest, 2);
    assert.equal(rates.delivered.proc, 5);
    const usage = limitUsages(v2, Date.now(), (await fetchSubjectCounts(jsm, "EVENTS", { max: 1 })).subjects[0].messages);
    assert.equal(usage.find((u) => u.id === "perSubject")!.max, 500);
    assert.ok(usage.find((u) => u.id === "perSubject")!.value > 0);
  });
});
