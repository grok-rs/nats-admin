// Conversions from nats.js message types into webview-friendly DTOs.

import { headers as mkHeaders, type Msg, type MsgHdrs } from "@nats-io/nats-core";
import type { JsMsg, StoredMsg } from "@nats-io/jetstream";
import type { MessageDTO, PublishRequest } from "../shared/dto";
import { base64ToBytes, bytesToBase64 } from "../shared/encoding";

let counter = 0;
export const nextId = (): string => (++counter).toString(36);

export function headersToArray(h?: MsgHdrs): [string, string][] {
  if (!h) return [];
  const out: [string, string][] = [];
  for (const k of h.keys()) for (const v of h.values(k)) out.push([k, v]);
  return out;
}

export function arrayToHeaders(arr: [string, string][] | undefined): MsgHdrs | undefined {
  const list = (arr ?? []).filter(([k]) => k.trim());
  if (!list.length) return undefined;
  const h = mkHeaders();
  for (const [k, v] of list) h.append(k.trim(), v);
  return h;
}

function statusOf(h?: MsgHdrs): string | undefined {
  if (!h || !h.hasError) return undefined;
  return `${h.code}${h.description ? ` ${h.description}` : ""}`;
}

export function msgToDTO(m: Msg, extra?: Partial<MessageDTO>): MessageDTO {
  return {
    id: nextId(),
    subject: m.subject,
    reply: m.reply || undefined,
    time: new Date().toISOString(),
    headers: headersToArray(m.headers),
    data: bytesToBase64(m.data),
    size: m.data.length,
    status: statusOf(m.headers),
    ...extra,
  };
}

export function jsMsgToDTO(m: JsMsg, extra?: Partial<MessageDTO>): MessageDTO {
  return {
    id: nextId(),
    subject: m.subject,
    seq: m.seq,
    time: m.time.toISOString(),
    headers: headersToArray(m.headers),
    data: bytesToBase64(m.data),
    size: m.data.length,
    deliveryCount: m.info.deliveryCount,
    redelivered: m.redelivered,
    pending: m.info.pending,
    ...extra,
  };
}

export function storedMsgToDTO(m: StoredMsg): MessageDTO {
  return {
    id: nextId(),
    subject: m.subject,
    seq: m.seq,
    time: m.time.toISOString(),
    headers: headersToArray(m.header),
    data: bytesToBase64(m.data),
    size: m.data.length,
  };
}

export function decodePublish(req: PublishRequest): { subject: string; data: Uint8Array; headers?: MsgHdrs; reply?: string } {
  return {
    subject: req.subject.trim(),
    data: base64ToBytes(req.data),
    headers: arrayToHeaders(req.headers),
    reply: req.reply?.trim() || undefined,
  };
}
