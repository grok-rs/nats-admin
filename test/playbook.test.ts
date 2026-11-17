import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlaybook, PLAYBOOK_SAMPLE } from "../src/shared/playbook";
import {
  connectionDirectiveEdit,
  describeMessage,
  effectiveConnectionName,
  expandBlock,
  formatReply,
  intOption,
  sanitizeFileName,
} from "../src/playbook/playbookCore";
import { utf8Encode } from "../src/shared/encoding";

test("effective connection: block option wins over file directive", () => {
  const pb = parsePlaybook("@connection prod\n\n### a\nPUB x.y connection=dev\nhi\n\n### b\nPUB x.z\nho\n");
  assert.equal(effectiveConnectionName(pb, pb.blocks[0]), "dev");
  assert.equal(effectiveConnectionName(pb, pb.blocks[1]), "prod");
  const none = parsePlaybook("PUB a b");
  assert.equal(effectiveConnectionName(none, none.blocks[0]), undefined);
});

test("PUB expansion renders templates per message", () => {
  const pb = parsePlaybook(PLAYBOOK_SAMPLE);
  const exp = expandBlock(pb.blocks[0], { defaultRequestTimeout: 5000, now: new Date("2026-01-01T00:00:00Z") });
  assert.equal(exp.verb, "PUB");
  assert.equal(exp.messages.length, 3);
  const bodies = exp.messages.map((m) => JSON.parse(m.data));
  assert.deepEqual(
    bodies.map((b) => b.id),
    [1, 2, 3],
  );
  assert.equal(bodies[0].createdAt, "2026-01-01T00:00:00.000Z");
  const ids = exp.messages.map((m) => m.headers.find(([k]) => k === "Nats-Msg-Id")![1]);
  assert.equal(new Set(ids).size, 3, "uuid rendered per message");
  assert.equal(exp.jetstream, false);
});

test("subject, reply and js options", () => {
  const pb = parsePlaybook("PUB orders.{{seq}} count=2 reply=inbox.{{seq}} js=true\nx");
  const exp = expandBlock(pb.blocks[0], { defaultRequestTimeout: 1 });
  assert.deepEqual(
    exp.messages.map((m) => [m.subject, m.reply]),
    [
      ["orders.1", "inbox.1"],
      ["orders.2", "inbox.2"],
    ],
  );
  assert.equal(exp.jetstream, true);
});

test("REQ uses timeout option or the default", () => {
  const pb = parsePlaybook("### r\nREQ a.b timeout=250\n{}\n### s\nREQ a.c count=5\n{}");
  assert.equal(expandBlock(pb.blocks[0], { defaultRequestTimeout: 5000 }).timeoutMs, 250);
  const second = expandBlock(pb.blocks[1], { defaultRequestTimeout: 5000 });
  assert.equal(second.timeoutMs, 5000);
  assert.equal(second.messages.length, 1, "REQ never repeats");
});

test("SUB expansion", () => {
  const pb = parsePlaybook("SUB orders.> count=5 timeout=30000 queue=workers");
  const exp = expandBlock(pb.blocks[0], { defaultRequestTimeout: 1 });
  assert.equal(exp.maxMessages, 5);
  assert.equal(exp.timeoutMs, 30000);
  assert.equal(exp.queue, "workers");
  const dflt = expandBlock(parsePlaybook("SUB a").blocks[0], { defaultRequestTimeout: 1 });
  assert.equal(dflt.maxMessages, undefined);
  assert.equal(dflt.timeoutMs, 60000);
});

test("invalid numeric options throw", () => {
  const pb = parsePlaybook("PUB a count=abc\nx");
  assert.throws(() => expandBlock(pb.blocks[0], { defaultRequestTimeout: 1 }), /whole number/);
  const pb2 = parsePlaybook("PUB a count=0\nx");
  assert.throws(() => intOption(pb2.blocks[0], "count", 1, 10), /between 1 and 10/);
});

test("reply formatting", () => {
  const ok = JSON.parse(
    formatReply({ requestSubject: "a", subject: "_INBOX.x", headers: [["k", "1"], ["k", "2"]], data: utf8Encode('{"n":1}'), latencyMs: 1.234, at: new Date(0) }),
  );
  assert.deepEqual(ok.data, { n: 1 });
  assert.deepEqual(ok.headers, { k: ["1", "2"] });
  assert.equal(ok.latencyMs, 1.23);
  assert.equal(ok.status, "ok");
  const text = JSON.parse(formatReply({ requestSubject: "a", data: utf8Encode("pong"), latencyMs: 1 }));
  assert.equal(text.data, "pong");
  const bin = JSON.parse(formatReply({ requestSubject: "a", data: new Uint8Array([0, 255, 1]), latencyMs: 1 }));
  assert.equal(bin.encoding, "base64");
  const err = JSON.parse(formatReply({ requestSubject: "a", latencyMs: 2, error: "no responders" }));
  assert.equal(err.status, "error");
  assert.equal(err.error, "no responders");
});

test("@connection directive edit", () => {
  const replace = connectionDirectiveEdit("# hi\n@connection old\n### x\nPUB a\n", "new");
  assert.deepEqual(replace, { line: 1, replace: true, text: "@connection new" });
  const afterComments = connectionDirectiveEdit("# c1\n# c2\n\n### x\nPUB a\n", "dev");
  assert.equal(afterComments.line, 2);
  assert.equal(afterComments.replace, false);
  assert.equal(afterComments.text, "\n@connection dev\n");
  const top = connectionDirectiveEdit("### x\nPUB a\n", "dev");
  assert.deepEqual(top, { line: 0, replace: false, text: "@connection dev\n\n" });
  // Applying the insert keeps the file parseable with the new directive.
  const src = "# c1\n### x\nPUB a\nhi\n";
  const e = connectionDirectiveEdit(src, "dev");
  const lines = src.split("\n");
  const applied = [...lines.slice(0, e.line), e.text + lines[e.line], ...lines.slice(e.line + 1)].join("\n");
  const pb = parsePlaybook(applied);
  assert.equal(pb.connection, "dev");
  assert.equal(pb.blocks.length, 1);
  assert.equal(pb.blocks[0].body, "hi");
});

test("message description and file names", () => {
  const d = describeMessage(3, { subject: "a.b", reply: "r", headers: [["h", "v"]], data: utf8Encode('{"x":1}') });
  assert.match(d, /^#3 a\.b \(reply → r\) · 7 B/);
  assert.match(d, /    h: v/);
  assert.match(d, /"x": 1/);
  assert.equal(sanitizeFileName("/home/u/my playbook.nats"), "my_playbook");
  assert.equal(sanitizeFileName("Untitled-1"), "Untitled-1");
});
