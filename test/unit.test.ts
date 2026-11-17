import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKeyTree, findNode, sortedChildren } from "../src/shared/keyTree";
import { decodeMsgpack, decodeProtobuf, detect, formatProtobuf, hexdump, render } from "../src/shared/payload";
import { renderTemplate, hasTemplate } from "../src/shared/template";
import { parsePlaybook, PLAYBOOK_SAMPLE } from "../src/shared/playbook";
import { fmtBytes, fmtNanos, parseDuration } from "../src/shared/format";
import { base64ToBytes, bytesToBase64, hexToBytes, utf8Encode } from "../src/shared/encoding";
import { contextToProfile } from "../src/core/natsContexts";
import { deriveMonitorUrl, extractSeed, type ConnectionProfile } from "../src/core/profile";

test("key tree groups keys by separator and counts", () => {
  const root = buildKeyTree(["app.db.host", "app.db.port", "app.db", "app.name", "flags"], ".");
  assert.equal(root.count, 5);
  const app = root.children.get("app")!;
  assert.equal(app.count, 4);
  assert.equal(app.isKey, false);
  const db = findNode(root, "app.db", ".")!;
  assert.equal(db.isKey, true, "app.db is both a key and a folder");
  assert.equal(db.children.size, 2);
  assert.deepEqual(
    sortedChildren(app).map((n) => n.name),
    ["db", "name"],
  );
  // folders before leaf keys at root
  assert.deepEqual(
    sortedChildren(root).map((n) => n.name),
    ["app", "flags"],
  );
  const flat = buildKeyTree(["a.b", "c"], "");
  assert.deepEqual([...flat.children.keys()], ["a.b", "c"]);
});

test("payload detection", () => {
  assert.equal(detect(utf8Encode('{"a":1}')).format, "json");
  assert.equal(detect(utf8Encode('{"a":1}')).kind, "object");
  assert.equal(detect(utf8Encode("[1,2]")).kind, "array");
  assert.equal(detect(utf8Encode("5432")).kind, "number");
  assert.equal(detect(utf8Encode("db.internal")).format, "text");
  assert.equal(detect(utf8Encode("hello world")).format, "text");
  assert.equal(detect(new Uint8Array([0, 1, 2, 255, 254])).format, "binary");
  assert.equal(detect(new Uint8Array()).format, "empty");
  assert.equal(detect(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0])).gzip, true);
});

test("hexdump layout", () => {
  const d = hexdump(utf8Encode("AB"));
  assert.ok(d.startsWith("00000000  41 42 "));
  assert.ok(d.endsWith("|AB|"));
});

