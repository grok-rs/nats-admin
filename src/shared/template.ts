// Payload/subject templates: {{uuid}}, {{seq}}, {{timestamp}}, {{unix}},
// {{unixMs}}, {{random}}, {{random:min:max}}, {{randomString:n}}, {{date}}.

export interface TemplateContext {
  /** 1-based sequence number (e.g. index within a burst). */
  seq: number;
  /** Optional extra variables, referenced as {{name}}. */
  vars?: Record<string, string>;
  now?: Date;
}

export const TEMPLATE_HELP = [
  ["{{uuid}}", "random UUID v4"],
  ["{{seq}}", "1-based counter (per burst)"],
  ["{{timestamp}}", "ISO-8601 time"],
  ["{{date}}", "YYYY-MM-DD"],
  ["{{unix}}", "seconds since epoch"],
  ["{{unixMs}}", "milliseconds since epoch"],
  ["{{random}}", "random integer 0–999999"],
  ["{{random:1:100}}", "random integer in range"],
  ["{{randomString:12}}", "random alphanumeric string"],
] as const;

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function uuid(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback (should not be needed on Node 20 / Chromium).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function hasTemplate(s: string): boolean {
  return /\{\{\s*[\w:.-]+\s*\}\}/.test(s);
}

export function renderTemplate(input: string, ctx: TemplateContext): string {
  const now = ctx.now ?? new Date();
  return input.replace(/\{\{\s*([\w.-]+)((?::[^}:]*)*)\s*\}\}/g, (whole, name: string, rest: string) => {
    const args = rest ? rest.slice(1).split(":") : [];
    switch (name) {
      case "uuid":
        return uuid();
      case "seq":
        return String(ctx.seq);
      case "timestamp":
        return now.toISOString();
      case "date":
        return now.toISOString().slice(0, 10);
      case "unix":
        return String(Math.floor(now.getTime() / 1000));
      case "unixMs":
        return String(now.getTime());
      case "random": {
        const min = args[0] !== undefined ? Number(args[0]) : 0;
        const max = args[1] !== undefined ? Number(args[1]) : 999999;
        return Number.isFinite(min) && Number.isFinite(max) ? String(randInt(min, max)) : whole;
      }
      case "randomString": {
        const n = Math.max(1, Math.min(4096, Number(args[0] ?? 16) || 16));
        let s = "";
        for (let i = 0; i < n; i++) s += ALNUM[randInt(0, ALNUM.length - 1)];
        return s;
      }
      default:
        return ctx.vars && name in ctx.vars ? ctx.vars[name] : whole;
    }
  });
}
