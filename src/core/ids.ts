/**
 * 实体键派生规则。
 *
 * ⚠️ 这里是整个同步系统最容易出错的一段代码。
 *
 * 三句哈希（`sliceCid`）的归一化口径必须与服务端
 * `core/learning/services/ja_text.py` + `analysis_cache.three_sentence_digest`
 * 逐字符一致，两边跑同一组测试向量（见 docs/11-plugin-sync.md）。一旦不一致，
 * 同一句台词在两台设备上会算出两个键，直接后果是学习进度分裂、经验值翻倍——
 * 而且用户完全看不出原因。
 *
 * 核心原则（2026-10-14 身份模型重构定稿）：
 *  · **身份只有三种哈希** —— 文件（sha256 全文件哈希）、句子（三句哈希）、
 *    学习记录（文件对的哈希，见 `recordCid`）。不存在由元数据（作品名/集号）
 *    派生的身份：那些字段全部降级为展示字段，改名零身份后果。
 *  · 键必须由内容派生，绝不能用随机 UUID（session 除外——会话本来就不是
 *    跨设备合并的对象）。随机键会让两台设备各自导入同一份素材时生成两套主键。
 */

import { sha256Hex } from "./hash";
import { normalizeJa } from "./jaText";

export type AssetKind = "video" | "subtitle";

/** 标题归一化：NFKC → 全角大小写折平 → 去空白 → 折叠重复空格 → 转小写。 */
export function normalizeTitle(title: string): string {
  return title.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * 集号归一化（仅用于展示与笔记命名）。
 *
 * 4.0 与 4 必须落到同一个字符串；但 1.5（特别篇）必须保留小数。
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
 * ⚠️ 它**不是句子键**（句子身份由三句 hash 派生，见 `sliceCid`）。
 * 用途：① `SentenceRow.textHash` 字段（纯句子去重索引）；② 与服务端共享的
 * 纯句子缓存 key 兼容口径。别拿它当主键用。
 */
export function sentenceTextHash(ja: string): Promise<string> {
  return sha256Hex([ja.replace(/\s+/gu, "")]);
}

// ── 各实体 ────────────────────────────────────────────────────────────────

/**
 * 学习记录的键：**文件对的哈希**（2026-10-14 用户拍板）。
 *
 * `R:` + sha256(视频 sha256 ⟨US⟩ 日文字幕 sha256)。同一条学习记录 =
 * 同一对文件；任何一份换了（哪怕只差一个字节）都是**另一条记录**——
 * 不做模糊匹配，宁可让用户看到两条并列的记录，也不把两份不同素材的学习
 * 数据搅在一起（删减版/未删减版并存正是这个规则的直接受益者）。
 *
 * 派生（而不是拼接两个 64-hex 当键）有个顺带的好处：键长恒定 66 字符，
 * 服务端所有 80 宽度的列天然放行。
 */
export function recordCid(videoSha256: string, jaSubSha256: string): Promise<string> {
  return prefixed("R:", [videoSha256, "\u001f", jaSubSha256]);
}

/**
 * 素材（本机文件）的键：`A:` + 文件 sha256。
 *
 * 文件哈希本身就是摘要，这里只做前缀命名空间，不再二次哈希。
 * 同一个文件（字节级相同）在两条学习记录里是**同一个素材行**——
 * 时间轴校准（`offsetMs`）挂在素材行上，因此同一视频换字幕校准自动带过去。
 */
export function assetShaCid(sha256: string): string {
  return `A:${sha256}`;
}

/**
 * 句子键：三句 hash（2026-10-09 用户拍板）。
 *
 * 用「上一句 + 本句 + 下一句」三句原文做 SHA-256：同一段台词（含前后句）
 * 不管出现在哪条学习记录里，身份都一样；反过来，仅一句相同的两个句子
 * 因为前后句不同而得到不同的 cid。
 *
 * 关键口径（详见 docs/concept/cid.md）：
 *  · 首句 / 末句退化为两句（prev / next 传 null）；
 *  · **`index` 与文件哈希不进 key**；
 *  · 三句各自**先归一化**再拼接（`normalizeJa`：NFKC + 去标点 + 片假名折平假名，
 *    见 `core/jaText.ts`）—— 所以「そうか。」/「そうか」/「ｿｳｶ」/「ソウカ」得到
 *    同一个 cid。归一化口径与服务端 `analysis_cache.three_sentence_digest`
 *    一致，**两端必须同步改**。
 *  · 参与哈希的是**原片日文**（`line.ja`），**不是**用户纠错后的版本 ——
 *    AI 解析缓存的 key 才用纠错后的文本（那是另一个 hash，见 D3）。
 *  · 三句之间用 `\u001f`（US，控制字符，台词里不会出现）分隔。
 *
 * ⚠️ 撞了就合并（用户拍板）：相同的三句序列 —— 无论同一条记录还是跨记录 ——
 * 得到同一个 cid，学习进度 / 笔记 / 解析只认这一份。
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