test("msgpack decode", () => {
  // {"a":1,"b":[true,"x"]}
  const bytes = new Uint8Array([0x82, 0xa1, 0x61, 0x01, 0xa1, 0x62, 0x92, 0xc3, 0xa1, 0x78]);
  assert.deepEqual(decodeMsgpack(bytes), { a: 1, b: [true, "x"] });
  assert.match(render(bytes, "msgpack").text, /"b": \[/);
});

test("protobuf schema-less decode", () => {
  // field 1 varint 150, field 2 string "testing", field 3 nested {1: 1}
  const bytes = new Uint8Array([0x08, 0x96, 0x01, 0x12, 0x07, ...utf8Encode("testing"), 0x1a, 0x02, 0x08, 0x01]);
  const fields = decodeProtobuf(bytes);
  assert.equal(fields[0].value, 150);
  assert.equal(fields[1].value, "testing");
  assert.equal(fields[1].as, "string");
  assert.equal(fields[2].as, "message");
  assert.match(formatProtobuf(fields), /3 \(len\) \{/);
  assert.throws(() => decodeProtobuf(utf8Encode("{not proto")));
});

test("render modes", () => {
  assert.equal(render(utf8Encode('{"a":1}'), "auto").text, '{\n  "a": 1\n}');
  assert.throws(() => render(utf8Encode("x"), "json"));
  assert.equal(render(utf8Encode("hi"), "base64").text, "aGk=");
});

test("templates", () => {
  const out = renderTemplate("{{seq}}-{{uuid}}-{{random:5:5}}-{{unknown}}-{{randomString:4}}", { seq: 7 });
  const [seq, ...rest] = out.split("-");
  assert.equal(seq, "7");
  assert.match(out, /^7-[0-9a-f-]{36}-5-\{\{unknown\}\}-[A-Za-z0-9]{4}$/);
  assert.equal(rest.length > 0, true);
  assert.equal(renderTemplate("{{name}}", { seq: 1, vars: { name: "x" } }), "x");
  assert.equal(renderTemplate("{{date}}", { seq: 1, now: new Date("2026-01-02T03:04:05Z") }), "2026-01-02");
  assert.ok(hasTemplate("a {{uuid}}"));
  assert.ok(!hasTemplate("a {b}"));
});

test("playbook parsing", () => {
  const pb = parsePlaybook(PLAYBOOK_SAMPLE);
  assert.equal(pb.connection, "local");
  assert.equal(pb.blocks.length, 3);
  const [pub, req, sub] = pb.blocks;
  assert.equal(pub.verb, "PUB");
  assert.equal(pub.subject, "orders.eu.created");
  assert.equal(pub.options.count, "3");
  assert.deepEqual(pub.headers, [
    ["Nats-Msg-Id", "{{uuid}}"],
    ["Content-Type", "application/json"],
  ]);
  assert.match(pub.body, /^\{\n  "id": \{\{seq\}\}/);
  assert.equal(req.verb, "REQ");
  assert.equal(req.options.timeout, "2000");
  assert.equal(req.headers.length, 0);
  assert.equal(req.body, '{"tz": "UTC"}');
  assert.equal(sub.verb, "SUB");
  assert.equal(sub.body, "");

  const single = parsePlaybook("PUB a.b\nhello\nworld\n");
  assert.equal(single.blocks.length, 1);
  assert.equal(single.blocks[0].body, "hello\nworld");
  const bad = parsePlaybook("### x\nFOO bar\n");
  assert.equal(bad.errors.length, 1);
});

test("formatting", () => {
  assert.equal(fmtBytes(1536), "1.50 KiB");
  assert.equal(fmtBytes(0), "0 B");
  assert.equal(fmtNanos(0), "∞");
  assert.equal(fmtNanos(90 * 1e9), "1m30s");
  assert.equal(parseDuration("1h30m"), 5_400_000);
  assert.equal(parseDuration("45"), 45_000);
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("abc"), undefined);
});

test("encoding round trips", () => {
  const b = new Uint8Array([0, 1, 2, 250, 255]);
  assert.deepEqual(base64ToBytes(bytesToBase64(b)), b);
  assert.deepEqual(hexToBytes("00 01 02 fa ff"), b);
});

test("nats cli context import", () => {
  const { profile, secrets } = contextToProfile("prod", {
    url: "nats://a:4222,nats://b:4222",
    user: "admin",
    password: "pw",
    ca: "/etc/ca.pem",
    jetstream_domain: "hub",
  });
  assert.deepEqual(profile.servers, ["nats://a:4222", "nats://b:4222"]);
  assert.equal(profile.auth.kind, "userpass");
  assert.equal(secrets.password, "pw");
  assert.equal(profile.tls?.caFile, "/etc/ca.pem");
  assert.equal(profile.jsDomain, "hub");
  assert.equal(contextToProfile("c", { creds: "/x.creds" }).profile.auth.kind, "creds");
});

test("monitor url derivation and seed extraction", () => {
  const p = (servers: string[], monitorUrl?: string): ConnectionProfile => ({ id: "x", name: "x", servers, auth: { kind: "none" }, monitorUrl });
  assert.equal(deriveMonitorUrl(p(["nats://10.0.0.5:4222"])), "http://10.0.0.5:8222");
  assert.equal(deriveMonitorUrl(p(["tls://nats.example.com"])), "http://nats.example.com:8222");
  assert.equal(deriveMonitorUrl(p(["nats://h:4222"], "http://m:9000/")), "http://m:9000");
  assert.equal(deriveMonitorUrl(p(["wss://h:443"])), undefined);
  const seed = "SUAIBDPBAUTWCWBKIO6XHQNINK5FWJW4OHLXC3HQ2KFE4PEJUA44CNHTAM";
  assert.equal(extractSeed(`-----BEGIN USER NKEY SEED-----\n${seed}\n------END`), seed);
});
