/**
 * 学习流程的数据层（本地）。
 *
 *   · 进度跟着句子走（progressCid = P:<三句哈希>），三步各自的完成时刻分开记；
 *   · 「重置」把那一步**完全恢复初始**（完成时刻、留档、草稿一并清，
 *     2026-10-04 用户拍板，取代旧"重做不动完成时刻"的约定）——
 *     completedAt 由三步齐全推导，缺一步整句就回到未完成；
 *   · 会话记录"在学哪条记录、学到第几句"，中途退出再进来从这一句接着来。
 *
 * 身份模型（2026-10-14 重构）：进度/笔记/录音/解析全挂在**句子哈希**上，
 * 跨学习记录共享——同一句（三句哈希相同）出现在哪条记录里都算学过。
 * 学习记录 = 文件哈希对（见 core/ids.ts::recordCid），删除记录绝不碰句子层。
 *
 * 业务行直接写在同一个事务里（outbox 已随 2026-10-06 统一快照同步退役——
 * 全量快照重推不依赖逐行待办）。
 */

import { rowDigest } from "../core/digest";
import { assetShaCid, progressCid, sessionCid } from "../core/ids";
import { STORE, type StoreName, type VaultDb } from "../storage/db";
import { fileExists } from "../storage/files";
import { hasSections } from "./ai/client";
import { bumpStudyDay, type StudyDayPatch } from "./studyDays";
import type {
  AssetRow,
  ChatTurn,
  ProgressRow,
  RecordLineRow,
  RecordRow,
  SentenceAnalysis,
  SentenceRow,
  SessionRow,
  StudySentence,
} from "../types/entities";

// 视图层从 types/entities 拿 StudySentence；这里 re-export 保持旧 import 路径可用。
export type { StudySentence } from "../types/entities";

export interface RecordListItem {
  record: RecordRow;
  total: number;
  completed: number;
  /** 这条记录最近一次会话（"上次学到第 N 句"的来源）；没学过为 null */
  lastSession: SessionRow | null;
  /** 视频文件在磁盘上还找不找得到 —— 首页「文件丢失」灰态分组的依据 */
  videoAvailable: boolean;
}

const live = <T extends { deletedAt: string | null }>(rows: T[]): T[] =>
  rows.filter((row) => !row.deletedAt);

/** 首页列表：本机导入过的每条学习记录，带句数、已学句数和上次学到的位置。 */
export async function loadRecordList(db: VaultDb): Promise<RecordListItem[]> {
  const [records, lines, sessions, progress, assets] = await Promise.all([
    db.getAll<RecordRow>(STORE.records),
    db.getAll<RecordLineRow>(STORE.lines),
    db.getAll<SessionRow>(STORE.sessions),
    db.getAll<ProgressRow>(STORE.progress),
    db.getAll<AssetRow>(STORE.assets),
  ]);

  const completedBySentence = new Map<string, number>();
  for (const row of live(progress)) {
    if (row.completedAt) {
      completedBySentence.set(row.sliceCid, (completedBySentence.get(row.sliceCid) ?? 0) + 1);
    }
  }

  const latestSessionByRecord = new Map<string, SessionRow>();
  for (const session of live(sessions)) {
    if (!session.recordCid) continue;
    const current = latestSessionByRecord.get(session.recordCid);
    if (!current || session.startedAt > current.startedAt) {
      latestSessionByRecord.set(session.recordCid, session);
    }
  }

  const assetByCid = new Map(live(assets).map((row) => [row.cid, row]));

  const items: RecordListItem[] = [];
  for (const record of live(records)) {
    const recordLines = lines.filter((row) => row.recordCid === record.cid);
    if (recordLines.length === 0) continue;
    const total = recordLines.length;
    const completed = recordLines.reduce(
      (sum, line) => sum + (completedBySentence.get(line.sentenceCid) ? 1 : 0),
      0,
    );
    // 「文件丢失」判定：视频素材行的本地路径在磁盘上还打不打得开。
    // 跨会话回来才核对一次，列表页的 I/O 量 = 记录数，可接受。
    const videoAsset = assetByCid.get(assetShaCid(record.videoSha256));
    const videoAvailable = videoAsset ? await fileExists(videoAsset.localPath) : false;
    items.push({
      record,
      total,
      completed,
      lastSession: latestSessionByRecord.get(record.cid) ?? null,
      videoAvailable,
    });
  }

  // 集号可能留空（不是番剧的单集视频）。`Number("")` 是 0，直接相减会让这类视频
  // 冒充"第 0 集"挤到最前面 —— 空集号一律排到最后，别跟正片抢位置。
  const episodeOrder = (number: string): number => {
    const value = Number(number);
    return number.trim() && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  };

  // 同一部番排一起、集号从小到大；最近学过的记录排最前
  items.sort((a, b) => {
    const byTitle = (a.record.title || a.record.titleJa).localeCompare(
      b.record.title || b.record.titleJa,
    );
    if (byTitle !== 0) return byTitle;
    const byNumber = episodeOrder(a.record.number) - episodeOrder(b.record.number);
    if (byNumber !== 0) return byNumber;
    const aAt = a.lastSession?.startedAt ?? "";
    const bAt = b.lastSession?.startedAt ?? "";
    return bAt.localeCompare(aAt);
  });
  return items;
}

