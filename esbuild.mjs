// Build script: bundles the extension host code (Node/CJS) and every webview
// entry point (browser/IIFE). `--watch` rebuilds on change, `--production`
// minifies, `--tests` bundles the unit/integration tests into out/test.
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readdirSync } from "node:fs";

const args = new Set(process.argv.slice(2));
const production = args.has("--production");
const watch = args.has("--watch");
const tests = args.has("--tests");
const integration = args.has("--integration");

const common = {
  bundle: true,
  sourcemap: production ? false : "linked",
  minify: production,
  logLevel: "info",
  legalComments: "none",
};

const webviewEntries = readdirSync("webview")
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => `webview/${f}`);

/** @type {esbuild.BuildOptions[]} */
const builds = integration
  ? [
      {
        ...common,
        sourcemap: "inline",
        entryPoints: ["test-integration/runTests.ts", "test-integration/suite.ts"],
        outdir: "out/test-integration",
        platform: "node",
        format: "cjs",
        target: "node20",
        external: ["vscode", "@vscode/test-electron"],
      },
    ]
  : tests
  ? [
      {
        ...common,
        sourcemap: "inline",
        entryPoints: readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`),
        outdir: "out/test",
        platform: "node",
        format: "cjs",
        target: "node20",
        external: ["vscode"],
      },
    ]
  : [
      {
        ...common,
        entryPoints: ["src/extension.ts"],
        outfile: "dist/extension.js",
        platform: "node",
        format: "cjs",
        target: "node20",
        external: ["vscode"],
      },
      {
        ...common,
        entryPoints: webviewEntries,
        outdir: "dist/webview",
        platform: "browser",
        format: "iife",
        target: "es2022",
        jsx: "automatic",
        jsxImportSource: "preact",
        loader: { ".ttf": "file" },
      },
    ];

if (!tests && !integration) {
  mkdirSync("dist/codicons", { recursive: true });
  for (const f of ["codicon.css", "codicon.ttf"]) {
    cpSync(`node_modules/@vscode/codicons/dist/${f}`, `dist/codicons/${f}`);
  }
}

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
