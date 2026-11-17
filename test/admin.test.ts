// Admin features: $SYS helpers, topology model + layered layout, cluster model + diagram layout
// (pure), plus live tests against a throwaway 2-node nats-server cluster with a system account.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { jetstreamManager, AckPolicy, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { Objm } from "@nats-io/obj";
import { Svcm } from "@nats-io/services";
import {
  detectSystemAccess,
  fetchUserInfo,
  hasSystemAccess,
  isNoAccessError,
  parseGoDuration,
  pingAll,
  pingServers,
  serverRequest,
  summarizePermissions,
  uniqueRoutePeers,
  SystemAccessError,
  type Healthz,
  type Routez,
  type ServerStatsMsg,
} from "../src/nats/system";
import { buildGraph, DEFAULT_FILTERS, DEFAULT_THRESHOLDS, lineage, MAX_CONSUMERS_PER_STREAM, moreConsumersNodeId, streamKind, topologyTotals, type TopologyData } from "../src/admin/topologyModel";
import { countCrossings, edgeMidpoint, edgePath, isotonicPlace, layoutGraph, type LayoutNodeInput } from "../src/admin/graphLayout";
import {
  buildClusterGraph,
  clusterTotals,
  computeRates,
  counterSample,
  gatewaysFromGatewayz,
  layoutClusterGraph,
  leafsFromLeafz,
  routesFromRoutez,
  serverRowFromStatsz,
  serverRowFromVarz,
  serverTone,
  userExpiry,
  whoAmIView,
  type ServerRow,
} from "../src/admin/clusterModel";
import { collectTopology, streamToTopo } from "../src/admin/topologyData";
import { collectMonitor, collectSystem, basicFromInfo, monitorCandidates } from "../src/admin/clusterData";
import type { StreamInfo } from "@nats-io/jetstream";
import { buildServerDetails, buildWhoAmI } from "../src/admin/docs";

// ---------------------------------------------------------------------------------------------
// $SYS helpers
// ---------------------------------------------------------------------------------------------

describe("system helpers", () => {
  test("parseGoDuration", () => {
    assert.equal(parseGoDuration("221µs"), 0.221);
    assert.equal(parseGoDuration("1.5ms"), 1.5);
    assert.equal(parseGoDuration("3m10s"), 190_000);
    assert.equal(parseGoDuration("2d4h"), 2 * 86_400_000 + 4 * 3_600_000);
    assert.equal(parseGoDuration("1y2d"), 31_536_000_000 + 2 * 86_400_000);
    assert.equal(parseGoDuration("500ns"), 0.0005);
    assert.equal(parseGoDuration("0"), 0);
    assert.equal(parseGoDuration(""), undefined);
    assert.equal(parseGoDuration("abc"), undefined);
    assert.equal(parseGoDuration("3m garbage"), undefined);
  });

  test("summarizePermissions", () => {
    const open = summarizePermissions(undefined);
    assert.equal(open.unrestricted, true);
    assert.equal(open.short, "unrestricted");
    const p = summarizePermissions({ publish: { allow: [">"], deny: ["secret.>"] }, subscribe: { allow: ["orders.>", "billing.>", "audit.>"] }, responses: { max: 1, ttl: 5e9 } });
    assert.equal(p.unrestricted, false);
    assert.deepEqual(p.publish, { allow: [">"], deny: ["secret.>"] });
    assert.match(p.lines[0], /^Publish: allow >; deny secret\.>$/);
    assert.match(p.lines[1], /^Subscribe: allow orders\.>, billing\.>, audit\.>$/);
    assert.match(p.lines[2], /max 1, ttl 5000ms/);
    assert.equal(p.short, "pub ✓ > ✗ secret.> · sub ✓ orders.> billing.> +1");
    const denyOnly = summarizePermissions({ publish: { deny: ["$SYS.>"] } });
    assert.match(denyOnly.lines[0], /allow all; deny \$SYS\.>/);
    assert.match(denyOnly.lines[1], /Subscribe: unrestricted/);
  });

  test("uniqueRoutePeers merges pooled routes", () => {
    assert.deepEqual(uniqueRoutePeers([{ name: "n2" }, { name: "n3" }, { name: "n2" }, { remote_id: "X", remote_name: "n4" }, { remote_id: "X" }]), ["X", "n2", "n3"]);
    assert.deepEqual(uniqueRoutePeers(undefined), []);
  });

  test("isNoAccessError", () => {
    assert.ok(isNoAccessError(new Error("no responders: '$SYS.REQ.SERVER.PING'")));
    assert.ok(isNoAccessError(new Error('Permissions Violation for Publish to "$SYS.REQ.SERVER.PING"')));
    assert.ok(!isNoAccessError(new Error("invalid json")));
  });
});

// ---------------------------------------------------------------------------------------------
// Topology model
// ---------------------------------------------------------------------------------------------

const stream = (name: string, o: Partial<TopologyData["streams"][number]> = {}): TopologyData["streams"][number] => ({
  name,
  ...streamKind(name),
  subjects: [],
  messages: 10,
  bytes: 1000,
  consumerCount: 0,
  storage: "file",
  retention: "limits",
  replicas: 1,
  maxBytes: -1,
  maxMsgs: -1,
  ...o,
});
const consumer = (s: string, name: string, o: Partial<TopologyData["consumers"][number]> = {}): TopologyData["consumers"][number] => ({
  stream: s,
  name,
  durable: true,
  kind: "pull",
  pending: 0,
  ackPending: 0,
  redelivered: 0,
  waiting: 0,
  maxAckPending: 1000,
  ackPolicy: "explicit",
  filterSubjects: [],
  ...o,
});

