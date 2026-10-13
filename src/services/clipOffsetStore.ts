/**
 * 校准偏移的读写。
 *
 * 偏移存在素材行上（`AssetRow.offsetMs`）：错位本质是"某份字幕 × 某条视频"之间的关系，
 * 跟着素材走 —— 换机重导同一份视频（指纹相同 ⇒ cid 相同）时，云上拉回的偏移自动挂回。
 */

import { STORE, type VaultDb } from "../storage/db";
import type { AssetRow } from "../types/entities";
import { normalizeOffset } from "./clipOffset";

/** 读素材上存的偏移。没存过 = 不偏移。 */
export async function loadVideoOffset(db: VaultDb, assetCid: string): Promise<number> {
  const asset = await db.get<AssetRow>(STORE.assets, assetCid);
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
