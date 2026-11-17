// Launches VS Code with the extension under development and runs suite.ts in
// the extension host. A throwaway nats-server (JetStream + monitoring) is
// started for the run. Uses the locally installed VS Code when found, or
// VSCODE_EXECUTABLE; otherwise @vscode/test-electron downloads one.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

async function main(): Promise<void> {
  if (spawnSync("nats-server", ["--version"]).status !== 0) {
    console.error("nats-server is required on PATH for integration tests");
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), "nats-admin-it-"));
  const port = await freePort();
  const mport = await freePort();
  const server = spawn("nats-server", ["-js", "-sd", join(dir, "js"), "-p", String(port), "-m", String(mport), "-a", "127.0.0.1"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 600));
  const root = resolve(__dirname, "../..");
  const candidates = [process.env.VSCODE_EXECUTABLE, "/usr/share/code/code", "/usr/share/code-insiders/code-insiders"].filter(Boolean) as string[];
  const vscodeExecutablePath = candidates.find((c) => existsSync(c));
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: resolve(__dirname, "suite.js"),
      launchArgs: ["--disable-extensions", "--user-data-dir", join(dir, "user"), "--extensions-dir", join(dir, "ext"), "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust"],
      extensionTestsEnv: { NATS_IT_URL: `nats://127.0.0.1:${port}`, NATS_IT_MONITOR: `http://127.0.0.1:${mport}`, NATS_URL: `nats://127.0.0.1:${port}` },
    });
  } finally {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("Integration tests failed:", e);
  process.exit(1);
});
