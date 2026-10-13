/**
 * 规范化摘要。
 *
 * 上行前客户端先算一次，服务端比对同 cid 行的 `row_digest` —— 相等就
 * 直接回 `unchanged`，不写库、不记变更、不抬版本号。
 *
 * 这道防线专门用来消灭「A 推到云端 → B 拉下来 → B 再推回去 → A 又拉一遍」
 * 这种乒乓同步：内容其实一次都没变，只是每轮都被当成新改动。
 */

import { sha256Hex } from "./hash";

/** 对象键名排序后再序列化，保证同样的内容必得同样的字节序列。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * 参与摘要计算时要剔除的字段。
 *
 * `rev` 是服务端版本、`clientUpdatedAt` 随每次触碰变化 —— 它们不该参与
 * "内容有没有变"的判断，否则摘要永远不相等，乒乓同步照旧。
 */
const VOLATILE = new Set(["rev", "rowDigest", "clientUpdatedAt", "deletedAt", "dirty"]);

export function stripVolatile<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (VOLATILE.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export async function rowDigest(row: Record<string, unknown>): Promise<string> {
  return sha256Hex([canonicalJson(stripVolatile(row))]);
}
