// Mock host for the Consumer Lab webview (see scripts/harness.mjs).
(function () {
  const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
  const push = location.hash === "#push";
  let next = 1, ackFloor = 0, delivered = 0, ackPending = 0, redelivered = 0;
  const held = new Map();
  const queue = []; // nak'd seqs for redelivery
  const deliveries = new Map();
  window.__MOCK_INIT__ = { profileId: "c1", connectionName: "local", stream: "ORDERS", consumer: push ? "pushy" : "billing" };
  window.__MOCK__ = {
    async info() {
      return {
        name: push ? "pushy" : "billing", stream: "ORDERS", durable: true, push,
        deliverSubject: push ? "deliver.pushy" : undefined, deliverGroup: push ? "workers" : undefined,
        filterSubjects: push ? [] : ["orders.eu.>"], deliverPolicy: "all", ackPolicy: "explicit", replayPolicy: "instant",
        ackWaitNs: 30e9, maxDeliver: 3, maxAckPending: 100, maxWaiting: 512,
        numPending: Math.max(0, 120 - delivered), numAckPending: ackPending, numRedelivered: redelivered, numWaiting: 0,
        deliveredStreamSeq: delivered, deliveredConsumerSeq: delivered, ackFloorStreamSeq: ackFloor, ackFloorConsumerSeq: ackFloor,
        lastActive: new Date(Date.now() - 4000).toISOString(), streamFirstSeq: 1, streamLastSeq: 150, streamMessages: 150,
        created: "2026-11-17T10:00:00Z",
      };
    },
    async fetch({ batch }) {
      await new Promise((r) => setTimeout(r, 200));
      const out = [];
      while (out.length < batch && (queue.length || next <= 120)) {
        const seq = queue.length ? queue.shift() : next++;
        const dc = (deliveries.get(seq) || 0) + 1;
        deliveries.set(seq, dc);
        if (dc > 1) redelivered++;
        delivered = Math.max(delivered, seq);
        ackPending++;
        const body = JSON.stringify({ id: seq, customer: "c" + (seq % 7), total: seq * 3 + 0.5 });
        const id = "d" + seq + "-" + dc;
        held.set(id, { seq, state: "pending" });
        out.push({ id, seq, subject: "orders.eu.created", time: new Date().toISOString(), headers: [["Nats-Msg-Id", "o" + seq]], data: b64(body), size: body.length, deliveryCount: dc, redelivered: dc > 1, pending: 120 - delivered, ackState: "pending" });
      }
      return { messages: out, warnings: [] };
    },
    async act({ ids, action }) {
      return ids.map((id) => {
        const h = held.get(id);
        if (!h) return { id, state: "pending", error: "Message is no longer held by this session" };
        if (h.state !== "pending" && h.state !== "working") return { id, state: h.state, error: "Already " + h.state };
        if (action !== "working") ackPending--;
        if (action === "nak") queue.push(h.seq);
        if (action === "ack") ackFloor = Math.max(ackFloor, h.seq);
        h.state = action;
        return { id, state: action };
      });
    },
    async forget() { return true; },
    async openLiveTail(p) { console.log("openLiveTail", p.subject, p.queue); return true; },
    async copy() { return true; },
  };
})();
