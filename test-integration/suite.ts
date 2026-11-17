// Runs inside the VS Code extension host (see runTests.ts). Exercises the real
// extension: activation, connection, explorer tree, KV / config file systems,
// info documents, commands and webview panels against a live nats-server.

import * as vscode from "vscode";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { AckPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { Objm } from "@nats-io/obj";
import { Svcm } from "@nats-io/services";
import type { ExtensionApi } from "../src/extension";
import type { NatsNode } from "../src/tree/explorer";

const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last}` : ""}`);
}

const label = (n: NatsNode) => {
  const l = n.getTreeItem().label;
  return typeof l === "string" ? l : (l?.label ?? "");
};

async function child(parent: NatsNode, name: string): Promise<NatsNode> {
  const kids = await parent.getChildren();
  const found = kids.find((k) => label(k) === name);
  assert.ok(found, `expected child "${name}" under "${label(parent)}", got [${kids.map(label).join(", ")}]`);
  return found;
}

function openWebviewTypes(): string[] {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs).flatMap((t) => (t.input instanceof vscode.TabInputWebview ? [t.input.viewType] : []));
}

export async function run(): Promise<void> {
  const url = process.env.NATS_IT_URL!;
  const monitorUrl = process.env.NATS_IT_MONITOR!;
  const ext = vscode.extensions.getExtension("grok-rs.nats-admin");
  assert.ok(ext, "extension is installed in the dev host");
  const api = (await ext.activate()) as ExtensionApi;
  await vscode.workspace.getConfiguration("nats").update("confirmDestructiveActions", false, vscode.ConfigurationTarget.Global);

  // --- seed the server -------------------------------------------------------
  const nc: NatsConnection = await connect({ servers: url });
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);
  await jsm.streams.add({ name: "ORDERS", subjects: ["orders.>"] });
  for (let i = 1; i <= 20; i++) await js.publish(`orders.${i % 2 ? "eu" : "us"}.created`, enc.encode(JSON.stringify({ id: i })));
  await jsm.consumers.add("ORDERS", { durable_name: "billing", ack_policy: AckPolicy.Explicit });
  const kv = await new Kvm(js).create("config", { history: 5 });
  await kv.put("app.features", '{"darkMode":true,"limits":{"rps":100}}');
  await kv.put("app.db.host", "db.internal");
  await kv.put("app.db", '{"pool":{"min":2}}');
  await kv.put("flags", "[1,2,3]");
  const os = await new Objm(js).create("files");
  await os.putBlob({ name: "docs/hello.txt" }, enc.encode("hello object store"));
  const svc = await new Svcm(nc).add({ name: "calc", version: "1.0.0" });
  svc.addEndpoint("add", { subject: "calc.add", handler: (_e, m) => m.respond("3") });

  const results: { name: string; ok: boolean; error?: string; ms: number }[] = [];
  const test = async (name: string, fn: () => Promise<void>) => {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ name, ok: true, ms: Date.now() - t0 });
    } catch (e) {
      results.push({ name, ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e), ms: Date.now() - t0 });
    }
  };

  let profileId = "";
  let conn: NatsNode | undefined;

  await test("add a profile and connect via command", async () => {
    const p = await api.store.save({ name: "it-local", servers: [url], auth: { kind: "none" }, monitorUrl });
    profileId = p.id;
    await vscode.commands.executeCommand("nats.connect", profileId);
    assert.ok(api.manager.get(profileId), "connection is live");
    assert.equal(api.manager.stateOf(profileId).state, "connected");
  });

  await test("explorer shows server, streams, consumers, KV key hierarchy, objects and services", async () => {
    const roots = await api.explorer.getChildren();
    conn = roots.find((r) => label(r) === "it-local");
    assert.ok(conn, "connection node");
    assert.equal(conn.getTreeItem().contextValue, "connection.connected.manual");
    const top = (await conn.getChildren()).map(label);
    assert.deepEqual(top, ["Server", "Streams", "Key-Value", "Object Store", "Services"]);

    const orders = await child(await child(conn, "Streams"), "ORDERS");
    assert.match(String(orders.getTreeItem().description), /20 msgs/);
    await child(orders, "billing");

    const bucket = await child(await child(conn, "Key-Value"), "config");
    const app = await child(bucket, "app");
    assert.equal(app.getTreeItem().contextValue, "kvFolder");
    const db = await child(app, "db");
    assert.equal(db.getTreeItem().contextValue, "kvKeyFolder", "app.db is both a key and a folder");
    await child(db, "host");
    await child(app, "features");
    await child(bucket, "flags");

    await child(await child(await child(conn, "Object Store"), "files"), "docs/hello.txt");
    const calc = await child(await child(conn, "Services"), "calc");
    await child(calc, "add");
  });

  await test("KV value opens pretty-printed as JSON", async () => {
    const uri = vscode.Uri.parse(`nats-kv://${profileId}/config/app.features`);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    assert.equal(doc.getText(), JSON.stringify({ darkMode: true, limits: { rps: 100 } }, null, 2) + "\n");
    await until(() => vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())?.languageId === "json", "JSON language mode");
  });

  await test("saving a KV document writes compact JSON back to the bucket", async () => {
    const uri = vscode.Uri.parse(`nats-kv://${profileId}/config/app.features`);
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), JSON.stringify({ darkMode: false, limits: { rps: 250 } }, null, 2) + "\n");
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(await doc.save(), "document saved");
    const e = await kv.get("app.features");
    assert.equal(dec.decode(e!.value), '{"darkMode":false,"limits":{"rps":250}}');
  });

  await test("open KV editor live-reloads when the value changes on the server", async () => {
    const uri = vscode.Uri.parse(`nats-kv://${profileId}/config/app.features`);
    await sleep(300);
    await kv.put("app.features", '{"darkMode":true,"remote":1}');
    await until(() => vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())?.getText().includes('"remote": 1'), "editor reload after remote change", 8000);
  });

  await test("plain-text KV values round-trip unchanged", async () => {
    const uri = vscode.Uri.parse(`nats-kv://${profileId}/config/app.db.host`);
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.equal(doc.getText(), "db.internal");
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), "db2.internal");
    await vscode.workspace.applyEdit(edit);
    assert.ok(await doc.save());
    assert.equal(dec.decode((await kv.get("app.db.host"))!.value), "db2.internal");
  });

  await test("info documents render stream, consumer, KV and server JSON", async () => {
    const stream = JSON.parse((await vscode.workspace.openTextDocument(vscode.Uri.parse(`nats-info://${profileId}/stream/ORDERS.json`))).getText());
    assert.equal(stream.config.name, "ORDERS");
    assert.equal(stream.state.messages, 20);
    const consumer = JSON.parse((await vscode.workspace.openTextDocument(vscode.Uri.parse(`nats-info://${profileId}/consumer/ORDERS/billing.json`))).getText());
    assert.equal(consumer.name, "billing");
    const status = JSON.parse((await vscode.workspace.openTextDocument(vscode.Uri.parse(`nats-info://${profileId}/kv/config.json`))).getText());
    assert.equal(status.bucket, "config");
    assert.equal(status.history, 5);
    const obj = JSON.parse((await vscode.workspace.openTextDocument(vscode.Uri.parse(`nats-info://${profileId}/obj/files.json`))).getText());
    assert.equal(obj.bucket, "files");
    const objInfo = JSON.parse((await vscode.workspace.openTextDocument(vscode.Uri.parse(`nats-info://${profileId}/object-info/files/docs/hello.txt.json`))).getText());
    assert.equal(objInfo.size, 18);
    const objText = (await vscode.workspace.openTextDocument(vscode.Uri.parse(`nats-info://${profileId}/object/files/docs/hello.txt`))).getText();
    assert.equal(objText, "hello object store");
    const server = JSON.parse((await vscode.workspace.openTextDocument(vscode.Uri.parse(`nats-info://${profileId}/server.json`))).getText());
    assert.ok(server.server.server_name);
    assert.equal(typeof server.jetstream.streams, "number");
    const rev = (await kv.history({ key: "app.features" })) as AsyncIterable<{ revision: number }>;
    let first = 0;
    for await (const r of rev) {
      first = r.revision;
      break;
    }
    const old = (await vscode.workspace.openTextDocument(vscode.Uri.parse(`nats-info://${profileId}/kv-rev/config/${first}/app.features`))).getText();
    assert.match(old, /"rps": 100/);
  });

  await test("editing the stream config JSON applies it on the server", async () => {
    const uri = vscode.Uri.parse(`nats-config://${profileId}/stream/ORDERS.json`);
    const doc = await vscode.workspace.openTextDocument(uri);
    const cfg = JSON.parse(doc.getText());
    cfg.max_msgs = 1000;
    cfg.description = "edited from VS Code";
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), JSON.stringify(cfg, null, 2));
    await vscode.workspace.applyEdit(edit);
    assert.ok(await doc.save());
    const si = await jsm.streams.info("ORDERS");
    assert.equal(si.config.max_msgs, 1000);
    assert.equal(si.config.description, "edited from VS Code");
  });

  await test("panel commands open their webviews without errors", async () => {
    assert.ok(conn);
    const before = api.testing.reportedErrors.length;
    const orders = await child(await child(conn, "Streams"), "ORDERS");
    const billing = await child(orders, "billing");
    const bucket = await child(await child(conn, "Key-Value"), "config");
    const endpoint = await child(await child(await child(conn, "Services"), "calc"), "add");
    const steps: [string, unknown, string][] = [
      ["nats.browseMessages", orders, "nats.messageBrowser"],
      ["nats.openConsumerLab", billing, "nats.consumerLab"],
      ["nats.openKvBrowser", bucket, "nats.kvBrowser"],
      ["nats.openDashboard", conn, "nats.dashboard"],
      ["nats.publish", conn, "nats.publisher"],
      ["nats.deadLetters", conn, "nats.deadLetters"],
      ["nats.subscribe", endpoint, "nats.liveTail"],
      ["nats.editConnection", conn, "nats.connectionEditor"],
      ["nats.openStreamDashboard", orders, "nats.streamDashboard"],
      ["nats.openTopology", conn, "nats.topology"],
      ["nats.openCluster", conn, "nats.cluster"],
      ["nats.openHealthDashboard", conn, "nats.healthDashboard"],
      ["nats.openHome", undefined, "nats.home"],
    ];
    for (const [cmd, arg, viewType] of steps) {
      await vscode.commands.executeCommand(cmd, arg);
      await until(() => openWebviewTypes().some((t) => t.endsWith(viewType)), `${viewType} panel from ${cmd}`);
    }
    assert.deepEqual(api.testing.reportedErrors.slice(before), [], "no errors reported to the user");
    await sleep(2500); // let webviews boot and issue their first RPCs
    assert.deepEqual(api.testing.reportedErrors.slice(before), [], "no errors after webviews loaded");
    const log = api.testing.rpcLog;
    console.log(`  webview RPCs:\n    ${[...new Set(log)].join("\n    ")}`);
    const failedRpcs = log.filter((l) => l.includes(" error: "));
    assert.deepEqual(failedRpcs, [], "no failing webview RPCs");
    // Panels that call the host on load prove their scripts run under the real CSP.
    for (const vt of ["nats.messageBrowser", "nats.consumerLab", "nats.kvBrowser", "nats.dashboard", "nats.connectionEditor", "nats.streamDashboard", "nats.topology", "nats.cluster", "nats.home"]) {
      assert.ok(log.some((l) => l.startsWith(`${vt} `) && l.endsWith(" ok")), `${vt} webview made a successful RPC`);
    }
  });

  await test("health check reports best-practice findings (exported Markdown report)", async () => {
    await jsm.streams.add({ name: "UNBOUNDED", subjects: ["unbounded.>"] });
    await vscode.commands.executeCommand("nats.runHealthCheck", profileId);
    await vscode.commands.executeCommand("nats.exportHealthReport", profileId);
    const text = await until(() => {
      const doc = vscode.window.activeTextEditor?.document;
      return doc && doc.languageId === "markdown" && doc.isUntitled ? doc.getText() : undefined;
    }, "health report document");
    assert.ok(text);
    assert.match(text, /UNBOUNDED/, "report mentions the unbounded stream");
    assert.match(text, /score/i);
  });

  await test("Overview sidebar view resolves", async () => {
    await vscode.commands.executeCommand("nats.overview.focus");
    await until(() => api.testing.rpcLog.some((l) => /^nats\.overview /.test(l) || /overview/.test(l)), "overview webview RPC", 8000);
  });

  await test("delete key command", async () => {
    assert.ok(conn);
    const bucket = await child(await child(conn, "Key-Value"), "config");
    const flags = await child(bucket, "flags");
    await vscode.commands.executeCommand("nats.kvDeleteKey", flags);
    const e = await kv.get("flags");
    assert.equal(e?.operation, "DEL");
    assert.deepEqual(api.testing.reportedErrors.filter((x) => /kvDeleteKey/.test(x)), []);
  });

  const ctxRoot = mkdtempSync(join(tmpdir(), "nats-it-ctx-"));
  let ctxId = "";

  await test("NATS CLI contexts appear automatically and stay in sync with the files", async () => {
    mkdirSync(join(ctxRoot, "context"));
    writeFileSync(join(ctxRoot, "context", "it-prod.json"), JSON.stringify({ url, description: "integration production" }));
    writeFileSync(join(ctxRoot, "context.txt"), "it-prod\n");
    await vscode.workspace.getConfiguration("nats").update("contexts.directory", join(ctxRoot, "context"), vscode.ConfigurationTarget.Global);
    const p = (await until(() => api.store.list().find((x) => x.name === "it-prod"), "context profile to be discovered"))!;
    ctxId = p.id;
    assert.equal(p.origin, "nats-context");
    assert.equal(p.environment, "prod", "environment guessed from the context name");
    assert.ok(api.store.isSelectedContext(p), "context.txt selection honoured");
    // A new context file shows up without any command (file watcher).
    writeFileSync(join(ctxRoot, "context", "it-second.json"), JSON.stringify({ url }));
    await until(() => api.store.list().some((x) => x.name === "it-second"), "second context via file watcher", 8000);
  });

  await test("context connection is labelled production in the tree", async () => {
    await vscode.commands.executeCommand("nats.connect", ctxId);
    assert.ok(api.manager.get(ctxId));
    const node = (await api.explorer.getChildren()).find((r) => label(r) === "it-prod")!;
    const ti = node.getTreeItem();
    assert.match(String(ti.contextValue), /^connection\.connected\.ctx.*\.prod$/);
    assert.match(String(ti.description), /★ \[PROD · ctx\]/);
  });

  await test("read-only mode blocks writes from commands and editors", async () => {
    await api.store.setOverlay(ctxId, { readOnly: true });
    assert.equal(api.manager.get(ctxId)!.profile.readOnly, true, "live connection sees the new profile");
    const node = (await api.explorer.getChildren()).find((r) => label(r) === "it-prod")!;
    const features = await child(await child(await child(await child(node, "Key-Value"), "config"), "app"), "features");
    const before = api.testing.reportedErrors.length;
    await vscode.commands.executeCommand("nats.kvDeleteKey", features);
    assert.match(api.testing.reportedErrors.slice(before).join("\n"), /read-only/);
    assert.equal((await kv.get("app.features"))?.operation, "PUT", "key untouched");
    const stat = await vscode.workspace.fs.stat(vscode.Uri.parse(`nats-kv://${ctxId}/config/app.features`));
    assert.equal(stat.permissions, vscode.FilePermission.Readonly, "KV editor opens read-only");
    await api.store.setOverlay(ctxId, { readOnly: false });
  });

  await test("NATS_URL from the environment is offered as a connection", async () => {
    const env = api.store.list().find((x) => x.origin === "env");
    assert.ok(env, "env profile present");
    assert.deepEqual(env.servers, [url]);
  });

  await test("explorer refreshes itself from JetStream advisories", async () => {
    assert.ok(conn);
    await vscode.commands.executeCommand("nats.connect", profileId);
    const roots = await api.explorer.getChildren();
    const live = roots.find((r) => label(r) === "it-local")!;
    const streams = await child(live, "Streams");
    assert.ok(!(await streams.getChildren()).some((n) => label(n) === "LATE"));
    await jsm.streams.add({ name: "LATE", subjects: ["late.>"] });
    await until(
      async () => {
        const c = (await api.explorer.getChildren()).find((r) => label(r) === "it-local")!;
        return (await (await child(c, "Streams")).getChildren()).some((n) => label(n) === "LATE");
      },
      "LATE stream to appear without a manual refresh",
      6000,
    );
  });

  await test("disconnect closes the connection", async () => {
    await vscode.commands.executeCommand("nats.disconnect", profileId);
    assert.equal(api.manager.get(profileId), undefined);
    assert.equal(api.manager.stateOf(profileId).state, "disconnected");
  });

  await svc.stop();
  await nc.close();
  rmSync(ctxRoot, { recursive: true, force: true });

  const pad = Math.max(...results.map((r) => r.name.length));
  console.log("\n[nats-admin integration]");
  for (const r of results) {
    console.log(`  ${r.ok ? "✔" : "✖"} ${r.name.padEnd(pad)} ${r.ms}ms`);
    if (!r.ok) console.log(`      ${r.error?.split("\n").join("\n      ")}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`  ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) throw new Error(`${failed.length} integration test(s) failed`);
}
