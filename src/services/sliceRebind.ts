/**
 * 换字幕后的「重新挂载」：把旧切片 cid 上的学习数据搬到新切片 cid 上。
 *
 * ## 为什么需要它
 *
 * `sliceCid` 由「上一句 + 本句 + 下一句」三句原文派生（见 `core/ids.ts`），所以
 * 换一版字幕重新导入 —— 哪怕只差一个标点 —— 这一集所有句子的 cid 会全部变掉，
 * 已经学过的进度、写过的笔记、纠过的读音会全部变成**孤儿**（数据还在库里，
 * 但新句子找不到它们）。
 *
 * ## 做什么
 *
 * 导入时用**日文相似度**把新句子认回旧句子（判据见 `jaMatch.ts`），然后把
 * 挂在旧 cid 上的东西整体 rekey 到新 cid：
 *
 *   · `progress`（cid 是 `P:<sliceCid>`，要重算 cid 与 `sliceCid` 字段）
 *   · `notes`（主键就是 sliceCid）
 *   · `recordings`（主键就是 sliceCid；录音不上云，本地救不回来就只能重录）
 *   · `meta` 里的 `exposed:<sliceCid>` 曝光标记（不搬 = 换字幕后单词熟练度重置）
 *
 * ## 边界
 *
 * **只在本地做**。云端 `sync_rows` 里那行旧 cid 不动（只增不删）。
 *
 * ⚠️ 等级双计：旧行打墓碑后，`sync_lines`（等级经验值）本来会残留旧线 → 同一句
 * 算两次。2026-10-09 起由**两件事**消除：服务端 `_project_lines` 跳过墓碑行，
 * 以及搬过来的新行带的 `recovery.from` 标记（服务端据此删掉来源 cid 的旧线）。
 * `applyRebind` **默认就给新行打这个标记**（换字幕与换机关联共用同一段 rekey）。
 *
 * vault 里已生成的 md 笔记不在 rekey 范围内：导入完成后笔记会按新 cid 重新
 * 生成，旧段落锚点自然作废。
 */

import { progressCid } from "../core/ids";
import { STORE, type VaultDb } from "../storage/db";
import { MATCH_THRESHOLD, jaSimilarity } from "./jaMatch";

/**
 * 句序窗口：换字幕时句子可能整体前后挪几位，只在这个窗口内找"同一句"。
 *
 * 为什么要有窗口：不限制的话，一集 300 句里任意两句都要比一次（9 万次），
 * 而且容易出现跨段的错绑（第 3 句绑到第 250 句）。句序在换字幕时基本保持，
 * ±15 句足够吸收增删，又不会绑到别的段落去。
 */
export const MATCH_WINDOW = 15;

/** 一次重挂载：从 `from` 搬到 `to`。 */
export interface RebindPair {
  from: string;
  to: string;
}

/**
 * 规划重挂载：新句在**第几句**的位置上认回了旧句的哪个 cid。
 *
 * 三条防错绑的约束：
 *   · 句序必须在 `MATCH_WINDOW` 窗口内；
 *   · 相似度必须过 `MATCH_THRESHOLD`（见 `jaMatch.ts`）；
 *   · **一个旧句只能被认领一次** —— 否则两句新句会抢同一个旧进度。
 *
 * @returns 新句下标 → 旧切片 cid
 */
export function planRebind(
  previous: readonly { cid: string; index: number; ja: string }[],
  incoming: readonly { index: number; ja: string }[],
): Map<number, string> {
  const result = new Map<number, string>();
  if (previous.length === 0 || incoming.length === 0) return result;
  const claimed = new Set<string>();

  for (const [position, cue] of incoming.entries()) {
    let best: { cid: string; score: number } | null = null;
    for (const old of previous) {
      if (claimed.has(old.cid)) continue;
      if (Math.abs(old.index - cue.index) > MATCH_WINDOW) continue;
      const score = jaSimilarity(old.ja, cue.ja);
      if (score < MATCH_THRESHOLD) continue;
      if (!best || score > best.score) best = { cid: old.cid, score };
    }
    if (!best) continue;
    claimed.add(best.cid);
    result.set(position, best.cid);
  }
  return result;
}

export interface RebindResult {
  /** 搬了多少条（progress + notes + recordings + 曝光标记） */
  moved: number;
}

export interface RebindOptions {
  /**
   * 「关联恢复」标记的 `source`（写进搬过来的 `ProgressRow.recovery.source`），
   * 供 UI 区分「换字幕接回」与「换机从云端接回」。默认 `"slice-rebind"`。
   */
  source?: string;
  /**
   * 是否给搬过来的 progress 行打 `recovery.from` 标记。**默认开**。
   *
   * 它有两个作用：① 服务端 `_project_lines` 据此把来源 cid 的旧等级线删掉，
   * 同一句不会在 `sync_lines`（等级经验值）里被算两次；② UI 打「关联恢复」徽标、
   * 给「撤销」入口。关掉只该有一种理由：调用方自己接管了去重。
   */
  markRecovery?: boolean;
}

