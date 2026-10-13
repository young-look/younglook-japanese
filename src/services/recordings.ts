/**
 * 跟读录音的本地存取。
 *
 * 录音是**本地私有**数据：只进 IndexedDB 的 recordings 表（key = sliceCid），
 * 不上云同步 —— 音频体积大，而且"听听自己读的"本来就只对
 * 录音的那台设备有意义。换设备/重装后没有录音，界面退化为只能重录一遍，
 * 不算错误。
 */

import { STORE, type VaultDb } from "../storage/db";

export interface RecordingRow {
  sliceCid: string;
  blob: Blob;
  mimeType: string;
  seconds: number;
  savedAt: string;
}

export async function loadRecording(db: VaultDb, sliceCid: string): Promise<RecordingRow | undefined> {
  try {
    return await db.get<RecordingRow>(STORE.recordings, sliceCid);
  } catch {
    // 表不存在（老库升级失败之类）就当没有录音，别挡着学习流程
    return undefined;
  }
}

export async function saveRecording(
  db: VaultDb,
  sliceCid: string,
  blob: Blob,
  mimeType: string,
  seconds: number,
): Promise<void> {
  const row: RecordingRow = {
    sliceCid,
    blob,
    mimeType,
    seconds,
    savedAt: new Date().toISOString(),
  };
  await db.put(STORE.recordings, row);
}

/**
 * 删掉这句的录音 —— 「重置」跟读那一步时用。
 * 本来就没有（或表都不在）不算错：重置要的是"回到没录过"的状态。
 */
export async function deleteRecording(db: VaultDb, sliceCid: string): Promise<void> {
  try {
    await db.delete(STORE.recordings, sliceCid);
  } catch {
    // 表不存在之类：没有可删的就当删干净了
  }
}
