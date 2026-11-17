// Mock host for the Stream Dashboard webview (node scripts/harness.mjs streamDashboard).
// Query parameters (append to the printed file:// URL):
//   env=dev|test|staging|prod (default prod) · ro=1 (read-only) · theme=dark|light|hc
//   state=empty|error|disconnected|loading|nolimits|sourceerror · sources=0 · cluster=0
// Simulated time advances 4 s per poll so charts fill quickly.
(function () {
  const q = new URLSearchParams(location.search);
  const state = q.get("state") || "";
  const env = q.get("env") || "prod";
  const theme = q.get("theme") || "dark";
  const b64 = (s) => btoa(unescape(encodeURIComponent(s)));

  // ---- theme variable sets (subset of VS Code Light Modern / High Contrast) ----
  const THEMES = {
    light: {
      body: "vscode-light",
      vars: {
        foreground: "#3b3b3b", descriptionForeground: "#6f6f6f", "editor-background": "#ffffff", "sideBar-background": "#f8f8f8",
        "panel-border": "#e5e5e5", "widget-border": "#e5e5e5", "textLink-foreground": "#005fb8", "button-background": "#005fb8",
        "button-foreground": "#ffffff", "button-hoverBackground": "#0258a8", "button-secondaryBackground": "#e5e5e5",
        "button-secondaryForeground": "#3b3b3b", "button-secondaryHoverBackground": "#cccccc", "input-background": "#ffffff",
        "input-foreground": "#3b3b3b", "input-border": "#cecece", "input-placeholderForeground": "#767676", focusBorder: "#005fb8",
        "list-hoverBackground": "#f2f2f2", "list-activeSelectionBackground": "#e8e8e8", "list-activeSelectionForeground": "#000000",
        "list-inactiveSelectionBackground": "#e4e6f1", "badge-background": "#cccccc", "badge-foreground": "#3b3b3b",
        "textCodeBlock-background": "#f8f8f8", errorForeground: "#a1260d", "editorWarning-foreground": "#bf8803",
        "editorInfo-foreground": "#1a85ff", "testing-iconPassed": "#388a34", "charts-foreground": "#616161", "charts-lines": "#61616180",
        "charts-red": "#e51400", "charts-blue": "#1a85ff", "charts-yellow": "#bf8803", "charts-orange": "#d18616", "charts-green": "#388a34",
        "charts-purple": "#652d90", "terminal-ansiMagenta": "#bc05bc", "terminal-ansiCyan": "#0598bc", "editorHoverWidget-background": "#f8f8f8",
        "editorHoverWidget-border": "#c8c8c8", "editorHoverWidget-foreground": "#3b3b3b", "widget-shadow": "#00000029",
        "toolbar-hoverBackground": "#b8b8b850",
      },
    },
    hc: {
      body: "vscode-high-contrast",
      vars: {
        foreground: "#ffffff", descriptionForeground: "#d6d6d6", "editor-background": "#000000", "sideBar-background": "#000000",
        "panel-border": "#6fc3df", "widget-border": "#6fc3df", contrastBorder: "#6fc3df", contrastActiveBorder: "#f38518",
        "textLink-foreground": "#21a6ff", "button-background": "#000000", "button-border": "#6fc3df", "button-foreground": "#ffffff",
        "button-secondaryBackground": "#000000", "button-secondaryForeground": "#ffffff", "input-background": "#000000",
        "input-foreground": "#ffffff", "input-border": "#6fc3df", focusBorder: "#f38518", "list-hoverBackground": "#ffffff1a",
        errorForeground: "#f48771", "editorWarning-foreground": "#ffd370", "editorInfo-foreground": "#3794ff", "testing-iconPassed": "#73c991",
        "charts-foreground": "#ffffff", "charts-red": "#f48771", "charts-blue": "#3794ff", "charts-yellow": "#ffd370", "charts-orange": "#ff9d3b",
        "charts-green": "#89d185", "charts-purple": "#b180d7", "terminal-ansiMagenta": "#d670d6", "terminal-ansiCyan": "#29b8db",
        "editorHoverWidget-background": "#0c141f", "editorHoverWidget-border": "#6fc3df", "editorHoverWidget-foreground": "#ffffff",
      },
    },
  };
  const t = THEMES[theme];
  if (t) {
    for (const [k, v] of Object.entries(t.vars)) document.documentElement.style.setProperty(`--vscode-${k}`, v);
    const apply = () => document.body && (document.body.classList.add(t.body), (document.body.dataset.vscodeThemeKind = t.body));
    if (!apply()) document.addEventListener("DOMContentLoaded", apply);
  } else {
    const apply = () => document.body && document.body.classList.add("vscode-dark");
    if (!apply()) document.addEventListener("DOMContentLoaded", apply);
  }

  // ---- simulated stream ----
  let simT = Date.now() - 600_000;
  const STEP = 4000;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);
  const empty = state === "empty";
  const noLimits = state === "nolimits";
  const avg = 418;
  const S = {
    lastSeq: empty ? 0 : 1_284_220,
    messages: empty ? 0 : 182_340,
    deleted: empty ? 0 : 37,
    firstTsAgo: 15.2 * 3600_000,
  };
  const consumers = empty
    ? []
    : [
        { name: "analytics", kind: "push", durable: true, bound: true, filter: [], pending: 640, ack: 0, max: -1, redel: 3, waiting: 0, speed: 1.0, lag: 0 },
        { name: "archiver", kind: "pull", durable: true, bound: false, filter: ["orders.>"], pending: 9_210, ack: 500, max: 500, redel: 0, waiting: 0, speed: 0.0, lag: 9_000 },
        { name: "audit-replay", kind: "push", durable: true, bound: false, filter: ["orders.audit"], pending: 4_200, ack: 0, max: -1, redel: 0, waiting: 0, speed: 0, idle: 900_000 },
        { name: "billing", kind: "pull", durable: true, bound: false, filter: ["orders.*.*.created"], pending: 12, ack: 24, max: 1000, redel: 0, waiting: 4, speed: 0.31 },
        { name: "legacy-export", kind: "pull", durable: true, bound: false, filter: ["orders.eu.>"], pending: 51_400, ack: 0, max: 1000, redel: 0, waiting: 0, speed: 0, paused: true, idle: 3 * 86400_000 },
        { name: "shipping", kind: "pull", durable: true, bound: false, filter: ["orders.*.*.paid"], pending: 18_450, ack: 920, max: 1000, redel: 312, waiting: 0, speed: 0.12, grow: 4 },
      ];
  for (const c of consumers) {
    c.delivered = 1_000_000 + Math.round(rnd() * 200_000);
    c.ackFloor = S.lastSeq - c.pending - c.ack - (c.lag || 0);
    c.created = new Date(Date.now() - 40 * 86400_000).toISOString();
  }
  const sources =
    q.get("sources") === "0" || empty
      ? []
      : [
          { name: "ORDERS_APAC", lag: 1_520, active: 4_100, filter: "orders.apac.>", grow: 22 },
          { name: "ORDERS_US", lag: 0, active: 180, external: state === "sourceerror" ? "$JS.us-east.API" : undefined },
        ];
  if (state === "sourceerror") sources[1].error = "stream not found (10059) on domain us-east";

  function step() {
    simT += STEP;
    const burst = Math.sin(simT / 45_000) * 18 + (rnd() < 0.08 ? 80 : 0);
    const rate = empty ? 0 : Math.max(0, 42 + burst + rnd() * 10);
    const added = Math.round((rate * STEP) / 1000);
    S.lastSeq += added;
    S.messages = Math.min(noLimits ? Infinity : 250_000, S.messages + added);
    for (const c of consumers) {
      if (c.paused) continue;
      const take = Math.round(added * (c.speed + (c.speed ? rnd() * 0.05 : 0)) * (c.filter.length ? 1 : 1));
      c.delivered += take + (c.redel && rnd() < 0.3 ? 2 : 0);
      c.pending = Math.max(0, c.pending + Math.round(added * (c.filter.length ? 0.25 : 1)) - take + (c.grow || 0));
      if (c.name === "analytics") c.pending = Math.round(200 + rnd() * 900);
      if (c.name === "billing") (c.pending = Math.round(rnd() * 30)), (c.ack = Math.round(10 + rnd() * 40));
      if (c.redel && rnd() < 0.2) c.redel += 1;
      c.ackFloor = Math.max(c.ackFloor, S.lastSeq - c.pending - c.ack - (c.lag || 0) - 50_000);
      if (take > 0 || c.name === "analytics") c.lastActive = simT - Math.round(rnd() * 1500);
    }
    for (const s of sources) s.lag = Math.max(0, s.lag + (s.grow ? Math.round((rnd() - 0.4) * s.grow * 4) : 0));
  }

  function snapshot() {
    step();
    const maxMsgs = noLimits ? -1 : 250_000;
    const firstSeq = empty ? 1 : S.lastSeq - S.messages - S.deleted + 1;
    return {
      at: simT,
      serverAt: simT,
      consumersTotal: consumers.length,
      stream: {
        name: "ORDERS",
        description: "Order lifecycle events from every region",
        subjects: ["orders.>"],
        created: new Date(Date.now() - 92 * 86400_000).toISOString(),
        config: {
          retention: "limits",
          storage: "file",
          replicas: q.get("cluster") === "0" ? 1 : 3,
          discard: "old",
          discardNewPerSubject: false,
          maxMsgs,
          maxBytes: noLimits ? -1 : 128 * 1024 * 1024,
          maxAgeMs: noLimits ? 0 : 24 * 3600_000,
          maxMsgsPerSubject: noLimits ? -1 : 50_000,
          maxMsgSize: 1024 * 1024,
          maxConsumers: noLimits ? -1 : 16,
          duplicateWindowMs: 120_000,
          compression: "s2",
          sealed: false,
          denyDelete: false,
          denyPurge: false,
          allowRollup: true,
          allowDirect: true,
          mirrorDirect: false,
          placementCluster: "eu-west",
          sourceNames: sources.length ? sources.map((s) => s.name) : undefined,
          metadata: { owner: "team-orders", "on-call": "#orders-oncall" },
        },
        state: {
          messages: S.messages,
          bytes: S.messages * avg,
          firstSeq,
          lastSeq: S.lastSeq,
          firstTs: empty ? undefined : new Date(simT - S.firstTsAgo).toISOString(),
          lastTs: empty ? undefined : new Date(simT - 300).toISOString(),
          numDeleted: S.deleted,
          numSubjects: empty ? 0 : 61,
          consumerCount: consumers.length,
        },
        cluster:
          q.get("cluster") === "0"
            ? undefined
            : {
                name: "eu-west",
                leader: "nats-eu-1",
                leaderSince: new Date(Date.now() - 3 * 86400_000 - 4 * 3600_000).toISOString(),
                raftGroup: "S-R3F-x8Kq2pLm",
                peers: [
                  { name: "nats-eu-1", leader: true, current: true, offline: false, lag: 0 },
                  { name: "nats-eu-2", leader: false, current: true, offline: false, activeMs: 120 + Math.round(rnd() * 80), lag: 0 },
                  { name: "nats-eu-3", leader: false, current: false, offline: false, activeMs: 3200, lag: 1840 + Math.round(rnd() * 200) },
                ],
              },
        sources: sources.map((s) => ({ name: s.name, lag: s.lag, activeMs: s.active, error: s.error, filter: s.filter, external: s.external })),
      },
      consumers: consumers.map((c) => ({
        name: c.name,
        kind: c.kind,
        durable: c.durable,
        paused: !!c.paused,
        pushBound: c.bound,
        filters: c.filter,
        ackPolicy: "explicit",
        deliverPolicy: "all",
        numPending: c.pending,
        numAckPending: c.ack,
        numRedelivered: c.redel,
        numWaiting: c.waiting,
        maxAckPending: c.max,
        maxDeliver: 5,
        ackWaitMs: 30_000,
        deliveredStreamSeq: S.lastSeq - c.pending,
        deliveredConsumerSeq: c.delivered,
        ackFloorStreamSeq: c.ackFloor,
        ackFloorConsumerSeq: c.delivered - c.ack,
        lastActive: c.lastActive ? new Date(c.lastActive).toISOString() : c.idle ? new Date(simT - c.idle).toISOString() : undefined,
        created: c.created,
        replicas: 3,
      })),
    };
  }

  // ---- subjects ----
  const REGIONS = { eu: ["de", "fr", "nl", "es", "it", "pl"], us: ["east", "west", "central"], apac: ["jp", "sg", "au"], latam: ["br", "mx"] };
  const EVENTS = { created: 1, paid: 0.86, shipped: 0.71, cancelled: 0.08 };
  const REGION_W = { eu: 1, us: 0.72, apac: 0.38, latam: 0.16 };
  function subjects() {
    if (empty) return { at: Date.now(), total: 0, truncated: false, max: 2000, kept: 0, streamMessages: 0, keptMessages: 0, top: [], tree: [], treePrefix: "", roots: [] };
    const list = [];
    for (const [r, countries] of Object.entries(REGIONS))
      countries.forEach((c, i) => {
        for (const [e, w] of Object.entries(EVENTS)) list.push({ subject: `orders.${r}.${c}.${e}`, messages: Math.round(9000 * REGION_W[r] * w * (1 - i * 0.12)) });
      });
    list.push({ subject: "orders.audit", messages: 4_200 });
    list.push({ subject: "orders.eu", messages: 310 });
    const total = list.reduce((a, s) => a + s.messages, 0);
    const scale = S.messages / total;
    for (const s of list) s.messages = Math.max(1, Math.round(s.messages * scale));
    list.sort((a, b) => b.messages - a.messages);
    const tree = Object.entries(REGIONS).map(([r, countries]) => {
      const kids = countries.map((c) => ({ id: `orders.${r}.${c}`, label: c, hint: `orders.${r}.${c} · 4 subjects`, children: Object.keys(EVENTS).map((e) => ({ id: `orders.${r}.${c}.${e}`, label: e, value: list.find((s) => s.subject === `orders.${r}.${c}.${e}`).messages, hint: `orders.${r}.${c}.${e}` })) }));
      if (r === "eu") kids.push({ id: "orders.eu (exact)", label: "(exact)", value: list.find((s) => s.subject === "orders.eu").messages, hint: "Messages on exactly orders.eu" });
      return { id: `orders.${r}`, label: r, children: kids, hint: `orders.${r}` };
    });
    tree.push({ id: "orders.audit", label: "audit", value: 4_200, hint: "orders.audit" });
    const sum = (n) => (n.children ? n.children.reduce((a, c) => a + sum(c), 0) : n.value);
    return {
      at: Date.now(),
      total: list.length,
      truncated: q.get("truncated") === "1",
      max: 2000,
      kept: list.length,
      streamMessages: S.messages,
      keptMessages: list.reduce((a, s) => a + s.messages, 0),
      top: list.slice(0, 50),
      largest: list[0],
      tree,
      treePrefix: "orders",
      roots: [{ label: "orders.>", value: sum({ children: tree }), subjects: list.length }],
    };
  }

  function recent() {
    const subs = ["orders.eu.de.created", "orders.us.east.paid", "orders.eu.fr.shipped", "orders.apac.jp.created", "orders.audit", "orders.eu.nl.paid", "orders.latam.br.created"];
    const messages = [];
    for (let i = 0; i < 10; i++) {
      const seq = S.lastSeq - i;
      const subject = subs[(seq * 3) % subs.length];
      const body = subject === "orders.audit" ? `user=svc-billing action=refund order=${seq}` : JSON.stringify({ id: `ord_${seq.toString(36)}`, sku: "A1-" + (seq % 97), qty: (seq % 5) + 1, total: ((seq % 900) + 99) / 10, currency: "EUR" });
      messages.push({ id: `m${seq}`, seq, subject, time: new Date(simT - i * 900 - 300).toISOString(), headers: i % 3 === 0 ? [["Nats-Msg-Id", `ord-${seq}`]] : [], data: b64(body), size: body.length + 40 });
    }
    return { at: Date.now(), lastSeq: S.lastSeq, messages };
  }

  window.__MOCK_INIT__ = {
    profileId: "c-prod-eu",
    connectionName: "nats-eu-prod",
    stream: "ORDERS",
    environment: env,
    readOnly: q.get("ro") === "1",
    connState: state === "disconnected" ? "reconnecting" : "connected",
    connError: state === "disconnected" ? "nats://nats-eu-1.internal:4222 refused the connection" : undefined,
    refreshInterval: 600,
    maxSubjects: 2000,
    visible: true,
  };
  window.__CALLS__ = [];
  const log = (m, p) => (window.__CALLS__.push([m, p]), true);
  window.__MOCK__ = {
    snapshot: () => {
      if (state === "error") throw new Error("stream not found (10059)");
      if (state === "loading") return new Promise(() => undefined);
      return snapshot();
    },
    subjects: () => (state === "loading" ? new Promise(() => undefined) : new Promise((r) => setTimeout(() => r(subjects()), 250))),
    recent: () => new Promise((r) => setTimeout(() => r(recent()), 200)),
    browseSubject: (p) => log("browseSubject", p),
    openMessage: (p) => log("openMessage", p),
    openMessages: (p) => log("openMessages", p),
    consumerLab: (p) => log("consumerLab", p),
    consumerInfo: (p) => log("consumerInfo", p),
    streamInfo: (p) => log("streamInfo", p),
    editConfig: (p) => log("editConfig", p),
    createConsumer: (p) => log("createConsumer", p),
    publish: (p) => log("publish", p),
    openSetting: (p) => log("openSetting", p),
    close: (p) => log("close", p),
    reconnect: () => {
      setTimeout(() => window.__emit("connection", { state: "connected" }), 300);
      return true;
    },
  };
})();
