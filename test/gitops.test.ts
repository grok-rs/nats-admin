// Config-as-code: file conventions, diff rules, plan computation, KV transfer encoding and the
// JSON schemas (unit), plus export → plan → apply round trips against a throwaway nats-server.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { jetstream, jetstreamManager, AckPolicy, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  classifyFileName,
  cleanServerConfig,
  CONSUMER_FIELDS,
  exportKvDefinition,
  jsonErrorOffset,
  kvFromStreamConfig,
  KV_FIELDS,
  msToDuration,
  parseConfigFile,
  parseTtl,
  STREAM_FIELDS,
  type ParsedConfig,
  type ParsedOk,
} from "../src/gitops/configFiles";
import { configDiff, createFields, fitDuplicateWindow, immutableReason, mergeForUpdate, riskOf } from "../src/gitops/configDiff";
import { computePlan, consumerStreamsOf, fetchServerState, findConfigSubfolders, isJetStreamUnavailable, parseFolderFiles, readConfigFolder, type ServerState } from "../src/gitops/plan";
import { applyResource } from "../src/gitops/apply";
import { collectInventory, exportFiles } from "../src/gitops/export";
import { buildKvExport, decodeKvValue, encodeKvValue, importRecords, parseKvImport, readAllEntries, stripJsonWhitespace } from "../src/gitops/kvTransfer";
import { describeChange, fmtValue, listDelta } from "../src/gitops/valueFormat";
import { parseDuration } from "../src/shared/format";

const enc = new TextEncoder();
const dec = new TextDecoder();

function ok(p: ParsedConfig): ParsedOk {
  assert.ok(p.ok, p.ok ? "" : p.error);
  return p as ParsedOk;
}

// ---------------------------------------------------------------------------------------------
// File conventions
// ---------------------------------------------------------------------------------------------

