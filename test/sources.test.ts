import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { cliContextProfile, cliContextSecrets, discoverCliContexts, environmentProfile, selectedCliContext, stableId, workspaceProfiles } from "../src/core/sources";
import { decodeJwt, expiryStatus, jwtFromCreds } from "../src/core/creds";
import { cliCommands, cliConnectionFlag, cliEnvironment, shellQuote } from "../src/core/cli";
import { guessEnvironment, type ConnectionProfile } from "../src/core/profile";
import { probeNats } from "../src/core/probe";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

test("CLI context → profile (mTLS + creds + inbox prefix, like a real context)", () => {
  const p = cliContextProfile("dev01-audit", "/x/dev01-audit.json", {
    description: "dev-01 NATS",
    url: "tls://localhost:4223",
    creds: "/k/audit.creds",
    ca: "/c/ca.pem",
    cert: "/c/cert.pem",
    key: "/c/key.pem",
    inbox_prefix: "_INBOX_audit",
  });
  assert.equal(p.origin, "nats-context");
  assert.equal(p.contextName, "dev01-audit");
  assert.equal(p.auth.kind, "creds");
  assert.deepEqual(p.servers, ["tls://localhost:4223"]);
  assert.equal(p.tls?.enabled, true);
  assert.equal(p.tls?.certFile, "/c/cert.pem");
  assert.equal(p.inboxPrefix, "_INBOX_audit");
  assert.equal(p.environment, "dev");
  assert.equal(p.id, stableId("ctx", "dev01-audit"));
  assert.match(p.id, /^ctx-dev01-audit-[0-9a-f]{6}$/);
  const jwtCtx = cliContextProfile("j", "/j.json", { nkey: "/n.nk", user_jwt: "eyJ.x.y" });
  assert.equal(jwtCtx.auth.kind, "nkey");
  assert.equal(jwtCtx.auth.userJwt, "eyJ.x.y");
  assert.deepEqual(cliContextSecrets({ user: "a", password: "pw" }), { password: "pw", token: undefined });
});

