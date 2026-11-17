// Keeps the explorer in sync with changes made elsewhere (CLI, apps, other
// users) by listening to JetStream lifecycle advisories, plus an optional
// periodic statistics refresh. Permission errors are ignored quietly.

import * as vscode from "vscode";
import type { Subscription } from "@nats-io/nats-core";
import type { Services } from "../services";
import { log } from "./log";

// Only lifecycle advisories — NOT $JS.EVENT.ADVISORY.API (our own API calls would trigger refresh loops).
const SUBJECTS = [
  "$JS.EVENT.ADVISORY.STREAM.CREATED.>",
  "$JS.EVENT.ADVISORY.STREAM.DELETED.>",
  "$JS.EVENT.ADVISORY.STREAM.UPDATED.>",
  "$JS.EVENT.ADVISORY.CONSUMER.CREATED.>",
  "$JS.EVENT.ADVISORY.CONSUMER.DELETED.>",
];

type Kind = "streams" | "kv" | "obj";

export function kindForStream(stream: string): Kind {
  return stream.startsWith("KV_") ? "kv" : stream.startsWith("OBJ_") ? "obj" : "streams";
}

export function registerAutoRefresh(s: Services): void {
  const subs = new Map<string, Subscription[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let statsTimer: ReturnType<typeof setInterval> | undefined;

  const schedule = (connId: string, kind: Kind) => {
    const key = `${connId}:${kind}`;
    if (timers.has(key)) return;
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        s.explorer.refreshFolder(connId, kind);
      }, 500),
    );
  };

  const stop = (connId: string) => {
    for (const sub of subs.get(connId) ?? []) {
      try {
        sub.unsubscribe();
      } catch {
        /* closed */
      }
    }
    subs.delete(connId);
  };

  const start = (connId: string) => {
    stop(connId);
    if (!vscode.workspace.getConfiguration("nats").get<boolean>("explorer.autoRefresh", true)) return;
    const lc = s.manager.get(connId);
    if (!lc || !lc.info?.jetstream) return;
    const list: Subscription[] = [];
    for (const subject of SUBJECTS) {
      try {
        const sub = lc.nc.subscribe(subject, {
          callback: (err, msg) => {
            if (err) return; // permission violation etc. — ignore
            const tokens = msg.subject.split(".");
            // $JS.EVENT.ADVISORY.<STREAM|CONSUMER>.<ACTION>.<stream>[.<consumer>]
            const stream = tokens[5];
            if (!stream) return;
            schedule(connId, tokens[3] === "CONSUMER" ? "streams" : kindForStream(stream));
          },
        });
        void sub.closed.then(undefined, () => undefined);
        list.push(sub);
      } catch (e) {
        log.debug(`advisory subscription ${subject} failed: ${String(e)}`);
      }
    }
    subs.set(connId, list);
  };

  const restartStats = () => {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = undefined;
    const secs = vscode.workspace.getConfiguration("nats").get<number>("explorer.statsRefreshInterval", 0);
    if (secs > 0) {
      statsTimer = setInterval(() => {
        for (const lc of s.manager.connected()) {
          s.explorer.refreshFolder(lc.id, "streams");
          s.explorer.refreshFolder(lc.id, "kv");
        }
      }, Math.max(5, secs) * 1000);
    }
  };

  s.context.subscriptions.push(
    s.manager.onDidChangeState((e) => {
      if (e.state === "connected") start(e.profileId);
      else if (e.state === "disconnected" || e.state === "error") stop(e.profileId);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("nats.explorer.autoRefresh")) for (const lc of s.manager.connected()) start(lc.id);
      if (e.affectsConfiguration("nats.explorer.statsRefreshInterval")) restartStats();
    }),
    {
      dispose: () => {
        for (const id of [...subs.keys()]) stop(id);
        timers.forEach((t) => clearTimeout(t));
        if (statsTimer) clearInterval(statsTimer);
      },
    },
  );
  restartStats();
}
