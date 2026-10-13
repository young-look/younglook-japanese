/**
 * 单词熟练度（`words` store）。
 *
 * 埋点在**开卡那一刻**（卡片把分词结果显示出来时）：句中所有实词都算被看到过一次。
 * 这是「曝光」最自然的时刻 —— 用户确实盯着这些词在看，而不是在翻目录。
 *
 * 熟练度只由曝光次数推导（翻卡复习不做，SRS 调度字段已删）：
 *
 *   mastery = clamp(exposureCount / 8, 0, 1)
 *   status  = 没见过的新词 / 复习过 3 次以上的已掌握 / 其余学习中
 *
 * 8 次这个数是拍的：一句台词平均出 5~8 个实词，同一集里高频词会反复出现，
 * 八次差不多是"见过好几面、开始有印象"的位置。改这里一处即可。
 */
import { rowDigest } from "../core/digest";
import { wordCid } from "../core/ids";
import { STORE, type VaultDb } from "../storage/db";
import { bumpStudyDay } from "./studyDays";
import { CONTENT_POS, type Token, type WordRow } from "../types/entities";

/** 熟练度拉满所需的曝光次数。 */
export const EXPOSURE_FULL = 8;

/** 复习到这个次数就算「已掌握」。 */
export const KNOWN_REVIEW_COUNT = 3;

export function masteryFrom(exposureCount: number): number {
  const ratio = Math.max(exposureCount, 0) / EXPOSURE_FULL;
  return Math.round(Math.min(Math.max(ratio, 0), 1) * 10000) / 10000;
}

export function statusFrom(exposureCount: number, reviewCount: number): WordRow["status"] {
  if (exposureCount <= 0) return "new";
  if (reviewCount >= KNOWN_REVIEW_COUNT) return "known";
  return "learning";
}

/** 开卡埋点的标记前缀。同一句只计一次曝光 —— 来回翻不该刷熟练度。 */
const exposedKey = (sliceCid: string): string => `exposed:${sliceCid}`;

function emptyRow(cid: string, token: Token, now: string): WordRow {
  return {
    cid,
    lemma: token.lemma || token.surface,
    pos: token.pos,
    surface: token.surface,
    reading: token.reading ?? "",
    romaji: token.romaji ?? "",
    definition: token.def ?? "",
    meaningSource: token.meaningSource ?? "",
    status: "new",
    mastery: 0,
    lastReviewedAt: null,
    reviewCount: 0,
    lapseCount: 0,
    correctCount: 0,
    exposureCount: 0,
    firstSeenAt: now,
    lastSeenAt: now,
    clientUpdatedAt: now,
    deletedAt: null,
    rev: 0,
    rowDigest: "",
  };
}

/**
 * 记一次开卡曝光：把这句里的实词各加一次曝光。
 *
 * @returns 新增的词数（第一次见到的才算"新词"）
 *
 * 失败只会抛在调用方 —— 埋点不该阻塞渲染，StudyView 那边是 try/catch 包着的。
 */
export async function recordWordExposure(
  db: VaultDb,
  sliceCid: string,
  tokens: readonly Token[],
): Promise<number> {
  const now = new Date().toISOString();

  // 只取实词，并按 (lemma, pos) 去重 —— 一句里出现两次的同一个词算一次
  const seen = new Map<string, Token>();
  for (const token of tokens) {
    if (!CONTENT_POS.has(token.pos)) continue;
    const lemma = (token.lemma || token.surface).trim();
    if (!lemma) continue;
    const key = `${lemma}|${token.pos}`;
    if (!seen.has(key)) seen.set(key, token);
  }
  if (seen.size === 0) return 0;

  // ⚠️ cid 与摘要都要算哈希（await crypto.subtle），**必须放在事务外面**。
  // IndexedDB 事务里只要 await 了一个非 IDB 的 Promise 就会自动提交，
  // 后面的请求会拿到 TransactionInactiveError（storage/db.ts 头部就写着这条）。
  const entries: Array<{ cid: string; token: Token }> = [];
  for (const [, token] of seen) {
    entries.push({ cid: await wordCid(token.lemma || token.surface, token.pos), token });
  }

  // 同一句只算一次：翻回来看第二遍不该把熟练度刷上去
  const marker = await db.get<{ key: string; value: boolean }>(STORE.meta, exposedKey(sliceCid));
  if (marker?.value) return 0;

  const rows = await db.transaction([STORE.words], "readonly", async (tx) => {
    const out: WordRow[] = [];
    for (const entry of entries) {
      out.push((await tx.get<WordRow>(STORE.words, entry.cid)) ?? emptyRow(entry.cid, entry.token, now));
    }
    return out;
  });

  let fresh = 0;
  const updated: WordRow[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const { token } = entries[i];
    const row = rows[i];
    if (row.exposureCount === 0) fresh += 1;

    row.exposureCount += 1;
    row.lastSeenAt = now;
    // 形态/读音/释义取最新的非空值：词典更新后旧行也能跟上
    row.surface = token.surface || row.surface;
    row.reading = token.reading || row.reading;
    row.romaji = token.romaji || row.romaji;
    row.definition = token.def || row.definition;
    if (token.meaningSource) row.meaningSource = token.meaningSource;
    row.status = statusFrom(row.exposureCount, row.reviewCount);
    row.mastery = masteryFrom(row.exposureCount);
    row.clientUpdatedAt = now;
    row.rowDigest = await rowDigest(row as unknown as Record<string, unknown>);
    updated.push(row);
  }

  await db.transaction([STORE.words, STORE.meta], "readwrite", async (tx) => {
    for (const row of updated) await tx.put(STORE.words, row);
    await tx.put(STORE.meta, { key: exposedKey(sliceCid), value: true });
  });

  await bumpStudyDay(db, { newWords: fresh, openedSlices: 1 });
  return fresh;
}

