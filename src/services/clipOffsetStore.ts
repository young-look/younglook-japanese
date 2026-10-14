/**
 * 校准偏移的读写。
 *
 * 偏移存在视频素材行上（`AssetRow.offsetMs`）：错位本质是"某份字幕 × 某条视频"之间的关系，
 * 跟着**视频文件**走 —— 素材行按文件 sha256 寻址（跨记录共享），所以同一个视频
 * 换一份字幕重新导入，校准自动还在；换一个视频文件则从头再校。
 */

import { STORE, type VaultDb } from "../storage/db";
import { assetShaCid } from "../core/ids";
import type { AssetRow } from "../types/entities";
import { normalizeOffset } from "./clipOffset";

/** 读视频素材上存的偏移。没存过 = 不偏移。 */
export async function loadVideoOffset(db: VaultDb, videoSha256: string): Promise<number> {
  const asset = await db.get<AssetRow>(STORE.assets, assetShaCid(videoSha256));
  return normalizeOffset(asset?.offsetMs ?? 0);
}

/** 存偏移，返回更新后的素材行（内存里那份也要跟着换，别用旧的覆盖回去）。 */
export async function saveVideoOffset(db: VaultDb, asset: AssetRow, offsetMs: number): Promise<AssetRow> {
  const next: AssetRow = {
    ...asset,
    offsetMs: normalizeOffset(offsetMs),
    clientUpdatedAt: new Date().toISOString(),
  };
  await db.transaction([STORE.assets], "readwrite", (tx) => tx.put(STORE.assets, next));
  return next;
}