function sampleData(): TopologyData {
  return {
    at: Date.parse("2026-01-01T00:00:10Z"),
    jetstream: true,
    warnings: [],
    streams: [
      stream("ORDERS", { subjects: ["orders.>"], consumerCount: 2, lastTs: "2026-01-01T00:00:05Z" }),
      stream("ORDERS_MIRROR", { mirror: { name: "ORDERS", lag: 5000, activeMs: 100 } }),
      stream("EU", { sources: [{ name: "ORDERS", lag: 1, filter: "orders.eu.>" }, { name: "REMOTE", external: "$JS.hub.API", lag: 0 }] }),
      stream("TELEMETRY", { subjects: ["t.a", "t.b", "t.c", "t.d", "t.e", "t.f", "t.g", "t.h"], bytes: 96, maxBytes: 100 }),
      stream("KV_config", { subjects: ["$KV.config.>"] }),
      stream("OBJ_files", { subjects: ["$O.files.C.>", "$O.files.M.>"] }),
    ],
    consumers: [consumer("ORDERS", "billing", { pending: 20_000 }), consumer("ORDERS", "ship", { ackPending: 1000, maxAckPending: 1000 }), consumer("TELEMETRY", "push1", { kind: "push", deliverSubject: "d.x", pushBound: false })],
    endpoints: [
      { service: "orders-api", version: "1.0.0", name: "create", subject: "orders.api.create", instances: 2, requests: 100, errors: 0 },
      { service: "quotes", version: "1.0.0", name: "quote", subject: "billing.quote", instances: 1, requests: 10, errors: 1 },
    ],
  };
}

