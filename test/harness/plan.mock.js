// Mock host for the Config Plan webview.
// Variants via the URL hash (comma-separated): #prod #readonly #empty #disconnected #noconn
// #insync #error #loading #nojs #subs (subfolders with their own config files)
(function () {
  const flags = new Set(location.hash.replace(/^#/, "").split(",").filter(Boolean));
  const NS = 1e9;
  const conn = {
    id: "c1",
    name: flags.has("prod") ? "prod-eu-west" : "local",
    env: flags.has("prod") ? "prod" : "dev",
    readOnly: flags.has("readonly"),
    state: flags.has("disconnected") ? "disconnected" : "connected",
    server: "nats-0 · v2.14.4",
    url: flags.has("prod") ? "nats://nats-0.prod.internal:4222" : "nats://127.0.0.1:4222",
  };

  const items = [
    {
      id: "stream:ORDERS",
      kind: "stream",
      name: "ORDERS",
      action: "update",
      file: "ORDERS.stream.json",
      warnings: [],
      changes: [
        { path: "max_age", op: "change", from: 0, to: 86400 * NS, unit: "ns", risk: "Messages older than 1d will be deleted" },
        { path: "subjects", op: "change", from: ["orders.>", "legacy.orders.>"], to: ["orders.>", "returns.>"], risk: 'Stops capturing "legacy.orders.>"' },
        { path: "description", op: "add", to: "Order lifecycle events (EU + US)" },
        { path: "max_bytes", op: "change", from: -1, to: 10737418240, unit: "bytes", risk: "Messages above the new limit will be deleted (or new ones rejected with discard \"new\")" },
        { path: "metadata.owner", op: "change", from: "team-a", to: "payments" },
        { path: "num_replicas", op: "change", from: 1, to: 3 },
      ],
    },
    {
      id: "stream:AUDIT",
      kind: "stream",
      name: "AUDIT",
      action: "update",
      file: "AUDIT.stream.json",
      warnings: [],
      blocked: "storage cannot be changed on the existing resource",
      changes: [
        { path: "storage", op: "change", from: "file", to: "memory", immutable: "Storage type cannot change on an existing stream — create a new stream and move the data (for example with a source), then switch over" },
        { path: "compression", op: "change", from: "none", to: "s2" },
      ],
    },
    {
      id: "stream:EVENTS",
      kind: "stream",
      name: "EVENTS",
      action: "create",
      file: "EVENTS.stream.json",
      warnings: [],
      changes: [],
      fields: [
        { path: "description", op: "add", to: "Domain events" },
        { path: "subjects", op: "add", to: ["events.>"] },
        { path: "retention", op: "add", to: "limits" },
        { path: "storage", op: "add", to: "file" },
        { path: "num_replicas", op: "add", to: 1 },
        { path: "max_age", op: "add", to: 7 * 86400 * NS, unit: "ns" },
        { path: "max_bytes", op: "add", to: 1073741824, unit: "bytes" },
        { path: "duplicate_window", op: "add", to: 120 * NS, unit: "ns" },
        { path: "discard", op: "add", to: "old" },
      ],
    },
    { id: "stream:PAYMENTS", kind: "stream", name: "PAYMENTS", action: "unchanged", file: "PAYMENTS.stream.json", warnings: [], changes: [] },
    { id: "stream:INVENTORY", kind: "stream", name: "INVENTORY", action: "unchanged", file: "INVENTORY.stream.json", warnings: [], changes: [], unsaved: true },
    {
      id: "stream:LEGACY_LOGS",
      kind: "stream",
      name: "LEGACY_LOGS",
      action: "drift",
      warnings: [],
      changes: [],
      fields: [
        { path: "subjects", op: "add", to: ["logs.legacy.>"] },
        { path: "retention", op: "add", to: "limits" },
        { path: "max_age", op: "add", to: 30 * 86400 * NS, unit: "ns" },
        { path: "storage", op: "add", to: "file" },
      ],
    },
    {
      id: "kv:config",
      kind: "kv",
      name: "config",
      action: "update",
      file: "config.kv.json",
      warnings: [],
      changes: [
        { path: "history", op: "change", from: 5, to: 10 },
        { path: "ttl", op: "change", from: 3600000, to: 86400000, unit: "ms" },
      ],
    },
    {
      id: "kv:sessions",
      kind: "kv",
      name: "sessions",
      action: "create",
      file: "sessions.kv.json",
      warnings: [],
      changes: [],
      fields: [
        { path: "history", op: "add", to: 1 },
        { path: "ttl", op: "add", to: 1800000, unit: "ms" },
        { path: "storage", op: "add", to: "memory" },
        { path: "compression", op: "add", to: true },
      ],
    },
    {
      id: "consumer:ORDERS/billing",
      kind: "consumer",
      name: "billing",
      stream: "ORDERS",
      action: "update",
      file: "ORDERS.billing.consumer.json",
      warnings: [],
      changes: [
        { path: "max_ack_pending", op: "change", from: 1000, to: 500 },
        { path: "ack_wait", op: "change", from: 30 * NS, to: 60 * NS, unit: "ns" },
        { path: "max_deliver", op: "change", from: -1, to: 5, risk: "Messages that already reached the new limit stop being redelivered" },
      ],
    },
    {
      id: "consumer:EVENTS/indexer",
      kind: "consumer",
      name: "indexer",
      stream: "EVENTS",
      action: "create",
      file: "EVENTS.indexer.consumer.json",
      dependsOn: "stream:EVENTS",
      warnings: ['No "durable_name": the consumer is created as durable "indexer" (from the file name)'],
      changes: [],
      fields: [
        { path: "ack_policy", op: "add", to: "explicit" },
        { path: "deliver_policy", op: "add", to: "all" },
        { path: "filter_subject", op: "add", to: "events.>" },
        { path: "max_deliver", op: "add", to: 5 },
        { path: "backoff", op: "add", to: [NS, 5 * NS, 30 * NS], unit: "ns" },
      ],
    },
    { id: "consumer:ORDERS/shipping", kind: "consumer", name: "shipping", stream: "ORDERS", action: "unchanged", file: "ORDERS.shipping.consumer.json", warnings: [], changes: [] },
    {
      id: "consumer:ORDERS/debug-tmp",
      kind: "consumer",
      name: "debug-tmp",
      stream: "ORDERS",
      action: "drift",
      warnings: [],
      changes: [],
      fields: [
        { path: "ack_policy", op: "add", to: "none" },
        { path: "deliver_policy", op: "add", to: "new" },
        { path: "filter_subject", op: "add", to: "orders.debug.>" },
      ],
    },
    { id: "stream:BROKEN", kind: "stream", name: "BROKEN", action: "error", file: "BROKEN.stream.json", warnings: [], changes: [], error: 'Invalid JSON at line 7, column 3: Unexpected token \'}\'' },
    {
      id: "file:ORDERS.bad.name.consumer.json",
      kind: "consumer",
      name: "ORDERS.bad.name.consumer.json",
      action: "error",
      file: "ORDERS.bad.name.consumer.json",
      warnings: [],
      changes: [],
      error: 'Consumer files must be named <STREAM>.<CONSUMER>.consumer.json (stream and consumer names cannot contain dots); got "ORDERS.bad.name.consumer.json"',
    },
  ];

  function counts(list) {
    const c = { create: 0, update: 0, unchanged: 0, drift: 0, error: 0 };
    list.forEach((i) => c[i.action]++);
    return c;
  }

  let current = flags.has("insync") ? items.filter((i) => i.action === "unchanged" || i.action === "drift") : items;
  if (flags.has("insync")) current = current.concat([{ id: "kv:config", kind: "kv", name: "config", action: "unchanged", file: "config.kv.json", warnings: [], changes: [] }]);

  function planResult() {
    const list = flags.has("empty") ? [] : current;
    return {
      folder: "/home/dev/shop/nats/" + conn.name,
      folderLabel: "shop • nats/" + conn.name,
      connection: conn,
      generatedAt: Date.now(),
      durationMs: 142,
      files: flags.has("empty") ? 0 : list.filter((i) => i.file).length,
      subfolders: flags.has("subs") ? ["dev", "prod/eu-west"] : [],
      scope: ["stream", "kv", "consumer"],
      items: list,
      counts: counts(list),
      jetstream: !flags.has("nojs"),
    };
  }

  window.__MOCK_INIT__ = { folder: "/home/dev/shop/nats/" + conn.name, folderLabel: "shop • nats/" + conn.name, connection: flags.has("noconn") ? undefined : conn };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  window.__MOCK__ = {
    plan: async () => {
      if (flags.has("loading")) return new Promise(() => undefined);
      await wait(350);
      if (flags.has("error")) throw new Error("JetStream API timeout: no responders on $JS.API.STREAM.LIST (is JetStream enabled for this account?)");
      return planResult();
    },
    apply: async ({ ids }) => {
      const t0 = Date.now();
      await wait(150);
      const results = [];
      const order = ids.map((id) => current.find((i) => i.id === id)).filter(Boolean);
      for (const i of order) window.__emit("progress", { id: i.id, state: "pending" });
      for (const i of order) {
        if (i.blocked) {
          const r = { id: i.id, state: "skipped", message: "Blocked: " + i.blocked };
          results.push(r);
          window.__emit("progress", r);
          continue;
        }
        window.__emit("progress", { id: i.id, state: "running" });
        await wait(420);
        const fail = i.id === "consumer:ORDERS/billing";
        const r = fail ? { id: i.id, state: "failed", message: "consumer max_ack_pending exceeds the stream's consumer_limits (500) [10116]" } : { id: i.id, state: "done", message: i.action === "create" ? "created" : "updated" };
        results.push(r);
        window.__emit("progress", r);
      }
      // Applied items now match the server.
      current = current.map((i) => (results.some((r) => r.id === i.id && r.state === "done") ? { ...i, action: "unchanged", changes: [], fields: undefined, dependsOn: undefined } : i));
      return {
        applied: results.filter((r) => r.state === "done").length,
        failed: results.filter((r) => r.state === "failed").length,
        skipped: results.filter((r) => r.state === "skipped").length,
        durationMs: Date.now() - t0,
        results,
      };
    },
    adopt: async ({ ids }) => {
      const files = [];
      current = current.map((i) => {
        if (!ids.includes(i.id)) return i;
        const file = i.kind === "consumer" ? `${i.stream}.${i.name}.consumer.json` : `${i.name}.${i.kind}.json`;
        files.push(file);
        return { ...i, action: "unchanged", file, fields: undefined };
      });
      return files;
    },
    selectConnection: async () => ({ ...conn, name: "staging-us", env: "staging", state: "connected" }),
    connect: async () => {
      await wait(200);
      conn.state = "connected";
      return { ...conn };
    },
    openFile: () => true,
    compare: () => true,
    viewServer: () => true,
    exportHere: () => true,
    planSubfolder: ({ dir }) => {
      window.__lastSubfolder = dir;
      return true;
    },
    revealFolder: () => true,
  };
})();
