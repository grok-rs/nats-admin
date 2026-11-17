// Operational commands: environments & protection, connection sources
// (contexts / hidden / save as managed), local server detection, nats CLI
// terminal and command copying, consumer pause / resume / reset.

import * as vscode from "vscode";
import type { Services } from "../services";
import { ConsumerNode, KvBucketNode, ObjBucketNode, StreamNode } from "../tree/explorer";
import { assertWritable, CancelledError, confirmDanger, pickConnection, pickFrom, required, safe } from "../core/ui";
import { ENVIRONMENTS, type ConnectionProfile, type Environment } from "../core/profile";
import { cliCommands, cliConnectionFlag, cliEnvironment, type CliTarget } from "../core/cli";
import { parseDuration } from "../shared/format";
import { profileIdOf } from "./connectionCommands";
import { uniqueName } from "../panels/connectionEditorPanel";
import { probeNats } from "../core/probe";

export function registerOpsCommands(s: Services): void {
  const reg = (id: string, fn: (...args: any[]) => unknown) => s.context.subscriptions.push(vscode.commands.registerCommand(id, safe(id.replace("nats.", ""), fn)));

  const profileFrom = async (arg: unknown, placeHolder: string): Promise<ConnectionProfile> => {
    const id = profileIdOf(arg);
    const p = id ? s.store.get(id) : undefined;
    if (p) return p;
    return pickFrom(s.store.list(), (x) => x.name, placeHolder, (x) => x.servers.join(", "));
  };

  // --- environments & protection -------------------------------------------------------

  reg("nats.setEnvironment", async (arg?: unknown) => {
    const p = await profileFrom(arg, "Set the environment of which connection?");
    const pick = required(
      await vscode.window.showQuickPick(
        [
          ...ENVIRONMENTS.map((e) => ({
            label: `$(circle-filled) ${e.label}`,
            description: e.id === "prod" ? "typed confirmation for destructive actions, red accents" : undefined,
            picked: p.environment === e.id,
            value: e.id as Environment | "none",
          })),
          { label: "$(circle-outline) None", description: undefined, picked: !p.environment, value: "none" as const },
        ],
        { title: `Environment of ${p.name}` },
      ),
    );
    await s.store.setOverlay(p.id, { environment: pick.value });
    if (pick.value === "prod" && !p.readOnly) {
      const ro = await vscode.window.showInformationMessage(`"${p.name}" is now marked as production. Make it read-only as well?`, "Make read-only");
      if (ro) await s.store.setOverlay(p.id, { readOnly: true });
    }
  });

  reg("nats.toggleReadOnly", async (arg?: unknown) => {
    const p = await profileFrom(arg, "Toggle read-only mode for which connection?");
    const next = !p.readOnly;
    if (!next && p.environment === "prod") {
      const ok = await vscode.window.showWarningMessage(`Allow changes on production connection "${p.name}"?`, { modal: true, detail: "Writes (publish, KV changes, stream/consumer updates, purges, acks) will be possible again." }, "Allow changes");
      if (!ok) return;
    }
    await s.store.setOverlay(p.id, { readOnly: next });
    vscode.window.setStatusBarMessage(`${p.name}: ${next ? "read-only — writes are blocked" : "writes allowed"}`, 4000);
  });

  reg("nats.toggleAutoConnect", async (arg?: unknown) => {
    const p = await profileFrom(arg, "Toggle auto-connect for which connection?");
    await s.store.setOverlay(p.id, { autoConnect: !p.autoConnect });
    vscode.window.setStatusBarMessage(`${p.name}: ${!p.autoConnect ? "connects automatically on startup" : "auto-connect off"}`, 4000);
  });

  // --- connection sources -----------------------------------------------------------------

  reg("nats.openContextFile", async (arg?: unknown) => {
    const p = await profileFrom(arg, "Open which context?");
    if (!p.contextFile) throw new Error(`"${p.name}" is not a NATS CLI context`);
    await vscode.window.showTextDocument(vscode.Uri.file(p.contextFile));
  });

  reg("nats.hideConnection", async (arg?: unknown) => {
    const p = await profileFrom(arg, "Hide which connection?");
    if (s.store.isManaged(p.id)) throw new Error("Saved connections can be removed instead of hidden");
    await s.manager.disconnect(p.id);
    await s.store.hide(p.id);
    void vscode.window.showInformationMessage(`"${p.name}" is hidden. Use "NATS: Show Hidden Connections…" to bring it back.`);
  });

  reg("nats.showHiddenConnections", async () => {
    const hidden = s.store.hiddenProfiles();
    if (!hidden.length) {
      void vscode.window.showInformationMessage("No hidden connections.");
      return;
    }
    const picks = await vscode.window.showQuickPick(
      hidden.map((h) => ({
        label: h.profile.name,
        description: h.reason === "shadowed" ? "shadowed by a saved connection with the same name" : h.profile.servers.join(", "),
        detail: h.profile.contextFile,
        id: h.profile.id,
        reason: h.reason,
      })),
      { canPickMany: true, placeHolder: "Select connections to show again" },
    );
    if (!picks?.length) return;
    await s.store.unhide(picks.filter((x) => x.reason === "hidden").map((x) => x.id));
    if (picks.some((x) => x.reason === "shadowed")) {
      void vscode.window.showInformationMessage("Shadowed contexts reappear when the saved connection with the same name is renamed or removed.");
    }
  });

  reg("nats.saveAsManaged", async (arg?: unknown) => {
    const p = await profileFrom(arg, "Save which connection in VS Code?");
    const { id: _id, origin: _origin, contextFile: _f, contextName: _n, ...rest } = p;
    const saved = await s.store.save({ ...rest, name: uniqueName(s, p.name) }, await s.store.getSecrets(p.id));
    void vscode.window.showInformationMessage(`Saved "${saved.name}" as a VS Code connection — edit it freely; the original ${p.origin === "nats-context" ? "context" : "entry"} is now shadowed.`);
  });

  reg("nats.connectLocal", async () => {
    const existing = s.store.list().find((p) => p.servers.some((x) => /^(nats:\/\/)?(127\.0\.0\.1|localhost):4222$/.test(x)));
    const id = existing?.id ?? (await s.store.save({ name: uniqueName(s, "localhost"), servers: ["nats://127.0.0.1:4222"], auth: { kind: "none" }, environment: "dev" })).id;
    await vscode.commands.executeCommand("nats.connect", id);
  });

  // --- nats CLI ------------------------------------------------------------------------------

  reg("nats.openTerminal", async (arg?: unknown) => {
    const p = await profileFrom(arg, "Open a nats CLI terminal for which connection?");
    const { env, notes } = cliEnvironment(p, await s.store.getSecrets(p.id));
    const term = vscode.window.createTerminal({
      name: `nats: ${p.name}`,
      env,
      iconPath: new vscode.ThemeIcon("terminal"),
      color: p.environment ? new vscode.ThemeColor(`terminal.ansi${p.environment === "prod" ? "Red" : p.environment === "staging" ? "Yellow" : p.environment === "test" ? "Blue" : "Green"}`) : undefined,
      message: `\x1b[1mnats CLI environment for "${p.name}"${p.environment === "prod" ? " \x1b[31m(PRODUCTION)" : ""}\x1b[0m — ${Object.keys(env).join(", ")} set. Try: nats server check connection · nats stream ls · nats kv ls`,
    });
    term.show();
    for (const n of notes) void vscode.window.showWarningMessage(n);
  });

  reg("nats.copyCliCommand", async (node?: unknown) => {
    let target: CliTarget;
    if (node instanceof StreamNode) target = { kind: "stream", stream: node.name };
    else if (node instanceof ConsumerNode) target = { kind: "consumer", stream: node.stream, consumer: node.name };
    else if (node instanceof KvBucketNode) target = { kind: "kv", bucket: node.name };
    else if (node instanceof ObjBucketNode) target = { kind: "obj", bucket: node.name };
    else throw new Error("Select a stream, consumer or bucket in the NATS explorer");
    const p = s.store.get((node as StreamNode).connId);
    const flag = p ? cliConnectionFlag(p) : "";
    const pick = required(
      await vscode.window.showQuickPick(
        cliCommands(target).map((c) => ({ label: c.label, description: c.command + flag, command: c.command + flag })),
        { placeHolder: "Copy which nats CLI command?", matchOnDescription: true },
      ),
    );
    await vscode.env.clipboard.writeText(pick.command);
    vscode.window.setStatusBarMessage(`Copied: ${pick.command}`, 4000);
  });

  // --- consumer operations ---------------------------------------------------------------------

  const consumerTarget = async (arg?: unknown) => {
    if (!(arg instanceof ConsumerNode)) throw new Error("Select a consumer in the NATS explorer");
    const lc = await pickConnection(s, arg.connId);
    return { lc, node: arg, jsm: await lc.jsm() };
  };

  reg("nats.pauseConsumer", async (arg?: unknown) => {
    const { lc, node, jsm } = await consumerTarget(arg);
    assertWritable(lc, "pausing a consumer");
    const input = required(
      await vscode.window.showInputBox({
        title: `Pause ${node.stream} › ${node.name}`,
        prompt: "Pause for how long (e.g. 30m, 2h, 1d) or until an ISO date/time. Requires nats-server 2.11+.",
        value: "1h",
        validateInput: (v) => (parseDuration(v) !== undefined || !Number.isNaN(Date.parse(v)) ? undefined : "Enter a duration (30m, 2h) or a date/time"),
      }),
    );
    const ms = parseDuration(input);
    const until = ms !== undefined ? new Date(Date.now() + ms) : new Date(input);
    const res = await jsm.consumers.pause(node.stream, node.name, until);
    void vscode.window.showInformationMessage(res.paused ? `${node.name} paused until ${new Date(res.pause_until ?? until).toLocaleString()}.` : `${node.name} was not paused (server may not support pausing).`);
    s.explorer.refreshFolder(lc.id, "streams");
  });

  reg("nats.resumeConsumer", async (arg?: unknown) => {
    const { lc, node, jsm } = await consumerTarget(arg);
    assertWritable(lc, "resuming a consumer");
    const res = await jsm.consumers.resume(node.stream, node.name);
    void vscode.window.showInformationMessage(res.paused ? `${node.name} is still paused.` : `${node.name} resumed.`);
    s.explorer.refreshFolder(lc.id, "streams");
  });

  reg("nats.resetConsumer", async (arg?: unknown) => {
    const { lc, node, jsm } = await consumerTarget(arg);
    const seqText = required(
      await vscode.window.showInputBox({
        title: `Reset ${node.stream} › ${node.name}`,
        prompt: "Stream sequence to redeliver from (empty = the consumer's deliver policy start). Requires a recent nats-server.",
        validateInput: (v) => (!v.trim() || /^\d+$/.test(v.trim()) ? undefined : "Enter a sequence number"),
      }),
    );
    if (!(await confirmDanger(`Reset consumer "${node.name}"?`, "Its delivery and acknowledgement state restarts; messages are redelivered.", "Reset", { lc, typeToConfirm: node.name }))) return;
    try {
      await jsm.consumers.reset(node.stream, node.name, seqText.trim() ? Number(seqText) : undefined);
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      throw new Error(`Reset failed (needs a nats-server version with consumer reset support): ${e instanceof Error ? e.message : String(e)}`);
    }
    void vscode.window.showInformationMessage(`${node.name} reset${seqText.trim() ? ` to sequence ${seqText.trim()}` : ""}.`);
    s.explorer.refreshFolder(lc.id, "streams");
  });
}

/** Sets the nats.localServerDetected context key when there are no profiles and localhost:4222 speaks NATS. */
export function registerLocalDetection(s: Services): void {
  const check = async () => {
    const show = s.store.list().length === 0 && (await probeNats());
    void vscode.commands.executeCommand("setContext", "nats.localServerDetected", show);
  };
  void s.store.ready.then(check);
  s.context.subscriptions.push(s.store.onDidChange(() => void check()));
}
