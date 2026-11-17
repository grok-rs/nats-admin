// Mock host for the KV Browser webview.
(function () {
  // ?theme=light renders with (a subset of) VS Code Light Modern; ?empty=1 shows an empty bucket.
  const q = new URLSearchParams(location.search);
  if (q.get("theme") === "light") {
    const vars = {
      foreground: "#3b3b3b", descriptionForeground: "#6f6f6f", "editor-background": "#ffffff", "sideBar-background": "#f8f8f8",
      "panel-border": "#e5e5e5", "widget-border": "#e5e5e5", "textLink-foreground": "#005fb8", "button-background": "#005fb8",
      "button-foreground": "#ffffff", "button-secondaryBackground": "#e5e5e5", "button-secondaryForeground": "#3b3b3b",
      "input-background": "#ffffff", "input-foreground": "#3b3b3b", "input-border": "#cecece", focusBorder: "#005fb8",
      "list-hoverBackground": "#f2f2f2", "list-inactiveSelectionBackground": "#e4e6f1", "badge-background": "#cccccc", "badge-foreground": "#3b3b3b",
      errorForeground: "#a1260d", "editorWarning-foreground": "#bf8803", "testing-iconPassed": "#388a34",
      "charts-red": "#e51400", "charts-blue": "#1a85ff", "charts-yellow": "#bf8803", "charts-orange": "#d18616", "charts-green": "#388a34",
      "charts-purple": "#652d90", "terminal-ansiMagenta": "#bc05bc", "terminal-ansiCyan": "#0598bc",
      "editorHoverWidget-background": "#f8f8f8", "editorHoverWidget-border": "#c8c8c8", "editorHoverWidget-foreground": "#3b3b3b",
    };
    for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(`--vscode-${k}`, v);
    document.addEventListener("DOMContentLoaded", () => document.body.classList.add("vscode-light"));
  }
  const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
  const now = Date.now();
  let rev = 30;
  const mk = (key, value, agoSec) => ({ key, revision: ++rev, created: new Date(now - agoSec * 1000).toISOString(), operation: "PUT", size: value.length, data: b64(value) });
  const entries = [
    mk("app.name", '"nats-admin"', 3600),
    mk("app.db.host", "db.internal", 3000),
    mk("app.db.port", "5432", 2900),
    mk("app.db", '{"pool":{"min":2,"max":20},"ssl":true,"replicas":["r1","r2"]}', 2000),
    mk("app.features", '{"darkMode":false,"beta":["kv-browser","consumer-lab","dlq"],"limits":{"rps":200,"burst":250}}', 120),
    mk("services.billing.url", "http://billing:8080", 500),
    mk("services.auth.url", "http://auth:9000", 400),
    mk("users.alice", '{"user":"alice","loginAt":"2026-11-17T10:00:00Z","roles":["admin"],"meta":{"ip":"10.0.0.1"}}', 50),
    mk("users.bob", '{"user":"bob","loginAt":"2026-11-17T11:00:00Z","roles":[]}', 40),
    mk("users.carol", '{"user":"carol","loginAt":null,"roles":["dev","ops"],"meta":{"ip":"10.0.0.7","agent":"cli"}}', 30),
    mk("flags", "[1,2,3]", 20),
    mk("blob", String.fromCharCode(0, 1, 2, 3, 250, 251, 252), 10),
  ];
  // Generated keys so the overview charts (sizes, types, key space, activity) have shape.
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);
  for (let i = 0; i < 48; i++) {
    const id = (0x1a2b + i * 97).toString(16);
    const items = Array.from({ length: Math.floor(rnd() ** 2 * 12) }, (_, j) => ({ sku: `A${j}`, qty: j + 1 }));
    entries.push(mk(`sessions.${id}`, JSON.stringify({ user: `u${i}`, cart: items, ttl: 1800, ua: "Mozilla/5.0" }), Math.floor(rnd() ** 1.6 * 6 * 3600)));
  }
  for (const region of ["eu", "us"]) for (let h = 1; h <= 6; h++) entries.push(mk(`metrics.${region}.host${h}.cpu`, String(Math.round(rnd() * 100)), Math.floor(rnd() * 900)));
  for (let i = 0; i < 5; i++) entries.push(mk(`feature.flag${i}`, i % 2 ? "true" : "false", 5 * 3600 + i * 60));
  entries.push(mk("cache.avatar.alice", String.fromCharCode(...Array.from({ length: 900 }, (_, i) => (i * 37) % 256)), 7200));
  // Revisions follow write time, like a real bucket.
  entries.sort((a, b) => Date.parse(a.created) - Date.parse(b.created)).forEach((e, i) => (e.revision = 31 + i));
  rev = 31 + entries.length;
  window.__MOCK_INIT__ = {
    connName: "local",
    bucket: "config",
    status: { bucket: "config", values: 22, history: 5, ttlMs: 0, bytes: 1843, storage: "file", replicas: 1 },
    separator: ".",
    maxKeys: 5000,
  };
  window.__MOCK__ = {
    load: () => {
      setTimeout(() => window.__emit("snapshot", { entries: q.get("empty") === "1" ? [] : entries, truncated: false, max: 5000 }), 150);
      return true;
    },
    stopLive: () => true,
    status: () => window.__MOCK_INIT__.status,
    history: ({ key }) => {
      const cur = entries.find((e) => e.key === key);
      return [cur, { ...cur, revision: cur.revision - 9, created: new Date(now - 86400000).toISOString(), data: b64('{"darkMode":true,"beta":["kv-browser","consumer-lab"],"limits":{"rps":100,"burst":250}}') }, { ...cur, revision: cur.revision - 15, operation: "DEL", data: "", size: 0 }];
    },
    put: ({ key, data, revision }) => {
      const e = entries.find((x) => x.key === key);
      if (revision && e && revision !== e.revision) throw new Error(`Conflict: "${key}" was modified on the server (now revision ${e.revision}). Reload the value or overwrite.`);
      const next = { ...(e || mk(key, "", 0)), data, revision: ++rev, created: new Date().toISOString() };
      setTimeout(() => window.__emit("updates", [next]), 50);
      return next.revision;
    },
    create: ({ key, data }) => {
      const next = { key, revision: ++rev, created: new Date().toISOString(), operation: "PUT", size: atob(data).length, data };
      entries.push(next);
      setTimeout(() => window.__emit("updates", [next]), 50);
      return rev;
    },
    delete: ({ key }) => (setTimeout(() => window.__emit("updates", [{ key, revision: ++rev, created: new Date().toISOString(), operation: "DEL", size: 0 }]), 50), true),
    purge: ({ key }) => (setTimeout(() => window.__emit("updates", [{ key, revision: ++rev, created: new Date().toISOString(), operation: "PURGE", size: 0 }]), 50), true),
    confirm: () => true,
    openInEditor: () => true,
    diff: () => true,
    bucketInfo: () => true,
    export: () => "/tmp/config.json",
    refreshTree: () => true,
  };
})();
