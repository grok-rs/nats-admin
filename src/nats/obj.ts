// Object Store operations. Pure NATS logic — no vscode imports.

import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { once } from "node:events";
import type { ObjectInfo, ObjectStore, ObjectStoreStatus, Objm } from "@nats-io/obj";

export async function listObjBuckets(objm: Objm): Promise<ObjectStoreStatus[]> {
  const out: ObjectStoreStatus[] = [];
  for await (const s of objm.list()) out.push(s);
  return out.sort((a, b) => a.bucket.localeCompare(b.bucket));
}

export async function listObjects(os: ObjectStore): Promise<ObjectInfo[]> {
  const list = await os.list();
  return list.filter((o) => !o.deleted).sort((a, b) => a.name.localeCompare(b.name));
}

export async function readObject(os: ObjectStore, name: string, maxBytes: number): Promise<{ info: ObjectInfo; data: Uint8Array }> {
  const info = await os.info(name);
  if (!info || info.deleted) throw new Error(`Object "${name}" not found`);
  if (info.size > maxBytes) throw new Error(`Object is ${info.size} bytes — larger than the preview limit (${maxBytes}). Download it instead.`);
  const data = await os.getBlob(name);
  if (!data) throw new Error(`Object "${name}" not found`);
  return { info, data };
}

export async function uploadFile(os: ObjectStore, name: string, filePath: string, description?: string): Promise<ObjectInfo> {
  await stat(filePath);
  const rs = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>;
  return os.put({ name, description }, rs);
}

export async function downloadToFile(
  os: ObjectStore,
  name: string,
  filePath: string,
  onProgress?: (bytes: number, total: number) => void,
): Promise<number> {
  const r = await os.get(name);
  if (!r) throw new Error(`Object "${name}" not found`);
  const out = createWriteStream(filePath);
  const reader = r.data.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (!out.write(value)) await once(out, "drain");
      onProgress?.(bytes, r.info.size);
    }
  } finally {
    out.end();
    await once(out, "close").catch(() => undefined);
  }
  const err = await r.error;
  if (err) throw err;
  return bytes;
}
