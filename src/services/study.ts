/**
 * 学习流程的数据层（本地）。
 *
 * 对齐服务端 `core/learning/services/study.py` 的行为口径：
 *   · 进度跟着切片走（progressCid = P:<sliceCid>），三步各自的完成时刻分开记；
 *   · 「重置」把那一步**完全恢复初始**（完成时刻、留档、草稿一并清，
 *     2026-10-04 用户拍板，取代旧"重做不动完成时刻"的约定）——
 *     completedAt 由三步齐全推导，缺一步整句就回到未完成；
 *   · 会话记录"在学哪集、学到第几句"，中途退出再进来从这一句接着来。
 *
 * 业务行直接写在同一个事务里（outbox 已随 2026-10-06 统一快照同步退役——
 * 全量快照重推不依赖逐行待办）。
 */

import { rowDigest } from "../core/digest";
import { progressCid, sessionCid } from "../core/ids";
import { STORE, type StoreName, type VaultDb } from "../storage/db";
import { bumpStudyDay, type StudyDayPatch } from "./studyDays";
import type {
  AssetRow,
  ChatTurn,
  EpisodeRow,
  ProgressRow,
  SentenceAnalysis,
  SessionRow,
  SliceRow,
  WorkRow,
} from "../types/entities";

export interface EpisodeListItem {
  work: WorkRow;
  episode: EpisodeRow;
  total: number;
  completed: number;
  /** 这一集最近一次会话（"上次学到第 N 句"的来源）；没学过为 null */
  lastSession: SessionRow | null;
}

const live = <T extends { deletedAt: string | null }>(rows: T[]): T[] =>
  rows.filter((row) => !row.deletedAt);

/** 首页列表：本机导入过的每一集，带句数、已学句数和上次学到的位置。 */
export async function loadEpisodeList(db: VaultDb): Promise<EpisodeListItem[]> {
  const [works, episodes, slices, sessions, progress] = await Promise.all([
    db.getAll<WorkRow>(STORE.works),
    db.getAll<EpisodeRow>(STORE.episodes),
    db.getAll<SliceRow>(STORE.slices),
    db.getAll<SessionRow>(STORE.sessions),
    db.getAll<ProgressRow>(STORE.progress),
  ]);

  const completedBySlice = new Map<string, number>();
  for (const row of live(progress)) {
    if (row.completedAt) completedBySlice.set(row.sliceCid, (completedBySlice.get(row.sliceCid) ?? 0) + 1);
  }

  const totalByEpisode = new Map<string, number>();
  const sliceCidsByEpisode = new Map<string, string[]>();
  for (const slice of live(slices)) {
    totalByEpisode.set(slice.episodeCid, (totalByEpisode.get(slice.episodeCid) ?? 0) + 1);
    const bucket = sliceCidsByEpisode.get(slice.episodeCid) ?? [];
    bucket.push(slice.cid);
    sliceCidsByEpisode.set(slice.episodeCid, bucket);
  }

  const latestSessionByEpisode = new Map<string, SessionRow>();
  for (const session of live(sessions)) {
    if (!session.episodeCid) continue;
    const current = latestSessionByEpisode.get(session.episodeCid);
    if (!current || session.startedAt > current.startedAt) {
      latestSessionByEpisode.set(session.episodeCid, session);
    }
  }

  const items: EpisodeListItem[] = [];
  for (const episode of live(episodes)) {
    const work = works.find((row) => row.cid === episode.workCid && !row.deletedAt);
    const total = totalByEpisode.get(episode.cid) ?? 0;
    if (!work || total === 0) continue;
    const completed = (sliceCidsByEpisode.get(episode.cid) ?? []).reduce(
      (sum, sliceCid) => sum + (completedBySlice.get(sliceCid) ? 1 : 0),
      0,
    );
    items.push({
      work,
      episode,
      total,
      completed,
      lastSession: latestSessionByEpisode.get(episode.cid) ?? null,
    });
  }

  // 集号可能留空（不是番剧的单集视频）。`Number("")` 是 0，直接相减会让这类视频
  // 冒充"第 0 集"挤到最前面 —— 空集号一律排到最后，别跟正片抢位置。
  const episodeOrder = (number: string): number => {
    const value = Number(number);
    return number.trim() && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  };

  // 同一部番排一起、集号从小到大；最近学过的集排最前（服务端选集页同款）
  items.sort((a, b) => {
    const byWork = (a.work.title || a.work.titleJa).localeCompare(b.work.title || b.work.titleJa);
    if (byWork !== 0) return byWork;
    const byNumber = episodeOrder(a.episode.number) - episodeOrder(b.episode.number);
    if (byNumber !== 0) return byNumber;
    const aAt = a.lastSession?.startedAt ?? "";
    const bAt = b.lastSession?.startedAt ?? "";
    return bAt.localeCompare(aAt);
  });
  return items;
}

