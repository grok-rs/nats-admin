// Mock host for the Live Tail webview (see scripts/harness.mjs).
window.__MOCK_INIT__ = { connectionName: "local", maxMessages: 2000 };
(function () {
  const colors = ["#4daafc", "#3fb950", "#d29922", "#db61a2"];
  let subs = [];
  let n = 0;
  let total = 0;
  let paused = false;
  const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
  function makeMsg(sub) {
    n++;
    total++;
    const kind = n % 5;
    const subject = sub.subject.replace(">", n % 2 ? "eu.created" : "us.shipped").replace("*", "x");
    const payload =
      kind === 0 ? "order " + n + " shipped" : kind === 4 ? String.fromCharCode(0, 1, 2, 255) : JSON.stringify({ id: n, customer: "c" + (n % 7), total: n * 3.5, items: [{ sku: "A" + n, qty: 2 }] });
    return {
      id: "m" + n, subject, time: new Date().toISOString(),
      headers: n % 3 === 0 ? [["Nats-Msg-Id", "o" + n], ["Content-Type", "application/json"]] : [],
      data: kind === 4 ? btoa(payload) : b64(payload), size: payload.length, subId: sub.id,
      reply: n % 4 === 0 ? "_INBOX.abc." + n : undefined,
    };
  }
  setInterval(() => {
    if (!subs.length || paused) return;
    const batch = [];
    for (const s of subs) { const m = makeMsg(s); s.count++; batch.push(m); }
    window.__emit("messages", batch);
    window.__emit("subs", subs);
  }, 400);
  setInterval(() => window.__emit("stats", { rate: subs.length * 2.5, total, paused, pausedCount: paused ? 7 : 0 }), 1000);
  window.__MOCK__ = {
    ready: () => ({ subs, stats: { rate: 0, total, paused, pausedCount: 0 } }),
    subscribe: ({ subject, queue }) => {
      if (subs.some((s) => s.subject === subject)) throw new Error("Already subscribed to " + subject);
      subs.push({ id: "s" + (subs.length + 1), subject, queue, color: colors[subs.length % colors.length], count: 0, active: true });
      return subs;
    },
    unsubscribe: ({ id }) => (subs = subs.filter((s) => s.id !== id)),
    pause: (p) => ((paused = p.paused), { paused }),
    clear: () => null,
    reply: (p) => ({ bytes: atob(p.data).length }),
    republish: () => null,
    export: (p) => "/tmp/live-tail." + p.format,
  };
})();
