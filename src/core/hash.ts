/**
 * SHA-256 助手。
 *
 * 只依赖 WebCrypto：Obsidian（Electron 渲染进程）与 Node 22 都有 `globalThis.crypto.subtle`，
 * 于是单测和运行时走的是完全同一份实现，不会出现"测试过了线上不一样"。
 */

const encoder = new TextEncoder();

export type HashPart = string | Uint8Array | ArrayBuffer;

function toBytes(part: HashPart): Uint8Array {
  if (typeof part === "string") return encoder.encode(part);
  if (part instanceof Uint8Array) return part;
  return new Uint8Array(part);
}

function concatToBuffer(parts: readonly HashPart[]): ArrayBuffer {
  const bytes = parts.map(toBytes);
  const total = bytes.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const b of bytes) {
    out.set(b, offset);
    offset += b.byteLength;
  }
  return out.buffer;
}

export async function sha256Hex(parts: readonly HashPart[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", concatToBuffer(parts));
  return toHex(new Uint8Array(digest));
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
