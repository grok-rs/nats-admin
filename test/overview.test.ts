// Overview / Home / server dashboard: pure model helpers and live metrics collection against a
// throwaway nats-server (JetStream + HTTP monitoring on random ports).

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { AckPolicy, jetstream, jetstreamManager, StorageType, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { Objm } from "@nats-io/obj";
import {
  ALLOWED_COMMANDS,
  appendHistory,
  compareProfiles,
  connectionRates,
  counterIncrease,
  counterRates,
  countStreamKinds,
  filterFleet,
  groupByEnvironment,
  historySeries,
  isAllowedCommand,
  isDegraded,
  isDocsLink,
  isUnhealthy,
  needsAttention,
  ownConnectionCid,
  parseGoDuration,
  RateSampler,
  resolveLimit,
  rttTone,
  stateLabel,
  stateTone,
  summarizeFleet,
  usageFraction,
  type FleetRow,
  type HealthDTO,
  type LiveMetrics,
  type ProfileSummary,
} from "../src/overview/model";
import { collectSample, MetricsTracker, withTimeout, type MetricsSource, type RawSample } from "../src/overview/metrics";

function profile(over: Partial<ProfileSummary> & { id: string }): ProfileSummary {
  return {
    name: over.id,
    servers: ["nats://127.0.0.1:4222"],
    readOnly: false,
    origin: "manual",
    autoConnect: false,
    selectedContext: false,
    managed: true,
    state: "disconnected",
    active: false,
    auth: "none",
    tls: false,
    ...over,
  };
}

function health(score: number, errors = 0, warnings = 0): HealthDTO {
  return { connId: "x", score, errors, warnings, infos: 0, at: new Date(0).toISOString(), top: [] };
}

function metrics(over: Partial<LiveMetrics> = {}): LiveMetrics {
  return { profileId: "x", at: 0, monitor: { ok: false }, history: [], ...over };
}

describe("overview model", () => {
  test("counterRates: per-second deltas, undefined on reset or non-increasing time", () => {
    const prev = { t: 1000, c: { inMsgs: 100, outMsgs: 50, inBytes: 1000, outBytes: 500 } };
    const r = counterRates(prev, { t: 3000, c: { inMsgs: 300, outMsgs: 70, inBytes: 5000, outBytes: 500 } });
    assert.deepEqual(r, { msgsIn: 100, msgsOut: 10, bytesIn: 2000, bytesOut: 0 });
    assert.equal(counterRates(undefined, prev), undefined);
    assert.equal(counterRates(prev, { t: 1000, c: prev.c }), undefined, "same time");
    assert.equal(counterRates(prev, { t: 2000, c: { ...prev.c, inMsgs: 10 } }), undefined, "counter went down (restart)");
  });

  test("RateSampler restarts the series when the source flips or a counter resets", () => {
    const s = new RateSampler();
    const c = (n: number) => ({ inMsgs: n, outMsgs: n, inBytes: n * 10, outBytes: n * 10 });
    assert.equal(s.update("a", "server", 0, c(0)), undefined, "first sample");
    assert.deepEqual(s.update("a", "server", 1000, c(5)), { msgsIn: 5, msgsOut: 5, bytesIn: 50, bytesOut: 50 });
    assert.equal(s.update("a", "server", 1000, c(9)), undefined, "duplicate timestamp keeps the baseline");
    assert.deepEqual(s.update("a", "server", 2000, c(9)), { msgsIn: 4, msgsOut: 4, bytesIn: 40, bytesOut: 40 });
    assert.equal(s.update("a", "client", 3000, c(1)), undefined, "source changed → new baseline");
    assert.deepEqual(s.update("a", "client", 4000, c(3))?.msgsIn, 2);
    assert.equal(s.update("a", "client", 5000, c(0)), undefined, "reset → gap");
    assert.deepEqual(s.update("a", "client", 6000, c(2))?.msgsIn, 2, "recovers after the reset");
    assert.equal(s.update("b", "client", 6000, c(2)), undefined, "keys are independent");
    s.forget("a");
    assert.equal(s.update("a", "client", 7000, c(4)), undefined);
  });

  test("RateSampler restarts when /varz answers from another server (load-balanced monitoring URL)", () => {
    const s = new RateSampler();
    const c = (n: number) => ({ inMsgs: n, outMsgs: n, inBytes: n, outBytes: n });
    assert.equal(s.update("p", "server", 0, c(1000), "NA"), undefined);
    assert.equal(s.update("p", "server", 1000, c(1010), "NA")?.msgsIn, 10);
    // Server B has handled far more messages: subtracting A's counters would be a fake spike.
    assert.equal(s.update("p", "server", 2000, c(900_000), "NB"), undefined, "other server → new baseline, no spike");
    assert.equal(s.update("p", "server", 3000, c(900_050), "NB")?.msgsIn, 50);
    // …and back to A, whose counters are lower than B's: no gap-and-guess either.
    assert.equal(s.update("p", "server", 4000, c(1030), "NA"), undefined);
    assert.equal(s.update("p", "server", 5000, c(1040), "NA")?.msgsIn, 10);
    assert.equal(s.update("p", "server", 6000, c(1050))?.msgsIn, undefined, "unknown origin counts as another server");
  });

  test("MetricsTracker keys server rates by the /varz server id", () => {
    const t = new MetricsTracker();
    const raw = (at: number, n: number, serverId: string): RawSample => ({
      at,
      client: { inMsgs: 0, outMsgs: 0, inBytes: 0, outBytes: 0 },
      monitor: { ok: true },
      serverCounters: { t: at, c: { inMsgs: n, outMsgs: n, inBytes: n, outBytes: n }, serverId },
    });
    t.ingest("p", raw(1000, 100, "NA"));
    assert.equal(t.ingest("p", raw(2000, 120, "NA")).rates?.msgsIn, 20);
    assert.equal(t.ingest("p", raw(3000, 5_000_000, "NB")).rates, undefined, "switch → gap, not a 5M msgs/s spike");
    assert.equal(t.ingest("p", raw(4000, 5_000_010, "NB")).rates?.msgsIn, 10);
  });

  test("appendHistory keeps the newest points in order; historySeries maps gaps to null", () => {
    let h = appendHistory([], { t: 1, rtt: 1 }, 3);
    h = appendHistory(h, { t: 2, rtt: 2 }, 3);
    h = appendHistory(h, { t: 2, rtt: 99 }, 3); // out of order / duplicate → dropped
    h = appendHistory(h, { t: 3 }, 3);
    h = appendHistory(h, { t: 4, rtt: 4 }, 3);
    assert.deepEqual(
      h.map((p) => p.t),
      [2, 3, 4],
    );
    assert.deepEqual(historySeries(h, "rtt"), [
      { t: 2, v: 2 },
      { t: 3, v: null },
      { t: 4, v: 4 },
    ]);
  });

  test("groupByEnvironment orders production first and drops empty groups", () => {
    const items = [profile({ id: "a", environment: "dev" }), profile({ id: "b" }), profile({ id: "c", environment: "prod" }), profile({ id: "d", environment: "dev", state: "connected" })];
    const groups = groupByEnvironment(items, (p) => p.environment, compareProfiles);
    assert.deepEqual(
      groups.map((g) => [g.env, g.label, g.items.map((i) => i.id)]),
      [
        ["prod", "Production", ["c"]],
        ["dev", "Development", ["d", "a"]],
        ["none", "No environment", ["b"]],
      ],
    );
    assert.deepEqual(groupByEnvironment([], () => undefined), []);
  });

  test("compareProfiles: live connections first, then natural name order", () => {
    const list = [profile({ id: "n10" }), profile({ id: "n2" }), profile({ id: "zz", state: "connected" }), profile({ id: "err", state: "error" }), profile({ id: "re", state: "reconnecting" })];
    assert.deepEqual(
      list.sort(compareProfiles).map((p) => p.id),
      ["zz", "re", "err", "n2", "n10"],
    );
  });

  test("tones and labels", () => {
    assert.equal(stateTone("connected"), "ok");
    assert.equal(stateTone("reconnecting"), "warn");
    assert.equal(stateTone("error"), "danger");
    assert.equal(stateTone("connecting"), "info");
    assert.equal(stateTone("disconnected"), "neutral");
    assert.equal(stateLabel("reconnecting"), "Reconnecting…");
    assert.equal(rttTone(undefined), "neutral");
    assert.equal(rttTone(3, 100), "ok");
    assert.equal(rttTone(150, 100), "warn");
    assert.equal(rttTone(400, 100), "danger");
  });

  test("health classification", () => {
    assert.equal(isUnhealthy(undefined), false);
    assert.equal(isUnhealthy(health(50)), true);
    assert.equal(isUnhealthy(health(95, 1)), true, "any error finding");
    assert.equal(isDegraded(health(80)), true);
    assert.equal(isDegraded(health(95, 0, 2)), true, "warnings");
    assert.equal(isDegraded(health(100)), false);
    assert.equal(isDegraded(health(40)), false, "unhealthy is not degraded");
  });

  test("countStreamKinds separates KV and object store backing streams", () => {
    assert.deepEqual(countStreamKinds(["ORDERS", "KV_config", "OBJ_files", "EVENTS", "KV_sessions"]), { streams: 2, kv: 2, obj: 1, total: 5 });
    assert.deepEqual(countStreamKinds([]), { streams: 0, kv: 0, obj: 0, total: 0 });
  });

  test("resolveLimit: account → tiers → server → unlimited", () => {
    assert.deepEqual(resolveLimit(100, [], 1000), { max: 100, source: "account" });
    assert.deepEqual(resolveLimit(-1, [50, -1, 25], 1000), { max: 75, source: "tiers" });
    assert.deepEqual(resolveLimit(0, [], 1000), { max: 1000, source: "server" });
    assert.deepEqual(resolveLimit(-1, [undefined], undefined), { source: "none" });
    assert.equal(usageFraction(25, 100), 0.25);
    assert.equal(usageFraction(25, -1), undefined);
    assert.equal(usageFraction(undefined, 100), undefined);
  });

  test("summarizeFleet aggregates connected profiles only", () => {
    const rows: FleetRow[] = [
      {
        profile: profile({ id: "p1", environment: "prod", state: "connected" }),
        metrics: metrics({ jetstream: { enabled: true, streams: 3, totalStreams: 5, consumers: 7, kv: 1, obj: 1 }, rates: { msgsIn: 10, msgsOut: 5, bytesIn: 1, bytesOut: 1, source: "server" } }),
        health: health(40),
      },
      { profile: profile({ id: "p2", environment: "dev", state: "connected" }), metrics: metrics({ jetstream: { enabled: false } }), health: health(80) },
      { profile: profile({ id: "p3", state: "connected" }), metrics: metrics({ jetstream: { enabled: true, totalStreams: 2, consumers: 1 } }) },
      { profile: profile({ id: "p4", state: "error", error: "refused" }) },
      { profile: profile({ id: "p5", environment: "prod", state: "reconnecting" }) },
    ];
    const s = summarizeFleet(rows);
    assert.equal(s.profiles, 5);
    assert.equal(s.connected, 3);
    assert.equal(s.connecting, 1);
    assert.equal(s.errors, 1);
    assert.equal(s.unhealthy, 1);
    assert.equal(s.degraded, 1);
    assert.equal(s.unchecked, 2, "p3 (no health) and p5 (reconnecting, no health)");
    assert.equal(s.streams, 5, "user streams of p1 plus the account total of p3 when kinds are unknown");
    assert.equal(s.consumers, 8);
    assert.equal(s.kv, 1);
    assert.equal(s.msgsIn, 10);
    assert.equal(s.withRates, 1);
    assert.deepEqual(s.byEnv, { prod: 2, staging: 0, test: 0, dev: 1, none: 2 });
  });

  test("filterFleet: multi-term search, environment and state filters", () => {
    const rows: FleetRow[] = [
      { profile: profile({ id: "eu-prod", environment: "prod", state: "connected", origin: "nats-context", contextName: "eu-prod" }), metrics: metrics({ server: { name: "nats-eu-1", id: "N1", version: "2.14.4", jetstream: true, tlsRequired: true, authRequired: true, cluster: "eu" } }) },
      { profile: profile({ id: "local", environment: "dev", servers: ["nats://localhost:4222"] }) },
      { profile: profile({ id: "staging", environment: "staging", state: "error", error: "timeout" }) },
      { profile: profile({ id: "ci", origin: "env" }), health: undefined },
    ];
    const ids = (r: FleetRow[]) => r.map((x) => x.profile.id);
    assert.deepEqual(ids(filterFleet(rows, { query: "eu 2.14" })), ["eu-prod"], "server identity is searchable");
    assert.deepEqual(ids(filterFleet(rows, { query: "LOCALHOST" })), ["local"], "servers, case-insensitive");
    assert.deepEqual(ids(filterFleet(rows, { query: "context" })), ["eu-prod"], "origin label");
    assert.deepEqual(ids(filterFleet(rows, { query: "environment" })), ["ci"], "env origin label");
    assert.deepEqual(ids(filterFleet(rows, { env: "none" })), ["ci"]);
    assert.deepEqual(ids(filterFleet(rows, { env: "prod", query: "" })), ["eu-prod"]);
    assert.deepEqual(ids(filterFleet(rows, { state: "live" })), ["eu-prod"]);
    assert.deepEqual(ids(filterFleet(rows, { state: "offline" })), ["local", "staging", "ci"]);
    assert.deepEqual(ids(filterFleet(rows, { state: "attention" })), ["staging"]);
    assert.equal(needsAttention({ profile: profile({ id: "w", warning: "nsc:// not supported" }) }), true);
    assert.deepEqual(ids(filterFleet(rows, { query: "nomatch" })), []);
  });

  test("parseGoDuration", () => {
    assert.equal(parseGoDuration("1d2h3m4s"), 86_400_000 + 7_200_000 + 180_000 + 4000);
    assert.equal(parseGoDuration("1.5ms"), 1.5);
    assert.equal(parseGoDuration("250µs"), 0.25);
    assert.equal(parseGoDuration("312µs"), 0.312);
    assert.equal(parseGoDuration(""), 0);
    assert.equal(parseGoDuration(undefined), 0);
    assert.equal(parseGoDuration("garbage"), 0);
  });

  test("connectionRates: per-cid rates, skipping new clients and counter resets", () => {
    const prev = { t: 0, conns: [{ cid: 1, in_msgs: 10, out_msgs: 0, in_bytes: 100, out_bytes: 0 }, { cid: 2, in_msgs: 50, out_msgs: 50, in_bytes: 0, out_bytes: 0 }] };
    const cur = { t: 2000, conns: [{ cid: 1, in_msgs: 30, out_msgs: 4, in_bytes: 300, out_bytes: 40 }, { cid: 2, in_msgs: 1, out_msgs: 1, in_bytes: 0, out_bytes: 0 }, { cid: 3, in_msgs: 5, out_msgs: 5, in_bytes: 5, out_bytes: 5 }] };
    const r = connectionRates(prev, cur);
    assert.deepEqual([...r.keys()], [1]);
    assert.deepEqual(r.get(1), { msgsIn: 10, msgsOut: 2, bytesIn: 100, bytesOut: 20 });
    assert.equal(connectionRates(undefined, cur).size, 0);
  });

  test("ownConnectionCid: only when /connz comes from the server this connection is on", () => {
    const me = { id: "NSERVER_A", clientId: 7 };
    assert.equal(ownConnectionCid(me, "NSERVER_A"), 7);
    assert.equal(ownConnectionCid(me, "NSERVER_B"), undefined, "monitoring URL points at another cluster member: cid 7 there is someone else");
    assert.equal(ownConnectionCid(me, undefined), undefined, "no /varz → unknown server");
    assert.equal(ownConnectionCid(undefined, "NSERVER_A"), undefined);
    assert.equal(ownConnectionCid({ id: "NSERVER_A" }, "NSERVER_A"), undefined, "no client id");
    assert.equal(ownConnectionCid({ id: "NSERVER_A", clientId: 0 }, "NSERVER_A"), 0, "cid 0 is a valid id");
  });

  test("counterIncrease: growth across a window, undefined on reset or too few points", () => {
    const pts = (...v: (number | null)[]) => v.map((x) => ({ v: x }));
    assert.equal(counterIncrease(pts(2, 2, 3, null, 5)), 3);
    assert.equal(counterIncrease(pts(4, 4, 4)), 0);
    assert.equal(counterIncrease(pts(null, 4)), 0, "a single value: no growth");
    assert.equal(counterIncrease(pts()), undefined);
    assert.equal(counterIncrease(pts(null, null)), undefined);
    assert.equal(counterIncrease(pts(9, 10, 1, 2)), undefined, "counter went down (server restart)");
  });

  test("MetricsTracker re-lists stream kinds after invalidateKinds and forgets profiles", () => {
    const t = new MetricsTracker(5, 60_000);
    const raw = (at: number, kinds?: RawSample["kinds"]): RawSample => ({
      at,
      client: { inMsgs: at, outMsgs: 0, inBytes: 0, outBytes: 0 },
      monitor: { ok: false },
      jetstream: { enabled: true, totalStreams: 3, consumers: 1 },
      kinds,
    });
    assert.equal(t.needsKinds("p", 0), true);
    const m1 = t.ingest("p", raw(1000, { streams: 1, kv: 1, obj: 1, total: 3 }));
    assert.deepEqual([m1.jetstream?.streams, m1.jetstream?.kv, m1.jetstream?.obj], [1, 1, 1]);
    assert.equal(t.needsKinds("p", 2000), false, "within the TTL");
    assert.equal(t.needsKinds("p", 61_000), true, "after the TTL");
    t.invalidateKinds("p");
    assert.equal(t.needsKinds("p", 2000), true, "invalidated (stream created / deleted)");
    const m2 = t.ingest("p", raw(2000));
    assert.equal(m2.jetstream?.streams, 1, "previous kinds carried over until the next listing");
    assert.equal(m2.rates?.source, "client");
    assert.equal(m2.rates?.msgsIn, 1000, "client counters → per-second rate");
    t.forget("p");
    const m3 = t.ingest("p", raw(3000));
    assert.equal(m3.rates, undefined, "fresh baseline after forget");
    assert.equal(m3.jetstream?.streams, 3, "no kinds known: account total");
    assert.equal(m3.history.length, 1);
  });

  test("withTimeout rejects slow promises and passes fast ones through", async () => {
    assert.equal(await withTimeout(Promise.resolve(5), 50, "fast"), 5);
    await assert.rejects(withTimeout(new Promise(() => undefined), 20, "slow thing"), /slow thing timed out after 20 ms/);
    await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 50, "x"), /boom/);
  });

  test("command and link whitelists", () => {
    assert.equal(isAllowedCommand("nats.openDashboard"), true);
    assert.equal(isAllowedCommand("workbench.action.terminal.sendSequence"), false);
    assert.equal(isAllowedCommand("toString"), false, "no prototype keys");
    assert.equal(isAllowedCommand(42), false);
    assert.equal(ALLOWED_COMMANDS["nats.connect"], "id");
    assert.equal(ALLOWED_COMMANDS["nats.openHome"], "none");
    assert.equal(isDocsLink("https://docs.nats.io"), true);
    assert.equal(isDocsLink("https://evil.example/docs.nats.io"), false);
  });
});