/**
 * 从列表里移除一条学习记录（软删）。
 *
 * ⚠️ 硬边界（2026-10-14 重构定稿）：**只软删记录行本身**。
 * 句子行（sentences）是跨记录共享的内容层，进度/笔记/录音全挂句子哈希——
 * 删记录绝不能碰它们，否则同句子所在的其它记录会被连带清空。
 * 素材行也是共享的（同一视频可被多条记录引用），同样不动；
 * 素材库副本的清理由 RemoveModal 的引用计数单独把关。
 * 同一对文件重新导入时记录键相同 → 复活（见 importer）。
 */
export async function removeRecord(db: VaultDb, recordCid: string): Promise<void> {
  const record = await db.get<RecordRow>(STORE.records, recordCid);
  if (!record || record.deletedAt) return;

  const now = new Date().toISOString();
  // ⚠️ `deletedAt` / `clientUpdatedAt` 都是 volatile 字段（见 core/digest.ts），
  // 不参与摘要计算，所以这一行的 rowDigest **不用重算**。
  // 上行靠统一快照全量重推（见 sync/snapshot.ts），跟摘要没关系。
  await db.put(STORE.records, { ...record, deletedAt: now, clientUpdatedAt: now });
}

/** 学习视图句：记录层台词 × 句子覆盖层 拼出来的视图行。 */
function toStudySentence(line: RecordLineRow, sentence: SentenceRow | undefined): StudySentence {
  return {
    cid: line.sentenceCid,
    index: line.index,
    startMs: line.startMs,
    endMs: line.endMs,
    ja: line.ja,
    zh: line.zh,
    speaker: line.speaker,
    textHash: sentence?.textHash ?? "",
    analysis: sentence?.analysis ?? null,
    textFixes: sentence?.textFixes,
    readingFixes: sentence?.readingFixes,
    correctionsUpdatedAt: sentence?.correctionsUpdatedAt,
  };
}

/** 一条记录的全部学习句（按集内序号排好）。 */
export async function loadStudySentences(db: VaultDb, recordCid: string): Promise<StudySentence[]> {
  const recordLines = await db.getAll<RecordLineRow>(STORE.lines, IDBKeyRange.bound(
    [recordCid, 0],
    [recordCid, Number.MAX_SAFE_INTEGER],
  ));
  if (recordLines.length === 0) return [];
  const sentences = new Map(
    (await db.getAll<SentenceRow>(STORE.sentences)).map((row) => [row.cid, row]),
  );
  return recordLines
    .map((line) => toStudySentence(line, sentences.get(line.sentenceCid)))
    .sort((a, b) => a.index - b.index);
}

export async function loadProgress(db: VaultDb, sentenceCid: string): Promise<ProgressRow | undefined> {
  return db.get<ProgressRow>(STORE.progress, progressCid(sentenceCid));
}

/** 这条记录最近一次会话（没有就 null）。 */
export async function lastSessionOf(db: VaultDb, recordCid: string): Promise<SessionRow | null> {
  const rows = live(await db.getAllByIndex<SessionRow>(STORE.sessions, "by_record", recordCid));
  if (rows.length === 0) return null;
  return rows.reduce((latest, row) => (row.startedAt > latest.startedAt ? row : latest));
}

