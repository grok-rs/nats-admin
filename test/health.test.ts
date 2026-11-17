// Health doctor tests: pure checks / score / report on fixtures, plus live
// collection against throwaway nats-servers (JetStream + monitoring, JetStream
// disabled, and a user without consumer-listing permissions).

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { AckPolicy, DiscardPolicy, RetentionPolicy, jetstream, jetstreamManager, type ConsumerInfo, type StreamInfo } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { Objm } from "@nats-io/obj";
import { analyze, compareVersions, isTransientConsumer, limitRatio, parseActive, usageSeverity } from "../src/health/checks";
import { buildReport, healthScore, summarize, toMarkdown } from "../src/health/score";
import { collectSnapshot, isPermissionError, mapPool, type CollectSource } from "../src/health/collect";
import { badgeFor, compareFindings, countsText, decorationMarks, DEFAULT_THRESHOLDS, findingOf, nodePathsFor, scoreLabel, targetKey, targetLabel, type Finding, type HealthSnapshot } from "../src/health/model";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const T = { ...DEFAULT_THRESHOLDS, pendingWarning: 1000 };
const NOW = Date.parse("2026-11-17T12:00:00Z");

function stream(name: string, cfg: Record<string, unknown> = {}, state: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): StreamInfo {
  return {
    config: { name, subjects: [`${name.toLowerCase()}.>`], retention: "limits", storage: "file", discard: "old", max_age: 0, max_bytes: -1, max_msgs: -1, max_msgs_per_subject: -1, num_replicas: 1, ...cfg },
    created: "2026-01-01T00:00:00Z",
    state: { messages: 0, bytes: 0, first_seq: 1, last_seq: 0, consumer_count: 0, ...state },
    ...extra,
  } as unknown as StreamInfo;
}

function consumer(streamName: string, name: string, cfg: Record<string, unknown> = {}, state: Record<string, unknown> = {}): ConsumerInfo {
  return {
    stream_name: streamName,
    name,
    created: "2026-01-01T00:00:00Z",
    config: { durable_name: name, ack_policy: "explicit", max_deliver: 5, max_ack_pending: 1000, ack_wait: 30e9, ...cfg },
    delivered: { consumer_seq: 0, stream_seq: 0, last_active: new Date(NOW - 1000).toISOString() },
    ack_floor: { consumer_seq: 0, stream_seq: 0 },
    num_ack_pending: 0,
    num_redelivered: 0,
    num_waiting: 1,
    num_pending: 0,
    push_bound: false,
    ...state,
  } as unknown as ConsumerInfo;
}

function snapshot(over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    connId: "c1",
    connName: "local",
    at: NOW,
    durationMs: 42,
    server: { name: "n1", id: "NID", version: "2.10.14", jetstream: true },
    connectedUrl: "nats://127.0.0.1:4222",
    rttMs: 0.4,
    jetstream: { enabled: true },
    streams: [],
    consumers: {},
    monitor: { reachable: false },
    notes: [],
    ...over,
  };
}

const ids = (fs: Finding[]) => fs.map((f) => f.id);
const find = (fs: Finding[], id: string, key?: string) => fs.find((f) => f.id === id && (!key || targetKey(f.target) === key));

