// Tests for the Consumer Lab session and message export helpers. The live
// part spawns a throwaway nats-server (skipped when it is not installed).

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { AckPolicy, jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import { consumerView, LabSession } from "../src/nats/consumerLab";
import { messagesToCsv, messagesToJson, messageToJsonDoc } from "../src/nats/messageExport";
import type { MessageDTO } from "../src/shared/dto";
import { bytesToBase64, utf8Encode } from "../src/shared/encoding";

const msg = (seq: number, subject: string, payload: Uint8Array, headers: [string, string][] = []): MessageDTO => ({
  id: String(seq),
  seq,
  subject,
  time: "2026-11-17T10:00:00.000Z",
  headers,
  data: bytesToBase64(payload),
  size: payload.length,
});

test("export: JSON keeps JSON payloads structured, text as text, binary as base64", () => {
  const out = JSON.parse(
    messagesToJson("ORDERS", [
      msg(1, "a.b", utf8Encode('{"x":1}'), [
        ["H", "1"],
        ["H", "2"],
      ]),
      msg(2, "a.c", utf8Encode("plain text")),
      msg(3, "a.d", new Uint8Array([0, 255, 1])),
    ]),
  );
  assert.equal(out.stream, "ORDERS");
  assert.equal(out.count, 3);
  assert.deepEqual(out.messages[0].payload, { x: 1 });
  assert.deepEqual(out.messages[0].headers, { H: ["1", "2"] });
  assert.equal(out.messages[1].encoding, "text");
  assert.equal(out.messages[2].encoding, "base64");
  assert.equal(out.messages[2].payload, "AP8B");
  const doc = JSON.parse(messageToJsonDoc("S", msg(9, "z", utf8Encode("[1]"))));
  assert.equal(doc.stream, "S");
  assert.deepEqual(doc.payload, [1]);
});

test("export: CSV quotes fields with commas, quotes and newlines", () => {
  const csv = messagesToCsv([msg(1, "a.b", utf8Encode('{"x":"a,b"}')), msg(2, "a.c", utf8Encode('say "hi"\nbye'))]);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "seq,time,subject,size,headers,encoding,payload");
  assert.equal(lines[1], '1,2026-11-17T10:00:00.000Z,a.b,11,,json,"{""x"":""a,b""}"');
  assert.ok(csv.includes('"say ""hi""\nbye"'));
});

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

describe("Consumer Lab session (live server)", { skip: !hasServer && "nats-server not installed" }, () => {
  let server: ChildProcess;
  let dir: string;
  let nc: NatsConnection;
  let jsm: JetStreamManager;
  let js: JetStreamClient;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "nats-admin-lab-"));
    const port = await freePort();
    server = spawn("nats-server", ["-js", "-sd", dir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
    for (let i = 0; i < 50 && !nc; i++) {
      try {
        nc = await connect({ servers: `nats://127.0.0.1:${port}`, timeout: 500 });
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    jsm = await jetstreamManager(nc);
    js = jetstream(nc);
    await jsm.streams.add({ name: "LAB", subjects: ["lab.>"] });
    for (let i = 1; i <= 6; i++) await js.publish(`lab.${i % 2 ? "odd" : "even"}`, utf8Encode(JSON.stringify({ i })));
    await jsm.consumers.add("LAB", { durable_name: "work", ack_policy: AckPolicy.Explicit, ack_wait: 30_000_000_000, max_deliver: 5 });
    await jsm.consumers.add("LAB", { durable_name: "pushy", ack_policy: AckPolicy.Explicit, deliver_subject: "deliver.pushy" });
  });

  after(async () => {
    await nc?.close();
    server?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  test("consumerView maps config and state", async () => {
    const v = consumerView(await jsm.consumers.info("LAB", "work"), await jsm.streams.info("LAB"));
    assert.equal(v.push, false);
    assert.equal(v.durable, true);
    assert.equal(v.numPending, 6);
    assert.equal(v.maxDeliver, 5);
    assert.equal(v.streamLastSeq, 6);
    const p = consumerView(await jsm.consumers.info("LAB", "pushy"));
    assert.equal(p.push, true);
    assert.equal(p.deliverSubject, "deliver.pushy");
  });

  test("fetch, ack, nak, term, working and redelivery", async () => {
    const lab = new LabSession(
      () => js,
      () => nc,
      "LAB",
      "work",
    );
    const first = await lab.fetch(4, 1000);
    assert.equal(first.messages.length, 4);
    assert.deepEqual(
      first.messages.map((m) => m.seq),
      [1, 2, 3, 4],
    );
    assert.ok(first.messages.every((m) => m.ackState === "pending" && m.deliveryCount === 1));
    const [a, b, c, d] = first.messages.map((m) => m.id);

    const r = await lab.act([a], "ack");
    assert.deepEqual(r, [{ id: a, state: "ack" }]);
    const again = await lab.act([a], "ack");
    assert.match(again[0].error ?? "", /Already acknowledged/);

    await lab.act([b], "nak");
    await lab.act([c], "term", { reason: "bad payload" });
    const w = await lab.act([d], "working");
    assert.equal(w[0].state, "working");
    assert.deepEqual(lab.openIds(), [d]);

    let info = await jsm.consumers.info("LAB", "work");
    assert.equal(info.ack_floor.stream_seq, 1);
    // Outstanding: the in-progress message and the nak'd one awaiting redelivery (term'd seq 3 is gone).
    assert.equal(info.num_ack_pending, 2);

    // The nak'd message (seq 2) comes back with deliveryCount 2.
    const second = await lab.fetch(3, 1000);
    const redelivered = second.messages.find((m) => m.seq === 2);
    assert.ok(redelivered, "nak'd message is redelivered");
    assert.equal(redelivered.deliveryCount, 2);
    assert.equal(redelivered.redelivered, true);

    await lab.act([d, ...second.messages.map((m) => m.id)], "ack");
    assert.deepEqual(lab.openIds(), []);
    info = await jsm.consumers.info("LAB", "work");
    assert.equal(info.num_ack_pending, 0);

    lab.forget();
    const unknown = await lab.act([a], "ack");
    assert.match(unknown[0].error ?? "", /no longer held/);
  });

  test("fetch on an empty consumer returns no messages after expiry", async () => {
    const lab = new LabSession(
      () => js,
      () => nc,
      "LAB",
      "work",
    );
    const res = await lab.fetch(5, 1000);
    // 6 messages: 1-6; seq 3 terminated, the rest acked → nothing left.
    assert.equal(res.messages.length, 0);
  });

  test("fetch on a missing consumer rejects", async () => {
    const lab = new LabSession(
      () => js,
      () => nc,
      "LAB",
      "nope",
    );
    await assert.rejects(lab.fetch(1, 1000), /consumer/i);
  });
});