/** 进一条记录：开一条新会话。 */
export async function startSession(db: VaultDb, recordCid: string): Promise<SessionRow> {
  const now = new Date().toISOString();
  const session: SessionRow = {
    cid: sessionCid(),
    recordCid,
    startedAt: now,
    endedAt: null,
    currentIndex: 0,
    clientUpdatedAt: now,
    deletedAt: null,
    rev: 0,
    rowDigest: await rowDigest({ recordCid, startedAt: now, endedAt: null, currentIndex: 0 }),
  };
  await db.transaction([STORE.sessions], "readwrite", (tx) => tx.put(STORE.sessions, session));
  return session;
}

/** 会话推进/收尾。收尾（endedAt 由空变有）时把这段时长记进日活。 */
export async function saveSession(db: VaultDb, session: SessionRow): Promise<void> {
  const now = new Date().toISOString();
  const next: SessionRow = { ...session, clientUpdatedAt: now };
  next.rowDigest = await rowDigest({
    recordCid: next.recordCid,
    startedAt: next.startedAt,
    endedAt: next.endedAt,
    currentIndex: next.currentIndex,
  });
  await db.transaction([STORE.sessions], "readwrite", (tx) => tx.put(STORE.sessions, next));

  // 退出学习才结算时长：会话中途会反复推进，每次都加会把时长算成好几倍
  if (session.endedAt == null && next.endedAt != null) {
    const seconds = Math.round((Date.parse(next.endedAt) - Date.parse(next.startedAt)) / 1000);
    if (Number.isFinite(seconds) && seconds > 0) {
      await bumpStudyDay(db, { studySeconds: seconds }).catch(() => undefined);
    }
  }
}

export interface CopyStepInput {
  /** 这次敲的内容；通过时落库留档 */
  text: string;
  passed: boolean;
}

export interface ReadStepInput {
  seconds: number | null;
}

export interface ImitationStepInput {
  text: string;
  /**
   * 这一遍算不算通过。
   *  - true：AI 核对判对；**或者** AI 不可用时的兜底放行（那种情况要 `verified: false`）；
   *  - false：AI 核对判错，这一步退回未完成 —— 判错就得改，不能算学会。
   */
  correct: boolean;
  /**
   * 这次结论是不是**真的由 AI 核对得出**的。
   *
   * AI 不可用（没开 / 没登录 / 没填 Key）时这一步不做任何检查直接放行，
   * 传 false —— 卡片上标黄、上行时不收。详见 `ProgressRow.imitationVerifiedAt`。
   */
  verified: boolean;
  /**
   * AI 判定给的理由与建议。
   * 以前拿到就丢了，导致助手追问时"上次为什么判错"永远是空的 ——
   * 现在随这一步一起留档。
   *
   * ⚠️ `correct` 必须是**判定当时的结论**（和 `correct` 参数同一份判定），
   * 展示侧要靠它区分"这份评语还算不算数"（见 `ProgressRow.imitationFeedback`）。
   */
  feedback?: {
    correct?: boolean;
    reason?: string;
    suggestion?: string;
    /** suggestion 的区别说明（一句中文）；与 suggestion 成对，缺一个就不显示 */
    suggestionNote?: string;
    translation?: string;
  };
}

function baseProgress(sentenceCid: string, now: string): ProgressRow {
  return {
    cid: progressCid(sentenceCid),
    sliceCid: sentenceCid,
    copyAttempts: 0,
    copyDoneAt: null,
    copyEpoch: 0,
    copyText: "",
    readAloudAt: null,
    readAloudVerifiedAt: null,
    readAloudSeconds: 0,
    readEpoch: 0,
    imitationText: "",
    imitationCorrect: null,
    imitationVerifiedAt: null,
    imitationFeedback: {},
    imitationHint: null,
    imitationChat: [],
    imitationEpoch: 0,
    completedAt: null,
    clientUpdatedAt: now,
    deletedAt: null,
    rev: 0,
    rowDigest: "",
  };
}

