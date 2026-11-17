// Unit tests for the design-system chart maths (webview/lib/charts pure modules).
import { test } from "node:test";
import assert from "node:assert/strict";
import { extent, fmtSpan, fmtTimeTick, linearScale, niceDomain, niceNum, niceTicks, timeTicks, TIME_STEPS } from "../webview/lib/charts/scale";
import { counterRate, decimate, lastValue, medianInterval, nearestIndex, RateTracker, relativeChange, RingBuffer, seriesStats, TimeSeriesBuffer, type TimePoint } from "../webview/lib/charts/series";
import { arcPath, bucketize, histogram, polar, quantile, shares, squarify, truncateToWidth } from "../webview/lib/charts/layout";
import { compact, durationParts, formatDeltaPercent, formatParts, formatValue, resolveUnit } from "../webview/lib/charts/units";
import { colorOf, healthLabel, healthTone, sequentialColor, seriesColor, toneColor, usageTone } from "../webview/lib/charts/palette";

test("niceNum picks 1/2/2.5/5 multiples", () => {
  assert.equal(niceNum(0.7, true), 0.5);
  assert.equal(niceNum(1.2, true), 1);
  assert.equal(niceNum(1.8, true), 2);
  assert.equal(niceNum(3, true), 2.5);
  assert.equal(niceNum(42, true), 50);
  assert.equal(niceNum(42, false), 50);
  assert.equal(niceNum(0, true), 1);
});