/** A snapshot exercising every check. */
function richSnapshot(): HealthSnapshot {
  const streams = [
    stream("UNBOUNDED", {}, { messages: 10, bytes: 2048 }),
    stream("BOUNDED", { max_age: 86400e9 }),
    stream("PERSUBJ", { max_msgs_per_subject: 10 }),
    stream("ROLLING", { max_msgs: 100 }, { messages: 100 }), // limits + discard old at its limit: by design
    stream("FULL", { discard: "new", max_bytes: 1000 }, { bytes: 990 }),
    stream("NEARLY", { discard: "new", max_msgs: 100 }, { messages: 85 }),
    stream("WQOLD", { retention: "workqueue", max_msgs: 100, max_age: 1 }, { messages: 90, consumer_count: 1 }),
    stream("INTEREST", { retention: "interest", max_age: 1 }, { consumer_count: 0 }),
    stream("WORK", { retention: "workqueue", max_age: 1 }, { messages: 7, consumer_count: 0 }),
    stream("EVEN", { num_replicas: 2, max_age: 1 }, {}, { cluster: { name: "C1", leader: "n1", replicas: [{ name: "n2", current: true, offline: false, active: 1e6, lag: 0 }] } }),
    stream("NOLEADER", { num_replicas: 3, max_age: 1 }, {}, { cluster: { name: "C1", replicas: [] } }),
    stream("LAGGY", { num_replicas: 3, max_age: 1 }, {}, { cluster: { name: "C1", leader: "n1", replicas: [{ name: "n2", current: false, offline: false, active: 2e9, lag: 512 }, { name: "n3", current: true, offline: true, active: 9e10, lag: 0 }] } }),
    stream("MIRROR", { max_age: 1, mirror: { name: "UPSTREAM" } }, {}, { mirror: { name: "UPSTREAM", lag: 50_000, active: 1e9 } }),
    stream("SOURCED", { max_age: 1, sources: [{ name: "A" }, { name: "B" }] }, {}, { sources: [{ name: "A", lag: 0, active: 10 * 60e9 }, { name: "B", lag: 0, active: 1e9, error: { code: 404, description: "stream not found" } }] }),
    stream("ORDERS", { max_age: 7 * 86400e9 }, { messages: 50_000, consumer_count: 6 }),
    stream("KV_config", { max_msgs_per_subject: 5, discard: "new", max_bytes: 1000 }, { messages: 3, bytes: 900 }),
    stream("OBJ_files", { discard: "new" }, { bytes: 10 }),
  ];
  const consumers: Record<string, ConsumerInfo[]> = {
    ORDERS: [
      consumer("ORDERS", "healthy"),
      consumer("ORDERS", "lagging", { max_deliver: -1 }, { num_pending: 20_000, num_waiting: 0, delivered: { consumer_seq: 1, stream_seq: 1, last_active: new Date(NOW - 3600_000).toISOString() } }),
      consumer("ORDERS", "stalled", { max_ack_pending: 10 }, { num_ack_pending: 10, num_redelivered: 150 }),
      consumer("ORDERS", "almost", { max_ack_pending: 100 }, { num_ack_pending: 92 }),
      consumer("ORDERS", "pushy", { deliver_subject: "deliver.pushy" }, { num_pending: 5, push_bound: false }),
      consumer("ORDERS", "paused", {}, { paused: true, pause_remaining: 3600e9, num_pending: 3 }),
      consumer("ORDERS", "ordered", { durable_name: undefined, ack_policy: "none", max_deliver: -1 }, { num_pending: 999_999, num_waiting: 0 }),
    ],
  };
  return snapshot({
    server: { name: "n1", id: "NID", version: "2.9.22", cluster: "C1", jetstream: true },
    rttMs: 250,
    streams,
    consumers,
    account: {
      memory: 0,
      storage: 960,
      reserved_memory: 0,
      reserved_storage: 0,
      streams: 18,
      consumers: 7,
      limits: { max_memory: -1, max_storage: 1000, max_streams: 20, max_consumers: -1, max_ack_pending: -1, memory_max_stream_bytes: -1, storage_max_stream_bytes: -1, max_bytes_required: false },
      api: { total: 1000, errors: 120 },
    },
    monitor: {
      url: "http://127.0.0.1:8222",
      reachable: true,
      healthz: { status: "unavailable", error: "JetStream stream 'ORDERS' is not current" },
      varz: { slow_consumers: 3, slow_consumer_stats: { clients: 3 }, connections: 90, max_connections: 100, jetstream: { config: { max_storage: 1000, max_memory: 0 }, stats: { storage: 500, memory: 0 } } },
    },
    notes: [{ scope: "consumers", stream: "SECRET", message: "Permissions Violation for Publish to $JS.API.CONSUMER.LIST.SECRET", permission: true }],
  });
}

// ---------------------------------------------------------------------------------------------
// Pure tests
// ---------------------------------------------------------------------------------------------

