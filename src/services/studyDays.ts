/**
 * 日活聚合（`study_days` store）。
 *
 * 这张表是「今天学了多少」的唯一本地来源，也是网页看板上连续打卡、
 * 近 30 天柱状图、热力图的数据源。
 *
 * 同步口径（2026-10-06 统一快照）：随全量快照重推、逐行 LWW，与本地写入
 * 无耦合 —— 不需要逐行变更队列（outbox 已随统一快照退役）。
 */
import { STORE, type TxScope, type VaultDb } from "../storage/db";
import type { StudyDayRow } from "../types/entities";

/** 本地日期键 `YYYY-MM-DD`。用本地时间而不是 UTC —— 打卡是按用户过的那一天算的。 */
export function dayKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 本机时区名。服务端要它来对齐「哪一天」，没有就退回空串。 */
export function localTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

const COUNTERS = [
  "sentencesCompleted",
  "copyCount",
  "readCount",
  "imitationCount",
  "reviewCount",
  "newWords",
  "studySeconds",
  "openedSlices",
] as const;

export type StudyDayPatch = Partial<Pick<StudyDayRow, (typeof COUNTERS)[number]>>;

function emptyRow(day: string, now: string = new Date().toISOString()): StudyDayRow {
  return {
    day,
    tz: localTz(),
    sentencesCompleted: 0,
    copyCount: 0,
    readCount: 0,
    imitationCount: 0,
    reviewCount: 0,
    newWords: 0,
    studySeconds: 0,
    openedSlices: 0,
    clientUpdatedAt: now,
  };
}

/**
 * 给今天的计数加上 `patch`（按字段累加），返回合并后的整行。
 *
 * read-modify-write：keyPath 是 `day`，同一天永远只有一行，
 * 直接 put 会把别的步骤刚加的计数冲掉。
 *
 * @param tx 已在 `[STORE.studyDays]` 上的事务（要和业务写同事务时传进来）
 */
export async function bumpStudyDay(
  db: VaultDb,
  patch: StudyDayPatch,
  day: string = dayKey(),
): Promise<StudyDayRow> {
  return db.transaction([STORE.studyDays], "readwrite", async (tx) =>
    bumpStudyDayInTx(tx, patch, day),
  );
}

/** 事务内版本：和业务写（比如单词曝光）放在同一个事务里时用这个。 */
export async function bumpStudyDayInTx(
  tx: TxScope,
  patch: StudyDayPatch,
  day: string = dayKey(),
): Promise<StudyDayRow> {
  const now = new Date().toISOString();
  const current = (await tx.get<StudyDayRow>(STORE.studyDays, day)) ?? emptyRow(day, now);
  const next: StudyDayRow = { ...current, day, tz: current.tz || localTz() };
  let touched = false;
  for (const field of COUNTERS) {
    const delta = patch[field];
    if (typeof delta === "number" && Number.isFinite(delta) && delta !== 0) {
      next[field] = Math.max(next[field] + delta, 0);
      touched = true;
    }
  }
  if (touched) next.clientUpdatedAt = now;
  await tx.put(STORE.studyDays, next);
  return next;
}