/**
 * 从列表里移除一集（软删）。
 *
 * 给**内置演示素材**配的出口 —— 用户看够了要能删掉，不能白送一集删不掉的。
 * 但它对任何一集都通用：没有理由只让示例能删。
 *
 * 是**软删**不是真删：挂上 `deletedAt`，`live()` 一过滤列表里立刻消失，而
 * 学习记录（progress / sessions）和已经生成的笔记文件**一律不动** —— 那些是
 * 用户自己学出来的东西，删一集视频不该把它们一起烧掉。
 *
 * 连带一起软删的只有**这一集自己的**素材与切片（它们没有独立存在的意义），
 * 以及**这部作品在没有别的集之后**的作品行（否则列表里会剩一条空壳作品）。
 */
export async function removeEpisode(db: VaultDb, episodeCid: string): Promise<void> {
  const episode = await db.get<EpisodeRow>(STORE.episodes, episodeCid);
  if (!episode || episode.deletedAt) return;

  const [siblings, assets, slices] = await Promise.all([
    db.getAllByIndex<EpisodeRow>(STORE.episodes, "by_work", episode.workCid),
    db.getAllByIndex<AssetRow>(STORE.assets, "by_episode", episodeCid),
    db.getAllByIndex<SliceRow>(STORE.slices, "by_episode", episodeCid),
  ]);

  const now = new Date().toISOString();
  // ⚠️ `deletedAt` / `clientUpdatedAt` 都是 volatile 字段（见 core/digest.ts），
  // 不参与摘要计算，所以这几行的 rowDigest **不用重算** —— 删不删它都一样。
  // 上行靠统一快照全量重推（见 sync/snapshot.ts），跟摘要没关系。
  const dead = <T extends { deletedAt: string | null; clientUpdatedAt: string }>(row: T): T => ({
    ...row,
    deletedAt: now,
    clientUpdatedAt: now,
  });

  const work =
    siblings.some((row) => row.cid !== episodeCid && !row.deletedAt)
      ? null
      : (await db.get<WorkRow>(STORE.works, episode.workCid)) ?? null;
  const deadWork = work && !work.deletedAt ? work : null;

  const stores: StoreName[] = [STORE.episodes, STORE.assets, STORE.slices];
  if (deadWork) stores.push(STORE.works);

  await db.transaction(stores, "readwrite", async (tx) => {
    await tx.put(STORE.episodes, dead(episode));
    for (const row of assets) await tx.put(STORE.assets, dead(row));
    for (const row of slices) await tx.put(STORE.slices, dead(row));
    if (deadWork) await tx.put(STORE.works, dead(deadWork));
  });
}

export async function loadSlices(db: VaultDb, episodeCid: string): Promise<SliceRow[]> {
  const rows = await db.getAllByIndex<SliceRow>(STORE.slices, "by_episode", episodeCid);
  return live(rows).sort((a, b) => a.index - b.index);
}

export async function loadProgress(db: VaultDb, sliceCid: string): Promise<ProgressRow | undefined> {
  return db.get<ProgressRow>(STORE.progress, progressCid(sliceCid));
}

/** 这一集最近一次会话（没有就 null）。 */
export async function lastSessionOf(db: VaultDb, episodeCid: string): Promise<SessionRow | null> {
  const rows = live(await db.getAllByIndex<SessionRow>(STORE.sessions, "by_episode", episodeCid));
  if (rows.length === 0) return null;
  return rows.reduce((latest, row) => (row.startedAt > latest.startedAt ? row : latest));
}

