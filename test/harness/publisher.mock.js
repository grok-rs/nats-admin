window.__MOCK_INIT__ = {
  connectionName: "local",
  defaultTimeout: 5000,
  templateHelp: [["{{uuid}}", "random UUID v4"], ["{{seq}}", "1-based counter (per burst)"], ["{{timestamp}}", "ISO-8601 time"]],
  prefill: { mode: "publish", subject: "orders.eu.created", payload: '{"id": {{seq}}, "at": "{{timestamp}}"}', headers: [["Nats-Msg-Id", "{{uuid}}"]], jetstream: true },
};
window.__MOCK__ = {
  publish: async (f) => {
    if (f.subject.includes("fail")) throw new Error("No stream captures \"" + f.subject + "\" (no JetStream responders).");
    for (let i = 1; i <= f.count; i += Math.ceil(f.count / 4)) { window.__emit("progress", { sent: i, total: f.count }); await new Promise((r) => setTimeout(r, 50)); }
    return { sent: f.count, bytes: f.count * 40, durationMs: 12, firstSubject: f.subject, acks: f.jetstream ? [{ stream: "ORDERS", seq: 151, duplicate: false }, { stream: "ORDERS", seq: 150 + f.count, duplicate: false }].slice(0, f.count > 1 ? 2 : 1) : undefined };
  },
  request: async (f) => {
    await new Promise((r) => setTimeout(r, 120));
    if (f.subject === "nobody") throw new Error('No responders: nothing is subscribed to "nobody".');
    const body = JSON.stringify({ quote: 12.5, currency: "EUR", items: [{ sku: "A1", price: 12.5 }] });
    return { reply: { id: "r1", subject: "_INBOX.x.1", time: new Date().toISOString(), headers: [["Content-Type", "application/json"]], data: btoa(body), size: body.length }, latencyMs: 3.42, requestBytes: f.payload.length };
  },
  cancel: () => null,
  copyPlaybook: () => "### block",
};