describe("health checks (pure)", () => {
  test("helpers", () => {
    assert.ok(compareVersions("2.9.22", "2.10.0") < 0);
    assert.ok(compareVersions("v2.10.14-beta.1", "2.10.0") > 0);
    assert.equal(compareVersions("2.10", "2.10.0"), 0);
    assert.equal(parseActive("0001-01-01T00:00:00Z"), undefined);
    assert.equal(parseActive(12345), undefined);
    assert.equal(parseActive("2026-11-17T12:00:00Z"), NOW);
    assert.equal(limitRatio(5, -1), undefined);
    assert.equal(limitRatio(5, 0), undefined);
    assert.equal(limitRatio(5, 10), 0.5);
    assert.equal(usageSeverity(0.96, T), "error");
    assert.equal(usageSeverity(0.85, T), "warning");
    assert.equal(usageSeverity(0.5, T), undefined);
    assert.ok(isTransientConsumer(consumer("S", "x", { durable_name: undefined, ack_policy: "none" })));
    assert.ok(!isTransientConsumer(consumer("S", "x", { ack_policy: "none" })));
    assert.ok(isPermissionError(new Error("Permissions Violation for Publish to $JS.API.INFO")));
    assert.ok(!isPermissionError(new Error("503")));
    assert.equal(badgeFor(1), "!");
    assert.equal(badgeFor(4), "4");
    assert.equal(badgeFor(12), "9+");
  });

  test("a healthy snapshot has no findings and scores 100", () => {
    const snap = snapshot({ streams: [stream("ORDERS", { max_age: 86400e9 }, { messages: 10, consumer_count: 1 })], consumers: { ORDERS: [consumer("ORDERS", "billing")] }, monitor: { url: "http://x", reachable: true, healthz: { status: "ok" }, varz: { slow_consumers: 0 } } });
    const fs = analyze(snap, T);
    assert.deepEqual(ids(fs), []);
    const r = buildReport(snap, fs, T);
    assert.equal(r.score, 100);
    assert.equal(scoreLabel(r.score), "Healthy");
    assert.equal(countsText(r.counts), "no findings");
    assert.deepEqual(
      r.resources.map((x) => x.key),
      ["server", "stream/ORDERS", "consumer/ORDERS/billing"],
    );
    assert.ok(r.resources.every((x) => !x.worst));
  });

  test("every check fires on the rich fixture", () => {
    const fs = analyze(richSnapshot(), T);
    const expect: [string, string | undefined, Finding["severity"]][] = [
      ["connection.rtt-high", "connection", "warning"],
      ["server.version-old", "server", "warning"],
      ["server.healthz", "server", "error"],
      ["server.slow-consumers", "server", "warning"],
      ["server.connections-near-limit", "server", "warning"],
      ["account.storage-near-limit", "account", "error"],
      ["account.streams-near-limit", "account", "warning"],
      ["account.api-errors", "account", "warning"],
      ["stream.unbounded", "stream/UNBOUNDED", "warning"],
      ["stream.near-limit", "stream/FULL", "error"],
      ["stream.near-limit", "stream/NEARLY", "warning"],
      ["stream.near-limit", "stream/WQOLD", "warning"],
      ["stream.replicas-1", "stream/ORDERS", "warning"],
      ["stream.replicas-even", "stream/EVEN", "warning"],
      ["stream.no-leader", "stream/NOLEADER", "error"],
      ["stream.replica-lagging", "stream/LAGGY", "warning"],
      ["stream.replica-offline", "stream/LAGGY", "error"],
      ["stream.mirror-lag", "stream/MIRROR", "warning"],
      ["stream.source-lag", "stream/SOURCED", "warning"],
      ["stream.source-error", "stream/SOURCED", "error"],
      ["stream.interest-no-consumers", "stream/INTEREST", "warning"],
      ["stream.workqueue-no-consumers", "stream/WORK", "warning"],
      ["kv.near-limit", "kv/config", "warning"],
      ["kv.replicas-1", "kv/config", "warning"],
      ["objectstore.replicas-1", "obj/files", "warning"],
      ["consumer.pending-high", "consumer/ORDERS/lagging", "error"],
      ["consumer.pull-idle", "consumer/ORDERS/lagging", "warning"],
      ["consumer.max-deliver-unlimited", "consumer/ORDERS/lagging", "info"],
      ["consumer.ack-pending-stalled", "consumer/ORDERS/stalled", "error"],
      ["consumer.ack-pending-stalled", "consumer/ORDERS/almost", "warning"],
      ["consumer.redeliveries", "consumer/ORDERS/stalled", "warning"],
      ["consumer.push-unbound", "consumer/ORDERS/pushy", "warning"],
      ["consumer.paused", "consumer/ORDERS/paused", "warning"],
      ["collect.consumers", "connection", "info"],
    ];
    for (const [id, key, sev] of expect) {
      const f = find(fs, id, key);
      assert.ok(f, `expected ${id} on ${key}; got ${fs.map((x) => `${x.id}@${targetKey(x.target)}`).join(", ")}`);
      assert.equal(f.severity, sev, `${id} on ${key}`);
      assert.ok(f.title && f.detail && f.recommendation, `${id} has title, detail and recommendation`);
    }
    // Things that must NOT be reported.
    assert.ok(!find(fs, "stream.unbounded", "stream/BOUNDED"));
    assert.ok(!find(fs, "stream.unbounded", "stream/PERSUBJ"), "max_msgs_per_subject bounds a stream");
    assert.ok(!find(fs, "stream.near-limit", "stream/ROLLING"), "limits + discard old at the limit is a rolling window");
    assert.ok(!fs.some((f) => targetKey(f.target) === "consumer/ORDERS/ordered"), "transient ordered consumers are ignored");
    assert.ok(!fs.some((f) => targetKey(f.target) === "consumer/ORDERS/healthy"));
    assert.ok(!find(fs, "server.js-storage-near-limit"), "server storage at 50% is fine");
    assert.ok(!find(fs, "stream.unbounded", "kv/config"), "KV buckets are not checked for unbounded limits");
    // Sorted most important first, keys unique.
    const sorted = [...fs].sort(compareFindings);
    assert.deepEqual(ids(fs), ids(sorted));
    assert.equal(new Set(fs.map((f) => f.key)).size, fs.length);
    assert.equal(fs[0].severity, "error");
  });

  test("fixes point at commands with arguments the health fixer understands", () => {
    const fs = analyze(richSnapshot(), T);
    const known = new Set(["nats.editStreamConfig", "nats.streamInfo", "nats.browseMessages", "nats.consumerInfo", "nats.editConsumerConfig", "nats.openConsumerLab", "nats.kvBucketInfo", "nats.objBucketInfo", "nats.serverInfo", "nats.openDashboard", "nats.editConnection"]);
    for (const f of fs) {
      if (!f.fix) continue;
      assert.ok(known.has(f.fix.command), `${f.id}: ${f.fix.command}`);
      assert.equal(f.fix.args.connId, "c1");
      if (/Stream|browse/.test(f.fix.command)) assert.ok(f.fix.args.stream, `${f.id} has a stream`);
      if (/Consumer/.test(f.fix.command)) assert.ok(f.fix.args.stream && f.fix.args.consumer, `${f.id} has stream + consumer`);
      if (/Bucket/.test(f.fix.command)) assert.ok(f.fix.args.bucket, `${f.id} has a bucket`);
    }
    assert.equal(find(fs, "stream.unbounded")!.fix!.command, "nats.editStreamConfig");
    assert.equal(find(fs, "consumer.pull-idle")!.fix!.command, "nats.openConsumerLab");
    assert.equal(find(fs, "consumer.max-deliver-unlimited")!.fix!.command, "nats.editConsumerConfig");
    assert.deepEqual(find(fs, "kv.near-limit")!.fix!.args, { connId: "c1", stream: "KV_config" });
    assert.ok(find(fs, "stream.unbounded")!.docs?.startsWith("https://docs.nats.io/"));
  });

  test("thresholds change the outcome", () => {
    const snap = richSnapshot();
    const loose = analyze(snap, { ...T, pendingWarning: 1e9, rttWarningMs: 1000, storageWarningRatio: 0.99, storageErrorRatio: 0.999, ackPendingRatio: 1 });
    assert.ok(!find(loose, "consumer.pending-high"));
    assert.ok(!find(loose, "connection.rtt-high"));
    assert.ok(!find(loose, "stream.near-limit", "stream/NEARLY"));
    assert.ok(!find(loose, "consumer.ack-pending-stalled", "consumer/ORDERS/almost"));
    assert.ok(find(loose, "consumer.ack-pending-stalled", "consumer/ORDERS/stalled"), "a full ack pending window is always reported");
  });

  test("JetStream disabled, monitoring unreachable and permission notes", () => {
    const off = analyze(snapshot({ server: { name: "n1", id: "x", version: "2.12.0", jetstream: false }, jetstream: { enabled: false, reason: "JetStream is not enabled" }, monitor: { url: "http://127.0.0.1:1", reachable: false, error: "ECONNREFUSED" } }), T);
    const js = find(off, "server.jetstream-disabled")!;
    assert.equal(js.category, "server");
    assert.equal(js.severity, "info");
    const mon = find(off, "server.monitor-unreachable")!;
    assert.equal(mon.fix?.command, "nats.editConnection");
    assert.match(mon.detail, /ECONNREFUSED/);
    const acct = analyze(snapshot({ jetstream: { enabled: false } }), T);
    assert.equal(find(acct, "server.jetstream-disabled")!.category, "account", "server has JetStream, account doesn't");
    const denied = analyze(snapshot({ jetstream: { enabled: false, permissionDenied: true }, notes: [{ scope: "jetstream", message: "Permissions Violation", permission: true }] }), T);
    assert.ok(!find(denied, "server.jetstream-disabled"));
    assert.match(find(denied, "collect.jetstream")!.recommendation, /\$JS\.API/);
  });

  test("every failing or lagging source of a stream is reported", () => {
    const snap = snapshot({
      streams: [
        stream("AGG", { max_age: 1, sources: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }, { name: "A" }] }, {}, {
          sources: [
            { name: "A", lag: 0, active: 1e9, error: { code: 404, description: "stream not found" } },
            { name: "B", lag: 0, active: 1e9, error: { code: 503, description: "no responders" } },
            { name: "C", lag: 5000, active: 1e9 },
            { name: "D", lag: 0, active: 20 * 60e9 },
            // Same upstream again (e.g. another filter / domain): reported separately too.
            { name: "A", lag: 7000, active: 1e9 },
          ],
        }),
      ],
    });
    const fs = analyze(snap, T);
    const errors = fs.filter((f) => f.id === "stream.source-error");
    const lags = fs.filter((f) => f.id === "stream.source-lag");
    assert.deepEqual(errors.map((f) => f.title).sort(), ["Source A is failing", "Source B is failing"]);
    assert.equal(lags.length, 3, lags.map((f) => f.title).join(" | "));
    assert.ok(lags.some((f) => /Source C is 5,000 messages behind/.test(f.title)));
    assert.ok(lags.some((f) => /Source D inactive/.test(f.title)));
    assert.equal(new Set(fs.map((f) => f.key)).size, fs.length, "keys stay unique");
    assert.ok(fs.every((f) => targetKey(f.target) === "stream/AGG"));
  });

  test("an unanswered JetStream API is 'could not access', not 'not enabled'", () => {
    const fs = analyze(snapshot({ jetstream: { enabled: false, reason: "JetStream timed out after 10s", failed: true }, notes: [{ scope: "jetstream", message: "JetStream timed out after 10s", permission: false }] }), T);
    assert.ok(!find(fs, "server.jetstream-disabled"), "a timeout does not mean JetStream is off");
    const f = find(fs, "collect.jetstream")!;
    assert.ok(f, ids(fs).join(", "));
    assert.equal(f.severity, "info");
    assert.match(f.title, /Could not access the JetStream API/);
    assert.match(f.recommendation, /incomplete/);
  });

  test("collectSnapshot classifies JetStream errors and survives every failing call", async () => {
    const fake = (jsError: Error, rtt: () => Promise<number> = async () => 1.5): CollectSource =>
      ({
        nc: { rtt, getServer: () => "nats://127.0.0.1:4222" } as unknown as NatsConnection,
        info: { server_name: "n1", server_id: "NID", version: "2.11.0", jetstream: true } as never,
        jsm: () => Promise.reject(jsError),
      }) as CollectSource;
    const timedOut = await collectSnapshot(fake(new Error("TimeoutError: timeout")), { connId: "c", connName: "c" });
    assert.equal(timedOut.jetstream.enabled, false);
    assert.equal(timedOut.jetstream.failed, true);
    assert.equal(timedOut.rttMs, 1.5);
    assert.equal(timedOut.server?.version, "2.11.0");
    assert.deepEqual(timedOut.streams, []);
    const off = await collectSnapshot(fake(new Error("503 no responders")), { connId: "c", connName: "c" });
    assert.equal(off.jetstream.failed, undefined);
    assert.match(off.jetstream.reason!, /not enabled/);
    const denied = await collectSnapshot(fake(new Error("Permissions Violation for Publish to $JS.API.INFO"), () => Promise.reject(new Error("rtt failed"))), { connId: "c", connName: "c" });
    assert.equal(denied.jetstream.permissionDenied, true);
    assert.equal(denied.jetstream.failed, undefined);
    assert.equal(denied.rttMs, undefined);
    assert.deepEqual(
      denied.notes.map((n) => n.scope),
      ["rtt", "jetstream"],
    );
    // A slow RTT is cut off by the per-call timeout instead of hanging the run.
    const slow = await collectSnapshot(fake(new Error("503"), () => new Promise(() => undefined)), { connId: "c", connName: "c", timeoutMs: 50 });
    assert.match(slow.notes.find((n) => n.scope === "rtt")!.message, /timed out/);
  });

  test("tiered account limits", () => {
    const snap = snapshot({
      account: {
        memory: 0,
        storage: 0,
        reserved_memory: 0,
        reserved_storage: 0,
        streams: 1,
        consumers: 0,
        limits: { max_memory: 0, max_storage: 0, max_streams: 0, max_consumers: 0, max_ack_pending: 0, memory_max_stream_bytes: 0, storage_max_stream_bytes: 0, max_bytes_required: false },
        api: { total: 10, errors: 9 },
        tiers: { R3: { memory: 0, storage: 99, reserved_memory: 0, reserved_storage: 0, streams: 1, consumers: 0, limits: { max_memory: 0, max_storage: 100, max_streams: 0, max_consumers: 0, max_ack_pending: 0, memory_max_stream_bytes: 0, storage_max_stream_bytes: 0, max_bytes_required: false } } },
      },
    });
    const fs = analyze(snap, T);
    assert.equal(find(fs, "account.storage-near-limit-R3")?.severity, "error");
    assert.ok(!find(fs, "account.api-errors"), "API error ratio needs at least 100 requests");
  });

  test("score saturates per severity", () => {
    const f = (severity: Finding["severity"], n: number) => Array.from({ length: n }, () => ({ severity }));
    assert.equal(healthScore([]), 100);
    assert.equal(healthScore(f("info", 1)), 99);
    const oneError = healthScore(f("error", 1));
    assert.ok(oneError < 90 && oneError >= 60, `one error → degraded (${oneError})`);
    assert.ok(healthScore(f("error", 3)) < 60, "three errors → critical");
    assert.ok(healthScore(f("warning", 100)) >= 60, "warnings alone stay degraded at worst");
    assert.ok(healthScore(f("warning", 1)) >= 90, "a single warning keeps a healthy score");
    assert.ok(healthScore([...f("error", 5), ...f("warning", 50), ...f("info", 50)]) >= 0);
    assert.ok(healthScore(f("warning", 2)) < healthScore(f("warning", 1)));
    assert.equal(healthScore([{ severity: "error", weight: 0 }]), 100, "weights scale the penalty");
  });

  test("report, summary, Markdown and decorations", () => {
    const snap = richSnapshot();
    const fs = analyze(snap, T);
    const r = buildReport(snap, fs, T);
    assert.equal(r.counts.error + r.counts.warning + r.counts.info, fs.length);
    assert.ok(r.score < 60, `rich fixture is critical (${r.score})`);
    assert.deepEqual(r.inventory, { streams: 15, consumers: 6, kv: 1, obj: 1 });
    const orders = r.resources.find((x) => x.key === "stream/ORDERS")!;
    assert.equal(orders.worst, "warning");
    assert.match(orders.summary, /50,000 msgs/);
    const lagging = r.resources.find((x) => x.key === "consumer/ORDERS/lagging")!;
    assert.equal(lagging.worst, "error");
    assert.equal(lagging.parent, "ORDERS");
    assert.ok(!r.resources.some((x) => x.key === "consumer/ORDERS/ordered"));
    assert.ok(r.resources.some((x) => x.key === "kv/config" && x.worst === "warning"));
    const cat = r.categories.find((c) => c.category === "consumer")!;
    assert.equal(cat.count, fs.filter((f) => f.category === "consumer").length);
    assert.ok(cat.score < 100);

    const sum = summarize(r);
    assert.equal(sum.top.length, 5);
    assert.equal(sum.top[0].severity, "error");
    assert.equal(sum.errors, r.counts.error);

    const md = toMarkdown(r, { environment: "Production" });
    assert.match(md, /^# NATS health report: local/);
    assert.match(md, new RegExp(`Score ${r.score}/100`));
    assert.match(md, /### Errors \(\d+\)/);
    assert.match(md, /`consumer\.pending-high`/);
    assert.match(md, /\(Production\)/);
    assert.match(md, /## Collection notes/);
    const tableRows = md.split("## Resources with findings")[1].split("\n## ")[0].split("\n").filter((l) => l.startsWith("| `"));
    assert.ok(tableRows.length > 5);
    assert.ok(tableRows.every((l) => l.trimEnd().endsWith("|")), "table rows stay on one line");

    const kv = find(fs, "kv.near-limit")!;
    assert.deepEqual(nodePathsFor(kv), ["/kv/config", "/stream/KV_config"]);
    assert.deepEqual(nodePathsFor(find(fs, "consumer.pull-idle")!), ["/consumer/ORDERS/lagging"]);
    assert.deepEqual(nodePathsFor(find(fs, "account.api-errors")!), ["/server"]);
    const marks = decorationMarks(fs);
    assert.ok(![...marks.values()].some((m) => m.errors + m.warnings === 0), "info-only nodes are not decorated");
    const lagMark = marks.get("/consumer/ORDERS/lagging")!;
    assert.deepEqual([lagMark.errors, lagMark.warnings], [1, 1], "pending-high (error) + pull-idle (warning); max-deliver info skipped");
    // ORDERS: its own replicas-1 warning plus every consumer error / warning rolled up.
    const ordersMark = marks.get("/stream/ORDERS")!;
    const consumerFs = fs.filter((f) => f.target.kind === "consumer" && f.target.stream === "ORDERS" && f.severity !== "info");
    assert.equal(ordersMark.errors, consumerFs.filter((f) => f.severity === "error").length);
    assert.equal(ordersMark.warnings, 1 + consumerFs.filter((f) => f.severity === "warning").length);
    assert.ok(ordersMark.titles.includes("consumer stalled: Ack pending limit reached — delivery stalled"), ordersMark.titles.join(" | "));
    assert.equal(marks.get("/kv/config")?.warnings, 2);
    assert.equal(marks.get("/stream/KV_config")?.warnings, 2, "KV findings also mark the backing stream");
    assert.ok(marks.get("/server")!.errors >= 1);
    assert.equal(targetLabel(kv.target), "KV config");
    assert.equal(findingOf({ finding: kv }), kv);
    assert.equal(findingOf(kv), kv);
    assert.equal(findingOf({ connId: "c1" }), undefined);
  });

  test("mapPool bounds concurrency and keeps order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });
    assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
    assert.ok(peak <= 3);
  });
});

