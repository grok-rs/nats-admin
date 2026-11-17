window.__MOCK_INIT__ = { connectionName: "local", subjects: ["$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>", "$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.>"] };
setTimeout(() => window.__emit("advisories", [
  { id: "a1", kind: "max_deliveries", stream: "ORDERS", consumer: "billing", streamSeq: 42, deliveries: 3, timestamp: new Date().toISOString(), raw: { type: "io.nats.jetstream.advisory.v1.max_deliver", stream: "ORDERS", consumer: "billing", stream_seq: 42, deliveries: 3 } },
  { id: "a2", kind: "terminated", stream: "ORDERS", consumer: "audit", streamSeq: 7, deliveries: 1, reason: "invalid payload", timestamp: new Date().toISOString(), raw: { stream_seq: 7, reason: "invalid payload" } },
  { id: "a3", kind: "max_deliveries", stream: "PAYMENTS", consumer: "settle", streamSeq: 900, deliveries: 5, timestamp: new Date().toISOString(), raw: {} },
]), 300);
window.__MOCK__ = {
  ready: () => ({ listening: true, connected: true }),
  getMessage: ({ stream, seq }) => {
    if (stream === "PAYMENTS") return null;
    const body = JSON.stringify({ id: seq, customer: "c3", total: 12.5 });
    return { id: "x" + seq, subject: "orders.eu.created", seq, time: new Date().toISOString(), headers: [["Nats-Msg-Id", "o" + seq]], data: btoa(body), size: body.length };
  },
  republish: ({ stream }) => ({ subject: "orders.eu.created", stream, seq: 151, duplicate: false }),
  deleteMessage: () => ({ deleted: true }),
};