const isCopyDone = (row: ProgressRow) => row.copyDoneAt !== null;
const isReadDone = (row: ProgressRow) => row.readAloudAt !== null;
/**
 * 仿写完成 = 这一步算过了（AI 判对，或 AI 不可用时的兜底放行）。
 * ⚠️ AI 判错时这里会是 false，也就是"这一步不算完成" —— 有意如此。
 */
const isImitationDone = (row: ProgressRow) => row.imitationCorrect === true;

function deriveCompleted(row: ProgressRow): string | null {
  if (isCopyDone(row) && isReadDone(row) && isImitationDone(row)) {
    return row.completedAt ?? new Date().toISOString();
  }
  return null;
}

/** 三步里的一步 —— 用来决定给日活加哪个计数。 */
type StudyStep = "copy" | "read" | "imitation";

async function persistProgress(
  db: VaultDb,
  row: ProgressRow,
  step?: StudyStep,
): Promise<ProgressRow> {
  const before = row.completedAt;
  const next: ProgressRow = {
    ...row,
    clientUpdatedAt: new Date().toISOString(),
  };
  next.completedAt = deriveCompleted(next);
  next.rowDigest = await rowDigest({ ...next, completedAt: next.completedAt } as Record<string, unknown>);
  await db.transaction([STORE.progress], "readwrite", (tx) => tx.put(STORE.progress, next));

  // 日活埋点。经验值只认「三步齐全」的那一刻 —— 与服务端口径一致，
  // 否则在目录里来回翻就能把网页上的等级刷上去。
  // 记不住也不该让用户学不下去，所以失败只吞掉。
  const patch: StudyDayPatch = {};
  if (step === "copy") patch.copyCount = 1;
  if (step === "read") patch.readCount = 1;
  if (step === "imitation") patch.imitationCount = 1;
  if (before == null && next.completedAt != null) patch.sentencesCompleted = 1;
  if (Object.keys(patch).length > 0) {
    await bumpStudyDay(db, patch).catch(() => undefined);
  }
  return next;
}

/**
 * 跟读记一笔：读过 + 时长（录音本身不落盘，只在内存里回听）。
 *
 * `verified` = 这一遍**有没有真的让 AI 逐词核对过并全对**。两条过关路径必须分开：
 * AI 逐词 → true（卡片说「正解」）；本地只查有没有出声、或没麦时的「标记完成」
 * → false（卡片说「已完成」——没人判过发音）。见 `ProgressRow.readAloudVerifiedAt`。
 */
export async function recordReadAloud(
  db: VaultDb,
  sentence: StudySentence,
  seconds: number | null,
  verified: boolean,
): Promise<ProgressRow> {
  const now = new Date().toISOString();
  const row = (await loadProgress(db, sentence.cid)) ?? baseProgress(sentence.cid, now);
  row.readAloudAt = now;
  row.readAloudVerifiedAt = verified ? now : null;
  if (seconds !== null) row.readAloudSeconds = seconds;
  return persistProgress(db, row, "read");
}

/** 抄写检查通过/失败都算一次尝试；对了落完成时刻并留档。 */
export async function submitCopy(
  db: VaultDb,
  sentence: StudySentence,
  input: CopyStepInput,
): Promise<ProgressRow> {
  const now = new Date().toISOString();
  const row = (await loadProgress(db, sentence.cid)) ?? baseProgress(sentence.cid, now);
  row.copyAttempts += 1;
  if (input.passed) {
    row.copyDoneAt = row.copyDoneAt ?? now;
    row.copyText = input.text.trim();
  }
  return persistProgress(db, row, "copy");
}

/**
 * 仿写检查的结果落库：留档 + 定下这一步算不算过。
 *
 * `correct` 必须由调用方明确给出 —— 没有"省略即通过"这种口子。
 * 不经 AI 的通过路径只有**浅检查放行**（AI 不可用时点「检查」，2026-10-07 起
 * 三步卡没有「保存」——数据自动保存，这颗钮只管核对）：
 * 那种情况 `verified` 传 false，卡片标黄、上行不收（见 `ProgressRow.imitationVerifiedAt`）。
 */
