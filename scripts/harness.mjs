// Renders a webview bundle in a plain browser page for visual testing.
//   node scripts/harness.mjs <name>      → out/harness/<name>.html
// The page loads test/harness/<name>.mock.js, which must define
//   window.__MOCK_INIT__  (the panel's init data) and
//   window.__MOCK__ = { method(params) { return result | Promise } }
// Push host events from the console / devtools with window.__emit(event, data).
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const name = process.argv[2];
if (!name) {
  console.error("usage: node scripts/harness.mjs <webview-name>");
  process.exit(1);
}
const root = resolve(".");
const mock = resolve(`test/harness/${name}.mock.js`);
if (!existsSync(mock)) console.warn(`warning: ${mock} not found (RPCs will fail)`);
mkdirSync("out/harness", { recursive: true });
const theme = `
  --vscode-font-family: system-ui, -apple-system, "Segoe UI", Ubuntu, sans-serif; --vscode-font-size: 13px;
  --vscode-editor-font-family: "Droid Sans Mono", monospace; --vscode-editor-font-size: 12px;
  --vscode-foreground: #cccccc; --vscode-descriptionForeground: #9d9d9d; --vscode-editor-background: #1f1f1f;
  --vscode-sideBar-background: #181818; --vscode-panel-border: #2b2b2b; --vscode-widget-border: #313131;
  --vscode-textLink-foreground: #4daafc; --vscode-button-background: #0078d4; --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #026ec1; --vscode-button-secondaryBackground: #313131; --vscode-button-secondaryForeground: #cccccc;
  --vscode-button-secondaryHoverBackground: #3c3c3c; --vscode-input-background: #313131; --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c; --vscode-input-placeholderForeground: #989898; --vscode-focusBorder: #0078d4;
  --vscode-list-hoverBackground: #2a2d2e; --vscode-list-activeSelectionBackground: #04395e; --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-list-inactiveSelectionBackground: #37373d; --vscode-badge-background: #616161; --vscode-badge-foreground: #f8f8f8;
  --vscode-textCodeBlock-background: #2b2b2b; --vscode-errorForeground: #f85149; --vscode-editorWarning-foreground: #cca700;
  --vscode-inputValidation-errorBorder: #be1100; --vscode-inputValidation-errorBackground: #5a1d1d;
  --vscode-inputValidation-warningBorder: #b89500; --vscode-inputValidation-warningBackground: #352a05;
  --vscode-inputValidation-infoBorder: #007acc; --vscode-inputValidation-infoBackground: #063b49;
  --vscode-toolbar-hoverBackground: #5a5d5e50; --vscode-scrollbarSlider-background: #79797966; --vscode-scrollbarSlider-hoverBackground: #646464b3; --vscode-scrollbarSlider-activeBackground: #bfbfbf66; --vscode-progressBar-background: #0078d4;`;
const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${name} harness</title>
<link rel="stylesheet" href="${root}/dist/codicons/codicon.css">
<link rel="stylesheet" href="${root}/dist/webview/${name}.css">
<style>:root{${theme}}</style>
<script>
  window.__HARNESS_LOG__ = [];
  window.acquireVsCodeApi = () => ({
    postMessage(m) {
      window.__HARNESS_LOG__.push(m);
      if (m.kind !== "req") return;
      const fn = (window.__MOCK__ || {})[m.method];
      Promise.resolve()
        .then(() => { if (!fn) throw new Error("mock: no handler for " + m.method); return fn(m.params || {}); })
        .then((result) => window.postMessage({ kind: "res", id: m.id, ok: true, result: result ?? null }, "*"))
        .catch((e) => window.postMessage({ kind: "res", id: m.id, ok: false, error: String(e && e.message || e) }, "*"));
    },
    getState() { return window.__STATE__; },
    setState(s) { window.__STATE__ = s; },
  });
  window.__emit = (event, data) => window.postMessage({ kind: "evt", event, data }, "*");
</script>
<script src="${mock}"></script>
<script>window.__INIT__ = window.__MOCK_INIT__;</script>
</head><body><div id="root"></div><script src="${root}/dist/webview/${name}.js"></script></body></html>`;
writeFileSync(`out/harness/${name}.html`, html);
console.log(`file://${resolve(`out/harness/${name}.html`)}`);