describe("topology model", () => {
  test("nodes, edges and kinds", () => {
    const g = buildGraph(sampleData());
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    assert.equal(byId.get("stream:KV_config")?.kind, "kv");
    assert.equal(byId.get("stream:KV_config")?.label, "config");
    assert.equal(byId.get("stream:OBJ_files")?.kind, "obj");
    assert.ok(byId.get("stream:ORDERS_MIRROR")?.flags.includes("mirror"));
    assert.ok(byId.get("stream:EU")?.flags.includes("sourced"));
    // subject → stream
    assert.ok(g.edges.some((e) => e.kind === "capture" && e.from === "subj:ORDERS:orders.>" && e.to === "stream:ORDERS"));
    // mirror / source edges with lag label, external origin node
    const mirror = g.edges.find((e) => e.kind === "mirror")!;
    assert.equal(mirror.from, "stream:ORDERS");
    assert.equal(mirror.to, "stream:ORDERS_MIRROR");
    assert.equal(mirror.label, "lag 5,000");
    assert.equal(mirror.tone, "warn");
    assert.ok(byId.has("ext:REMOTE@$JS.hub.API"));
    assert.ok(g.edges.some((e) => e.kind === "source" && e.from === "ext:REMOTE@$JS.hub.API" && e.to === "stream:EU"));
    // consumers with pending badges
    const billing = byId.get("cons:ORDERS/billing")!;
    assert.equal(billing.badge?.text, "20.0k");
    assert.equal(billing.tone, "warn");
    assert.equal(byId.get("cons:ORDERS/ship")?.tone, "danger");
    assert.equal(byId.get("cons:TELEMETRY/push1")?.tone, "warn");
    // endpoint attached to the overlapping stream only
    const create = [...byId.values()].find((n) => n.kind === "endpoint" && n.ref.subject === "orders.api.create")!;
    assert.ok(g.edges.some((e) => e.kind === "serves" && e.from === "stream:ORDERS" && e.to === create.id));
    const quote = [...byId.values()].find((n) => n.kind === "endpoint" && n.ref.subject === "billing.quote")!;
    assert.ok(!g.edges.some((e) => e.to === quote.id));
    assert.equal(quote.tone, "danger"); // 10% errors
    // storage near the limit
    assert.equal(byId.get("stream:TELEMETRY")?.tone, "danger");
    // subjects folded after MAX_SUBJECTS_PER_STREAM
    assert.equal(byId.get("subj:TELEMETRY:+more")?.label, "+2 more");
    assert.equal(g.nodes.filter((n) => n.ref.stream === "TELEMETRY" && n.kind === "subject").length, 7);
    // relative time in stats
    assert.ok(byId.get("stream:ORDERS")!.stats.some(([k, v]) => k === "Last message" && v === "5s ago"));
  });

  test("filters remove node kinds and dangling edges", () => {
    const g = buildGraph(sampleData(), { ...DEFAULT_FILTERS, subjects: false, consumers: false, kv: false, obj: false, services: false });
    assert.ok(g.nodes.every((n) => n.kind === "stream" || n.kind === "external"));
    const ids = new Set(g.nodes.map((n) => n.id));
    assert.ok(g.edges.every((e) => ids.has(e.from) && ids.has(e.to)));
    assert.ok(g.edges.every((e) => e.kind === "mirror" || e.kind === "source"));
  });

  test("deterministic and thresholds respected", () => {
    const a = JSON.stringify(buildGraph(sampleData()));
    const b = JSON.stringify(buildGraph(sampleData()));
    assert.equal(a, b);
    const lenient = buildGraph(sampleData(), DEFAULT_FILTERS, { ...DEFAULT_THRESHOLDS, pendingWarning: 1e9, lagWarning: 1e9 });
    assert.equal(lenient.nodes.find((n) => n.id === "cons:ORDERS/billing")?.tone, "ok");
    assert.equal(lenient.edges.find((e) => e.kind === "mirror")?.tone, "ok");
  });

  test("consumers beyond the cap fold into one node, issues are never folded", () => {
    const data = sampleData();
    const n = MAX_CONSUMERS_PER_STREAM + 8;
    data.streams.push(stream("EVENTS", { subjects: ["events.>"], consumerCount: n }));
    for (let i = 0; i < n; i++) data.consumers.push(consumer("EVENTS", `w${String(i).padStart(2, "0")}`, { pending: 10 }));
    // the alphabetically last consumer is over the pending threshold: it must stay visible
    data.consumers.push(consumer("EVENTS", "zz-late", { pending: 50_000 }));
    const g = buildGraph(data);
    const events = g.nodes.filter((x) => x.kind === "consumer" && x.ref.stream === "EVENTS");
    assert.equal(events.length, MAX_CONSUMERS_PER_STREAM + 1, "cap (issues included) + the folded node");
    assert.ok(events.some((x) => x.id === "cons:EVENTS/zz-late" && x.tone === "warn"));
    const more = g.nodes.find((x) => x.id === moreConsumersNodeId("EVENTS"))!;
    assert.equal(more.label, `+${n + 1 - MAX_CONSUMERS_PER_STREAM} more consumers`);
    assert.equal(more.badge?.text, String((n + 1 - MAX_CONSUMERS_PER_STREAM) * 10));
    assert.ok(more.flags.includes("more") && more.tone === "ok");
    assert.ok(more.search.includes("w19"), "folded names stay searchable");
    assert.ok(g.edges.some((e) => e.from === "stream:EVENTS" && e.to === more.id && e.kind === "consume"));
    // small streams are not folded, totals still count every consumer
    assert.ok(!g.nodes.some((x) => x.id === moreConsumersNodeId("ORDERS")));
    assert.equal(topologyTotals(data, g).consumers, data.consumers.length);
  });

  test("streamToTopo counts the leader only when there is one", () => {
    const si = (leader?: string) =>
      ({
        config: { name: "S", subjects: ["s.>"], storage: "file", retention: "limits", num_replicas: 3 },
        state: { messages: 1, bytes: 2, consumer_count: 0, first_seq: 1, last_seq: 1, last_ts: "0001-01-01T00:00:00Z" },
        cluster: { name: "c", leader, replicas: [{ name: "a", current: true, active: 1 }, { name: "b", current: false, active: 1 }] },
        created: "2026-01-01T00:00:00Z",
      }) as unknown as StreamInfo;
    assert.deepEqual(streamToTopo(si("x")).cluster, { name: "c", leader: "x", replicasCurrent: 2, replicasTotal: 3 });
    assert.equal(streamToTopo(si(undefined)).cluster?.replicasCurrent, 1);
    assert.equal(streamToTopo(si("x")).lastTs, undefined, "zero time is not a last message");
  });

  test("lineage and totals", () => {
    const g = buildGraph(sampleData());
    const l = lineage(g, "stream:ORDERS");
    assert.ok(l.has("subj:ORDERS:orders.>") && l.has("cons:ORDERS/billing") && l.has("stream:ORDERS_MIRROR") && l.has("stream:EU"));
    assert.ok(!l.has("stream:TELEMETRY"));
    const t = topologyTotals(sampleData(), g);
    assert.equal(t.streams, 4);
    assert.equal(t.kv, 1);
    assert.equal(t.obj, 1);
    assert.equal(t.consumers, 3);
    assert.equal(t.endpoints, 2);
    assert.equal(t.services, 2);
    assert.equal(t.pending, 20_000);
    assert.ok(t.issues.danger >= 2 && t.issues.warn >= 2);
  });
});