// ---------------------------------------------------------------------------------------------
// Live: collectSample + MetricsTracker against a real server
// ---------------------------------------------------------------------------------------------

const hasServer = spawnSync("nats-server", ["--version"]).status === 0;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

describe("overview metrics (live server)", { skip: !hasServer && "nats-server not installed" }, () => {
  let server: ChildProcess;
  let dir: string;
  let nc: NatsConnection;
  let jsm: JetStreamManager;
  let monitorUrl: string;
  let src: MetricsSource;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "nats-admin-overview-"));
    const port = await freePort();
    const mport = await freePort();
    monitorUrl = `http://127.0.0.1:${mport}`;
    server = spawn("nats-server", ["-js", "-sd", dir, "-p", String(port), "-m", String(mport), "-a", "127.0.0.1", "-n", "overview-test"], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      try {
        nc = await connect({ servers: `nats://127.0.0.1:${port}`, timeout: 500 });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.ok(nc, "connected to test server");
    // Wait until the monitoring listener is up too.
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${monitorUrl}/healthz`)).ok) break;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    jsm = await jetstreamManager(nc);
    src = { nc, jsm: async () => jsm, hasJetStream: async () => true };
    await jsm.streams.add({ name: "ORDERS", subjects: ["orders.>"] });
    await jsm.streams.add({ name: "EVENTS", subjects: ["events.>"], storage: StorageType.Memory });
    await jsm.consumers.add("ORDERS", { durable_name: "billing", ack_policy: AckPolicy.Explicit });
    const js = jetstream(nc);
    await new Kvm(js).create("config");
    await new Objm(js).create("files");
  });

  after(async () => {
    await nc?.close();
    server?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  test("collects identity, RTT, varz and JetStream usage; rates from server counters", async () => {
    const tracker = new MetricsTracker(10, 60_000);
    const first = await collectSample(src, { monitorUrl, countKinds: tracker.needsKinds("p") });
    assert.equal(first.monitor.ok, true, first.monitor.error);
    assert.equal(first.server?.name, "overview-test");
    assert.equal(first.server?.jetstream, true);
    assert.ok(typeof first.rttMs === "number" && first.rttMs >= 0);
    assert.ok(first.varz && first.varz.connections >= 1 && first.varz.cores >= 1);
    assert.ok(first.serverCounters);
    assert.equal(first.serverCounters.serverId, first.server?.id, "server counters carry the /varz server id (same server here)");
    assert.deepEqual(first.kinds, { streams: 2, kv: 1, obj: 1, total: 4 });
    assert.equal(first.jetstream?.enabled, true);
    assert.equal(first.jetstream?.totalStreams, 4);
    assert.equal(first.jetstream?.consumers, 1);
    assert.equal(first.jetstream?.storageSource, "server", "unlimited account falls back to the server maximum from /varz");
    assert.ok((first.jetstream?.maxStorage ?? 0) > 0);

    const m1 = tracker.ingest("p", first);
    assert.equal(m1.rates, undefined, "no rate from a single sample");
    assert.deepEqual([m1.jetstream?.streams, m1.jetstream?.kv, m1.jetstream?.obj], [2, 1, 1]);
    assert.equal(tracker.needsKinds("p"), false, "kinds cached");

    const enc = new TextEncoder();
    for (let i = 0; i < 200; i++) nc.publish("noise.x", enc.encode("hello"));
    await nc.flush();
    await new Promise((r) => setTimeout(r, 1100));
    const second = await collectSample(src, { monitorUrl, countKinds: tracker.needsKinds("p") });
    assert.equal(second.kinds, undefined, "stream names not re-listed within the TTL");
    const m2 = tracker.ingest("p", second);
    assert.equal(m2.rates?.source, "server");
    assert.ok((m2.rates?.msgsIn ?? 0) > 0, `server in-rate > 0 (got ${m2.rates?.msgsIn})`);
    assert.deepEqual([m2.jetstream?.streams, m2.jetstream?.kv], [2, 1], "kinds carried over");
    assert.equal(m2.history.length, 2);
    assert.ok(typeof m2.history[1].msgsIn === "number");
  });

  test("falls back to client counters when monitoring is unreachable", async () => {
    const dead = `http://127.0.0.1:${await freePort()}`;
    const tracker = new MetricsTracker();
    const a = await collectSample(src, { monitorUrl: dead, timeoutMs: 800 });
    assert.equal(a.monitor.ok, false);
    assert.ok(a.monitor.error, "error reported");
    assert.equal(a.varz, undefined);
    assert.equal(a.jetstream?.storageSource, "none", "no server maximum without /varz");
    tracker.ingest("q", a);
    nc.publish("noise.y", new TextEncoder().encode("x"));
    await nc.flush();
    await new Promise((r) => setTimeout(r, 50));
    const b = tracker.ingest("q", await collectSample(src, { monitorUrl: dead, skipMonitor: true }));
    assert.equal(b.rates?.source, "client");
    assert.ok((b.rates?.msgsOut ?? 0) > 0, "this client's publish shows up as an outbound rate");
    assert.match(b.monitor.error ?? "", /retrying/);
  });

  test("a JetStream probe that hangs (reconnecting client) is reported as an error, not awaited", async () => {
    const hung: MetricsSource = { nc, jsm: () => new Promise(() => undefined), hasJetStream: () => new Promise(() => undefined) };
    const started = Date.now();
    const s = await collectSample(hung, { timeoutMs: 100 });
    assert.ok(Date.now() - started < 1500, `returned in ${Date.now() - started} ms`);
    assert.equal(s.jetstream?.enabled, true);
    assert.match(s.jetstream?.error ?? "", /timed out/);
    assert.ok(typeof s.rttMs === "number", "the rest of the sample is still collected");
  });

  test("reports JetStream as disabled without throwing", async () => {
    const noJs: MetricsSource = { nc, jsm: () => Promise.reject(new Error("no js")), hasJetStream: async () => false };
    const s = await collectSample(noJs, {});
    assert.deepEqual(s.jetstream, { enabled: false });
    assert.equal(s.monitor.ok, false);
    assert.match(s.monitor.error ?? "", /No monitoring URL/);
  });
});
