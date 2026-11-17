// Live integration tests for the NATS service layer. Each run spawns a
// throwaway nats-server (JetStream enabled) on a random port. Skipped when
// `nats-server` is not on PATH.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { jetstream, jetstreamManager, AckPolicy, RetentionPolicy, type JetStreamManager, type JetStreamClient } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { Objm } from "@nats-io/obj";
import { Svcm } from "@nats-io/services";
import { browseMessages, listConsumers, listStreams } from "../src/nats/streams";
import { history, listBuckets, listKeys, snapshotAndWatch } from "../src/nats/kv";
import { downloadToFile, listObjBuckets, listObjects, readObject, uploadFile } from "../src/nats/obj";
import { discoverServices } from "../src/nats/services";
import { fetchMonitor, type VarzLite } from "../src/nats/monitor";
import { base64ToBytes, utf8Decode } from "../src/shared/encoding";

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

describe("NATS service layer (live server)", { skip: !hasServer && "nats-server not installed" }, () => {
  let server: ChildProcess;
  let dir: string;
  let nc: NatsConnection;
  let jsm: JetStreamManager;
  let js: JetStreamClient;
  let monitorUrl: string;
  const enc = new TextEncoder();

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "nats-admin-test-"));
    const port = await freePort();
    const mport = await freePort();
    monitorUrl = `http://127.0.0.1:${mport}`;
    server = spawn("nats-server", ["-js", "-sd", dir, "-p", String(port), "-m", String(mport), "-a", "127.0.0.1"], { stdio: "ignore" });
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

    await jsm.streams.add({ name: "ORDERS", subjects: ["orders.>"] });
    for (let i = 1; i <= 100; i++) {
      const subj = i % 4 === 0 ? "orders.us.shipped" : "orders.eu.created";
      await js.publish(subj, enc.encode(JSON.stringify({ id: i })));
    }
    await jsm.consumers.add("ORDERS", { durable_name: "billing", ack_policy: AckPolicy.Explicit, filter_subject: "orders.eu.>" });
  });

  after(async () => {
    await nc?.close();
    server?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  test("streams and consumers list", async () => {
    await new Kvm(js).create("hidden");
    const visible = await listStreams(jsm, false);
    assert.deepEqual(
      visible.map((s) => s.config.name),
      ["ORDERS"],
    );
    const all = await listStreams(jsm, true);
    assert.ok(all.some((s) => s.config.name === "KV_hidden"));
    const consumers = await listConsumers(jsm, "ORDERS");
    assert.deepEqual(
      consumers.map((c) => c.name),
      ["billing"],
    );
  });

  test("browse forward / backward / filtered", async () => {
    const first = await browseMessages(jsm, js, { stream: "ORDERS", limit: 10, direction: "forward" });
    assert.equal(first.messages.length, 10);
    assert.equal(first.messages[0].seq, 1);
    assert.equal(first.atStart, true);
    assert.equal(first.atEnd, false);

    const newest = await browseMessages(jsm, js, { stream: "ORDERS", limit: 10, direction: "backward" });
    assert.deepEqual(
      newest.messages.map((m) => m.seq),
      [91, 92, 93, 94, 95, 96, 97, 98, 99, 100],
    );
    assert.equal(newest.atEnd, true);

    const tail = await browseMessages(jsm, js, { stream: "ORDERS", seq: 95, limit: 10, direction: "forward" });
    assert.equal(tail.messages.length, 6);
    assert.equal(tail.atEnd, true);

    const shipped = await browseMessages(jsm, js, { stream: "ORDERS", filter: "orders.us.>", limit: 5, direction: "forward" });
    assert.deepEqual(
      shipped.messages.map((m) => m.seq),
      [4, 8, 12, 16, 20],
    );
    assert.equal(JSON.parse(utf8Decode(base64ToBytes(shipped.messages[0].data))).id, 4);

    const shippedNewest = await browseMessages(jsm, js, { stream: "ORDERS", filter: "orders.us.>", limit: 3, direction: "backward" });
    assert.deepEqual(
      shippedNewest.messages.map((m) => m.seq),
      [92, 96, 100],
    );
    const older = await browseMessages(jsm, js, { stream: "ORDERS", filter: "orders.us.>", seq: 91, limit: 3, direction: "backward" });
    assert.deepEqual(
      older.messages.map((m) => m.seq),
      [80, 84, 88],
    );
    const none = await browseMessages(jsm, js, { stream: "ORDERS", seq: 500, limit: 3, direction: "forward" });
    assert.equal(none.messages.length, 0);
  });

  test("kv keys, snapshot + live watch, history", async () => {
    const kvm = new Kvm(js);
    const kv = await kvm.create("config", { history: 5 });
    await kv.put("app.db.host", "db.internal");
    await kv.put("app.db.port", "5432");
    await kv.put("app.features", '{"a":1}');
    await kv.put("app.features", '{"a":2}');
    await kv.put("tmp.x", "gone");
    await kv.delete("tmp.x");

    const buckets = await listBuckets(kvm);
    assert.ok(buckets.some((b) => b.bucket === "config" && b.history === 5));

    const { keys, truncated } = await listKeys(kv, undefined, 100);
    assert.deepEqual(keys.sort(), ["app.db.host", "app.db.port", "app.features"]);
    assert.equal(truncated, false);
    const limited = await listKeys(kv, "app.db.*", 1);
    assert.equal(limited.keys.length, 1);
    assert.equal(limited.truncated, true);

    const updates: string[] = [];
    let initial: string[] = [];
    const ready = new Promise<void>((resolve) => {
      void snapshotAndWatch(kv, {
        max: 100,
        maxValueBytes: 1024,
        live: true,
        onInitial: (entries) => {
          initial = entries.map((e) => e.key).sort();
          resolve();
        },
        onUpdate: (e) => updates.push(`${e.operation}:${e.key}`),
      }).then((h) => after(() => h.stop()));
    });
    await ready;
    assert.deepEqual(initial, ["app.db.host", "app.db.port", "app.features"]);
    await kv.put("new.key", "1");
    await kv.delete("app.db.port");
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(updates, ["PUT:new.key", "DEL:app.db.port"]);

    const h = await history(kv, "app.features");
    assert.deepEqual(
      h.map((e) => new TextDecoder().decode(e.value)),
      ['{"a":2}', '{"a":1}'],
    );

    // empty bucket snapshot resolves immediately
    const empty = await kvm.create("empty");
    const emptySnap = await new Promise<number>((resolve) => {
      void snapshotAndWatch(empty, { max: 10, maxValueBytes: 10, live: false, onInitial: (e) => resolve(e.length) });
    });
    assert.equal(emptySnap, 0);
  });

  test("object store upload / list / read / download", async () => {
    const objm = new Objm(js);
    const os = await objm.create("files");
    const src = join(dir, "upload.txt");
    writeFileSync(src, "hello object store\n".repeat(1000));
    await uploadFile(os, "docs/hello.txt", src);
    const buckets = await listObjBuckets(objm);
    assert.deepEqual(
      buckets.map((b) => b.bucket),
      ["files"],
    );
    const objects = await listObjects(os);
    assert.equal(objects[0].name, "docs/hello.txt");
    assert.equal(objects[0].size, 19000);
    const { data } = await readObject(os, "docs/hello.txt", 1_000_000);
    assert.equal(data.length, 19000);
    await assert.rejects(readObject(os, "docs/hello.txt", 10), /larger than the preview limit/);
    const dst = join(dir, "download.txt");
    const n = await downloadToFile(os, "docs/hello.txt", dst);
    assert.equal(n, 19000);
    assert.equal(readFileSync(dst, "utf8"), readFileSync(src, "utf8"));
  });

  test("service discovery", async () => {
    const svc = await new Svcm(nc).add({ name: "calc", version: "1.2.0", description: "adds numbers" });
    svc.addEndpoint("add", { subject: "calc.add", handler: (_err, msg) => msg.respond("3") });
    await nc.request("calc.add", "1+2");
    const found = await discoverServices(new Svcm(nc), 500);
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "calc");
    assert.deepEqual(found[0].versions, ["1.2.0"]);
    assert.equal(found[0].endpoints[0].subject, "calc.add");
    assert.equal(found[0].endpoints[0].numRequests, 1);
    await svc.stop();
  });

  test("browse a work-queue stream (direct-get fallback, no consumer conflicts)", async () => {
    await jsm.streams.add({ name: "WQ", subjects: ["wq.>"], retention: RetentionPolicy.Workqueue });
    await jsm.consumers.add("WQ", { durable_name: "worker", ack_policy: AckPolicy.Explicit });
    for (let i = 1; i <= 6; i++) await js.publish(i % 2 ? "wq.a" : "wq.b", enc.encode(String(i)));
    const page = await browseMessages(jsm, js, { stream: "WQ", limit: 4, direction: "forward" });
    assert.deepEqual(page.messages.map((m) => m.seq), [1, 2, 3, 4]);
    const filtered = await browseMessages(jsm, js, { stream: "WQ", filter: "wq.b", limit: 10, direction: "forward" });
    assert.deepEqual(filtered.messages.map((m) => m.seq), [2, 4, 6]);
    const newest = await browseMessages(jsm, js, { stream: "WQ", limit: 2, direction: "backward" });
    assert.deepEqual(newest.messages.map((m) => m.seq), [5, 6]);
    assert.equal((await jsm.consumers.info("WQ", "worker")).num_pending, 6, "browsing did not consume anything");
  });

  test("consumer pause / resume / reset against this server version", async () => {
    await jsm.consumers.add("ORDERS", { durable_name: "pausable", ack_policy: AckPolicy.Explicit });
    const paused = await jsm.consumers.pause("ORDERS", "pausable", new Date(Date.now() + 60_000));
    assert.equal(paused.paused, true);
    assert.equal((await jsm.consumers.info("ORDERS", "pausable")).paused, true);
    assert.equal((await jsm.consumers.resume("ORDERS", "pausable")).paused, false);
    let resetSupported = true;
    try {
      await jsm.consumers.reset("ORDERS", "pausable", 1);
    } catch (e) {
      resetSupported = false;
      console.log(`  (consumer reset not supported by this server: ${(e as Error).message})`);
    }
    console.log(`  consumer reset supported: ${resetSupported}`);
  });

  test("monitoring endpoint", async () => {
    const varz = await fetchMonitor<VarzLite>(monitorUrl, "varz");
    assert.ok(varz.version);
    assert.ok(varz.connections >= 1);
  });
});
