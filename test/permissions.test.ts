// Regression: restricted (read-only / audit) users without publish permission
// on $JS.FC.> must be able to read KV buckets without permission violations.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { jetstream } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { history, listKeys, snapshotAndWatch } from "../src/nats/kv";

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

describe("restricted user without $JS.FC permission", { skip: !hasServer && "nats-server not installed" }, () => {
  let server: ChildProcess;
  let dir: string;
  let url: string;
  let admin: NatsConnection;
  let audit: NatsConnection;
  const violations: string[] = [];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "nats-admin-perm-"));
    const port = await freePort();
    url = `nats://127.0.0.1:${port}`;
    writeFileSync(
      join(dir, "server.conf"),
      `listen: 127.0.0.1:${port}
jetstream { store_dir: "${join(dir, "js")}" }
accounts {
  APP {
    jetstream: enabled
    users: [
      { user: admin, password: admin }
      { user: audit, password: audit, permissions: {
          publish: { allow: ["$JS.API.>"], deny: ["$JS.FC.>"] }
          subscribe: { allow: ["_INBOX_audit.>"] }
      } }
    ]
  }
}
`,
    );
    server = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
    for (let i = 0; i < 50 && !admin; i++) {
      try {
        admin = await connect({ servers: url, user: "admin", pass: "admin", timeout: 500 });
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const kv = await new Kvm(jetstream(admin)).create("games", { history: 5 });
    for (let i = 0; i < 300; i++) await kv.put(`game.${i % 10}.state`, JSON.stringify({ i, payload: "x".repeat(200) }));
    await kv.put("game.0.state", '{"final":true}');
    audit = await connect({ servers: url, user: "audit", pass: "audit", inboxPrefix: "_INBOX_audit" });
    void (async () => {
      for await (const s of audit.status()) {
        if (s.type === "error") violations.push(String((s as { error?: unknown }).error));
      }
    })();
  });

  after(async () => {
    await audit?.close();
    await admin?.close();
    server?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  test("keys, snapshot and history load with zero permission violations", async () => {
    const kv = await new Kvm(jetstream(audit)).open("games");
    const { keys } = await listKeys(kv, undefined, 100);
    assert.equal(keys.length, 10);
    const snap = await new Promise<number>((resolve) => {
      void snapshotAndWatch(kv, { max: 100, maxValueBytes: 1024, live: false, onInitial: (e) => resolve(e.length) });
    });
    assert.equal(snap, 10);
    const h = await history(kv, "game.0.state");
    assert.equal(h.length, 5);
    assert.equal(new TextDecoder().decode(h[0].value), '{"final":true}');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(violations, [], "no permission violations reported to the client");
  });

  test("the client's push-based watcher reproduces the $JS.FC violation on larger buckets (root cause)", async () => {
    const big = await new Kvm(jetstream(admin)).create("big", { history: 1 });
    const blob = "y".repeat(64 * 1024);
    for (let i = 0; i < 64; i++) await big.put(`k.${i}`, blob);
    const kv = await new Kvm(jetstream(audit)).open("big");
    const it = await kv.watch();
    let failure = "";
    const done = (async () => {
      let n = 0;
      try {
        for await (const _e of it) if (++n >= 64) break;
      } catch (e) {
        failure = String(e);
      }
    })();
    await Promise.race([done, new Promise((r) => setTimeout(r, 4000))]);
    it.stop();
    assert.match(failure, /Permissions Violation for Publish to "\$JS\.FC\.KV_big/, "push watcher dies on the flow-control reply");
    // …while the extension's pull-based reader loads the same bucket cleanly:
    const mark = violations.length;
    const n = await new Promise<number>((resolve) => {
      void snapshotAndWatch(kv, { max: 100, maxValueBytes: 1024, live: false, onInitial: (e) => resolve(e.length) });
    });
    assert.equal(n, 64);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(violations.slice(mark), []);
  });
});
