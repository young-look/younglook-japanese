/**
 * 用户纠正（台词/翻译/注音）的云同步合并。
 *
 * 数据本身长在切片行的覆盖层上（`textFixes` / `readingFixes`，见 entities.ts），
 * 这里只管「服务端下拉的那份怎么套回本地」—— 与笔记的合并（`sliceNote.ts`）
 * 同一套 LWW 口径：`correctionsUpdatedAt` 新的赢，推拉都无状态、靠时间戳自愈。
 *
 * 云同步没有自己的请求时机 —— 挂在 main.ts 的 `syncStats` 同一趟里推拉
 * （统一快照的 corrections 集合复用这里的合并器；见 `sync/snapshot.ts`）。
 */

import { STORE, type VaultDb } from "../storage/db";
import type { SliceRow } from "../types/entities";
import { rowDigest } from "../core/digest";

/** 时间戳比较统一走毫秒：插件给 `Z` 结尾、服务端给 `+00:00` 结尾，字符串比大小会错。 */
function tsMs(value: string): number {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * 把服务端下拉的纠正合并进本地切片行（LWW：`correctionsUpdatedAt` 新的赢）。
 *
 * 内容三字段全空的墓碑行照合并 —— 撤销要能跨设备，靠的就是把覆盖层清掉。
 *
 * 本地没这句（素材没导入）时的默认口径是**跳过**：cid 是内容派生的，等素材导入后
 * 下一趟 pull 自然会把它补上。但换机后导入的是**另一版字幕**（cid 不同）时永远补不上
 * —— 那种情况由 `onOrphan` 回调交给调用方**暂存**（见 `sync/snapshot.ts` 的孤儿补丁），
 * 等用户确认接回后再套到新切片上。
 *
 * @returns 实际写入/覆盖的切片行数
 */
export async function applyPulledCorrections(
  db: VaultDb,
  rows: ReadonlyArray<{
    slice_cid?: unknown;
    ja?: unknown;
    zh?: unknown;
    reading_fixes?: unknown;
    client_updated_at?: unknown;
  }>,
  opts: {
    /** 本地没有对应切片（或它是墓碑）时回调 —— 调用方决定是否暂存为孤儿补丁。 */
    onOrphan?: (patch: {
      sliceCid: string;
      ja?: unknown;
      zh?: unknown;
      reading_fixes?: unknown;
      client_updated_at: string;
    }) => void;
  } = {},
): Promise<number> {
  let applied = 0;
  for (const pulled of rows) {
    const sliceCid = typeof pulled.slice_cid === "string" ? pulled.slice_cid : "";
    const clientUpdatedAt =
      typeof pulled.client_updated_at === "string" ? pulled.client_updated_at : "";
    // 时间戳解不出来 = 脏行，直接丢：落了库它永远赢不了 LWW，还把墓碑搅乱
    if (!sliceCid || !clientUpdatedAt || Number.isNaN(Date.parse(clientUpdatedAt))) continue;
    const local = await db.get<SliceRow>(STORE.slices, sliceCid);
    if (!local || local.deletedAt) {
      opts.onOrphan?.({
        sliceCid,
        ja: pulled.ja,
        zh: pulled.zh,
        reading_fixes: pulled.reading_fixes,
        client_updated_at: clientUpdatedAt,
      });
      continue;
    }
    if (tsMs(local.correctionsUpdatedAt ?? "") >= tsMs(clientUpdatedAt)) continue;

    const ja = typeof pulled.ja === "string" && pulled.ja.trim() ? pulled.ja : undefined;
    const zh = typeof pulled.zh === "string" && pulled.zh.trim() ? pulled.zh : undefined;
    let readingFixes: SliceRow["readingFixes"];
    if (pulled.reading_fixes && typeof pulled.reading_fixes === "object") {
      const fixes: NonNullable<SliceRow["readingFixes"]> = {};
      for (const [key, value] of Object.entries(pulled.reading_fixes as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const surface = (value as { surface?: unknown }).surface;
        const reading = (value as { reading?: unknown }).reading;
        if (typeof surface !== "string" || !surface.trim()) continue;
        if (typeof reading !== "string") continue;
        fixes[key] = { surface: surface.trim(), reading };
      }
      if (Object.keys(fixes).length > 0) readingFixes = fixes;
    }

    const next: SliceRow = {
      ...local,
      textFixes: ja || zh ? { ...(ja ? { ja } : {}), ...(zh ? { zh } : {}) } : undefined,
      readingFixes,
      correctionsUpdatedAt: clientUpdatedAt,
    };
    next.rowDigest = await rowDigest(next as unknown as Record<string, unknown>);
    await db.put(STORE.slices, next);
    applied += 1;
  }
  return applied;
}
