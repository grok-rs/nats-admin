// Mock host for the design-system gallery (node scripts/harness.mjs gallery).
// Simulates a NATS server's cumulative /varz-style counters: 15 minutes of history at 2s
// (including one server restart, so the charts show the counter-reset gap) plus a live
// `stats` RPC that keeps advancing the simulation.
(function () {
  let seed = 20261117;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const STEP = 2000;
  const now = Date.now();
  const start = now - 15 * 60_000;
  const restartAt = start + 9 * 60_000 + 7000;
  const c = { in_msgs: 912_345_678, out_msgs: 744_110_002, in_bytes: 301_442_000_000, out_bytes: 247_002_000_000 };
  const consumers = { billing: 12, shipping: 140, analytics: 30 };
  let restarted = false;

  function rate(t) {
    const phase = ((t - start) / 360_000) * Math.PI * 2;
    let r = 4200 + 1400 * Math.sin(phase) + (rnd() - 0.5) * 700;
    const sinceStart = (t - start) / 60_000;
    if (sinceStart > 12.2 && sinceStart < 12.7) r += 3800; // burst
    return Math.max(0, r);
  }

  function sample(t, dt) {
    if (!restarted && t >= restartAt) {
      restarted = true;
      c.in_msgs = 1200;
      c.out_msgs = 900;
      c.in_bytes = 400_000;
      c.out_bytes = 310_000;
    } else {
      const r = rate(t);
      c.in_msgs += Math.round((r * dt) / 1000);
      c.out_msgs += Math.round((r * 0.82 * dt) / 1000);
      c.in_bytes += Math.round((r * 338 * dt) / 1000);
      c.out_bytes += Math.round((r * 0.82 * 296 * dt) / 1000);
    }
    consumers.billing = Math.max(0, Math.round(consumers.billing + (rnd() - 0.5) * 10));
    consumers.shipping = Math.max(0, Math.round(consumers.shipping + 6 + (rnd() - 0.35) * 30));
    consumers.analytics = Math.max(0, Math.round(rnd() < 0.08 ? 600 + rnd() * 900 : consumers.analytics * 0.7 + rnd() * 20));
    return {
      t,
      counters: { ...c },
      gauges: {
        connections: Math.round(180 + 22 * Math.sin((t - start) / 200_000) + rnd() * 6),
        cpu: Math.round((18 + 9 * Math.sin((t - start) / 150_000) + rnd() * 4) * 10) / 10,
        mem: 412_000_000 + Math.round((t - start) / 1000) * 9000 + Math.round(rnd() * 4_000_000),
        rtt: Math.round((0.35 + rnd() * 0.5 + (rnd() < 0.05 ? 3 : 0)) * 1000) / 1000,
      },
      pending: { ...consumers },
    };
  }

  const history = [];
  for (let t = start; t <= now; t += STEP) history.push(sample(t, STEP));
  let lastT = history[history.length - 1].t;

  window.__MOCK_INIT__ = { history, stepMs: STEP, server: { name: "nats-eu-1", version: "2.14.4", url: "nats://nats-eu-1.internal:4222" } };
  window.__MOCK__ = {
    stats() {
      const t = Date.now();
      const s = sample(t, Math.max(250, t - lastT));
      lastT = t;
      return s;
    },
    ping() {
      return { ok: true, rttMs: 0.42 };
    },
  };
})();