/** 进一集：开一条新会话。 */
export async function startSession(db: VaultDb, episodeCid: string): Promise<SessionRow> {
  const now = new Date().toISOString();
  const session: SessionRow = {
    cid: sessionCid(),
    episodeCid,
    startedAt: now,
    endedAt: null,
    currentIndex: 0,
    clientUpdatedAt: now,
    deletedAt: null,
    rev: 0,
    rowDigest: await rowDigest({ episodeCid, startedAt: now, endedAt: null, currentIndex: 0 }),
  };
  await db.transaction([STORE.sessions], "readwrite", (tx) => tx.put(STORE.sessions, session));
  return session;
}

/** 会话推进/收尾。收尾（endedAt 由空变有）时把这段时长记进日活。 */
export async function saveSession(db: VaultDb, session: SessionRow): Promise<void> {
  const now = new Date().toISOString();
  const next: SessionRow = { ...session, clientUpdatedAt: now };
  next.rowDigest = await rowDigest({
    episodeCid: next.episodeCid,
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

function baseProgress(sliceCid: string, now: string): ProgressRow {
  return {
    cid: progressCid(sliceCid),
    sliceCid,
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
  slice: SliceRow,
  seconds: number | null,
  verified: boolean,
): Promise<ProgressRow> {
  const now = new Date().toISOString();
  const row = (await loadProgress(db, slice.cid)) ?? baseProgress(slice.cid, now);
  row.readAloudAt = now;
  row.readAloudVerifiedAt = verified ? now : null;
  if (seconds !== null) row.readAloudSeconds = seconds;
  return persistProgress(db, row, "read");
}

/** 抄写检查通过/失败都算一次尝试；对了落完成时刻并留档。 */
export async function submitCopy(
  db: VaultDb,
  slice: SliceRow,
  input: CopyStepInput,
): Promise<ProgressRow> {
  const now = new Date().toISOString();
  const row = (await loadProgress(db, slice.cid)) ?? baseProgress(slice.cid, now);
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
  slice: SliceRow,
  input: ImitationStepInput,
): Promise<ProgressRow> {
  const now = new Date().toISOString();
  const row = (await loadProgress(db, slice.cid)) ?? baseProgress(slice.cid, now);
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
  slice: SliceRow,
  step: "read" | "copy" | "imitation",
): Promise<ProgressRow> {
  const now = new Date().toISOString();
  const row = (await loadProgress(db, slice.cid)) ?? baseProgress(slice.cid, now);
  if (step === "read") {
    row.readEpoch += 1;
    row.readAloudAt = null;
    // 「有没有让 AI 判过」也是这一步的状态，跟着清 —— 留着它，下一遍还没核对
    // 就会显示成青蓝的「正解 ✓」（与上面 imitationVerifiedAt 同一个道理）。
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
 * 进一集时落在哪一句：
 * 上次会话停的那句优先；没学过就从第一句没学过的开始；都学完了回第一句。
 */
export function resumeIndex(
  slices: readonly SliceRow[],
  lastSession: SessionRow | null,
  completedSliceCids: ReadonlySet<string>,
): number {
  const total = slices.length;
  if (total === 0) return 0;
  const fromSession = lastSession?.currentIndex ?? 0;
  if (fromSession >= 1 && fromSession <= total) return fromSession;
  const firstOpen = slices.find((slice) => !completedSliceCids.has(slice.cid));
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
// 下面两处都是普通直写（outbox 已退役；同步是全量快照重推，不需要逐行待办）：
//   · 解析结果是纯缓存 —— 服务端有自己那份（跨用户共享，见
//     `learning.AnalysisCache`），本机这份丢了顶多重解析一次，
//     不该占着「待同步 N」的计数一直涨；AI 解析的读音（`aiReading`）同理，
//     不是用户写的，**永不上行**；
//   · 助手对话只是当前这句的上下文 —— 用户明确说了**聊天记录只留本地、
//     2026-10-06 起随统一快照上云（用户拍板：白名单之外全上云，聊天也是用户写的内容）。
//   （同一理由见 `studyDays.ts` 头部：写待办只会让 outbox 无限增长。）

/**
 * 把一份解析结果写进切片行 —— 翻回来不用再点、也不再花钱。
 *
 * ⚠️ 摘要照实重算，但这条改动**不登记为待上行**（见本节开头）。
 */
export async function saveSliceAnalysis(
  db: VaultDb,
  slice: SliceRow,
  analysis: SentenceAnalysis,
): Promise<void> {
  const next: SliceRow = { ...slice, analysis, clientUpdatedAt: new Date().toISOString() };
  next.rowDigest = await rowDigest(next as unknown as Record<string, unknown>);
  await db.put(STORE.slices, next);
}

/**
 * 保存用户对日文 / 中文字幕的修正（`textFixes`）。
 *
 * 🔥 **绝不动 `ja` / `zh` 字段** —— 日文参与 `sliceCid`（三句 hash）派生，
 * 改了它这个句子的 cid 就对不上，已有进度 / 录音 / 单词卡全成孤儿（见 entities.ts 的说明）。
 * 覆盖层只改「显示与解析时读到的文本」。
 *
 * 用户主动编辑的内容，走**私有同步**上云（见 `sync/snapshot.ts` 的 corrections 集合）；
 * 传 undefined = 撤销全部字幕修正 —— 覆盖层删掉，同时抬 `correctionsUpdatedAt`
 * 留墓碑，删除才能同步到别的设备。AI 解析落库（`saveSliceAnalysis`）不走这里，
 * 它仍然只落本机。
 */
export async function saveSliceTextFixes(
  db: VaultDb,
  slice: SliceRow,
  fixes: SliceRow["textFixes"],
): Promise<void> {
  const next: SliceRow = {
    ...slice,
    textFixes: fixes,
    correctionsUpdatedAt: new Date().toISOString(),
    clientUpdatedAt: new Date().toISOString(),
  };
  next.rowDigest = await rowDigest(next as unknown as Record<string, unknown>);
  await db.put(STORE.slices, next);
}

/** 这句的**实际**日文：用户改过就用他改的。空字符串算「没改」（见 `normalizeTextFix`）。 */
export function effectiveJa(slice: Pick<SliceRow, "ja" | "textFixes">): string {
  return slice.textFixes?.ja?.trim() ? slice.textFixes.ja : slice.ja;
}

/** 这句的实际中文。同 `effectiveJa`。 */
export function effectiveZh(slice: Pick<SliceRow, "zh" | "textFixes">): string {
  return slice.textFixes?.zh?.trim() ? slice.textFixes.zh : slice.zh;
}

/**
 * 把弹窗里两个输入框的值整理成 `textFixes`。
 *
 * 空 / 只剩空白 = **撤销这一项的修正**（存undefined 而不是空串），
 * 否则「清空 = 恢复原片字幕」这个动作在数据层看不出来，等于没实现。
 */
export function normalizeTextFix(ja: string, zh: string): SliceRow["textFixes"] {
  const out: NonNullable<SliceRow["textFixes"]> = {};
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
  slice: SliceRow,
  fixes: SliceRow["readingFixes"],
): Promise<void> {
  const next: SliceRow = {
    ...slice,
    readingFixes: fixes,
    correctionsUpdatedAt: new Date().toISOString(),
    clientUpdatedAt: new Date().toISOString(),
  };
  next.rowDigest = await rowDigest(next as unknown as Record<string, unknown>);
  await db.put(STORE.slices, next);
}

/**
 * 记一轮助手问答。
 *
 * 走 `persistProgress`：对话是进度行的一部分，而且它**不影响三步完成状态**
 * （`imitationCorrect` 没动），所以日活埋点不会被误触发。
 */
export async function appendChatTurn(
  db: VaultDb,
  slice: SliceRow,
  turn: Omit<ChatTurn, "ts">,
): Promise<ProgressRow> {
  const now = new Date().toISOString();
  const row = (await loadProgress(db, slice.cid)) ?? baseProgress(slice.cid, now);
  row.imitationChat = [...row.imitationChat, { ...turn, ts: now }];
  return persistProgress(db, row);
}