test("niceTicks covers the range with clean steps", () => {
  assert.deepEqual(niceTicks(0, 1000, 5), [0, 200, 400, 600, 800, 1000]);
  assert.deepEqual(niceTicks(0, 87, 4), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(niceTicks(0, 87, 3), [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks(0, 0.3, 3), [0, 0.1, 0.2, 0.3]);
  const t = niceTicks(-12, 37, 5);
  assert.ok(t[0] <= -12 && t[t.length - 1] >= 37);
  // Degenerate ranges never produce an empty axis.
  assert.deepEqual(niceTicks(0, 0, 4), [0, 0.25, 0.5, 0.75, 1]);
  assert.ok(niceTicks(5, 5, 4).length >= 2);
  assert.deepEqual(niceDomain(3, 97, 5), [0, 100]);
});

test("binary niceTicks align to KiB/MiB multiples", () => {
  const ticks = niceTicks(0, 3.2 * 1024 * 1024, 4, { binary: true });
  assert.deepEqual(ticks, [0, 1, 2, 3, 4].map((x) => x * 1024 * 1024));
  const k = niceTicks(0, 900 * 1024, 3, { binary: true });
  assert.equal(k[1] % 1024, 0);
});

test("linear scale maps and inverts", () => {
  const s = linearScale([0, 100], [200, 0]);
  assert.equal(s(0), 200);
  assert.equal(s(50), 100);
  assert.equal(s.invert(100), 50);
  assert.equal(linearScale([5, 5], [0, 10])(5), 0);
  assert.deepEqual(extent([3, null, -2, NaN, 9, undefined]), [-2, 9]);
  assert.equal(extent([null, NaN]), undefined);
});

test("time ticks align to wall-clock steps and respect max count", () => {
  const start = new Date(2026, 10, 17, 12, 0, 7).getTime();
  const { ticks, step } = timeTicks(start, start + 5 * 60_000, 6);
  assert.equal(step, 60_000);
  assert.ok(ticks.length <= 6 && ticks.length >= 4);
  for (const t of ticks) assert.equal(new Date(t).getSeconds(), 0);
  const hour = timeTicks(start, start + 3 * 3600_000, 4);
  assert.equal(hour.step, 3600_000);
  for (const t of hour.ticks) assert.equal(new Date(t).getMinutes(), 0);
  assert.equal(fmtTimeTick(new Date(2026, 0, 1, 9, 5, 3).getTime(), 10_000), "09:05:03");
  assert.equal(fmtTimeTick(new Date(2026, 0, 1, 9, 5, 3).getTime(), 300_000), "09:05");
  assert.deepEqual(timeTicks(10, 5).ticks, []);
  assert.ok(TIME_STEPS.every((s, i) => i === 0 || s > TIME_STEPS[i - 1]));
  assert.equal(fmtSpan(90_000), "1m 30s");
  assert.equal(fmtSpan(3600_000), "1h");
});

test("ring buffer keeps the newest N items", () => {
  const rb = new RingBuffer<number>(3);
  assert.equal(rb.last(), undefined);
  for (let i = 1; i <= 5; i++) rb.push(i);
  assert.deepEqual(rb.toArray(), [3, 4, 5]);
  assert.equal(rb.length, 3);
  assert.equal(rb.first(), 3);
  assert.equal(rb.last(), 5);
  assert.equal(rb.at(-2), 4);
  assert.deepEqual([...rb], [3, 4, 5]);
  rb.clear();
  assert.equal(rb.length, 0);
  assert.throws(() => new RingBuffer(0));
});

test("counter rates per second, with reset handling", () => {
  assert.equal(counterRate(undefined, { t: 0, v: 5 }), undefined);
  assert.equal(counterRate({ t: 0, v: 100 }, { t: 2000, v: 300 }), 100);
  assert.equal(counterRate({ t: 0, v: 100 }, { t: 0, v: 300 }), undefined, "dt = 0");
  assert.equal(counterRate({ t: 0, v: 500 }, { t: 1000, v: 20 }), null, "reset → gap");
  assert.equal(counterRate({ t: 0, v: 500 }, { t: 2000, v: 20 }, "restart"), 10, "reset → restart from 0");

  const rt = new RateTracker<"in" | "out">();
  assert.deepEqual(rt.update(1000, { in: 10, out: 5 }), {});
  assert.deepEqual(rt.update(2000, { in: 60, out: 5 }), { in: 50, out: 0 });
  assert.deepEqual(rt.update(3000, { in: 3, out: 7 }), { in: null, out: 2 });
  assert.deepEqual(rt.update(4000, { in: 13 }), { in: 10 });
  // Out-of-order sample does not move the baseline backwards.
  assert.deepEqual(rt.update(3500, { in: 20 }), {});
  assert.deepEqual(rt.update(5000, { in: 23 }), { in: 10 });
});

test("time-series buffer stores rates and windows", () => {
  const b = new TimeSeriesBuffer<"msgs" | "cpu">(4);
  assert.equal(b.pushCounters(0, { msgs: 0 }), false);
  b.pushCounters(1000, { msgs: 100 });
  b.pushCounters(2000, { msgs: 300 });
  b.push(2000, { cpu: 12.5 });
  b.pushCounters(3000, { msgs: 350 });
  assert.deepEqual(
    b.series("msgs").map((p) => p.v),
    [100, 200, 50],
  );
  assert.equal(b.length, 4);
  assert.equal(b.last("msgs"), 50);
  assert.equal(b.previous("msgs"), 200);
  assert.equal(b.last("cpu"), 12.5);
  assert.deepEqual(b.series("cpu"), [{ t: 2000, v: 12.5 }]);
  assert.deepEqual(
    b.series("msgs", 500).map((p) => p.v),
    [50],
  );
  assert.equal(b.stats("msgs")?.max, 200);
  b.push(4000, { cpu: Number.NaN });
  assert.deepEqual(b.series("cpu").at(-1), { t: 4000, v: null });
  b.clear();
  assert.equal(b.length, 0);
});

test("series helpers: stats, last value, nearest index, relative change", () => {
  const pts: TimePoint[] = [
    { t: 0, v: 4 },
    { t: 10, v: null },
    { t: 20, v: 10 },
    { t: 30, v: 1 },
  ];
  assert.deepEqual(seriesStats(pts), { min: 1, max: 10, avg: 5, last: 1, count: 3 });
  assert.equal(seriesStats([]), undefined);
  assert.equal(lastValue([...pts, { t: 40, v: null }]), 1);
  assert.equal(nearestIndex(pts, 14), 1);
  assert.equal(nearestIndex(pts, 16), 2);
  assert.equal(nearestIndex(pts, -5), 0);
  assert.equal(nearestIndex(pts, 99), 3);
  assert.equal(nearestIndex([], 1), -1);
  assert.equal(relativeChange(110, 100), 0.1);
  assert.equal(relativeChange(5, 0), undefined);
  assert.equal(medianInterval(pts), 10);
});

test("decimate keeps spikes and bounds the point count", () => {
  const pts: TimePoint[] = Array.from({ length: 10_000 }, (_, i) => ({ t: i * 1000, v: i === 4321 ? 999 : Math.sin(i / 50) }));
  const d = decimate(pts, 400);
  assert.ok(d.length <= 400, `got ${d.length}`);
  assert.ok(d.some((p) => p.v === 999), "spike survives");
  for (let i = 1; i < d.length; i++) assert.ok(d[i].t >= d[i - 1].t, "time stays ordered");
  const withGap = decimate([...pts.slice(0, 5000), { t: 5_000_500, v: null }, ...pts.slice(5000)], 400);
  assert.ok(withGap.some((p) => p.v === null), "gap survives");
  assert.equal(decimate(pts.slice(0, 10), 400).length, 10);
});

test("squarify tiles the whole rectangle without overlap", () => {
  const items = [6, 6, 4, 3, 2, 2, 1].map((v, i) => ({ id: `n${i}`, v }));
  const rect = { x: 0, y: 0, w: 600, h: 400 };
  const out = squarify(items, (d) => d.v, rect);
  assert.equal(out.length, 7);
  const area = out.reduce((a, r) => a + r.w * r.h, 0);
  assert.ok(Math.abs(area - 600 * 400) < 1e-6);
  const total = items.reduce((a, d) => a + d.v, 0);
  for (const r of out) {
    assert.ok(Math.abs((r.w * r.h) / (600 * 400) - r.item.v / total) < 1e-9, "area proportional to value");
    assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 600 + 1e-6 && r.y + r.h <= 400 + 1e-6);
  }
  for (let i = 0; i < out.length; i++)
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i];
      const b = out[j];
      const overlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      assert.ok(overlap < 1e-6, "no overlap");
    }
  // Aspect ratios stay reasonable for a squarified layout.
  const worst = Math.max(...out.map((r) => Math.max(r.w / r.h, r.h / r.w)));
  assert.ok(worst < 4, `worst aspect ${worst}`);
  assert.deepEqual(squarify([{ v: 0 }], (d) => d.v, rect), []);
  assert.equal(squarify(items, (d) => d.v, rect)[0].index, 0);
});