describe("config files", () => {
  test("classifies file names", () => {
    assert.deepEqual(classifyFileName("ORDERS.stream.json"), { ok: true, kind: "stream", name: "ORDERS" });
    assert.deepEqual(classifyFileName("ORDERS.billing.consumer.json"), { ok: true, kind: "consumer", stream: "ORDERS", name: "billing" });
    assert.deepEqual(classifyFileName("config.kv.json"), { ok: true, kind: "kv", name: "config" });
    assert.equal(classifyFileName("package.json"), undefined);
    const dotted = classifyFileName("ORDERS.a.b.consumer.json");
    assert.ok(dotted && !dotted.ok && /cannot contain dots/.test(dotted.error));
    const badStream = classifyFileName("my.stream.stream.json");
    assert.ok(badStream && !badStream.ok);
    const badBucket = classifyFileName("my bucket.kv.json");
    assert.ok(badBucket && !badBucket.ok);
  });

  test("parses a stream file and checks name / types / units", () => {
    const p = ok(parseConfigFile("ORDERS.stream.json", JSON.stringify({ subjects: ["orders.>"], max_age: 3600000000000 })));
    assert.equal(p.id, "stream:ORDERS");
    assert.equal(p.config.name, "ORDERS");

    const mismatch = parseConfigFile("ORDERS.stream.json", JSON.stringify({ name: "OTHER" }));
    assert.ok(!mismatch.ok && /file name says "ORDERS"/.test(mismatch.error));

    const dur = parseConfigFile("ORDERS.stream.json", JSON.stringify({ max_age: "24h" }));
    assert.ok(!dur.ok && /nanoseconds/.test(dur.error) && /86400000000000/.test(dur.error), !dur.ok ? dur.error : "");

    const en = parseConfigFile("ORDERS.stream.json", JSON.stringify({ storage: "disk" }));
    assert.ok(!en.ok && /"file", "memory"/.test(en.error));

    const unknown = ok(parseConfigFile("ORDERS.stream.json", JSON.stringify({ max_agee: 1 })));
    assert.ok(unknown.warnings.some((w) => /Unknown field "max_agee"/.test(w)));

    const tiny = ok(parseConfigFile("ORDERS.stream.json", JSON.stringify({ duplicate_window: 120 })));
    assert.ok(tiny.warnings.some((w) => /did you mean 120000000/.test(w)));
  });

  test("reports JSON syntax errors with a location", () => {
    const p = parseConfigFile("ORDERS.stream.json", '{\n  "subjects": ["a"],\n  "max_age": ,\n}');
    assert.ok(!p.ok);
    assert.match(p.error, /Invalid JSON at line 3, column 14: Unexpected token/);
    assert.equal(jsonErrorOffset('{"a": [1, 2,]}'), 12);
    assert.equal(jsonErrorOffset('{"a": "x"} trailing'), 11);
    assert.equal(jsonErrorOffset('{"a": {"b": [true, null, -1.5e3, "\\""]}}'), undefined);
    assert.equal(jsonErrorOffset("{"), 1);
    assert.equal(p.id, "stream:ORDERS");
  });

  test("consumer files take the stream from the file name", () => {
    const p = ok(parseConfigFile("sub/ORDERS.billing.consumer.json", JSON.stringify({ ack_policy: "explicit" })));
    assert.equal(p.stream, "ORDERS");
    assert.equal(p.name, "billing");
    assert.ok(p.warnings.some((w) => /durable "billing"/.test(w)));
    const both = parseConfigFile("ORDERS.billing.consumer.json", JSON.stringify({ filter_subject: "a", filter_subjects: ["b"] }));
    assert.ok(!both.ok && /not both/.test(both.error));
    const wrong = parseConfigFile("ORDERS.billing.consumer.json", JSON.stringify({ durable_name: "x" }));
    assert.ok(!wrong.ok);
  });

  test("KV definitions normalise ttl and compression", () => {
    const p = ok(parseConfigFile("config.kv.json", JSON.stringify({ history: 5, ttl: "1h30m", compression: "s2", storage: "memory" })));
    assert.deepEqual(p.config, { history: 5, ttl: 5_400_000, compression: true, storage: "memory", bucket: "config" });
    assert.equal(ok(parseConfigFile("c.kv.json", JSON.stringify({ ttl: 1500 }))).config.ttl, 1500);
    const ambiguous = parseConfigFile("c.kv.json", JSON.stringify({ ttl: "3600" }));
    assert.ok(!ambiguous.ok && /duration string/.test(ambiguous.error));
    const hist = parseConfigFile("c.kv.json", JSON.stringify({ history: 100 }));
    assert.ok(!hist.ok && /between 1 and 64/.test(hist.error));
  });

  test("durations round-trip exactly", () => {
    for (const ms of [1, 999, 1000, 1500, 60_000, 90_061_001, 86_400_000, 7 * 86_400_000, 3_600_000 + 1]) {
      const s = msToDuration(ms);
      assert.equal(parseTtl(s), ms, `${ms} → ${s}`);
      assert.equal(parseDuration(s), ms);
    }
    assert.equal(msToDuration(86_400_000), "1d");
    assert.equal(msToDuration(5_400_000), "1h30m");
  });

  test("KV definition from a backing stream and export format", () => {
    const sc = { name: "KV_cfg", description: "x", max_msgs_per_subject: 5, max_age: 3_600_000_000_000, storage: "file", num_replicas: 1, max_bytes: -1, max_msg_size: -1, compression: "s2", metadata: { "_nats.ver": "2.14.4", team: "a" } };
    assert.deepEqual(kvFromStreamConfig(sc), { bucket: "cfg", description: "x", history: 5, ttl: 3_600_000, storage: "file", replicas: 1, max_bytes: -1, max_value_size: -1, compression: true, metadata: { team: "a" } });
    const file = JSON.parse(exportKvDefinition(sc));
    assert.equal(file.ttl, "1h");
    const back = ok(parseConfigFile("cfg.kv.json", JSON.stringify(file)));
    assert.deepEqual(configDiff("kv", back.config, kvFromStreamConfig(sc)), []);
  });

  test("cleanServerConfig drops _nats metadata and empty objects", () => {
    const c = cleanServerConfig({ subjects: ["a"], name: "S", consumer_limits: {}, metadata: { "_nats.level": "1" }, max_age: 0 });
    assert.deepEqual(Object.keys(c), ["name", "subjects", "max_age"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Diff rules
// ---------------------------------------------------------------------------------------------

const SERVER_STREAM = {
  name: "ORDERS",
  subjects: ["orders.>", "returns.>"],
  retention: "limits",
  max_consumers: -1,
  max_msgs: -1,
  max_bytes: -1,
  max_age: 0,
  max_msgs_per_subject: -1,
  max_msg_size: -1,
  discard: "old",
  storage: "file",
  num_replicas: 1,
  duplicate_window: 120000000000,
  compression: "none",
  allow_direct: false,
  mirror_direct: false,
  sealed: false,
  deny_delete: false,
  deny_purge: false,
  allow_rollup_hdrs: false,
  consumer_limits: {},
  allow_msg_ttl: false,
  metadata: { "_nats.level": "4", "_nats.req.level": "0", "_nats.ver": "2.14.4", owner: "team-a" },
};

describe("configDiff", () => {
  test("ignores omitted and server-populated fields", () => {
    assert.deepEqual(configDiff("stream", { name: "ORDERS", subjects: ["returns.>", "orders.>"] }, SERVER_STREAM), []);
  });

  test("normalises zero limits, defaults and omitempty booleans", () => {
    const local = { max_msgs: 0, max_bytes: 0, duplicate_window: 0, num_replicas: 0, discard_new_per_subject: false, no_ack: false, metadata: {} };
    assert.deepEqual(configDiff("stream", local, SERVER_STREAM), []);
    const consumer = { durable_name: "c", ack_wait: 0, max_deliver: 0, max_ack_pending: 0, max_waiting: 0, headers_only: false };
    assert.deepEqual(configDiff("consumer", consumer, { durable_name: "c", name: "c", ack_wait: 30e9, max_deliver: -1, max_ack_pending: 1000, max_waiting: 512 }), []);
  });

  test("reports key-level changes with units and nested paths", () => {
    const changes = configDiff("stream", { max_age: 86400000000000, description: "Orders", metadata: { owner: "team-b", tier: "gold" }, subjects: ["orders.>"] }, SERVER_STREAM);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
    assert.deepEqual(Object.keys(byPath).sort(), ["description", "max_age", "metadata.owner", "metadata.tier", "subjects"]);
    assert.equal(byPath.max_age.op, "change");
    assert.equal(byPath.max_age.unit, "ns");
    assert.match(byPath.max_age.risk!, /older than 1d/);
    assert.equal(byPath.description.op, "add");
    assert.equal(byPath["metadata.tier"].op, "add");
    assert.match(byPath.subjects.risk!, /returns\.>/);
    assert.deepEqual(listDelta(byPath.subjects.from, byPath.subjects.to), { added: [], removed: ["returns.>"] });
    assert.match(describeChange(byPath.max_age), /max_age: 0 \(unlimited\) → 86400000000000 \(1d\)/);
  });

  test("ack_wait is server-derived while a backoff is set", () => {
    const server = { durable_name: "c", name: "c", ack_wait: 1e9, backoff: [1e9, 2e9], max_deliver: 5 };
    // File keeps an old ack_wait next to the backoff: no perpetual change.
    assert.deepEqual(configDiff("consumer", { ack_wait: 30e9, backoff: [1e9, 2e9] }, server), []);
    assert.deepEqual(configDiff("consumer", { ack_wait: 30e9 }, server), []);
    // Backoff removed in the file: ack_wait is compared again.
    assert.deepEqual(
      configDiff("consumer", { ack_wait: 30e9, backoff: [] }, server).map((c) => c.path),
      ["ack_wait", "backoff"],
    );
    assert.deepEqual(
      configDiff("consumer", { ack_wait: 30e9 }, { ...server, backoff: undefined }).map((c) => c.path),
      ["ack_wait"],
    );
    const p = ok(parseConfigFile("S.c.consumer.json", JSON.stringify({ ack_wait: 30e9, backoff: [1e9, 2e9] })));
    assert.ok(p.warnings.some((w) => /ack_wait" is ignored while "backoff"/.test(w)));
    assert.ok(!ok(parseConfigFile("S.c.consumer.json", JSON.stringify({ ack_wait: 1e9, backoff: [1e9] }))).warnings.some((w) => /ack_wait/.test(w)));
  });

  test("time strings compare by instant", () => {
    assert.deepEqual(configDiff("consumer", { opt_start_time: "2024-01-01T00:00:00.000Z" }, { opt_start_time: "2024-01-01T00:00:00Z" }), []);
  });

  test("flags immutable stream and consumer fields (verified against nats-server 2.14)", () => {
    const s = configDiff("stream", { storage: "memory", retention: "workqueue", deny_delete: false }, { ...SERVER_STREAM, deny_delete: true });
    assert.equal(s.length, 3);
    assert.ok(s.every((c) => c.immutable), JSON.stringify(s));
    assert.equal(immutableReason("stream", "retention", "limits", "interest"), undefined);
    assert.equal(immutableReason("stream", "max_consumers", -1, 10), undefined);
    assert.equal(immutableReason("stream", "first_seq", 0, 100), undefined);
    assert.ok(immutableReason("stream", "mirror.name", "A", "B"));
    assert.equal(immutableReason("stream", "sealed", false, true), undefined);
    assert.ok(immutableReason("stream", "sealed", true, false));
    for (const f of ["deliver_policy", "ack_policy", "replay_policy", "max_waiting", "mem_storage", "idle_heartbeat", "flow_control", "opt_start_seq"]) {
      assert.ok(immutableReason("consumer", f, "a", "b"), f);
    }
    assert.ok(immutableReason("consumer", "deliver_subject", undefined, "x"));
    assert.equal(immutableReason("consumer", "deliver_subject", "x", "y"), undefined);
    assert.equal(immutableReason("consumer", "max_ack_pending", 1, 2), undefined);
    assert.ok(immutableReason("kv", "storage", "file", "memory"));
    // allow_msg_schedules is one-way ("message schedules can not be disabled"); atomic / batched toggle freely.
    assert.ok(immutableReason("stream", "allow_msg_schedules", true, false));
    assert.equal(immutableReason("stream", "allow_msg_schedules", false, true), undefined);
    assert.ok(riskOf("stream", "allow_msg_schedules", false, true));
    assert.equal(immutableReason("stream", "allow_atomic", true, false), undefined);
    assert.equal(immutableReason("stream", "allow_batched", true, false), undefined);
  });

  test("duplicate window must fit max_age (server rule)", () => {
    const min = 60e9;
    // Lowering max_age below the current 2 min window: the update must lower the window too.
    assert.equal(fitDuplicateWindow(min, undefined, 120e9), min);
    assert.equal(fitDuplicateWindow(min, 0, 120e9), min);
    // Nothing to do: window already fits, no max_age, or the file sets the window itself.
    assert.equal(fitDuplicateWindow(3600e9, undefined, 120e9), undefined);
    assert.equal(fitDuplicateWindow(0, undefined, 120e9), undefined);
    assert.equal(fitDuplicateWindow(undefined, undefined, 120e9), undefined);
    assert.equal(fitDuplicateWindow(min, 30e9, 120e9), undefined);
    // An explicit window larger than max_age in the file is an error up front.
    const bad = parseConfigFile("ORDERS.stream.json", JSON.stringify({ max_age: min, duplicate_window: 120e9 }));
    assert.ok(!bad.ok && /duplicate_window.*cannot be larger than "max_age"/.test(bad.error), !bad.ok ? bad.error : "");
    ok(parseConfigFile("ORDERS.stream.json", JSON.stringify({ max_age: min, duplicate_window: min })));
    ok(parseConfigFile("ORDERS.stream.json", JSON.stringify({ max_age: 0, duplicate_window: 120e9 })));
  });

  test("risk rules", () => {
    assert.ok(riskOf("stream", "max_msgs", -1, 1000));
    assert.equal(riskOf("stream", "max_msgs", 1000, 2000), undefined);
    assert.ok(riskOf("stream", "sealed", false, true));
    assert.ok(riskOf("stream", "retention", "limits", "interest"));
    assert.ok(riskOf("kv", "history", 10, 5));
    assert.ok(riskOf("kv", "ttl", 0, 60_000));
  });

  test("createFields lists every local key except names", () => {
    const f = createFields("stream", { name: "X", subjects: ["x"], max_age: 1, metadata: { "_nats.ver": "1" } });
    assert.deepEqual(
      f.map((c) => c.path),
      ["subjects", "max_age"],
    );
  });

  test("mergeForUpdate keeps nested server keys", () => {
    const m = mergeForUpdate(SERVER_STREAM, { metadata: { tier: "gold" }, max_age: 5 });
    assert.deepEqual(m, { metadata: { tier: "gold", owner: "team-a" }, max_age: 5 });
  });

  test("fmtValue humanises units", () => {
    assert.equal(fmtValue(-1, "bytes"), "-1 (unlimited)");
    assert.equal(fmtValue(1073741824, "bytes"), "1073741824 (1.00 GiB)");
    assert.equal(fmtValue(3_600_000, "ms", "ttl"), "3600000 (1h)");
    assert.equal(fmtValue(0, "ms", "ttl"), "0 (no expiry)");
  });
});

// ---------------------------------------------------------------------------------------------
// Plan computation (synthetic server state)
// ---------------------------------------------------------------------------------------------

describe("computePlan", () => {
  const state: ServerState = {
    jetstream: true,
    streams: new Map<string, Record<string, unknown>>([
      ["ORDERS", SERVER_STREAM],
      ["LEGACY", { ...SERVER_STREAM, name: "LEGACY", subjects: ["legacy.>"] }],
      ["KV_config", { name: "KV_config", max_msgs_per_subject: 5, max_age: 0, storage: "file", num_replicas: 1, max_bytes: -1, max_msg_size: -1, compression: "none" }],
      ["OBJ_files", { name: "OBJ_files" }],
    ]),
    consumers: new Map([
      [
        "ORDERS",
        new Map<string, Record<string, unknown>>([
          ["billing", { durable_name: "billing", name: "billing", ack_policy: "explicit", max_ack_pending: 1000, ack_wait: 30e9 }],
          ["debug", { durable_name: "debug", name: "debug", ack_policy: "none" }],
        ]),
      ],
    ]),
    kv: new Map([["config", kvFromStreamConfig({ name: "KV_config", max_msgs_per_subject: 5, max_age: 0, storage: "file", num_replicas: 1, max_bytes: -1, max_msg_size: -1, compression: "none" })]]),
  };
  const files: [string, unknown][] = [
    ["ORDERS.stream.json", { subjects: ["orders.>", "returns.>"], max_age: 86400000000000 }],
    ["EVENTS.stream.json", { subjects: ["events.>"] }],
    ["ORDERS.billing.consumer.json", { durable_name: "billing", ack_policy: "explicit", max_ack_pending: 500 }],
    ["EVENTS.indexer.consumer.json", { ack_policy: "explicit" }],
    ["NOPE.x.consumer.json", { ack_policy: "explicit" }],
    ["config.kv.json", { history: 5 }],
    ["sessions.kv.json", { history: 1, ttl: "30m" }],
  ];
  const parsed = [...files.map(([f, c]) => parseConfigFile(f, JSON.stringify(c))), parseConfigFile("BROKEN.stream.json", "{"), parseConfigFile("dup/ORDERS.stream.json", "{}")];

  test("classifies create / update / unchanged / drift / error", () => {
    const { items, scope } = computePlan(parsed, state);
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    assert.deepEqual(scope, ["stream", "kv", "consumer"]);
    assert.equal(by["stream:ORDERS"].action, "update");
    assert.deepEqual(
      by["stream:ORDERS"].changes.map((c) => c.path),
      ["max_age"],
    );
    assert.equal(by["stream:EVENTS"].action, "create");
    assert.ok(by["stream:EVENTS"].fields?.some((f) => f.path === "subjects"));
    assert.equal(by["consumer:ORDERS/billing"].action, "update");
    assert.equal(by["consumer:EVENTS/indexer"].action, "create");
    assert.equal(by["consumer:EVENTS/indexer"].dependsOn, "stream:EVENTS");
    assert.equal(by["consumer:NOPE/x"].action, "error");
    assert.match(by["consumer:NOPE/x"].error!, /does not exist/);
    assert.equal(by["kv:config"].action, "unchanged");
    assert.equal(by["kv:sessions"].action, "create");
    assert.equal(by["stream:LEGACY"].action, "drift");
    assert.equal(by["consumer:ORDERS/debug"].action, "drift");
    assert.equal(by["stream:BROKEN"].action, "error");
    assert.match(by["file:dup/ORDERS.stream.json"].error!, /Duplicate definition/);
    assert.ok(!items.some((i) => /OBJ_|KV_/.test(i.name)), "internal streams never drift");
    assert.deepEqual(consumerStreamsOf(parsed).sort(), ["BROKEN", "EVENTS", "NOPE", "ORDERS"]);
    // Order: streams, kv, consumers
    const kinds = items.map((i) => i.kind);
    assert.ok(kinds.lastIndexOf("stream") < kinds.indexOf("kv") && kinds.lastIndexOf("kv") < kinds.indexOf("consumer"));
  });

  test("blocked updates and drift scope", () => {
    const { items } = computePlan([parseConfigFile("ORDERS.stream.json", JSON.stringify({ storage: "memory" }))], state);
    const orders = items.find((i) => i.id === "stream:ORDERS")!;
    assert.equal(orders.action, "update");
    assert.match(orders.blocked!, /storage/);
    // Only stream files → no KV drift
    assert.ok(!items.some((i) => i.kind === "kv"));
    // KV-only folder → no stream drift
    const kvOnly = computePlan([parseConfigFile("config.kv.json", "{}")], state).items;
    assert.deepEqual(
      kvOnly.map((i) => i.id),
      ["kv:config"],
    );
  });

  test("warns when the duplicate window is lowered with max_age / ttl", () => {
    const { items } = computePlan([parseConfigFile("ORDERS.stream.json", JSON.stringify({ max_age: 30e9 })), parseConfigFile("config.kv.json", JSON.stringify({ ttl: "45s" }))], {
      ...state,
      streams: new Map([...state.streams, ["KV_config", { ...state.streams.get("KV_config")!, duplicate_window: 120e9 }]]),
    });
    const orders = items.find((i) => i.id === "stream:ORDERS")!;
    assert.ok(orders.warnings.some((w) => /duplicate window \(2m\) is lowered to 30s/.test(w)), JSON.stringify(orders.warnings));
    const kv = items.find((i) => i.id === "kv:config")!;
    assert.ok(kv.warnings.some((w) => /lowered to 45s.*TTL/.test(w)), JSON.stringify(kv.warnings));
    const fine = computePlan([parseConfigFile("ORDERS.stream.json", JSON.stringify({ max_age: 3600e9 }))], state).items.find((i) => i.id === "stream:ORDERS")!;
    assert.deepEqual(fine.warnings, []);
  });

  test("JetStream unavailable vs other errors", () => {
    const off = new Error("jetstream is not enabled");
    off.name = "JetStreamNotEnabled";
    assert.ok(isJetStreamUnavailable(off));
    assert.ok(isJetStreamUnavailable(new Error("503 no responders")));
    assert.ok(!isJetStreamUnavailable(new Error("TIMEOUT")));
    assert.ok(!isJetStreamUnavailable(new Error("Permissions Violation for Publish to \"$JS.API.INFO\"")));
  });

  test("a folder plans only its own files; subfolders are listed separately", async () => {
    const root = mkdtempSync(join(tmpdir(), "nats-admin-plan-folder-"));
    try {
      mkdirSync(join(root, "dev"));
      mkdirSync(join(root, "prod", "eu"), { recursive: true });
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, "node_modules"));
      writeFileSync(join(root, "A.stream.json"), "{}");
      writeFileSync(join(root, "notes.json"), "{}");
      writeFileSync(join(root, "dev", "A.stream.json"), "{}");
      writeFileSync(join(root, "prod", "eu", "A.stream.json"), "{}");
      writeFileSync(join(root, ".git", "X.stream.json"), "{}");
      writeFileSync(join(root, "node_modules", "Y.stream.json"), "{}");
      const files = await readConfigFolder(root);
      assert.deepEqual(
        files.map((f) => f.file),
        ["A.stream.json"],
        "no duplicate A from dev/ or prod/eu/",
      );
      assert.deepEqual(await findConfigSubfolders(root), ["dev", "prod/eu"]);
      const unsaved = await readConfigFolder(root, new Map([[join(root, "A.stream.json"), '{"subjects":["a"]}']]));
      assert.equal(unsaved[0].unsaved, true);
      assert.match(unsaved[0].text, /subjects/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no JetStream → every file is an error", () => {
    const { items } = computePlan([parseConfigFile("A.stream.json", "{}")], { jetstream: false, streams: new Map(), consumers: new Map(), kv: new Map() });
    assert.equal(items[0].action, "error");
  });
});

// ---------------------------------------------------------------------------------------------
// KV transfer encoding
// ---------------------------------------------------------------------------------------------

describe("KV transfer encoding", () => {
  const roundTrip = (bytes: Uint8Array) => {
    const file = JSON.parse(JSON.stringify({ k: encodeKvValue(bytes) }));
    return decodeKvValue(file.k);
  };

  test("JSON values are parsed, text stays text, binary is base64", () => {
    assert.deepEqual(encodeKvValue(enc.encode('{"a":1,"b":[true,null]}')), { a: 1, b: [true, null] });
    assert.deepEqual(encodeKvValue(enc.encode('{\n  "a": 1\n}')), { a: 1 });
    assert.equal(encodeKvValue(enc.encode("5432")), 5432);
    assert.equal(encodeKvValue(enc.encode("true")), true);
    assert.equal(encodeKvValue(enc.encode("db.internal")), "db.internal");
    assert.equal(encodeKvValue(enc.encode('"quoted"')), '"quoted"');
    assert.deepEqual(encodeKvValue(new Uint8Array([0, 1, 250, 251])), { $base64: "AAH6+w==" });
    assert.equal(encodeKvValue(new Uint8Array()), "");
  });

  test("anything that would not round-trip exactly is exported as text", () => {
    for (const s of ["1.50", "1e3", '{"id":12345678901234567890}', '{"e":"\\u00e9"}', '{"$base64":"AAAA"}', " 7", '{"a":1,"a":2}']) {
      assert.equal(typeof encodeKvValue(enc.encode(s)), "string", s);
    }
  });

  test("round trips bytes exactly (except JSON whitespace)", () => {
    const samples = ["5432", "true", "null", '"quoted"', "plain text", "1.50", '{"id":12345678901234567890}', '{"$base64":"AAAA"}', "line1\nline2\u0000"];
    for (const s of samples) assert.equal(dec.decode(roundTrip(enc.encode(s))), s, s);
    const bin = new Uint8Array([0, 159, 146, 150, 255]);
    assert.deepEqual(roundTrip(bin), bin);
    assert.equal(dec.decode(roundTrip(enc.encode('{ "a" : [1, 2] }'))), '{"a":[1,2]}');
  });

  test("stripJsonWhitespace keeps string contents", () => {
    assert.equal(stripJsonWhitespace('{ "a b" : "c \\" d" }'), '{"a b":"c \\" d"}');
  });

  test("parseKvImport validates keys", () => {
    const r = parseKvImport(JSON.stringify({ "app.name": "x", "bad key": 1, ".lead": 2, "ok/=_-": { $base64: "AA==" } }));
    assert.deepEqual(
      r.records.map((x) => x.key),
      ["app.name", "ok/=_-"],
    );
    assert.equal(r.invalid.length, 2);
    assert.throws(() => parseKvImport("[1,2]"), /JSON object/);
    assert.deepEqual(Object.keys(buildKvExport([{ key: "b", value: enc.encode("1") }, { key: "a", value: enc.encode("2") }])), ["a", "b"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Schemas ↔ server API
// ---------------------------------------------------------------------------------------------

function typeFields(src: string, typeName: string): string[] {
  const start = src.indexOf(`export type ${typeName} =`);
  assert.ok(start >= 0, typeName);
  const open = src.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (; end < src.length; end++) {
    if (src[end] === "{") depth++;
    else if (src[end] === "}" && --depth === 0) break;
  }
  const body = src.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let d = 0;
  for (const line of body.split("\n")) {
    if (d === 0) {
      const m = /^\s*"?([a-z_]+)"?\??:/.exec(line);
      if (m) out.push(m[1]);
    }
    d += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
  }
  return out;
}

describe("JSON schemas", () => {
  const api = readFileSync(join(__dirname, "../../node_modules/@nats-io/jetstream/lib/jsapi_types.d.ts"), "utf8");
  const load = (n: string) => JSON.parse(readFileSync(join(__dirname, `../../schemas/${n}.schema.json`), "utf8"));
  const stream = load("stream");
  const consumer = load("consumer");
  const kv = load("kv");

  test("stream schema covers every StreamConfig field", () => {
    const fields = [...typeFields(api, "StreamConfig"), ...typeFields(api, "StreamUpdateConfig")];
    assert.ok(fields.length > 30, `parsed ${fields.length} fields`);
    for (const f of fields) {
      assert.ok(stream.properties[f], `stream schema misses ${f}`);
      assert.ok(STREAM_FIELDS[f], `STREAM_FIELDS misses ${f}`);
    }
    for (const f of Object.keys(STREAM_FIELDS)) assert.ok(stream.properties[f], `schema misses ${f}`);
  });

  test("consumer schema covers every ConsumerConfig field", () => {
    const fields = [...typeFields(api, "ConsumerConfig"), ...typeFields(api, "ConsumerUpdateConfig"), ...typeFields(api, "PriorityGroups")];
    assert.ok(fields.length > 30, `parsed ${fields.length} fields`);
    for (const f of fields) {
      assert.ok(consumer.properties[f], `consumer schema misses ${f}`);
      assert.ok(CONSUMER_FIELDS[f], `CONSUMER_FIELDS misses ${f}`);
    }
  });

  test("KV schema matches the KV definition fields", () => {
    assert.deepEqual(Object.keys(kv.properties).filter((k) => k !== "$schema").sort(), Object.keys(KV_FIELDS).sort());
  });

  test("every property has a markdownDescription; enums are described", () => {
    const walk = (node: Record<string, any>, path: string) => {
      for (const [k, p] of Object.entries<any>(node.properties ?? {})) {
        assert.ok(p.markdownDescription, `${path}.${k} has no markdownDescription`);
        if (p.enum) assert.equal(p.markdownEnumDescriptions?.length, p.enum.length, `${path}.${k} enum descriptions`);
        walk(p, `${path}.${k}`);
      }
      for (const d of Object.values<any>(node.definitions ?? {})) walk(d, `${path}#def`);
    };
    for (const [n, s] of Object.entries({ stream, consumer, kv })) {
      assert.equal(s.$schema, "http://json-schema.org/draft-07/schema#");
      walk(s, n);
    }
    assert.match(stream.properties.max_age.markdownDescription, /nanoseconds/);
    assert.match(stream.properties.storage.markdownDescription, /Immutable/);
  });
});

// ---------------------------------------------------------------------------------------------
// Live: export → plan → apply against nats-server
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

describe("config as code (live server)", { skip: !hasServer && "nats-server not installed" }, () => {
  let server: ChildProcess;
  let dir: string;
  let folder: string;
  let nc: NatsConnection;
  let jsm: JetStreamManager;
  let kvm: Kvm;

  const plan = async () => {
    const parsed = parseFolderFiles(await readConfigFolder(folder));
    const state = await fetchServerState(jsm, consumerStreamsOf(parsed));
    return { parsed, ...computePlan(parsed, state) };
  };
  const write = (file: string, obj: unknown) => writeFileSync(join(folder, file), JSON.stringify(obj, null, 2));
  const read = (file: string) => JSON.parse(readFileSync(join(folder, file), "utf8"));

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "nats-admin-gitops-"));
    folder = join(dir, "config");
    mkdirSync(folder);
    const port = await freePort();
    server = spawn("nats-server", ["-js", "-sd", join(dir, "js"), "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
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
    kvm = new Kvm(jetstream(nc));
    await jsm.streams.add({ name: "ORDERS", subjects: ["orders.>"], description: "orders", metadata: { owner: "team-a" } });
    await jsm.consumers.add("ORDERS", { durable_name: "billing", ack_policy: AckPolicy.Explicit, filter_subject: "orders.eu.>" });
    await jsm.consumers.add("ORDERS", { name: "ephemeral", ack_policy: AckPolicy.None, inactive_threshold: 60e9 });
    await kvm.create("config", { history: 5, ttl: 3_600_000, description: "app config" });
    await new Kvm(jetstream(nc)).create("cache", { history: 1 });
    const os = await import("@nats-io/obj");
    await new os.Objm(jetstream(nc)).create("files");
  });

  after(async () => {
    await nc?.close();
    server?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  test("export produces files that plan as unchanged", async () => {
    const inv = await collectInventory(jsm);
    assert.deepEqual(
      inv.entries.map((e) => e.id),
      ["stream:ORDERS", "consumer:ORDERS/billing", "kv:cache", "kv:config"],
    );
    assert.deepEqual(inv.objectStores, ["files"]);
    assert.equal(inv.ephemeral, 1);
    const files = exportFiles(inv.entries);
    assert.deepEqual(files.map((f) => f.path).sort(), ["ORDERS.billing.consumer.json", "ORDERS.stream.json", "cache.kv.json", "config.kv.json"]);
    for (const f of files) writeFileSync(join(folder, f.path), f.content);
    const s = read("ORDERS.stream.json");
    assert.equal(s.name, "ORDERS");
    assert.deepEqual(s.metadata, { owner: "team-a" });
    assert.equal(read("config.kv.json").ttl, "1h");

    const { items } = await plan();
    assert.ok(
      items.every((i) => i.action === "unchanged"),
      JSON.stringify(items.filter((i) => i.action !== "unchanged")),
    );
  });

  test("edits plan as updates / creates and apply converges", async () => {
    write("ORDERS.stream.json", { ...read("ORDERS.stream.json"), max_age: 86400000000000, subjects: ["orders.>", "returns.>"], metadata: { tier: "gold" } });
    write("ORDERS.billing.consumer.json", { ...read("ORDERS.billing.consumer.json"), max_ack_pending: 250, filter_subject: "orders.>" });
    write("config.kv.json", { ...read("config.kv.json"), history: 10, ttl: "24h" });
    write("EVENTS.stream.json", { subjects: ["events.>"], max_msgs: 0, duplicate_window: 0, storage: "memory" });
    write("EVENTS.indexer.consumer.json", { ack_policy: "explicit", max_deliver: 5, backoff: [1e9, 2e9] });
    write("sessions.kv.json", { history: 2, ttl: "30m", compression: true, metadata: { app: "web" } });
    write("SEALED.stream.json", { subjects: ["sealed.>"], sealed: true });

    const p1 = await plan();
    const by = Object.fromEntries(p1.items.map((i) => [i.id, i]));
    assert.equal(by["stream:ORDERS"].action, "update");
    assert.deepEqual(by["stream:ORDERS"].changes.map((c) => c.path).sort(), ["max_age", "metadata.tier", "subjects"]);
    assert.equal(by["consumer:ORDERS/billing"].action, "update");
    assert.equal(by["kv:config"].action, "update");
    assert.deepEqual(by["kv:config"].changes.map((c) => c.path).sort(), ["history", "ttl"]);
    assert.equal(by["stream:EVENTS"].action, "create");
    assert.equal(by["consumer:EVENTS/indexer"].dependsOn, "stream:EVENTS");
    assert.equal(by["kv:sessions"].action, "create");
    assert.equal(by["stream:SEALED"].action, "create");

    const parsed = new Map(p1.parsed.filter((p): p is ParsedOk => p.ok).map((p) => [p.id, p]));
    for (const item of p1.items.filter((i) => i.action === "create" || i.action === "update")) {
      const outcome = await applyResource({ jsm, kvm }, parsed.get(item.id)!);
      assert.equal(outcome, item.action === "create" ? "created" : "updated", item.id);
    }

    const p2 = await plan();
    assert.ok(
      p2.items.every((i) => i.action === "unchanged"),
      JSON.stringify(p2.items.filter((i) => i.action !== "unchanged")),
    );
    const orders = (await jsm.streams.info("ORDERS")).config;
    assert.deepEqual(orders.metadata && { owner: orders.metadata.owner, tier: orders.metadata.tier }, { owner: "team-a", tier: "gold" }, "nested metadata merged");
    assert.equal((await jsm.streams.info("SEALED")).config.sealed, true);
    const sessions = await (await kvm.open("sessions")).status();
    assert.equal(sessions.ttl, 1_800_000);
    assert.equal(sessions.compression, true);
    assert.equal((await jsm.consumers.info("EVENTS", "indexer")).config.max_deliver, 5);
  });

  test("immutable changes are blocked and the server agrees", async () => {
    write("ORDERS.stream.json", { ...read("ORDERS.stream.json"), storage: "memory" });
    const { items, parsed } = await plan();
    const orders = items.find((i) => i.id === "stream:ORDERS")!;
    assert.ok(orders.blocked, "blocked");
    const p = parsed.find((x) => x.id === "stream:ORDERS") as ParsedOk;
    await assert.rejects(applyResource({ jsm, kvm }, p), /storage type/);
    write("ORDERS.stream.json", { ...read("ORDERS.stream.json"), storage: "file" });

    write("ORDERS.billing.consumer.json", { ...read("ORDERS.billing.consumer.json"), ack_policy: "all" });
    const c = (await plan()).items.find((i) => i.id === "consumer:ORDERS/billing")!;
    assert.ok(c.blocked);
    write("ORDERS.billing.consumer.json", { ...read("ORDERS.billing.consumer.json"), ack_policy: "explicit" });
  });

  test("drift: server resources missing locally", async () => {
    await jsm.streams.add({ name: "ROGUE", subjects: ["rogue.>"] });
    await jsm.consumers.add("ORDERS", { durable_name: "adhoc", ack_policy: AckPolicy.Explicit });
    await kvm.create("scratch");
    const { items } = await plan();
    const drift = items.filter((i) => i.action === "drift").map((i) => i.id);
    assert.deepEqual(drift.sort(), ["consumer:ORDERS/adhoc", "kv:scratch", "stream:ROGUE"]);
    assert.ok(items.find((i) => i.id === "stream:ROGUE")!.fields!.some((f) => f.path === "subjects"));
  });

  test("KV keys export and import round trip", async () => {
    const kv = await kvm.open("config");
    await kv.put("app.name", enc.encode('"nats-admin"'));
    await kv.put("app.port", enc.encode("5432"));
    await kv.put("app.db", enc.encode('{"pool":{"min":2,"max":20}}'));
    await kv.put("blob", new Uint8Array([0, 1, 2, 255]));
    await kv.put("gone", enc.encode("x"));
    await kv.delete("gone");
    const { records } = await readAllEntries(kv);
    const file = JSON.stringify(buildKvExport(records), null, 2);
    const obj = JSON.parse(file);
    assert.deepEqual(Object.keys(obj), ["app.db", "app.name", "app.port", "blob"]);
    assert.deepEqual(obj["app.db"], { pool: { min: 2, max: 20 } });
    assert.equal(obj["app.name"], '"nats-admin"');
    assert.equal(obj["app.port"], 5432);
    assert.deepEqual(obj.blob, { $base64: "AAEC/w==" });

    const target = await kvm.create("restore", { history: 3 });
    await target.put("app.port", enc.encode("1"));
    const { records: incoming } = parseKvImport(file);
    const skip = await importRecords(target, incoming, { skipExisting: true });
    assert.deepEqual({ w: skip.written, s: skip.skipped, f: skip.failed.length }, { w: 3, s: 1, f: 0 });
    assert.equal(dec.decode((await target.get("app.port"))!.value), "1", "existing key kept");
    const over = await importRecords(target, incoming, { skipExisting: false });
    assert.equal(over.written, 4);
    assert.equal(dec.decode((await target.get("app.port"))!.value), "5432");
    assert.equal(dec.decode((await target.get("app.name"))!.value), '"nats-admin"');
    assert.deepEqual([...(await target.get("blob"))!.value], [0, 1, 2, 255]);
    assert.equal(dec.decode((await target.get("app.db"))!.value), '{"pool":{"min":2,"max":20}}');
  });

  test("consumer with backoff and a stale ack_wait converges", async () => {
    write("ORDERS.retry.consumer.json", { ack_policy: "explicit", ack_wait: 30e9, backoff: [1e9, 5e9], max_deliver: 4 });
    const p1 = await plan();
    const item = p1.items.find((i) => i.id === "consumer:ORDERS/retry")!;
    assert.equal(item.action, "create");
    assert.ok(item.warnings.some((w) => /ack_wait/.test(w)));
    const parsed = p1.parsed.find((p) => p.id === "consumer:ORDERS/retry") as ParsedOk;
    assert.equal(await applyResource({ jsm, kvm }, parsed), "created");
    assert.equal((await jsm.consumers.info("ORDERS", "retry")).config.ack_wait, 1e9, "server uses backoff[0]");
    assert.equal((await plan()).items.find((i) => i.id === "consumer:ORDERS/retry")!.action, "unchanged");
  });

  test("KV export can be cancelled", async () => {
    const kv = await kvm.open("config");
    const pre = await readAllEntries(kv, { token: { isCancellationRequested: true, onCancellationRequested: () => undefined } });
    assert.deepEqual(pre, { records: [], truncated: false, cancelled: true });
    let checks = 0;
    let stop: (() => void) | undefined;
    const mid = await readAllEntries(kv, {
      token: {
        get isCancellationRequested() {
          return ++checks > 2; // cancelled while the watch is delivering
        },
        onCancellationRequested: (cb: () => void) => (stop = cb),
      },
    });
    assert.equal(mid.cancelled, true);
    assert.equal(typeof stop, "function", "the watch can be stopped from the token");
  });

  test("lowering max_age / ttl below the duplicate window applies (server rejects a larger window)", async () => {
    // Exported files spell out duplicate_window: a smaller max_age is flagged before anything is sent.
    write("ORDERS.stream.json", { ...read("ORDERS.stream.json"), max_age: 60e9 });
    const p1 = await plan();
    const bad = p1.items.find((i) => i.id === "stream:ORDERS")!;
    assert.equal(bad.action, "error");
    assert.match(bad.error!, /duplicate_window/);

    // Without duplicate_window in the file, Apply lowers the window together with max_age.
    const { duplicate_window: _d, ...orders } = read("ORDERS.stream.json");
    write("ORDERS.stream.json", orders);
    write("config.kv.json", { ...read("config.kv.json"), ttl: "30s" });
    const p2 = await plan();
    const by = Object.fromEntries(p2.items.map((i) => [i.id, i]));
    assert.equal(by["stream:ORDERS"].action, "update");
    assert.ok(by["stream:ORDERS"].warnings.some((w) => /duplicate window/.test(w)));
    assert.equal(by["kv:config"].action, "update");
    assert.ok(by["kv:config"].warnings.some((w) => /duplicate window/.test(w)));
    const parsed = new Map(p2.parsed.filter((p): p is ParsedOk => p.ok).map((p) => [p.id, p]));
    assert.equal(await applyResource({ jsm, kvm }, parsed.get("stream:ORDERS")!), "updated");
    assert.equal(await applyResource({ jsm, kvm }, parsed.get("kv:config")!), "updated");
    const sc = (await jsm.streams.info("ORDERS")).config;
    assert.deepEqual([sc.max_age, sc.duplicate_window], [60e9, 60e9]);
    const kc = (await jsm.streams.info("KV_config")).config;
    assert.deepEqual([kc.max_age, kc.duplicate_window], [30e9, 30e9]);
    const p3 = await plan();
    for (const id of ["stream:ORDERS", "kv:config"]) assert.equal(p3.items.find((i) => i.id === id)!.action, "unchanged", id);
  });
});
