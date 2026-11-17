// Mock host for the Message Browser webview (see scripts/harness.mjs).
(function () {
  const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
  const all = [];
  for (let i = 1; i <= 150; i++) {
    const shipped = i > 120;
    const n = shipped ? i - 120 : i;
    const body = shipped ? `order ${n} shipped` : JSON.stringify({ id: n, customer: "c" + (n % 7), total: n * 3 + 0.5, items: [{ sku: "A" + n, qty: (n % 4) + 1 }] });
    all.push({
      id: "m" + i,
      seq: i,
      subject: shipped ? "orders.us.shipped" : "orders.eu.created",
      time: new Date(Date.UTC(2026, 10, 17, 10, 0, i)).toISOString(),
      headers: shipped ? [] : [["Nats-Msg-Id", "o" + n]],
      data: b64(body),
      size: body.length,
    });
  }
  // binary message
  all.push({ id: "m151", seq: 151, subject: "orders.bin", time: new Date().toISOString(), headers: [], data: "AAEC/wD+", size: 6 });
  const deleted = new Set();
  const match = (f, s) => {
    if (!f) return true;
    const ft = f.split("."), st = s.split(".");
    for (let i = 0; i < ft.length; i++) {
      if (ft[i] === ">") return st.length > i;
      if (st[i] === undefined) return false;
      if (ft[i] !== "*" && ft[i] !== st[i]) return false;
    }
    return ft.length === st.length;
  };
  const live = () => all.filter((m) => !deleted.has(m.seq));
  window.__MOCK_INIT__ = { profileId: "c1", connectionName: "local", stream: "ORDERS", pageSize: 25 };
  window.__MOCK__ = {
    async browse(q) {
      await new Promise((r) => setTimeout(r, 120));
      const msgs = live();
      const firstSeq = msgs[0].seq, lastSeq = msgs[msgs.length - 1].seq;
      const m = msgs.filter((x) => match(q.filter, x.subject));
      let page;
      if (q.direction === "forward") {
        let start = q.seq ?? firstSeq;
        if (q.startTime) start = (msgs.find((x) => x.time >= q.startTime) || { seq: lastSeq + 1 }).seq;
        page = m.filter((x) => x.seq >= start).slice(0, q.limit);
      } else {
        const end = q.seq ?? lastSeq;
        page = m.filter((x) => x.seq <= end).slice(-q.limit);
      }
      const lastMatch = m[m.length - 1], firstMatch = m[0];
      return {
        page: {
          messages: page,
          firstSeq, lastSeq, total: msgs.length,
          atEnd: !page.length || page[page.length - 1].seq >= (lastMatch ? lastMatch.seq : lastSeq),
          atStart: !page.length || page[0].seq <= (firstMatch ? firstMatch.seq : firstSeq),
        },
        summary: {
          name: "ORDERS", subjects: ["orders.>"], storage: "file", retention: "limits", replicas: 1,
          messages: msgs.length, bytes: msgs.reduce((a, x) => a + x.size, 0), firstSeq, lastSeq,
          firstTs: msgs[0].time, lastTs: msgs[msgs.length - 1].time, consumers: 2, numSubjects: 3, numDeleted: deleted.size,
        },
      };
    },
    async deleteMessage({ seq }) { deleted.add(seq); return true; },
    async republish({ message }) { console.log("republish", message.subject); return true; },
    async openJson() { return true; },
    async export({ format, messages }) { console.log("export", format, messages.length); return "/tmp/out." + format; },
    async copy() { return true; },
  };
})();
