// Parser for `.nats` playbook files — reusable, runnable NATS requests kept in
// the workspace (the VS Code equivalent of NATS Studio's "Saved Requests").
//
//   @connection local            (optional file-level default connection)
//
//   ### Create an order
//   PUB orders.eu.created count=3
//   Nats-Msg-Id: {{uuid}}
//
//   {"id": {{seq}}, "total": 12.5}
//
//   ### Ask for a quote
//   REQ billing.quote timeout=3000
//   {"sku": "A1"}
//
//   ### Watch shipments
//   SUB orders.*.shipped count=10 timeout=30000

export type PlaybookVerb = "PUB" | "REQ" | "SUB";

export interface PlaybookBlock {
  name?: string;
  verb: PlaybookVerb;
  subject: string;
  options: Record<string, string>;
  headers: [string, string][];
  body: string;
  /** 0-based line of the verb line. */
  line: number;
  /** 0-based first and last line covered by the block (inclusive). */
  startLine: number;
  endLine: number;
  /** Per-block connection override (`connection=` option). */
  connection?: string;
}

export interface PlaybookFile {
  connection?: string;
  connectionLine?: number;
  blocks: PlaybookBlock[];
  errors: { line: number; message: string }[];
}

const VERB_RE = /^(PUB|PUBLISH|REQ|REQUEST|SUB|SUBSCRIBE)\s+(\S+)(.*)$/i;
const HEADER_RE = /^([A-Za-z0-9][A-Za-z0-9_.\-]*)\s*:\s?(.*)$/;
const OPTION_RE = /([A-Za-z_]+)=("[^"]*"|\S+)/g;

function normalizeVerb(v: string): PlaybookVerb {
  const u = v.toUpperCase();
  if (u.startsWith("PUB")) return "PUB";
  if (u.startsWith("REQ")) return "REQ";
  return "SUB";
}

function isComment(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("#") && !t.startsWith("###") ? true : t.startsWith("//");
}

export function parsePlaybook(text: string): PlaybookFile {
  const lines = text.split(/\r?\n/);
  const result: PlaybookFile = { blocks: [], errors: [] };

  // Split into sections at "###" separators; content before the first
  // separator is also a section (so a single-request file needs no header).
  type Section = { name?: string; start: number; end: number };
  const sections: Section[] = [];
  let cur: Section = { start: 0, end: lines.length - 1 };
  lines.forEach((l, i) => {
    if (l.startsWith("###")) {
      cur.end = i - 1;
      sections.push(cur);
      cur = { name: l.replace(/^#+/, "").trim() || undefined, start: i, end: lines.length - 1 };
    }
  });
  sections.push(cur);

  for (const sec of sections) {
    let i = sec.name !== undefined || lines[sec.start]?.startsWith("###") ? sec.start + 1 : sec.start;
    // Skip blanks, comments and file directives until the verb line.
    let verbLine = -1;
    for (; i <= sec.end; i++) {
      const l = lines[i];
      const t = l.trim();
      if (!t || isComment(l)) continue;
      const dir = /^@connection\s+(.+)$/i.exec(t);
      if (dir) {
        result.connection = dir[1].trim();
        result.connectionLine = i;
        continue;
      }
      verbLine = i;
      break;
    }
    if (verbLine < 0) continue;
    const m = VERB_RE.exec(lines[verbLine].trim());
    if (!m) {
      result.errors.push({ line: verbLine, message: "Expected `PUB <subject>`, `REQ <subject>` or `SUB <subject>`" });
      continue;
    }
    const options: Record<string, string> = {};
    for (const om of m[3].matchAll(OPTION_RE)) options[om[1].toLowerCase()] = om[2].replace(/^"|"$/g, "");

    const headers: [string, string][] = [];
    let j = verbLine + 1;
    // Headers: consecutive `Name: value` lines directly after the verb line.
    for (; j <= sec.end; j++) {
      const l = lines[j];
      if (!l.trim()) {
        j++;
        break;
      }
      const hm = HEADER_RE.exec(l);
      // A JSON-ish line such as `{"a": 1}` or `"x": 1` is body, not a header.
      if (!hm || /^[{["]/.test(l.trim())) break;
      headers.push([hm[1], hm[2]]);
    }
    const bodyLines = lines.slice(j, sec.end + 1);
    // Drop trailing blank lines and trailing comment-only lines.
    while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop();
    // Leading blank lines too.
    while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift();

    result.blocks.push({
      name: sec.name,
      verb: normalizeVerb(m[1]),
      subject: m[2],
      options,
      headers,
      body: bodyLines.join("\n"),
      line: verbLine,
      startLine: sec.start,
      endLine: sec.end,
      connection: options.connection,
    });
  }
  return result;
}

export const PLAYBOOK_SAMPLE = `# NATS Playbook — click the CodeLens above a request to run it.
# Templates: {{uuid}} {{seq}} {{timestamp}} {{unix}} {{random:1:100}} {{randomString:8}}
# Options: count=N (PUB repeats / SUB stops after N), timeout=ms, reply=<subject>, connection=<name>

@connection local

### Publish a JSON event (3 times)
PUB orders.eu.created count=3
Nats-Msg-Id: {{uuid}}
Content-Type: application/json

{
  "id": {{seq}},
  "createdAt": "{{timestamp}}",
  "total": {{random:10:500}}
}

### Request / reply
REQ time.now timeout=2000
{"tz": "UTC"}

### Watch matching subjects (stops after 5 messages or 30s)
SUB orders.> count=5 timeout=30000
`;
