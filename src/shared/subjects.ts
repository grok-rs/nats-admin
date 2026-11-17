// NATS subject matching helpers ('*' = one token, '>' = one or more trailing tokens).

export function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return s.length > i;
    if (i >= s.length) return false;
    if (p[i] !== "*" && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

/** True when at least one concrete subject matches both patterns. */
export function subjectsOverlap(a: string, b: string): boolean {
  const x = a.split(".");
  const y = b.split(".");
  for (let i = 0; ; i++) {
    const xa = x[i];
    const yb = y[i];
    if (xa === undefined && yb === undefined) return true;
    if (xa === ">") return yb !== undefined;
    if (yb === ">") return xa !== undefined;
    if (xa === undefined || yb === undefined) return false;
    if (xa !== "*" && yb !== "*" && xa !== yb) return false;
  }
}

/** Replace wildcards with editable placeholders for a publish subject suggestion. */
export function concreteSubject(pattern: string): string {
  return pattern
    .split(".")
    .map((t) => (t === "*" ? "x" : t === ">" ? "test" : t))
    .join(".");
}
