// Human-friendly formatting helpers shared by the tree, info docs and webviews.

export function fmtBytes(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "–";
  if (n < 0) return "∞";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function fmtNumber(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "–";
  return n.toLocaleString("en-US");
}

/** Compact number: 1.2k, 3.4M. */
export function fmtCompact(n: number): string {
  if (Math.abs(n) < 1000) return String(Math.round(n * 10) / 10);
  const units = ["k", "M", "G", "T"];
  let v = n;
  let i = -1;
  while (Math.abs(v) >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)}${units[i]}`;
}

/** Format a duration given in nanoseconds (JetStream config unit). 0 → "∞". */
export function fmtNanos(ns: number | undefined): string {
  if (!ns) return "∞";
  return fmtMillis(ns / 1e6);
}

export function fmtMillis(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(2) : ms.toFixed(0)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s % 1 === 0 ? s : s.toFixed(1)}s`;
  const parts: string[] = [];
  let rem = Math.round(s);
  const d = Math.floor(rem / 86400);
  rem -= d * 86400;
  const h = Math.floor(rem / 3600);
  rem -= h * 3600;
  const m = Math.floor(rem / 60);
  rem -= m * 60;
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (rem && !d) parts.push(`${rem}s`);
  return parts.join("");
}

/** Relative time like "5s ago" / "3d ago". */
export function fmtAgo(date: Date | string | undefined, now = Date.now()): string {
  if (!date) return "–";
  const t = typeof date === "string" ? Date.parse(date) : date.getTime();
  if (!Number.isFinite(t)) return "–";
  const diff = now - t;
  if (diff < 0) return "just now";
  return `${fmtMillis(diff).replace(/\.\d+/, "")} ago`;
}

/** Parse "30s", "5m", "1h30m", "2d", "500ms" or a plain number of seconds into milliseconds. */
export function parseDuration(input: string): number | undefined {
  const s = input.trim().toLowerCase();
  if (!s) return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)/g;
  let total = 0;
  let matched = "";
  let m: RegExpExecArray | null;
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, y: 31_536_000_000 };
  while ((m = re.exec(s))) {
    total += Number(m[1]) * mult[m[2]];
    matched += m[0];
  }
  return matched.length === s.replace(/\s+/g, "").length ? total : undefined;
}