export async function submitImitation(
  db: VaultDb,
  sentence: StudySentence,
  input: ImitationStepInput,
): Promise<ProgressRow> {
  const now = new Date().toISOString();
  const row = (await loadProgress(db, sentence.cid)) ?? baseProgress(sentence.cid, now);
  row.imitationText = input.text.trim();
  row.imitationCorrect = input.correct;
  row.imitationVerifiedAt = input.correct && input.verified ? now : null;
  // 没带评语 = 这次结论不是 AI 给的（兜底放行）→ 把上一次的评语清掉。
  // 留着它，卡片上就会拿"上一遍判错的理由"去配这一遍的结论。
  row.imitationFeedback = input.feedback
    ? {
        // 判定当时的结论；调用方没单给时按这次落下的结论算（两者本来同源）
        correct: input.feedback.correct ?? row.imitationCorrect,
        reason: input.feedback.reason ?? "",
        suggestion: input.feedback.suggestion ?? "",
        suggestionNote: input.feedback.suggestionNote ?? "",
        translation: input.feedback.translation ?? "",
      }
    : {};
  return persistProgress(db, row, "imitation");
}

/**
 * 「重置」：把这一步**完全恢复到初始状态**（2026-10-04 用户拍板）——
 * 完成时刻、留档、尝试次数全清；跟读连本地录音也一起删（见 StudyView.handleReset）。
 * completedAt 由 deriveCompleted 重算：三步缺了哪一步，整句就回到未完成。
 */
export async function resetPracticeRecord(
  db: VaultDb,
  sentence: StudySentence,
  step: "read" | "copy" | "imitation",
): Promise<ProgressRow> {
  const now = new Date().toISOString();
  const row = (await loadProgress(db, sentence.cid)) ?? baseProgress(sentence.cid, now);
  if (step === "read") {
    row.readEpoch += 1;
    row.readAloudAt = null;
    // 「有没有让 AI 判过」也是这一步的状态，跟着清 —— 留着它，下一遍还没核对
    // 就会显示成青蓝的「正解 ✓」（与下面 imitationVerifiedAt 同一个道理）。
    row.readAloudVerifiedAt = null;
    row.readAloudSeconds = 0;
  } else if (step === "copy") {
    row.copyEpoch += 1;
    row.copyText = "";
    // 完成时刻与尝试次数也是这一步的状态，「完全清空」就一起归零 ——
    // 旧口径（重做不动完成时刻）2026-10-04 起作废。
    row.copyDoneAt = null;
    row.copyAttempts = 0;
  } else {
    row.imitationEpoch += 1;
    row.imitationText = "";
    row.imitationCorrect = null;
    // 「有没有核过」也要跟着清 —— 留着它，下一遍还没核对就会显示成绿「已完成 ✓」
    row.imitationVerifiedAt = null;
    // 判定理由也是这一步的留档，跟着一起清 —— 留着上一遍的"为什么没通过"
    // 会让用户对着新写的句子看到旧评语。
    row.imitationFeedback = {};
  }
  return persistProgress(db, row);
}

/**
 * 修补「AI 判过、却没记核对时间」的历史进度行。
 *
 * 中间版本的构建写仿写结论时漏了 `imitationVerifiedAt`（AI 的判语留在了
 * feedback 里，核对时刻没写），这些行在新构建里全被当成"未核对"标黄 ——
 * 明明 AI 的判语就在 feedback 里。启动时扫一遍：`correct === true` 且
 * **有 AI 评语**、却没有核对时刻的行，把缺的字段补齐 —— 评语就是
 * "AI 真的判过"的铁证；评语也没有的（兜底放行）保持未核对，那才是它本来的样子。
 * 幂等：补过一次的行不再匹配条件，重复跑是空转。
 */
export async function healLegacyImitationRows(db: VaultDb): Promise<number> {
  const rows = await db.getAll<ProgressRow>(STORE.progress);
  let healed = 0;
  for (const row of rows) {
    if (row.deletedAt) continue;
    if (row.imitationCorrect !== true || row.imitationVerifiedAt) continue;
    const feedback = row.imitationFeedback;
    const hasAiReason = typeof feedback?.reason === "string" && feedback.reason.trim() !== "";
    const aiSaidCorrect = feedback?.correct === true;
    if (!hasAiReason && !aiSaidCorrect) continue;
    row.imitationVerifiedAt = new Date().toISOString();
    if (feedback && typeof feedback.correct !== "boolean") {
      // 旧版评语没记判定当时的结论 —— 补齐，展示侧（storedVerdict）要靠它认这份评语
      feedback.correct = true;
    }
    await persistProgress(db, row);
    healed += 1;
  }
  return healed;
}