// ---------------------------------------------------------------------------------------------
// Live tests
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

async function connectRetry(opts: Parameters<typeof connect>[0]): Promise<NatsConnection> {
  for (let i = 0; i < 60; i++) {
    try {
      return await connect({ timeout: 500, ...opts });
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("could not connect to the test server");
}

function source(nc: NatsConnection): CollectSource {
  return { nc, get info() { return nc.info; }, jsm: () => jetstreamManager(nc) };
}

describe("health collection (live server)", { skip: !hasServer && "nats-server not installed" }, () => {
  const servers: ChildProcess[] = [];
  const conns: NatsConnection[] = [];
  const dirs: string[] = [];
  let nc: NatsConnection;
  let monitorUrl: string;
  const enc = new TextEncoder();

  const start = (args: string[]) => {
    const p = spawn("nats-server", args, { stdio: "ignore" });
    servers.push(p);
    return p;
  };

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "nats-admin-health-"));
    dirs.push(dir);
    const port = await freePort();
    const mport = await freePort();
    monitorUrl = `http://127.0.0.1:${mport}`;
    start(["-js", "-sd", dir, "-p", String(port), "-m", String(mport), "-a", "127.0.0.1"]);
    nc = await connectRetry({ servers: `nats://127.0.0.1:${port}` });
    conns.push(nc);
    const jsm = await jetstreamManager(nc);
    const js = jetstream(nc);

    await jsm.streams.add({ name: "UNBOUNDED", subjects: ["unb.>"] });
    await jsm.streams.add({ name: "FULL", subjects: ["full.>"], discard: DiscardPolicy.New, max_msgs: 10 });
    for (let i = 0; i < 10; i++) await js.publish("full.x", enc.encode(String(i)));
    await jsm.streams.add({ name: "INTEREST", subjects: ["int.>"], retention: RetentionPolicy.Interest, max_age: 3600e9 });
    await jsm.streams.add({ name: "WORK", subjects: ["work.>"], retention: RetentionPolicy.Workqueue, max_age: 3600e9 });
    for (let i = 0; i < 5; i++) await js.publish("work.job", enc.encode(String(i)));
    await jsm.streams.add({ name: "ORDERS", subjects: ["orders.>"], max_age: 3600e9 });
    for (let i = 0; i < 50; i++) await js.publish("orders.new", enc.encode(JSON.stringify({ i })));

    await jsm.consumers.add("ORDERS", { durable_name: "lagging", ack_policy: AckPolicy.Explicit });
    await jsm.consumers.add("ORDERS", { durable_name: "stalled", ack_policy: AckPolicy.Explicit, max_ack_pending: 5, max_deliver: 3 });
    await jsm.consumers.add("ORDERS", { durable_name: "pushy", ack_policy: AckPolicy.Explicit, deliver_subject: "deliver.pushy", max_deliver: 3 });
    await jsm.consumers.add("ORDERS", { durable_name: "redeliver", ack_policy: AckPolicy.Explicit, ack_wait: 300_000_000 });
    await jsm.consumers.add("ORDERS", { durable_name: "paused", ack_policy: AckPolicy.Explicit, max_deliver: 3, pause_until: new Date(Date.now() + 3600_000).toISOString() });

    // stalled: take all 5 ack slots without acking.
    const stalled = await js.consumers.get("ORDERS", "stalled");
    const batch = await stalled.fetch({ max_messages: 5, expires: 1000 });
    for await (const m of batch) void m;
    // redeliver: fetch, let ack_wait expire, fetch again (redelivered).
    const redeliver = await js.consumers.get("ORDERS", "redeliver");
    for await (const m of await redeliver.fetch({ max_messages: 3, expires: 1000 })) void m;
    await new Promise((r) => setTimeout(r, 600));
    for await (const m of await redeliver.fetch({ max_messages: 3, expires: 1000 })) void m;

    const kv = await new Kvm(js).create("cfg", { max_bytes: 1024 });
    await kv.put("blob", enc.encode("x".repeat(820)));
    await new Objm(js).create("files");
  });

  after(async () => {
    for (const c of conns) await c.close().catch(() => undefined);
    for (const s of servers) s.kill();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("collects streams, consumers, account and monitoring; analysis finds the planted problems", async () => {
    const snap = await collectSnapshot(source(nc), { connId: "live", connName: "live", monitorUrl });
    assert.equal(snap.jetstream.enabled, true);
    assert.ok(snap.rttMs !== undefined && snap.rttMs >= 0);
    assert.ok(snap.account, "account info");
    assert.ok(snap.server?.version);
    assert.deepEqual(
      snap.streams.map((s) => s.config.name),
      ["FULL", "INTEREST", "KV_cfg", "OBJ_files", "ORDERS", "UNBOUNDED", "WORK"],
    );
    assert.equal(snap.consumers.ORDERS?.length, 5);
    assert.equal(snap.consumers.UNBOUNDED, undefined, "streams without consumers are not listed");
    assert.equal(snap.monitor.reachable, true);
    assert.equal(snap.monitor.healthz?.status, "ok");
    assert.equal(typeof snap.monitor.varz?.slow_consumers, "number");
    assert.deepEqual(snap.notes, []);
    assert.ok(snap.durationMs >= 0);

    const fs = analyze(snap, { ...DEFAULT_THRESHOLDS, pendingWarning: 20 });
    const has = (id: string, key: string) => assert.ok(find(fs, id, key), `expected ${id} on ${key}; got ${fs.map((x) => `${x.id}@${targetKey(x.target)}`).join(", ")}`);
    has("stream.unbounded", "stream/UNBOUNDED");
    has("stream.near-limit", "stream/FULL");
    has("stream.interest-no-consumers", "stream/INTEREST");
    has("stream.workqueue-no-consumers", "stream/WORK");
    has("kv.near-limit", "kv/cfg");
    has("consumer.pending-high", "consumer/ORDERS/lagging");
    has("consumer.pull-idle", "consumer/ORDERS/lagging");
    has("consumer.max-deliver-unlimited", "consumer/ORDERS/lagging");
    has("consumer.ack-pending-stalled", "consumer/ORDERS/stalled");
    has("consumer.push-unbound", "consumer/ORDERS/pushy");
    has("consumer.paused", "consumer/ORDERS/paused");
    has("consumer.redeliveries", "consumer/ORDERS/redeliver");
    assert.equal(find(fs, "consumer.max-deliver-unlimited", "consumer/ORDERS/redeliver")?.severity, "warning", "unlimited redelivery with redeliveries in flight");
    assert.equal(find(fs, "stream.near-limit", "stream/FULL")?.severity, "error");
    assert.ok(!find(fs, "stream.replicas-1"), "single server: replicas 1 is fine");
    assert.ok(!fs.some((f) => f.category === "server"), "a fresh local server has no server findings");

    const r = buildReport(snap, fs, DEFAULT_THRESHOLDS);
    assert.ok(r.score < 90);
    assert.deepEqual(r.inventory, { streams: 5, consumers: 5, kv: 1, obj: 1 });
    assert.ok(r.resources.some((x) => x.key === "obj/files" && !x.worst));
  });

  test("unreachable monitoring is a note, not a failure", async () => {
    const closed = await freePort();
    const snap = await collectSnapshot(source(nc), { connId: "live", connName: "live", monitorUrl: `http://127.0.0.1:${closed}`, monitorTimeoutMs: 800 });
    assert.equal(snap.monitor.reachable, false);
    assert.ok(snap.monitor.error);
    assert.ok(snap.streams.length > 0, "JetStream data still collected");
    assert.ok(find(analyze(snap, DEFAULT_THRESHOLDS), "server.monitor-unreachable"));
  });

  test("a server without JetStream yields an info finding", async () => {
    const port = await freePort();
    start(["-p", String(port), "-a", "127.0.0.1"]);
    const plain = await connectRetry({ servers: `nats://127.0.0.1:${port}` });
    conns.push(plain);
    const snap = await collectSnapshot(source(plain), { connId: "plain", connName: "plain", timeoutMs: 3000 });
    assert.equal(snap.jetstream.enabled, false);
    assert.equal(snap.jetstream.failed, undefined, `recognised as "not enabled": ${snap.jetstream.reason}`);
    assert.equal(snap.server?.jetstream, false);
    assert.deepEqual(snap.streams, []);
    const fs = analyze(snap, DEFAULT_THRESHOLDS);
    const f = find(fs, "server.jetstream-disabled")!;
    assert.ok(f);
    assert.equal(f.category, "server");
    assert.ok(buildReport(snap, fs, DEFAULT_THRESHOLDS).score >= 90, "JetStream being off is informational");
  });

  test("permission errors are recorded, not thrown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nats-admin-health-perm-"));
    dirs.push(dir);
    const port = await freePort();
    const conf = join(dir, "server.conf");
    writeFileSync(
      conf,
      `listen: "127.0.0.1:${port}"
jetstream { store_dir: "${join(dir, "js")}" }
authorization {
  users = [
    { user: admin, password: admin }
    { user: limited, password: limited, permissions: { publish: { allow: [">"], deny: ["$JS.API.CONSUMER.LIST.>"] }, subscribe: { allow: [">"] } } }
  ]
}
`,
    );
    start(["-c", conf]);
    const admin = await connectRetry({ servers: `nats://127.0.0.1:${port}`, user: "admin", pass: "admin" });
    conns.push(admin);
    const jsm = await jetstreamManager(admin);
    await jsm.streams.add({ name: "SECRET", subjects: ["secret.>"], max_age: 3600e9 });
    await jsm.consumers.add("SECRET", { durable_name: "c1", ack_policy: AckPolicy.Explicit, max_deliver: 3 });
    const limited = await connectRetry({ servers: `nats://127.0.0.1:${port}`, user: "limited", pass: "limited" });
    conns.push(limited);
    const snap = await collectSnapshot(source(limited), { connId: "perm", connName: "perm", timeoutMs: 2500 });
    assert.equal(snap.jetstream.enabled, true);
    assert.deepEqual(
      snap.streams.map((s) => s.config.name),
      ["SECRET"],
    );
    const note = snap.notes.find((n) => n.scope === "consumers");
    assert.ok(note, `consumer listing failure recorded: ${JSON.stringify(snap.notes)}`);
    assert.equal(note.stream, "SECRET");
    assert.equal(note.permission, true, `permission flagged: ${note.message}`);
    const f = find(analyze(snap, DEFAULT_THRESHOLDS), "collect.consumers")!;
    assert.ok(f);
    assert.match(f.recommendation, /CONSUMER\.LIST/);
  });
});
