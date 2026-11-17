// Command argument parsing for the insights commands (pure: unit tested).

/** Argument of nats.browseSubject (also carried by every subject tree node as `target`). */
export interface SubjectTarget {
  connId: string;
  stream: string;
  /** Message Browser filter; undefined = the whole stream. */
  filter?: string;
}

/**
 * Resolve a nats.browseSubject argument: a subject tree node (`target`), { connId, stream, filter }
 * or { connId, stream, subject } (also `profileId` / `profile.id` for the connection).
 */
export function subjectTargetOf(arg: unknown): SubjectTarget | undefined {
  if (!arg || typeof arg !== "object") return undefined;
  const t = (arg as { target?: unknown }).target ?? arg;
  if (!t || typeof t !== "object") return undefined;
  const { stream, filter, subject } = t as Partial<SubjectTarget> & { subject?: unknown };
  const connId = connIdOf(t);
  if (!connId || typeof stream !== "string" || !stream) return undefined;
  const raw = typeof filter === "string" ? filter : typeof subject === "string" ? subject : "";
  const f = raw.trim();
  return { connId, stream, filter: f && f !== ">" ? f : undefined };
}

/** Connection id of a command argument: `connId`, `profileId` or `profile.id`. */
function connIdOf(a: object): string | undefined {
  const o = a as { connId?: unknown; profileId?: unknown; profile?: { id?: unknown } };
  if (typeof o.connId === "string" && o.connId) return o.connId;
  if (typeof o.profileId === "string" && o.profileId) return o.profileId;
  if (typeof o.profile?.id === "string" && o.profile.id) return o.profile.id;
  return undefined;
}

/** nats-node://<connId>/stream/<name> or /consumer/<stream>/<name> (explorer resourceUri, duck-typed vscode.Uri). */
function streamOfNodeUri(a: { scheme?: unknown; authority?: unknown; path?: unknown }): { connId?: string; stream?: string } | undefined {
  if (a.scheme !== "nats-node" || typeof a.authority !== "string" || typeof a.path !== "string") return undefined;
  const m = /^\/(?:stream|consumer)\/([^/]+)/.exec(a.path);
  let stream: string | undefined;
  try {
    stream = m ? decodeURIComponent(m[1]) : undefined;
  } catch {
    stream = m?.[1];
  }
  return { connId: a.authority || undefined, stream };
}

/**
 * Stream argument: an explorer StreamNode (connId + info.config.name), the Subjects folder or a
 * consumer node (connId + stream), { connId | profileId, stream }, a nats-node:// stream URI or a
 * profile id.
 */
export function streamArgOf(arg: unknown): { connId?: string; stream?: string } {
  if (typeof arg === "string") return { connId: arg };
  if (!arg || typeof arg !== "object") return {};
  const uri = streamOfNodeUri(arg as { scheme?: unknown });
  if (uri) return uri;
  const a = arg as { stream?: unknown; info?: { config?: { name?: unknown } } };
  const stream = typeof a.stream === "string" && a.stream ? a.stream : typeof a.info?.config?.name === "string" ? a.info.config.name : undefined;
  return { connId: connIdOf(arg), stream };
}