/**
 * 进一条记录时落在哪一句：
 * 上次会话停的那句优先；没学过就从第一句没学过的开始；都学完了回第一句。
 */
export function resumeIndex(
  sentences: readonly StudySentence[],
  lastSession: SessionRow | null,
  completedSentenceCids: ReadonlySet<string>,
): number {
  const total = sentences.length;
  if (total === 0) return 0;
  const fromSession = lastSession?.currentIndex ?? 0;
  if (fromSession >= 1 && fromSession <= total) return fromSession;
  const firstOpen = sentences.find((sentence) => !completedSentenceCids.has(sentence.cid));
  return firstOpen?.index ?? 1;
}

// ── 本地留档：解析结果与助手对话 ───────────────────────────────────────────
//
// 🔥 口径（2026-09-27 用户拍板；2026-10-06 纠正同步改版）：**跟读 / 抄写 /
// AI 解析 / 助手对话，全部留在本地。**
//
// 其中三样**另外还要上行**（不靠本节这两个写口，也不走 outbox）：
//   · **AI 核对通过的仿写**（`imitationVerifiedAt` 有值的那句）—— 走 `stats/push`；
//   · 日活计数与单词熟练度 —— 同上；
//   · **用户手改的台词/翻译/注音**（2026-10-06 起）—— 走 `corrections/push|pull`
//     的私有同步（用户主动编辑的内容，存整句；见 `sync/snapshot.ts` 的 corrections 集合）。
//
// 解析/纠错覆盖层写在**句子行**（sentences，三句哈希寻址）上——跨记录共享：
// 在哪条记录里学过/改过，别的记录翻开同一句直接就有。

/** 覆盖层的落库口：句子行不存在时兜底建一行（正常导入流程里它已经在）。 */
async function persistSentence(
  db: VaultDb,
  sentence: StudySentence,
  patch: Partial<Pick<SentenceRow, "analysis" | "textFixes" | "readingFixes" | "correctionsUpdatedAt">>,
): Promise<void> {
  const existing = await db.get<SentenceRow>(STORE.sentences, sentence.cid);
  const next: SentenceRow = existing
    ? { ...existing, ...patch, clientUpdatedAt: new Date().toISOString() }
    : {
        cid: sentence.cid,
        ja: sentence.ja,
        textHash: sentence.textHash,
        analysis: null,
        clientUpdatedAt: new Date().toISOString(),
        ...patch,
        rev: 0,
        rowDigest: "",
      };
  next.rowDigest = await rowDigest(next as unknown as Record<string, unknown>);
  await db.put(STORE.sentences, next);
}

/**
 * 把一份解析结果写进句子行 —— 翻回来不用再点、也不再花钱。
 *
 * ⚠️ 摘要照实重算，但这条改动**不登记为待上行**（见本节开头）。
 */
export async function saveSliceAnalysis(
  db: VaultDb,
  sentence: StudySentence,
  analysis: SentenceAnalysis,
): Promise<void> {
  await persistSentence(db, sentence, { analysis });
}

/**
 * 这条记录里**有没有解读那一块**（两段正文或整句译文，任一有内容就算）。
 *
 * 🔥 为什么要有它（2026-10-15 用户拍板）：解析是**两块各自独立**来的，解读那一块
 * 到手就**先单独落一次库**（见 StudyView.persistExplanationOnly）—— 于是库里会出现
 * "只有解读、没有词表"的**半份**记录（`done` 仍是 false）。这时判断"要不要把解读
 * 铺给用户看"就**不能再看 `done`** —— 那会把刚替他存下的解读又藏起来，等于白存，
 * 用户重启一次插件就以为"整句解析不见了"。
 *
 * ⚠️ 与 `done` 的分工（两者不是一回事，别互相替代）：
 *   · `done` = **两块都到**（解析完整：句子卡点亮、词点得开、按钮说「重新解析」）；
 *   · 这一个只回答"解读那块在不在"。
 */
