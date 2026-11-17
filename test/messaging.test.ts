import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { connect } from "@nats-io/transport-node";
import { AckPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import {
  ADVISORY_SUBJECTS,
  encodePayload,
  exampleSubject,
  messagesToCsv,
  messagesToJson,
  parseAdvisory,
  parseHeaderLines,
  republishHeaders,
  subscriptionColor,
  toPlaybookBlock,
} from "../src/nats/messaging";
import { parsePlaybook } from "../src/shared/playbook";
import { bytesToBase64, utf8Encode } from "../src/shared/encoding";
import type { MessageDTO } from "../src/shared/dto";

test("encodePayload handles every encoding", () => {
  assert.deepEqual(encodePayload("hi", "text"), utf8Encode("hi"));
  assert.deepEqual(encodePayload('{"a":1}', "json"), utf8Encode('{"a":1}'));
  assert.throws(() => encodePayload("{nope", "json"), /not valid JSON/);
  assert.deepEqual(encodePayload("aGk=", "base64"), utf8Encode("hi"));
  assert.throws(() => encodePayload("not base64!", "base64"), /base64/);
  assert.deepEqual(encodePayload("68 69", "hex"), utf8Encode("hi"));
  assert.throws(() => encodePayload("abc", "hex"), /odd/);
});

test("parseAdvisory reads max-deliveries and terminated advisories", () => {
  const max = parseAdvisory(
    "$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.ORDERS.billing",
    utf8Encode(JSON.stringify({ type: "io.nats.jetstream.advisory.v1.max_deliver", id: "x1", timestamp: "2026-11-17T10:00:00Z", stream: "ORDERS", consumer: "billing", stream_seq: 42, deliveries: 3 })),
  );
  assert.deepEqual(
    { kind: max?.kind, stream: max?.stream, consumer: max?.consumer, seq: max?.streamSeq, deliveries: max?.deliveries, id: max?.id },
    { kind: "max_deliveries", stream: "ORDERS", consumer: "billing", seq: 42, deliveries: 3, id: "x1" },
  );
  const term = parseAdvisory("$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.S.c", utf8Encode(JSON.stringify({ stream_seq: 7, deliveries: 1, reason: "bad payload" })));
  assert.equal(term?.kind, "terminated");
  assert.equal(term?.reason, "bad payload");
  assert.equal(term?.stream, "S");
  assert.equal(parseAdvisory("orders.created", utf8Encode("{}")), null);
  // Malformed body still yields stream/consumer from the subject.
  assert.equal(parseAdvisory("$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.S.c", utf8Encode("garbage"))?.consumer, "c");
});

test("republishHeaders drops dedupe/expectation headers and marks origin", () => {
  const h = republishHeaders(
    [
      ["Nats-Msg-Id", "o1"],
      ["Nats-Expected-Stream", "X"],
      ["Content-Type", "application/json"],
    ],
    "ORDERS/5",
  );
  assert.deepEqual(h, [
    ["Content-Type", "application/json"],
    ["Nats-Admin-Republished-From", "ORDERS/5"],
  ]);
});

const msg = (subject: string, payload: Uint8Array, extra: Partial<MessageDTO> = {}): MessageDTO => ({
  id: subject,
  subject,
  time: "2026-11-17T10:00:00.000Z",
  headers: [["k", "v"]],
  data: bytesToBase64(payload),
  size: payload.length,
  ...extra,
});

test("exports to CSV and JSON", () => {
  const msgs = [msg("a.b", utf8Encode('{"x":1}'), { seq: 3 }), msg("c", new Uint8Array([0, 255])), msg("d", utf8Encode('he said "hi", ok'))];
  const csv = messagesToCsv(msgs);
  const lines = csv.trim().split("\r\n");
  assert.equal(lines[0], "time,subject,seq,reply,size,headers,payload");
  assert.equal(lines[1], '2026-11-17T10:00:00.000Z,a.b,3,,7,k: v,"{""x"":1}"');
  assert.match(lines[2], /,base64:AP8=$/);
  assert.match(lines[3], /"he said ""hi"", ok"$/);
  const json = JSON.parse(messagesToJson(msgs));
  assert.deepEqual(json[0].payload, { x: 1 });
  assert.equal(json[0].seq, 3);
  assert.deepEqual(json[0].headers, { k: "v" });
  assert.equal(json[1].payload, "base64:AP8=");
  assert.equal(json[2].payload, 'he said "hi", ok');
});

test("playbook block round-trips through the playbook parser", () => {
  const text = toPlaybookBlock({ verb: "PUB", subject: "orders.eu.created", headers: [["Nats-Msg-Id", "{{uuid}}"]], body: '{"id": {{seq}}}', options: { count: 3, reply: undefined } });
  const pb = parsePlaybook(text);
  assert.equal(pb.blocks.length, 1);
  const b = pb.blocks[0];
  assert.equal(b.verb, "PUB");
  assert.equal(b.subject, "orders.eu.created");
  assert.equal(b.options.count, "3");
  assert.deepEqual(b.headers, [["Nats-Msg-Id", "{{uuid}}"]]);
  assert.equal(b.body, '{"id": {{seq}}}');
  const req = parsePlaybook(toPlaybookBlock({ verb: "REQ", subject: "svc.q", headers: [], body: "ping", options: { timeout: 2000 } })).blocks[0];
  assert.equal(req.verb, "REQ");
  assert.equal(req.options.timeout, "2000");
  assert.equal(req.body, "ping");
});

test("small helpers", () => {
  assert.equal(exampleSubject("orders.>"), "orders.new");
  assert.equal(exampleSubject("orders.*.created"), "orders.x.created");
  assert.notEqual(subscriptionColor(0), subscriptionColor(1));
  assert.equal(subscriptionColor(0), subscriptionColor(8));
  assert.deepEqual(parseHeaderLines("A: 1\nbad line\n  B-2 :two words\n"), [
    ["A", "1"],
    ["B-2", "two words"],
  ]);
});

const hasServer = spawnSync("nats-server", ["--version"]).status === 0;
const LIVE_URL = process.env.NATS_TEST_URL;

// Optional: real advisories from a live server (NATS_TEST_URL=nats://127.0.0.1:4333).
test("advisories from a live server parse", { skip: !(hasServer && LIVE_URL) && "set NATS_TEST_URL to run" }, async () => {
  const nc = await connect({ servers: LIVE_URL! });
  after(() => nc.close());
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);
  const name = `DLTEST_${Date.now()}`;
  await jsm.streams.add({ name, subjects: [`${name.toLowerCase()}.>`] });
  after(() => jsm.streams.delete(name).catch(() => undefined));
  await jsm.consumers.add(name, { durable_name: "worker", ack_policy: AckPolicy.Explicit, max_deliver: 1, ack_wait: 1_000_000_000 });
  const got: ReturnType<typeof parseAdvisory>[] = [];
  const subs = ADVISORY_SUBJECTS.map((s) => nc.subscribe(s, { callback: (_e, m) => void got.push(parseAdvisory(m.subject, m.data)) }));
  await nc.flush();
  await js.publish(`${name.toLowerCase()}.a`, utf8Encode("poison"));
  await js.publish(`${name.toLowerCase()}.b`, utf8Encode("terminate me"));
  const c = await js.consumers.get(name, "worker");
  const batch = await c.fetch({ max_messages: 2, expires: 2000 });
  for await (const m of batch) {
    if (m.subject.endsWith(".b")) m.term("bad");
    // .a is left un-acked → exceeds max_deliver=1 after ack_wait
  }
  // trigger redelivery check for the un-acked message
  await new Promise((r) => setTimeout(r, 1500));
  const again = await c.fetch({ max_messages: 1, expires: 1500 });
  for await (const _ of again) {
    /* nothing should be delivered */
  }
  await new Promise((r) => setTimeout(r, 300));
  subs.forEach((s) => s.unsubscribe());
  const kinds = got.filter((g) => g?.stream === name).map((g) => g!.kind).sort();
  assert.ok(kinds.includes("terminated"), `got ${JSON.stringify(got)}`);
  assert.ok(kinds.includes("max_deliveries"), `got ${JSON.stringify(got)}`);
  const term = got.find((g) => g?.kind === "terminated" && g.stream === name)!;
  assert.equal(term.reason, "bad");
  assert.equal(term.streamSeq, 2);
});