/** 开卡埋点的标记前缀，与 `services/words.ts` 一致。 */
const exposedKey = (sliceCid: string): string => `exposed:${sliceCid}`;

/**
 * 执行一批重挂载。
 *
 * 幂等：搬过的键在目标 cid 上已经存在（且是活行）时以**本地现有**为准，不覆盖
 * （换字幕不会把用户新学的进度抹掉）。搬完旧 progress 键打墓碑（见下）。
 */
export async function applyRebind(
  db: VaultDb,
  pairs: readonly RebindPair[],
  opts: RebindOptions = {},
): Promise<RebindResult> {
  if (pairs.length === 0) return { moved: 0 };
  const markRecovery = opts.markRecovery ?? true;
  const source = opts.source ?? "slice-rebind";
  const stores: Parameters<VaultDb["transaction"]>[0] = [
    STORE.progress, STORE.recordings, STORE.meta, STORE.slices,
  ];
  let moved = 0;

  await db.transaction(stores, "readwrite", async (tx) => {
    for (const pair of pairs) {
      if (!pair.from || !pair.to || pair.from === pair.to) continue;

      // ── progress：cid 要重算（它是 `P:<sliceCid>`），sliceCid 字段也要改 ──
      // 旧行**打墓碑**（deletedAt）留在库里，不硬删：云端只增不删，硬删的旧行
      // 会被下一次同步从云端原样拉回来「复活」，在多设备上变成看不见的幽灵账。
      // 墓碑抬了 clientUpdatedAt，LWW 必赢 —— 随快照上云把云端那行一并盖成已删，
      // 其他设备拉到墓碑后同样过滤掉，全端一致。所有读取路径都按 deletedAt 过滤
      // （loadCore / loadEpisodeList / StudyView / dataInventory 全是），本地展示不受影响。
      const oldProgress = await tx.get<Record<string, unknown>>(STORE.progress, progressCid(pair.from));
      if (oldProgress) {
        const newCid = progressCid(pair.to);
        const existing = await tx.get<Record<string, unknown>>(STORE.progress, newCid);
        // 目标不存在、或只是一枚墓碑（撤销关联后旧行被复活过的位置）→ 写过去。
        // 目标若已有**活行**则以本地现有为准，不覆盖（不抹掉用户新学的进度）。
        if (!existing || existing.deletedAt) {
          const next: Record<string, unknown> = {
            ...oldProgress, cid: newCid, sliceCid: pair.to, deletedAt: null,
          };
          if (markRecovery) {
            next.recovery = { from: pair.from, at: new Date().toISOString(), source };
          } else {
            delete next.recovery;
          }
          await tx.put(STORE.progress, next);
          moved += 1;
        }
        const now = new Date().toISOString();
        await tx.put(STORE.progress, { ...oldProgress, deletedAt: now, clientUpdatedAt: now });
      }

      // ── recordings：主键就是 sliceCid，整键搬家 ──
      // （笔记不搬：2026-10-09 起笔记是哈希寻址的内容 —— 服务端共享笔记与
      //   本机 my_notes 都按三句 hash 挂，句子内容变了就是另一个身份，
      //   跟共享笔记的自然边界一致，不做本地特判。）
      {
        const store = STORE.recordings;
        const row = await tx.get<Record<string, unknown>>(store, pair.from);
        if (row) {
          const existing = await tx.get<Record<string, unknown>>(store, pair.to);
          if (!existing) {
            await tx.put(store, { ...row, cid: pair.to, sliceCid: pair.to });
            moved += 1;
          }
          await tx.delete(store, pair.from);
        }
      }

      // ── 曝光标记：不搬 = 换字幕后单词熟练度被重置回「新词」 ──
      const marker = await tx.get<{ key: string; value: boolean }>(STORE.meta, exposedKey(pair.from));
      if (marker) {
        await tx.put(STORE.meta, { key: exposedKey(pair.to), value: marker.value });
        await tx.delete(STORE.meta, exposedKey(pair.from));
        moved += 1;
      }

      // ── 旧切片行本身：留着就是重复句（同一集会出现两份同样的台词） ──
      // 没被匹配上的旧句**不删** —— 它们是旧字幕版本独有的句子，用户切回旧
      // 字幕时还用得上，而且上面什么都没搬走，删了才是真的丢数据。
      await tx.delete(STORE.slices, pair.from);
    }
  });

  return { moved };
}