// ---------------------------------------------------------------------------------------------
// Layered layout
// ---------------------------------------------------------------------------------------------

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("graph layout", () => {
  test("left-to-right layers, no overlaps, deterministic", () => {
    const g = buildGraph(sampleData());
    const nodes: LayoutNodeInput[] = g.nodes.map((n) => ({ id: n.id, width: 180, height: n.kind === "subject" ? 28 : 44, order: n.order }));
    const l1 = layoutGraph(nodes, g.edges);
    const l2 = layoutGraph([...nodes].reverse(), [...g.edges].reverse());
    assert.deepEqual([...l1.nodes.entries()].sort(), [...l2.nodes.entries()].sort(), "input order must not matter");
    assert.equal(l1.nodes.size, g.nodes.length);
    const all = [...l1.nodes.values()];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) assert.ok(!overlaps(all[i], all[j]), `${all[i].id} overlaps ${all[j].id}`);
    for (const e of g.edges) {
      const a = l1.nodes.get(e.from)!;
      const b = l1.nodes.get(e.to)!;
      assert.ok(a.layer < b.layer, `${e.from} (${a.layer}) should be left of ${e.to} (${b.layer})`);
    }
    // subjects sit right next to their stream (sources pulled right)
    assert.equal(l1.nodes.get("subj:ORDERS:orders.>")!.layer + 1, l1.nodes.get("stream:ORDERS")!.layer);
    assert.ok(l1.width > 0 && l1.height > 0);
    for (const e of l1.edges) assert.ok(e.points.length >= 2);
  });

  test("crossing minimisation untangles a crossed bipartite graph", () => {
    // a→y, b→x listed so that the natural order crosses; layout must remove the crossing
    const nodes = ["a", "b", "x", "y"].map((id) => ({ id, width: 50, height: 20, order: id }));
    const l = layoutGraph(nodes, [
      { id: "1", from: "a", to: "y" },
      { id: "2", from: "b", to: "x" },
    ], { aspect: 0 });
    assert.equal(l.crossings, 0);
    const a = l.nodes.get("a")!;
    const y = l.nodes.get("y")!;
    assert.ok(Math.abs(a.y - y.y) < 1, "straight edge expected");
  });

  test("cycles and long edges", () => {
    const nodes = ["a", "b", "c", "d"].map((id) => ({ id, width: 40, height: 20, order: id }));
    const l = layoutGraph(nodes, [
      { id: "ab", from: "a", to: "b" },
      { id: "bc", from: "b", to: "c" },
      { id: "ca", from: "c", to: "a" },
      { id: "ad", from: "a", to: "d" },
      { id: "cd", from: "c", to: "d" },
    ]);
    assert.equal(l.nodes.size, 4);
    const rev = l.edges.filter((e) => e.reversed);
    assert.equal(rev.length, 1, "exactly one edge reversed to break the cycle");
    const ad = l.edges.find((e) => e.id === "ad")!;
    assert.ok(ad.points.length > 2, "long edge routed through dummy points");
    assert.match(edgePath(ad.points), /^M[\d.]+,[\d.]+( C[\d., -]+)+$/);
    assert.equal(edgeMidpoint([[0, 0], [10, 20]]).join(","), "5,10");
  });

  test("components are packed into shelves for large graphs", () => {
    const nodes: LayoutNodeInput[] = [];
    const edges = [];
    for (let i = 0; i < 40; i++) {
      const s = `s${String(i).padStart(2, "0")}`;
      nodes.push({ id: s, width: 100, height: 40, order: `2:${s}`, groupKey: `2:${s}` });
      for (let j = 0; j < 3; j++) {
        nodes.push({ id: `${s}c${j}`, width: 100, height: 30, order: `5:${s}:${j}` });
        edges.push({ id: `${s}-${j}`, from: s, to: `${s}c${j}` });
      }
    }
    const wrapped = layoutGraph(nodes, edges, { aspect: 1.6 });
    const tall = layoutGraph(nodes, edges, { aspect: 0 });
    assert.ok(tall.height / tall.width > 5);
    const ratio = wrapped.width / wrapped.height;
    assert.ok(ratio > 0.8 && ratio < 3.2, `aspect ${ratio}`);
    // components keep their group order: s00 above s01 in the first shelf
    assert.ok(wrapped.nodes.get("s00")!.y < wrapped.nodes.get("s01")!.y);
  });

  test("each shelf is only as wide as its widest component", () => {
    // one 4-layer chain followed by 30 two-layer components
    const nodes: LayoutNodeInput[] = ["a0", "a1", "a2", "a3"].map((id) => ({ id, width: 100, height: 40, order: `0:${id}`, groupKey: "0" }));
    const edges = [
      { id: "a01", from: "a0", to: "a1" },
      { id: "a12", from: "a1", to: "a2" },
      { id: "a23", from: "a2", to: "a3" },
    ];
    for (let i = 0; i < 30; i++) {
      const k = String(i).padStart(2, "0");
      nodes.push({ id: `b${k}`, width: 100, height: 40, order: `1:${k}:b`, groupKey: `1:${k}` }, { id: `c${k}`, width: 100, height: 40, order: `1:${k}:c`, groupKey: `1:${k}` });
      edges.push({ id: `bc${k}`, from: `b${k}`, to: `c${k}` });
    }
    const l = layoutGraph(nodes, edges, { aspect: 1.6, layerGap: 72, shelfGap: 96 });
    const all = [...l.nodes.values()];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) assert.ok(!overlaps(all[i], all[j]), `${all[i].id} overlaps ${all[j].id}`);
    const starts = [...new Set(all.filter((n) => n.layer === 0).map((n) => n.x))].sort((x, y) => x - y);
    assert.ok(starts.length >= 3, `expected ≥ 3 shelves, got ${starts.length}`);
    const steps = starts.slice(1).map((x, i) => x - starts[i]);
    assert.equal(steps[0], 4 * 100 + 3 * 72 + 96, "the first shelf holds the 4-layer chain");
    assert.ok(steps.slice(1).every((d) => d === 2 * 100 + 72 + 96), `narrow shelves: ${steps.join(", ")}`);
    // wrapping must fit the requested aspect better than a single column
    const single = layoutGraph(nodes, edges, { aspect: 0 });
    const score = (x: { width: number; height: number }) => Math.min(1.6 / x.width, 1 / x.height);
    assert.ok(score(l) > score(single) * 2);
  });

  test("isotonicPlace and countCrossings", () => {
    assert.deepEqual(isotonicPlace([10, 10], [0, 0], [1, 1], 5), [-7.5, 7.5]);
    assert.deepEqual(isotonicPlace([10, 10, 10], [0, 100, 200], [1, 1, 1], 5), [0, 100, 200]);
    const tops = isotonicPlace([10, 20, 10], [50, 40, 45], [1, 2, 1], 4);
    for (let i = 1; i < tops.length; i++) assert.ok(tops[i] >= tops[i - 1] + [10, 20, 10][i - 1] + 4 - 1e-9);
    const pos = new Map([["a", 0], ["b", 1], ["x", 0], ["y", 1]]);
    const down = new Map([["a", ["y"]], ["b", ["x"]]]);
    assert.equal(countCrossings([{ id: "a" }, { id: "b" }], [{ id: "x" }, { id: "y" }], down, pos), 1);
    const down2 = new Map([["a", ["x"]], ["b", ["y"]]]);
    assert.equal(countCrossings([{ id: "a" }, { id: "b" }], [{ id: "x" }, { id: "y" }], down2, pos), 0);
  });
});