test("histogram bins with nice edges and quantiles", () => {
  const values = Array.from({ length: 1000 }, (_, i) => (i % 100) + 0.5);
  const bins = histogram(values, { bins: 10 });
  assert.equal(bins.reduce((a, b) => a + b.count, 0), 1000);
  assert.equal(bins[0].x0, 0);
  assert.equal(bins.at(-1)!.x1, 100);
  for (const b of bins) assert.equal(b.x1 - b.x0, 10);
  const auto = histogram(values);
  assert.ok(auto.length >= 5 && auto.length <= 60);
  assert.deepEqual(histogram([]), []);
  const one = histogram([5, 5, 5]);
  assert.equal(one.reduce((a, b) => a + b.count, 0), 3);
  const clamped = histogram([-10, 1, 2, 50], { bins: 2, domain: [0, 10], nice: false });
  assert.deepEqual(
    clamped.map((b) => b.count),
    [3, 1],
  );
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(quantile(sorted, 0.5), 5.5);
  assert.equal(quantile(sorted, 0), 1);
  assert.equal(quantile(sorted, 1), 10);
  assert.equal(quantile([], 0.5), undefined);
});

test("bucketize fills every bucket", () => {
  const b = bucketize([1000, 1500, 2500, 9999, 10_000, 500], { start: 1000, end: 4000, bucketMs: 1000 });
  assert.deepEqual(
    b.map((p) => p.v),
    [2, 1, 0],
  );
  assert.deepEqual(
    b.map((p) => p.t),
    [1000, 2000, 3000],
  );
  const sum = bucketize(
    [
      { t: 0, v: 3 },
      { t: 10, v: 4 },
    ],
    { start: 0, end: 20, bucketMs: 20, agg: "sum" },
  );
  assert.equal(sum[0].v, 7);
  const max = bucketize(
    [
      { t: 0, v: 3 },
      { t: 10, v: 4 },
    ],
    { start: 0, end: 20, bucketMs: 20, agg: "max" },
  );
  assert.equal(max[0].v, 4);
  assert.deepEqual(bucketize([1], { start: 0, end: 0, bucketMs: 1 }), []);
});

test("arc paths and polar coordinates", () => {
  const [x, y] = polar(50, 50, 10, Math.PI / 2);
  assert.ok(Math.abs(x - 50) < 1e-9 && Math.abs(y - 40) < 1e-9, "π/2 is 12 o'clock");
  const p = arcPath(50, 50, 30, 40, Math.PI, 0);
  assert.match(p, /^M10,50A40,40 0 0 1 90,50L80,50A30,30 0 0 0 20,50Z$/);
  assert.ok(arcPath(0, 0, 5, 10, 0, Math.PI * 2).includes("Z"));
  assert.ok(arcPath(0, 0, 0, 10, 0, 1).startsWith("M0,0L"));
});

