// Data transfer objects exchanged between the extension host and webviews.
// Binary payloads always travel base64-encoded.

export interface MessageDTO {
  /** Unique id within a panel session. */
  id: string;
  subject: string;
  reply?: string;
  /** Stream sequence for JetStream messages. */
  seq?: number;
  /** ISO timestamp (server time for stored messages, receive time otherwise). */
  time: string;
  headers: [string, string][];
  /** Base64 payload. */
  data: string;
  size: number;
  /** Status code for no-responders / service errors etc. */
  status?: string;
  deliveryCount?: number;
  redelivered?: boolean;
  pending?: number;
  /** For Live Tail: which subscription delivered it. */
  subId?: string;
  /** For Consumer Lab: ack state chosen by the user. */
  ackState?: "pending" | "ack" | "nak" | "term" | "working";
}

export interface KvEntryDTO {
  key: string;
  revision: number;
  created: string;
  operation: "PUT" | "DEL" | "PURGE";
  size: number;
  /** Base64 value (may be omitted for very large values when listing). */
  data?: string;
  truncated?: boolean;
  delta?: number;
}

export interface KvBucketDTO {
  bucket: string;
  values: number;
  history: number;
  ttlMs: number;
  bytes: number;
  storage: string;
  replicas: number;
  description?: string;
}

export interface PublishRequest {
  subject: string;
  data: string; // base64
  headers: [string, string][];
  reply?: string;
}

export type RpcRequest = { kind: "req"; id: number; method: string; params?: unknown };
export type RpcResponse = { kind: "res"; id: number; ok: true; result: unknown } | { kind: "res"; id: number; ok: false; error: string };
export type RpcEvent = { kind: "evt"; event: string; data: unknown };
export type HostMessage = RpcResponse | RpcEvent;