export function hasExplanationContent(
  analysis: Pick<SentenceAnalysis, "explanation" | "translation"> | null | undefined,
): boolean {
  if (!analysis) return false;
  if ((analysis.translation ?? "").trim()) return true;
  return hasSections(analysis.explanation);
}

/**
 * 保存用户对日文 / 中文字幕的修正（`textFixes`）。
 *
 * 🔥 覆盖层存「覆盖后的文本」，记录层的 `ja` / `zh` 原文一律不动 ——
 * 身份永远锚在原片字幕上（三句哈希），用户改的版本叠加在显示层。
 * 显示与解析一律读 `effectiveJa(sentence)` / `effectiveZh(sentence)`。
 *
 * 用户主动编辑的内容，走**私有同步**上云（见 `sync/snapshot.ts` 的 corrections 集合）；
 * 传 undefined = 撤销全部字幕修正 —— 覆盖层删掉，同时抬 `correctionsUpdatedAt`
 * 留墓碑，删除才能同步到别的设备。AI 解析落库（`saveSliceAnalysis`）不走这里，
 * 它仍然只落本机。
 */
export async function saveSliceTextFixes(
  db: VaultDb,
  sentence: StudySentence,
  fixes: StudySentence["textFixes"],
): Promise<void> {
  await persistSentence(db, sentence, {
    textFixes: fixes,
    correctionsUpdatedAt: new Date().toISOString(),
  });
}

/** 这句的**实际**日文：用户改过就用他改的。空字符串算「没改」（见 `normalizeTextFix`）。 */
export function effectiveJa(sentence: Pick<StudySentence, "ja" | "textFixes">): string {
  return sentence.textFixes?.ja?.trim() ? sentence.textFixes.ja : sentence.ja;
}

/** 这句的实际中文。同 `effectiveJa`。 */
export function effectiveZh(sentence: Pick<StudySentence, "zh" | "textFixes">): string {
  return sentence.textFixes?.zh?.trim() ? sentence.textFixes.zh : sentence.zh;
}

/**
 * 把弹窗里两个输入框的值整理成 `textFixes`。
 *
 * 空 / 只剩空白 = **撤销这一项的修正**（存 undefined 而不是空串），
 * 否则「清空 = 恢复原片字幕」这个动作在数据层看不出来，等于没实现。
 */
export function normalizeTextFix(ja: string, zh: string): StudySentence["textFixes"] {
  const out: NonNullable<StudySentence["textFixes"]> = {};
  const jaTrim = ja.trim();
  const zhTrim = zh.trim();
  if (jaTrim) out.ja = jaTrim;
  if (zhTrim) out.zh = zhTrim;
  return Object.keys(out).length ? out : undefined;
}

/**
 * 保存用户对注音的纠错（`readingFixes`，键 = 分词序号）。
 *
 * 用户主动编辑的内容，走**私有同步**上云（见 `sync/snapshot.ts` 的 corrections 集合）；
 * AI 解析的读音不在这里、只落本机。`fixes` 传 undefined = 清掉全部纠错，
 * 覆盖层删掉、抬 `correctionsUpdatedAt` 留墓碑（同 `saveSliceTextFixes`）。
 */
export async function saveSliceReadingFixes(
  db: VaultDb,
  sentence: StudySentence,
  fixes: StudySentence["readingFixes"],
): Promise<void> {
  await persistSentence(db, sentence, {
    readingFixes: fixes,
    correctionsUpdatedAt: new Date().toISOString(),
  });
}

/**
 * 记一轮助手问答。
 *
 * 走 `persistProgress`：对话是进度行的一部分，而且它**不影响三步完成状态**
 * （`imitationCorrect` 没动），所以日活埋点不会被误触发。
 */
export async function appendChatTurn(
  db: VaultDb,
  sentence: StudySentence,
  turn: Omit<ChatTurn, "ts">,
): Promise<ProgressRow> {
  const now = new Date().toISOString();
  const row = (await loadProgress(db, sentence.cid)) ?? baseProgress(sentence.cid, now);
  row.imitationChat = [...row.imitationChat, { ...turn, ts: now }];
  return persistProgress(db, row);
}