test("text truncation and shares", () => {
  assert.equal(truncateToWidth("orders", 200), "orders");
  const t = truncateToWidth("orders.eu.created.v2", 50);
  assert.ok(t.endsWith("…") && t.length < 20);
  assert.equal(truncateToWidth("abc", 3), "");
  assert.deepEqual(shares([1, 3]), [0.25, 0.75]);
  assert.deepEqual(shares([0, 0]), [0, 0]);
  assert.deepEqual(shares([1, 1], 4), [0.25, 0.25]);
});

test("unit formatting", () => {
  assert.equal(compact(1284), "1,284");
  assert.equal(compact(12_900), "12.9k");
  assert.equal(compact(3_400_000), "3.4M");
  assert.equal(compact(2.345), "2.35");
  assert.equal(formatValue(4100, "msgs/s"), "4,100 msgs/s");
  assert.equal(formatValue(41_000, "msgs/s"), "41k msgs/s");
  assert.equal(formatValue(18.2 * 1024 * 1024, "bytes"), "18.2 MiB");
  assert.equal(formatValue(1536, "bytes/s"), "1.5 KiB/s");
  assert.deepEqual(formatParts(1536, "bytes/s"), { value: "1.5", unit: "KiB/s" });
  assert.equal(formatValue(0.312, "ms"), "312 µs");
  assert.equal(formatValue(4.25, "ms"), "4.25 ms");
  assert.equal(formatValue(1500, "ms"), "1.5 s");
  assert.equal(formatValue(200_000, "ms"), "3m 20s");
  assert.equal(formatValue(2_000_000, "ns"), "2 ms");
  assert.equal(formatValue(62.4, "percent"), "62%");
  assert.equal(formatValue(0.054, "ratio"), "5.4%");
  assert.equal(formatValue(12, "req/s"), "12 req/s");
  assert.equal(formatValue(null, "bytes"), "–");
  assert.equal(formatValue(Number.NaN), "–");
  assert.equal(formatValue(-1, "bytes"), "∞");
  assert.equal(resolveUnit("msgs/s").axisLabel, "msgs/s");
  assert.equal(resolveUnit("bytes").binary, true);
  assert.equal(resolveUnit("msgs/s").tick(1500), "1.5k");
  assert.equal(resolveUnit({ format: (v) => `${v}x` }).tick(3), "3x");
  assert.deepEqual(durationParts(0), { value: "0", unit: "ms" });
  assert.equal(formatDeltaPercent(0.1234), "+12.3%");
  assert.equal(formatDeltaPercent(-0.5), "−50%");
  assert.equal(formatDeltaPercent(0), "±0%");
});

test("palette: fixed slots, no cycling, tones and health", () => {
  assert.equal(seriesColor(0), "var(--series-1)");
  assert.equal(seriesColor(7), "var(--series-8)");
  assert.equal(seriesColor(8), "var(--series-other)", "9th series folds into other");
  assert.equal(seriesColor(-1), "var(--series-other)");
  assert.equal(toneColor("danger"), "var(--danger)");
  assert.equal(toneColor(undefined), "var(--tone-neutral)");
  assert.equal(colorOf({ tone: "warn" }, 3), "var(--warn)");
  assert.equal(colorOf({ color: "red", tone: "warn" }, 3), "red");
  assert.equal(colorOf({ slot: 2 }, 0), "var(--series-3)");
  assert.equal(colorOf({}, 1), "var(--series-2)");
  assert.equal(healthTone(95), "ok");
  assert.equal(healthTone(90), "ok");
  assert.equal(healthTone(75), "warn");
  assert.equal(healthTone(12), "danger");
  assert.equal(healthTone(undefined), "neutral");
  assert.equal(healthTone(80, { ok: 80, warn: 50 }), "ok");
  assert.equal(healthLabel(65), "Degraded");
  assert.equal(usageTone(0.5), "ok");
  assert.equal(usageTone(0.8), "warn");
  assert.equal(usageTone(0.95), "danger");
  assert.equal(usageTone(0.05, 0.75, 0.9, false), "danger", "low free space is bad");
  assert.equal(sequentialColor(0), "var(--vz-empty)");
  assert.match(sequentialColor(1), /100%/);
});