// ---------------------------------------------------------------------------------------------
// Cluster model
// ---------------------------------------------------------------------------------------------

const statsz = (name: string, cluster: string, o: Partial<ServerStatsMsg["statsz"]> = {}, leader = "n2"): ServerStatsMsg => ({
  server: { name, id: `ID_${name}`, cluster, ver: "2.14.4", jetstream: true },
  statsz: {
    start: "2026-01-01T00:00:00Z",
    mem: 100,
    cores: 4,
    cpu: 40,
    connections: 10,
    total_connections: 20,
    subscriptions: 100,
    sent: { msgs: 1000, bytes: 10_000 },
    received: { msgs: 2000, bytes: 20_000 },
    slow_consumers: 0,
    routes: [],
    gateways: [],
    active_servers: 3,
    jetstream: { config: { max_memory: 1000, max_storage: 10_000 }, stats: { memory: 100, storage: 9_600, api: { total: 5, errors: 1 } }, meta: { leader, cluster_size: 3 } },
    ...o,
  },
});

describe("cluster model", () => {
  test("serverRowFromStatsz / serverTone / totals", () => {
    const r = serverRowFromStatsz(statsz("n1", "east", { routes: [{ rid: 1, name: "n2" }, { rid: 2, name: "n2" }, { rid: 3, name: "n3" }], gateways: [{ gwid: 1, name: "west" }] }), Date.parse("2026-01-01T01:00:00Z"));
    assert.deepEqual(r.routePeers, ["n2", "n3"]);
    assert.deepEqual(r.gateways, ["west"]);
    assert.equal(r.uptimeMs, 3_600_000);
    assert.equal(r.inMsgs, 2000);
    assert.equal(r.metaLeader, false);
    assert.equal(serverRowFromStatsz(statsz("n2", "east")).metaLeader, true);
    const t = serverTone(r);
    assert.equal(t.tone, "danger"); // JetStream storage at 96%
    assert.ok(t.issues.some((i) => /storage at 96%/.test(i)));
    const warm = serverTone({ ...r, js: undefined, cpu: 320, cores: 4, slowConsumers: 2, health: { status: "ok" } });
    assert.equal(warm.tone, "warn");
    assert.deepEqual(warm.issues, ["2 slow consumers", "CPU at 80% of 4 cores"]);
    const hot = serverTone({ ...r, js: undefined, cpu: 380, cores: 4, slowConsumers: 0, health: { status: "ok" } });
    assert.equal(hot.tone, "danger");
    assert.equal(serverTone({ ...r, js: undefined, cpu: 10, health: { status: "error", detail: "js down" } }).issues[0], "Health check failed: js down");
    assert.equal(serverTone({ ...r, ghost: true }).tone, "neutral");
    const totals = clusterTotals([r, serverRowFromStatsz(statsz("n2", "east")), { ...r, id: "ghost", ghost: true }]);
    assert.equal(totals.servers, 2);
    assert.equal(totals.connections, 20);
    assert.equal(totals.jsStorage, 19_200);
    assert.deepEqual(totals.clusters, ["east"]);
  });

  test("serverRowFromVarz", () => {
    const r = serverRowFromVarz({ server_id: "X", server_name: "solo", version: "2.14.4", start: "2026-01-01T00:00:00Z", now: "2026-01-01T00:01:00Z", cpu: 1, cores: 2, mem: 5, connections: 3, cluster: { name: "c1" }, jetstream: { config: { max_memory: 10, max_storage: 20 }, stats: { memory: 1, storage: 2 }, meta: { leader: "solo" } } });
    assert.equal(r.uptimeMs, 60_000);
    assert.equal(r.cluster, "c1");
    assert.equal(r.js?.maxStorage, 20);
    assert.equal(r.metaLeader, true);
  });

  test("routez / gatewayz / leafz conversions", () => {
    const routes = routesFromRoutez([
      {
        server: { id: "A", name: "n1" },
        data: {
          routes: [
            { rid: 1, remote_id: "B", remote_name: "n2", rtt: "1ms", in_msgs: 1, out_msgs: 2, in_bytes: 3, out_bytes: 4, subscriptions: 5 },
            { rid: 2, remote_id: "B", remote_name: "n2", rtt: "500µs", in_msgs: 10, out_msgs: 20, in_bytes: 30, out_bytes: 40, subscriptions: 1 },
          ],
        },
      },
    ]);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].connections, 2);
    assert.equal(routes[0].inMsgs, 11);
    assert.equal(routes[0].rttMs, 0.5);
    const gws = gatewaysFromGatewayz([{ server: { id: "A", name: "n1", cluster: "east" }, data: { outbound_gateways: { west: { configured: true, connection: { rtt: "20ms", in_msgs: 5 } } }, inbound_gateways: { west: [{ connection: { rtt: "21ms" } }] } } }]);
    assert.deepEqual(gws.map((g) => `${g.remote}:${g.direction}:${g.rttMs}`), ["west:inbound:21", "west:outbound:20"]);
    const leafs = leafsFromLeafz([{ server: { id: "A", name: "n1" }, data: { leafs: [{ name: "edge", account: "APP", rtt: "5ms" }] } }]);
    assert.equal(leafs[0].rttMs, 5);
  });

  test("computeRates handles resets and missing servers", () => {
    const rows = (inA: number, inB?: number): ServerRow[] => [
      { id: "A", name: "a", version: "", jetstream: false, routePeers: [], gateways: [], inMsgs: inA, outMsgs: inA, inBytes: inA, outBytes: inA },
      ...(inB === undefined ? [] : [{ id: "B", name: "b", version: "", jetstream: false, routePeers: [], gateways: [], inMsgs: inB, outMsgs: inB, inBytes: inB, outBytes: inB }]),
    ];
    assert.equal(computeRates(undefined, counterSample(0, rows(0))), undefined);
    const r = computeRates(counterSample(0, rows(100, 50)), counterSample(2000, rows(300, 10)))!;
    assert.equal(r.perServer.A.inMsgs, 100);
    assert.equal(r.perServer.B.inMsgs, null, "counter went down: restart → null");
    assert.equal(r.total.inMsgs, 100);
    const r2 = computeRates(counterSample(0, rows(100)), counterSample(1000, rows(150, 10)))!;
    assert.equal(r2.perServer.B.inMsgs, null, "new server has no previous sample");
    assert.equal(r2.total.inMsgs, 50);
  });

  test("buildClusterGraph and layout", () => {
    const n = ["n1", "n2", "n3"].map((x) => serverRowFromStatsz(statsz(x, "east", { routes: ["n1", "n2", "n3"].filter((y) => y !== x).flatMap((y) => [{ rid: 1, name: y }, { rid: 2, name: y }]), gateways: [{ gwid: 1, name: "west" }] })));
    const w = ["w1", "w2"].map((x) => serverRowFromStatsz(statsz(x, "west", { routes: ["w1", "w2"].filter((y) => y !== x).map((y) => ({ rid: 1, name: y })) })));
    const solo = { ...serverRowFromStatsz(statsz("solo", "")), cluster: undefined };
    const snap = { servers: [...w, ...n, solo], gateways: [{ serverId: "ID_n1", serverName: "n1", cluster: "east", remote: "far", direction: "outbound" as const }], leafs: [{ serverId: "ID_n1", serverName: "n1", name: "edge" }], connectedServerId: "ID_n2" };
    const g = buildClusterGraph(snap);
    assert.deepEqual(g.clusters.map((c) => c.label), ["east", "far", "standalone", "west"]);
    assert.equal(g.clusters.find((c) => c.label === "far")?.remote, true);
    assert.equal(g.routes.length, 3 + 1, "east full mesh (3) + west (1), undirected and deduped");
    assert.deepEqual(g.gateways.map((x) => `${x.a}-${x.b}`).sort(), ["east-far", "east-west"]);
    assert.equal(g.leafs.length, 1);
    for (const maxWidth of [2000, 500]) {
      const l = layoutClusterGraph(g, { maxWidth });
      assert.equal(l.servers.length, 6);
      for (let i = 0; i < l.servers.length; i++)
        for (let j = i + 1; j < l.servers.length; j++) assert.ok(!overlaps({ ...l.servers[i], width: l.servers[i].w, height: l.servers[i].h }, { ...l.servers[j], width: l.servers[j].w, height: l.servers[j].h }));
      for (const s of l.servers) {
        const c = l.clusters.find((cc) => g.clusters.find((gc) => gc.name === cc.name)?.serverIds.includes(s.id))!;
        assert.ok(s.x >= c.x && s.y >= c.y && s.x + s.w <= c.x + c.w + 0.01 && s.y + s.h <= c.y + c.h + 0.01, `${s.id} inside ${c.label}`);
      }
      const xs = [...l.clusters.map((c) => c.x), ...l.servers.map((s) => s.x), ...l.gateways.map((x) => x.lx)];
      const ys = [...l.clusters.map((c) => c.y), ...l.servers.map((s) => s.y), ...l.gateways.map((x) => x.ly)];
      assert.ok(Math.min(...xs) >= 0 && Math.min(...ys) >= 0, "diagram starts at 0,0");
      assert.equal(l.routes.length, 4);
      assert.equal(l.gateways.length, 2);
      assert.equal(l.leafs.length, 1);
    }
  });

  test("whoAmIView / userExpiry", () => {
    assert.equal(whoAmIView(undefined).available, false);
    const v = whoAmIView({ user: "app", account: "APP", account_name: "APP", permissions: { publish: { deny: ["x"] } }, expires: 3_600_000_000_000 }, 0);
    assert.equal(v.user, "app");
    assert.equal(v.accountName, undefined, "account name equal to account is not repeated");
    assert.equal(v.expires, new Date(3_600_000).toISOString());
    assert.equal(userExpiry(0), undefined);
    assert.equal(userExpiry("2030-01-01T00:00:00Z"), "2030-01-01T00:00:00.000Z");
  });

  test("monitorCandidates prefers the connected server", () => {
    const p = { id: "p", name: "p", servers: ["nats://a.example:4222", "nats://b.example:4222"], auth: { kind: "none" as const } };
    assert.deepEqual(monitorCandidates(p, "b.example:4222"), ["http://b.example:8222", "http://a.example:8222"]);
    assert.deepEqual(monitorCandidates(p, "a.example:4222"), ["http://a.example:8222"]);
    assert.deepEqual(monitorCandidates(p), ["http://a.example:8222"]);
    assert.deepEqual(monitorCandidates({ ...p, monitorUrl: "https://mon.example/ " }, "b.example:4222"), ["https://mon.example"]);
    assert.deepEqual(monitorCandidates({ ...p, servers: ["wss://ws.example:443"] }, "wss://ws.example:443"), []);
  });

  test("basicFromInfo", () => {
    const b = basicFromInfo({ server_id: "S", server_name: "n1", version: "2.14.4", go: "", host: "h", port: 1, proto: 1, max_payload: 1, client_id: 1, cluster: "c", jetstream: true });
    assert.equal(b.servers[0].connected, true);
    assert.equal(b.servers[0].cluster, "c");
    assert.equal(basicFromInfo(undefined).servers.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// Live: 2-node cluster with a system account
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("admin (live 2-node cluster)", { skip: !hasServer && "nats-server not installed" }, () => {
  const servers: ChildProcess[] = [];
  let dir: string;
  let sys: NatsConnection;
  let app: NatsConnection;
  let jsm: JetStreamManager;
  let monitorUrl: string;
  const ports: { client: number; http: number; cluster: number }[] = [];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "nats-admin-sys-"));
    for (let i = 0; i < 2; i++) ports.push({ client: await freePort(), http: await freePort(), cluster: await freePort() });
    const routes = ports.map((p) => `"nats://127.0.0.1:${p.cluster}"`).join(", ");
    ports.forEach((p, i) => {
      const conf = join(dir, `s${i}.conf`);
      writeFileSync(
        conf,
        `server_name: t${i + 1}
listen: 127.0.0.1:${p.client}
http: 127.0.0.1:${p.http}
jetstream { store_dir: "${join(dir, `js${i}`)}" }
accounts {
  SYS { users: [{ user: sys, password: sys }] }
  APP { jetstream: enabled, users: [{ user: app, password: app, permissions: { publish: { allow: [">"], deny: ["secret.>"] }, subscribe: { allow: [">"] } } }] }
}
system_account: SYS
cluster { name: test, listen: 127.0.0.1:${p.cluster}, routes: [${routes}] }
`,
      );
      servers.push(spawn("nats-server", ["-c", conf], { stdio: "ignore" }));
    });
    monitorUrl = `http://127.0.0.1:${ports[0].http}`;
    for (let i = 0; i < 80 && !sys; i++) {
      try {
        sys = await connect({ servers: `nats://127.0.0.1:${ports[0].client}`, user: "sys", pass: "sys", timeout: 500 });
      } catch {
        await sleep(100);
      }
    }
    app = await connect({ servers: `nats://127.0.0.1:${ports[0].client}`, user: "app", pass: "app" });
    // wait for the route mesh and a JetStream meta leader
    for (let i = 0; i < 100; i++) {
      const all = await pingServers(sys, { maxWait: 500 }).catch(() => []);
      if (all.length === 2 && all.every((s) => s.statsz.routes?.length) && all.some((s) => s.statsz.jetstream?.meta?.leader)) break;
      await sleep(150);
    }
    jsm = await jetstreamManager(app);
    for (let i = 0; i < 60; i++) {
      try {
        await jsm.streams.add({ name: "ORDERS", subjects: ["orders.>"], num_replicas: 1 });
        break;
      } catch {
        await sleep(250);
      }
    }
  });

  after(async () => {
    await sys?.close();
    await app?.close();
    for (const s of servers) s.kill();
    await sleep(100);
    rmSync(dir, { recursive: true, force: true });
  });

  test("system-account detection", async () => {
    assert.equal(await detectSystemAccess(sys), true);
    assert.equal(await detectSystemAccess(app), false);
    assert.equal(await hasSystemAccess(app), false);
    await assert.rejects(pingServers(app, { maxWait: 300 }), SystemAccessError);
  });

  test("statsz scatter-gather and per-server endpoints", async () => {
    const t0 = Date.now();
    const all = await pingServers(sys, { maxWait: 3000 });
    assert.ok(Date.now() - t0 < 2500, "returns early once every active server answered");
    assert.deepEqual(all.map((s) => s.server.name), ["t1", "t2"]);
    const row = serverRowFromStatsz(all[0]);
    assert.deepEqual(row.routePeers, ["t2"]);
    for (const s of all) {
      const varz = await serverRequest<{ server_name: string }>(sys, s.server.id, "VARZ");
      assert.equal(varz.data?.server_name, s.server.name);
      const health = await serverRequest<Healthz>(sys, s.server.id, "HEALTHZ");
      assert.equal(health.data?.status, "ok");
      const jsz = await serverRequest<{ config?: unknown }>(sys, s.server.id, "JSZ");
      assert.ok(jsz.data?.config);
    }
    const routez = await pingAll<Routez>(sys, "ROUTEZ", {}, 2000, 2);
    const routes = routesFromRoutez(routez);
    assert.equal(routes.length, 2, "one merged row per server and peer");
    assert.ok(routes.every((r) => r.connections >= 1));
  });

  test("collectSystem builds a full snapshot", async () => {
    const part = await collectSystem(sys, { topology: true });
    assert.equal(part.servers.length, 2);
    assert.equal(part.expectedServers, 2);
    assert.ok(part.servers.every((s) => s.health?.status === "ok"));
    assert.ok(part.meta?.leader);
    const g = buildClusterGraph({ ...part, connectedServerId: part.servers[0].id });
    assert.equal(g.routes.length, 1);
    assert.equal(g.clusters.length, 1);
    await assert.rejects(collectSystem(app), SystemAccessError);
  });

  test("HTTP monitoring fallback", async () => {
    const part = await collectMonitor(monitorUrl);
    assert.equal(part.servers[0].name, "t1");
    assert.equal(part.servers[0].connected, true);
    assert.equal(part.servers[0].health?.status, "ok");
    assert.ok(part.servers.some((s) => s.ghost && s.name === "t2"), "route peer shown as ghost");
    assert.equal(part.routes.length, 1);
    // a monitoring URL that points at another server than the connected one is not "connected"
    const elsewhere = await collectMonitor(monitorUrl, 2500, "NOT_THIS_SERVER");
    assert.equal(elsewhere.servers[0].connected, false);
    const here = await collectMonitor(monitorUrl, 2500, part.servers[0].id);
    assert.equal(here.servers[0].connected, true);
  });

  test("user info for an ordinary user", async () => {
    const u = await fetchUserInfo(app);
    assert.equal(u?.user, "app");
    assert.equal(u?.account, "APP");
    assert.deepEqual(u?.permissions?.publish?.deny, ["secret.>"]);
    const v = whoAmIView(u);
    assert.match(v.permissions.short, /secret\.>/);
  });

  test("topology collection → graph → layout", async () => {
    await jsm.streams.add({ name: "ORDERS_MIRROR", mirror: { name: "ORDERS" }, num_replicas: 1 });
    await jsm.consumers.add("ORDERS", { durable_name: "billing", ack_policy: AckPolicy.Explicit, filter_subject: "orders.eu.>" });
    await new Kvm(app).create("config");
    await new Objm(app).create("files");
    const srv = await new Svcm(app).add({ name: "orders-api", version: "1.0.0" });
    srv.addEndpoint("create", { subject: "orders.api.create", handler: (_e, m) => m.respond(new TextEncoder().encode("ok")) });
    try {
      const lcLike = { jsm: () => jetstreamManager(app), svcm: () => new Svcm(app), hasJetStream: async () => true };
      const data = await collectTopology(lcLike);
      assert.equal(data.jetstream, true);
      assert.deepEqual(
        data.streams.map((s) => `${s.name}:${s.kind}`),
        ["KV_config:kv", "OBJ_files:obj", "ORDERS:stream", "ORDERS_MIRROR:stream"],
      );
      assert.equal(data.streams.find((s) => s.name === "ORDERS_MIRROR")?.mirror?.name, "ORDERS");
      assert.equal(data.consumers.find((c) => c.name === "billing")?.filterSubjects[0], "orders.eu.>");
      assert.equal(data.endpoints[0]?.subject, "orders.api.create");
      const g = buildGraph(data);
      assert.ok(g.edges.some((e) => e.kind === "mirror" && e.from === "stream:ORDERS"));
      assert.ok(g.edges.some((e) => e.kind === "serves" && e.from === "stream:ORDERS"));
      const l = layoutGraph(g.nodes.map((n) => ({ id: n.id, width: 180, height: 40, order: n.order })), g.edges);
      assert.equal(l.nodes.size, g.nodes.length);
      // caps for huge accounts: listing stops and a warning says so
      for (const name of ["c1", "c2", "c3"]) await jsm.consumers.add("ORDERS", { durable_name: name, ack_policy: AckPolicy.Explicit });
      const capped = await collectTopology(lcLike, { noServices: true, maxStreams: 2, maxConsumersPerStream: 2 });
      assert.equal(capped.streams.length, 2);
      assert.ok(capped.warnings.some((w) => /more than 2 streams/.test(w)), capped.warnings.join(" | "));
      const consCapped = await collectTopology(lcLike, { noServices: true, maxConsumersPerStream: 2 });
      assert.equal(consCapped.consumers.filter((c) => c.stream === "ORDERS").length, 2);
      assert.ok(consCapped.warnings.some((w) => /first 2 consumers are listed for ORDERS/.test(w)), consCapped.warnings.join(" | "));
      // JetStream unavailable → graceful
      const none = await collectTopology({ jsm: () => Promise.reject(new Error("JetStream not enabled")), svcm: () => new Svcm(app), hasJetStream: async () => false }, { noServices: true });
      assert.equal(none.jetstream, false);
      assert.match(none.jetstreamError ?? "", /not enabled/);
    } finally {
      await srv.stop();
    }
  });

  test("who-am-i and server details documents", async () => {
    const profile = { id: "p", name: "test", servers: [`nats://127.0.0.1:${ports[0].client}`], auth: { kind: "userpass" as const, username: "app" }, environment: "dev" as const };
    const doc = await buildWhoAmI({ nc: app, profile, hasJetStream: async () => true, jsm: () => jetstreamManager(app) });
    assert.equal(doc.user, "app");
    assert.equal(doc.account, "APP");
    assert.equal(doc.systemAccountAccess, false);
    const conn = doc.connection as Record<string, unknown>;
    assert.equal(conn.connectedUrl, `127.0.0.1:${ports[0].client}`);
    assert.equal(conn.inboxPrefix, "_INBOX");
    assert.equal(typeof conn.rttMs, "number");
    assert.equal(typeof conn.clientId, "number");
    assert.ok((doc.server as { name: string }).name === "t1");
    const all = await pingServers(sys);
    const details = await buildServerDetails(sys, all[1].server.id);
    assert.equal((details.server as { name: string }).name, "t2");
    assert.equal((details.health as Healthz).status, "ok");
    assert.ok((details.varz as Record<string, unknown>).server_name === "t2");
  });
});