test("discover contexts and the selected one from disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "nats-ctx-"));
  const dir = join(root, "context");
  mkdirSync(dir);
  writeFileSync(join(dir, "prod-eu.json"), JSON.stringify({ url: "nats://prod:4222", user: "ops", password: "x" }));
  writeFileSync(join(dir, "nsc.json"), JSON.stringify({ nsc: "nsc://op/acc/user" }));
  writeFileSync(join(dir, "broken.json"), "{not json");
  writeFileSync(join(root, "context.txt"), "prod-eu\n");
  try {
    const found = await discoverCliContexts(dir);
    assert.deepEqual(
      found.map((f) => f.profile.name),
      ["nsc", "prod-eu"],
    );
    assert.equal(found.find((f) => f.profile.name === "prod-eu")!.profile.environment, "prod");
    assert.match(found.find((f) => f.profile.name === "nsc")!.warning!, /nsc/);
    assert.equal(await selectedCliContext(dir, {}), "prod-eu");
    assert.equal(await selectedCliContext(dir, { NATS_CONTEXT: "other" }), "other");
    assert.deepEqual(await discoverCliContexts(join(root, "missing")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace and environment connections", () => {
  const ws = workspaceProfiles([{ name: "Team Prod", servers: "nats://a:4222,nats://b:4222", auth: { kind: "userpass", username: "svc" }, readOnly: true }, { bad: true }, { name: "" }]);
  assert.equal(ws.length, 1);
  assert.equal(ws[0].origin, "workspace");
  assert.equal(ws[0].environment, "prod");
  assert.equal(ws[0].readOnly, true);
  assert.deepEqual(ws[0].servers, ["nats://a:4222", "nats://b:4222"]);
  assert.equal(environmentProfile({}), undefined);
  const env = environmentProfile({ NATS_URL: "nats://h:4222", NATS_USER: "u", NATS_PASSWORD: "p", NATS_CA: "/ca" })!;
  assert.equal(env.profile.auth.kind, "userpass");
  assert.equal(env.secrets.password, "p");
  assert.equal(env.profile.tls?.caFile, "/ca");
  assert.equal(environmentProfile({ NATS_URL: "x", NATS_USER: "tok" })!.profile.auth.kind, "token");
  assert.equal(environmentProfile({ NATS_URL: "x", NATS_CREDS: "/c" })!.profile.auth.credsFile, "/c");
});

test("environment guessing", () => {
  assert.equal(guessEnvironment("prod-eu"), "prod");
  assert.equal(guessEnvironment("Production cluster"), "prod");
  assert.equal(guessEnvironment("staging"), "staging");
  assert.equal(guessEnvironment("uat-1"), "staging");
  assert.equal(guessEnvironment("qa"), "test");
  assert.equal(guessEnvironment("local"), "dev");
  assert.equal(guessEnvironment("nats://localhost:4222"), "dev");
  assert.equal(guessEnvironment("products-service"), undefined, "'products' must not match prod");
  assert.equal(guessEnvironment("billing"), undefined);
});

test("creds JWT decoding and expiry", () => {
  const exp = Math.floor(Date.now() / 1000) + 3 * 86400;
  const jwt = `${b64url({ typ: "JWT", alg: "ed25519-nkey" })}.${b64url({ name: "audit", sub: "UABC", iss: "AACC", exp, nats: { issuer_account: "AXYZ" } })}.sig`;
  const creds = `-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\nSUAAA\n------END USER NKEY SEED------\n`;
  assert.equal(jwtFromCreds(creds), jwt);
  const info = decodeJwt(jwt)!;
  assert.equal(info.name, "audit");
  assert.equal(info.account, "AXYZ");
  assert.equal(info.expires!.getTime(), exp * 1000);
  assert.equal(expiryStatus(info.expires)!.level, "soon");
  assert.equal(expiryStatus(new Date(Date.now() - 1000))!.level, "expired");
  assert.equal(expiryStatus(new Date(Date.now() + 30 * 86400_000)), undefined);
  assert.equal(expiryStatus(undefined), undefined);
  assert.equal(decodeJwt("garbage"), undefined);
});

test("nats CLI environment and commands", () => {
  const ctx = { id: "c", name: "dev01", servers: ["tls://x"], auth: { kind: "creds", credsFile: "/c" }, origin: "nats-context", contextName: "dev01" } as ConnectionProfile;
  assert.deepEqual(cliEnvironment(ctx, {}).env, { NATS_CONTEXT: "dev01" });
  assert.equal(cliConnectionFlag(ctx), " --context dev01");
  const manual = { id: "m", name: "m", servers: ["nats://a:4222", "nats://b:4222"], auth: { kind: "userpass", username: "u" }, tls: { enabled: true, caFile: "/ca" }, inboxPrefix: "_I" } as ConnectionProfile;
  const { env } = cliEnvironment(manual, { password: "pw" });
  assert.deepEqual(env, { NATS_URL: "nats://a:4222,nats://b:4222", NATS_USER: "u", NATS_PASSWORD: "pw", NATS_CA: "/ca", NATS_INBOX_PREFIX: "_I" });
  const seedOnly = cliEnvironment({ ...manual, auth: { kind: "nkey" }, tls: undefined, inboxPrefix: undefined }, { nkeySeed: "SU" });
  assert.equal(seedOnly.notes.length, 1);
  assert.equal(shellQuote("a b'c"), `'a b'\\''c'`);
  assert.equal(shellQuote("ORDERS"), "ORDERS");
  assert.ok(cliCommands({ kind: "stream", stream: "ORDERS" }).some((c) => c.command === "nats stream info ORDERS"));
  assert.ok(cliCommands({ kind: "consumer", stream: "S", consumer: "c" })[0].command.endsWith("S c"));
});

test("local server probe reads the INFO greeting", async () => {
  const fake = createServer((sock) => sock.end('INFO {"server_id":"x"}\r\n'));
  const other = createServer((sock) => sock.end("HTTP/1.1 400\r\n"));
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
  try {
    assert.equal(await probeNats("127.0.0.1", (fake.address() as { port: number }).port), true);
    assert.equal(await probeNats("127.0.0.1", (other.address() as { port: number }).port), false);
    assert.equal(await probeNats("127.0.0.1", 1, 300), false);
  } finally {
    fake.close();
    other.close();
  }
});
