/**
 * cid（客户端实体 ID）派生规则。
 *
 * ⚠️ 这里是整个同步系统最容易出错的一段代码。
 *
 * 规则必须与服务端 `core/psync/services/identity.py` 逐字符一致，两边跑同一组测试向量
 * （见 docs/11-plugin-sync.md）。一旦不一致，同一份素材在两台设备上会算出两个 cid，
 * 直接后果是学习进度分裂、经验值翻倍——而且用户完全看不出原因。
 *
 * 核心原则：**cid 必须由内容派生，绝不能用随机 UUID。**
 * 随机 ID 会让两台设备各自导入同一份字幕时生成两套主键。
 */

import { sha256Hex } from "./hash";
import { normalizeJa } from "./jaText";

export const ENTITY = {
  work: "work",
  episode: "episode",
  asset: "asset",
  slice: "slice",
  progress: "progress",
  word: "word",
  session: "session",
} as const;

export type EntityName = (typeof ENTITY)[keyof typeof ENTITY];

export type AssetKind = "video" | "subtitle";

/** 标题归一化：NFKC → 全角大小写折平 → 去空白 → 折叠重复空格 → 转小写。 */
export function normalizeTitle(title: string): string {
  return title.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * 集号归一化。
 *
 * 4.0 与 4 必须落到同一个字符串，否则同一集会有两个 cid；
 * 但 1.5（特别篇）必须保留小数。
 */
export function normalizeEpisodeNumber(value: number | string): string {
  const raw = typeof value === "number" ? value.toString() : String(value).trim();
  if (raw === "" || raw === "-") return "";
  const num = Number(raw);
  if (!Number.isFinite(num)) return raw;
  // 去掉无意义的小数尾巴，但保留真正的小数
  const rounded = Math.round(num * 100) / 100;
  return rounded.toString();
}

/**
 * 句子指纹：去掉所有空白后的 SHA-256。与服务端 learning.analysis.text_hash 口径一致。
 *
 * ⚠️ 自 2026-10-09 起它**不再是切片 cid 的输入**（切片身份改由三句 hash 派生，
 * 见 `sliceCid`）。它仍保留两个用途：① `SliceRow.textHash` 字段（纯句子去重索引）；② 与
 * 服务端共享的纯句子缓存 key 兼容口径。别再拿它喂 `sliceCid`。
 */
export function sentenceTextHash(ja: string): Promise<string> {
  return sha256Hex([ja.replace(/\s+/gu, "")]);
}

// ── 各实体 ────────────────────────────────────────────────────────────────

export function workCid(title: string, year?: number | null): Promise<string> {
  return prefixed("W:", [normalizeTitle(title), "|", String(year ?? "")]);
}

export function episodeCid(
  workCidValue: string,
  season: number | string | null | undefined,
  number: number | string,
): Promise<string> {
  return prefixed("E:", [
    workCidValue,
    "|",
    normalizeEpisodeNumber(season ?? ""),
    "|",
    normalizeEpisodeNumber(number),
  ]);
}

/**
 * 素材（本机文件）的 cid。
 *
 * `fingerprint` 为空表示算不出指纹（比如读不到文件），此时退化成随机 UUID——
 * 这种素材在两台设备之间不会被自动合并，只能靠 `assets/resolve` 让用户手动认领。
 * 这是有意设计：宁可少合并，也不能把两个不同的文件认成同一个。
 */
export function assetCid(kind: AssetKind, fingerprint: string | null): Promise<string> {
  if (!fingerprint) return Promise.resolve(`A:${randomUuid()}`);
  return prefixed("A:", [kind, "|", fingerprint]);
}

/**
 * 切片 cid：三句 hash（2026-10-09 用户拍板取代 `assetCid | index | textHash`）。
 *
 * 用「上一句 + 本句 + 下一句」三句原文做 SHA-256：同一段台词（含前后句）
 * 不管出现在哪部作品、哪一集，身份都一样；反过来，仅一句相同的两个句子
 * 因为前后句不同而得到不同的 cid。
 *
 * 关键口径（详见 docs/concept/cid.md）：
 *  · 首句 / 末句退化为两句（prev / next 传 null）；
 *  · **`index` 与 `assetCid` 不进 key**；
 *  · 三句各自**先归一化**再拼接（`normalizeJa`：NFKC + 去标点 + 片假名折平假名，
 *    见 `core/jaText.ts`）—— 所以「そうか。」/「そうか」/「ｿｳｶ」/「ソウカ」得到
 *    同一个 cid，换版本字幕里的标点、全半角、假名写法差异**在身份层就被吃掉**，
 *    不需要靠相似度兜底。与之相对，`sentenceTextHash` 仍只去空白（口径不同，别混）。
 *  · 参与哈希的是**原片日文**（`slice.ja`），**不是**用户纠错后的版本 ——
 *    AI 解析缓存的 key 才用纠错后的文本（那是另一个 hash，见 D3）。
 *  · 三句之间用 `\u001f`（US，控制字符，台词里不会出现）分隔，与
 *    服务端 `analysis_cache.three_sentence_digest` 的分隔符与归一化口径一致。
 *
 * ⚠️ 撞了就合并（用户拍板）：相同的三句序列 —— 无论同一集还是跨集 ——
 * 得到同一个 cid，学习进度 / 笔记 / 播放时间都只认这一份。
 */
export function sliceCid(
  prevJa: string | null,
  curJa: string,
  nextJa: string | null,
): Promise<string> {
  return prefixed("S:", [
    normalizeJa(prevJa ?? ""),
    "\u001f",
    normalizeJa(curJa),
    "\u001f",
    normalizeJa(nextJa ?? ""),
  ]);
}

export function progressCid(sliceCidValue: string): string {
  return `P:${sliceCidValue}`;
}

export function wordCid(lemma: string, pos: string): Promise<string> {
  return prefixed("w:", [lemma.trim(), "|", pos.trim()]);
}

export function sessionCid(): string {
  return `n:${randomUuid()}`;
}

/** 显示用的短标识：给错误消息、日志、UI 用，不做主键。 */
export function shortCid(cid: string): string {
  return cid.length <= 14 ? cid : `${cid.slice(0, 12)}…`;
}

async function prefixed(prefix: string, parts: readonly string[]): Promise<string> {
  return `${prefix}${await sha256Hex(parts)}`;
}

export function randomUuid(): string {
  // 不能直接写 `typeof crypto !== "undefined"`：lib.dom 下 crypto 恒为真，
  // 取反会把类型收窄成 never，赋值 go branch 就编译不过了。
  const webcrypto: Crypto = globalThis.crypto;
  if (typeof webcrypto?.randomUUID === "function") {
    return webcrypto.randomUUID();
  }
  // 兜底：任何环境下都能出一个 v4 形状的 id
  const bytes = new Uint8Array(16);
  webcrypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
