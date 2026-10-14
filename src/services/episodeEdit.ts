/**
 * 「编辑这条记录」的数据层：改导入时配置的那组**纯展示字段**（视频名称、
 * 年份、季度、集号、集标题）。
 *
 * ⚠️ 两条硬边界：
 *
 *  1. **cid 不重派生**。recordCid 由「视频 sha256 + 日文字幕 sha256」派生
 *     （见 core/ids.ts），这里改的全是展示字段，身份键原样保留 —— 进度/笔记/
 *     录音/解析全挂在句子哈希上，改名零后果。改名后重新导入同一个文件对，
 *     importer 会按哈希对认出这条记录并**复活**它（不产生新行）。
 *
 *  2. **改了名字要重新查重名**。名字 + 季集号是这条记录在列表里的观感身份，
 *     改完跟别的记录撞了就是两条长得一样的记录（见 findEditClash）——
 *     笔记文件名撞车由 allocateNoteName 的哈希短尾兜底，这里只做即时提示。
 */

import { rowDigest } from "../core/digest";
import { normalizeEpisodeNumber } from "../core/ids";
import { episodeStem } from "../markdown/templates";
import { STORE, type VaultDb } from "../storage/db";
import type { RecordRow } from "../types/entities";

export interface RecordEditValues {
  /** 视频名称 */
  workTitle: string;
  year: number | null;
  season: number | null;
  number: string;
  episodeTitle: string;
}

export interface RecordEditOutcome {
  ok: boolean;
  /** ok = false 时给人看的失败原因（撞名） */
  reason?: string;
}

/** 展示名兜底链，与列表/盘点层一致。 */
function displayTitle(record: RecordRow): string {
  return record.title || record.titleJa || "未命名";
}

/**
 * 编辑后的名字会不会撞上别的记录的笔记名。撞了返回对方所属的视频名。
 */
export async function findEditClash(
  db: VaultDb,
  edited: { recordCid: string },
  next: { workTitle: string; season: number | null; number: string },
): Promise<string | null> {
  const records = await db.getAll<RecordRow>(STORE.records);
  const stem = episodeStem(next.workTitle, next.season, next.number);
  for (const record of records) {
    if (record.deletedAt || record.cid === edited.recordCid) continue;
    if (episodeStem(displayTitle(record), record.season, record.number) === stem) {
      return displayTitle(record);
    }
  }
  return null;
}

/**
 * 保存编辑：字段有变化的行落库，然后搬笔记。
 *
 * 集号沿用导入的归一化（`normalizeEpisodeNumber`），4.0 与 4 落到同一个值。
 * 什么都没改时是空操作 —— 不写库、不动文件、不抬 clientUpdatedAt。
 *
 * 撞名在这里**再查一遍**（弹窗那次只是即时提示，是异步的，赶在回包前点保存
 * 完全可能）：撞了返回 `ok: false` + 一句人话，什么都没写。
 */
export async function saveRecordEdit(
  db: VaultDb,
  current: RecordRow,
  next: RecordEditValues,
): Promise<RecordEditOutcome> {
  const newTitle = next.workTitle.trim();
  const number = normalizeEpisodeNumber(next.number);
  const season = next.season;
  const year = next.year;

  const changed =
    newTitle !== current.title ||
    year !== current.year ||
    season !== current.season ||
    number !== current.number ||
    next.episodeTitle.trim() !== current.episodeTitle;
  if (!changed) return { ok: true };

  const clash = await findEditClash(
    db,
    { recordCid: current.cid },
    { workTitle: newTitle, season, number },
  );
  if (clash) {
    return { ok: false, reason: `已经有同名的这一集了：撞上了《${clash}》` };
  }

  const now = new Date().toISOString();
  const nextRecord: RecordRow = {
    ...current,
    title: newTitle,
    year,
    season,
    number,
    episodeTitle: next.episodeTitle.trim(),
    clientUpdatedAt: now,
  };
  nextRecord.rowDigest = await rowDigest(nextRecord as unknown as Record<string, unknown>);
  await db.put(STORE.records, nextRecord);
  // 落库成功后同步调用方手里的行：列表页保存后要重渲染，别让它读到旧名字
  Object.assign(current, nextRecord);

  return { ok: true };
}
