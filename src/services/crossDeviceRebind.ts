/**
 * 跨设备关联恢复：换机后把**云端的旧学习记录**接到本次导入的新切片上。
 *
 * ## 它解决什么
 *
 * 场景：用户在 A 机器上导入过一部剧（用的是 A 版字幕），学过一批句子，数据已上云；
 * 电脑丢了 / 换了新机器，本地库是空的。重登后云端把 `progress` 拉了回来 ——
 * 但**台词原文不在云上**（隐私红线，`slices` 整表不上云），所以本地没有对应切片，
 * 这批记录全成了孤儿。
 *
 * 用户接着导入 B 版字幕（同一部剧、同一集，但文件不同、标点/假名写法有出入）。
 * 此时：
 *
 *   · **cid 逐字相同的句子** —— 2026-10-09 起 `sliceCid` 的归一化口径与比对层对齐
 *     （标点 / 全半角 / 假名写法差异会被吃掉，见 `core/jaText.ts`），这批句子
 *     直接算出相同 cid，拉取时**已自动挂回**，根本不需要这里出手。
 *   · **剩下认不出的**（汉字↔假名、断句不同）—— 没有旧句原文可做相似度比对
 *     （`sliceRebind` 那条路走不通，它的旧句来自本机 slices 表）。
 *
 * 本模块走**位置锚定**：拿已命中的句子当锚点，按句序把认不出的句子挤回位置。
 *
 * ## 为什么不能静默做
 *
 * 位置锚定是**启发式** —— 错绑会把别句的进度挂到当前句上（而且因为旧行打了墓碑、
 * 新行显示"已完成"，用户看不出来）。所以：
 *   · 三道闸门（锚点足够多 / 命中率够高 / 偏移足够集中）全过才允许执行；
 *   · 只在**用户显式确认**后执行（弹窗在 `views/AssociationModal.ts`）；
 *   · 执行后每行带 `recovery` 标记 → UI 打徽标、可一键撤销。
 *
 * ## 铁律
 *
 * **绝不改 cid**。B 的切片保持自己的 cid，动作是把云端旧 cid 上的进度 rekey 到
 * 新 cid（复用 `sliceRebind.applyRebind`，见 `docs/concept/cid.md` 第六节）。
 */

import { progressCid } from "../core/ids";
import { STORE, type VaultDb } from "../storage/db";
import type { ProgressRow, SentenceAnalysis, SliceRow } from "../types/entities";
import { applyPulledCorrections } from "./sliceCorrection";
import { MATCH_WINDOW, applyRebind, type RebindPair } from "./sliceRebind";
import { ORPHAN_PATCH_PREFIX, type OrphanPatch } from "./sync/snapshot";

/** 云端记录（已由 pull 落到本机 `progress` 表）：身份 + 旧句序。 */
export interface CloudProgressRef {
  /** 云端那行的 `sliceCid`（A 版字幕算出的旧 cid）。 */
  sliceCid: string;
  /** 云端记录里内嵌的出处，旧字幕下的句序；缺失则无法参与对齐。 */
  sliceIndex: number | null;
}

/** 本次导入产生的新切片。 */
export interface LocalSliceRef {
  cid: string;
  index: number;
}

export interface CrossDevicePlanStats {
  /** 属于本集的云端记录条数 */
  cloudRows: number;
  /** cid 逐字命中（拉取时已自动挂回，不需要搬） */
  matched: number;
  /** 可用锚点数（命中且带旧句序） */
  anchors: number;
  /** 位置对齐成功、准备搬的条数 */
  aligned: number;
  /** 对不上、留作孤儿的条数 */
  orphans: number;
  /** cid 直接命中率 = matched / cloudRows */
  hitRate: number;
  /** 锚点偏移的中位数（新句序 − 旧句序） */
  offsetMedian: number;
  /** 偏移集中度：落在中位 ±OFFSET_TOLERANCE 内的锚点占比 */
  offsetDensity: number;
}

export interface CrossDevicePlan {
  /** 三道闸门全过且有可执行的对，才为 true —— 不过闸时调用方**不要弹窗**。 */
  ok: boolean;
  pairs: RebindPair[];
  stats: CrossDevicePlanStats;
}

/** 两侧锚点的偏移差超过它 → 判定断句重排，该句不接（见 `planCrossDeviceRebind`）。 */
export const OFFSET_TOLERANCE = 3;
/** 只有单侧锚点时，最多向外推多少句（超出不接 —— 外推越远越不可信）。 */
export const EXTRAPOLATE_WINDOW = MATCH_WINDOW;
/** 闸门①：可用锚点数下限（挡短句偶发碰撞造成的"巧合对齐"）。 */
export const MIN_ANCHORS = 3;
/** 闸门①：锚点数相对「待对齐行数」的下限比（限制无锚外推的比例）。 */
export const MIN_ANCHOR_RATIO = 0.2;
/** 闸门②：cid 直接命中率下限（挡"根本不是同一集"）。 */
export const MIN_HIT_RATE = 0.2;
/** 闸门③：偏移集中度下限（散乱 = 断句重排 → 拒绝）。 */
export const MIN_OFFSET_DENSITY = 0.8;

// ── 阈值的来源（2026-10-09 真实数据标定） ──────────────────────────────────
// 拿一对「同一集、同内容、异标点 / 异全半角 / 异半角片假名 / 汉字↔假名 / 断句合并」
// 的真实字幕（A 版 44 句 / B 版 43 句）走一遍 `planCrossDeviceRebind`（见
// `tests/crossDeviceRebind.test.ts` 的「真实数据标定」），实测：
//
//   hitRate = 0.727   anchors = 32   aligned = 11   orphans = 1
//   offsetMedian = 0  offsetDensity = 1.000
//
// 两个结论直接决定了下面的取值：
//   · **命中率天然很高** —— B1 把标点 / 全半角 / 假名写法差异在身份层吃掉了，
//     这批句子 cid 逐字相同、零成本挂回。剩下只有汉字↔假名与断句两类会造成未命中，
//     且三句 hash 让一处改写波及前后各一句（命中率 ≈ (1 − 改写比例)^3）。
//     本样本改写比例 ≈ 11%（4 处汉字↔假名 + 1 处合并）→ 0.73，与实测吻合。
//     所以一个「真的同一集」的两版字幕命中率会远高于 0.2；0.2 这条线只用来把
//     「完全不相干的一集」（命中率 ≈ 0）挡在门外，不拦「改写较多但仍同源」的版本。
//   · **偏移天生很集中** —— 断句合并只造成 −1 的整段位移，落在 ±OFFSET_TOLERANCE(3)
//     里，实测集中度 = 1.000。真正散乱（长期换段重排）时才该拒绝，故取 0.8。
//
// MIN_ANCHORS / MIN_ANCHOR_RATIO / EXTRAPOLATE_WINDOW 保持初值：它们约束的是
// 「外推」这类结构性风险，与本次实测的高命中/高集中并不冲突。

interface Anchor {
  oldIndex: number;
  newIndex: number;
  newCid: string;
  offset: number;
}

/**
 * 规划跨设备关联。
 *
 * @param cloudRows   本集的云端 progress 记录（`collectCloudProgressRefs` 产物）
 * @param localSlices 本次导入的新切片（cid + index）
 */
export function planCrossDeviceRebind(
  cloudRows: readonly CloudProgressRef[],
  localSlices: readonly LocalSliceRef[],
): CrossDevicePlan {
  const localByCid = new Map(localSlices.map((slice) => [slice.cid, slice]));
  const anchors: Anchor[] = [];
  const unmatched: CloudProgressRef[] = [];
  let matched = 0;

  for (const row of cloudRows) {
    const local = localByCid.get(row.sliceCid);
    if (local) {
      matched += 1;
      // 没有旧句序的命中行只能算 matched，当不了锚点（给不出偏移）
      if (row.sliceIndex != null) {
        anchors.push({
          oldIndex: row.sliceIndex,
          newIndex: local.index,
          newCid: local.cid,
          offset: local.index - row.sliceIndex,
        });
      }
    } else {
      unmatched.push(row);
    }
  }

  const sorted = [...anchors].sort((a, b) => a.oldIndex - b.oldIndex);
  // 一个新切片只被认领一次 —— 已命中的先占住，别让未命中行抢过去
  const claimed = new Set(anchors.map((anchor) => anchor.newCid));
  const alignable = unmatched.filter((row) => row.sliceIndex != null);
  const pairs: RebindPair[] = [];

  for (const row of alignable) {
    const oldIndex = row.sliceIndex as number;
    let left: Anchor | null = null;
    let right: Anchor | null = null;
    for (const anchor of sorted) {
      if (anchor.oldIndex <= oldIndex) left = anchor;
      else {
        right = anchor;
        break;
      }
    }

    let offset: number | null = null;
    if (left && right) {
      // 两侧锚点的局部偏移不一致 → 这段发生过断句重排，位置不可信，不接
      if (Math.abs(left.offset - right.offset) > OFFSET_TOLERANCE) continue;
      offset = oldIndex - left.oldIndex <= right.oldIndex - oldIndex ? left.offset : right.offset;
    } else if (left) {
      if (oldIndex - left.oldIndex > EXTRAPOLATE_WINDOW) continue;
      offset = left.offset;
    } else if (right) {
      if (right.oldIndex - oldIndex > EXTRAPOLATE_WINDOW) continue;
      offset = right.offset;
    } else {
      continue; // 一个锚都没有
    }

    const target = localSlices.find((slice) => slice.index === oldIndex + offset);
    if (!target || claimed.has(target.cid)) continue;
    claimed.add(target.cid);
    pairs.push({ from: row.sliceCid, to: target.cid });
  }

  const offsets = anchors.map((anchor) => anchor.offset);
  const offsetMedian = median(offsets);
  const offsetDensity = offsets.length === 0
    ? 0
    : offsets.filter((value) => Math.abs(value - offsetMedian) <= OFFSET_TOLERANCE).length / offsets.length;
  const cloudCount = cloudRows.length;
  const hitRate = cloudCount === 0 ? 0 : matched / cloudCount;
  const gate =
    anchors.length >= Math.max(MIN_ANCHORS, MIN_ANCHOR_RATIO * alignable.length) &&
    hitRate >= MIN_HIT_RATE &&
    offsetDensity >= MIN_OFFSET_DENSITY;

  const stats: CrossDevicePlanStats = {
    cloudRows: cloudCount,
    matched,
    anchors: anchors.length,
    aligned: pairs.length,
    orphans: alignable.length - pairs.length,
    hitRate,
    offsetMedian,
    offsetDensity,
  };
  const ok = gate && pairs.length > 0;
  return { ok, pairs: ok ? pairs : [], stats };
}

/** 一次关联的批次记录（存 `meta`），供撤销。 */
export interface AssociationBatch {
  episodeCid: string;
  at: string;
  pairs: RebindPair[];
}

const batchKey = (episodeCid: string): string => `assoc:${episodeCid}`;

/**
 * 读本机 `progress` 表，挑出**属于这一集、且带云端出处**的记录 —— 换机后刚 pull
 * 下来的旧记录就是这副样子（progress 在、切片没了）。
 *
 * 判据是 `provenance`（`work_cid` + `episode_number`）：它只在 build 快照时给
 * **完成过**的行内嵌，所以本地新学的行天然不带 —— 正好只有云端来的行会入选。
 *
 * ⚠️ `provenance` 里没有 season（既有局限），所以同作品「第 1 集」在 season 1 / 2
 * 下会被视作同一集。调用方只在该集确有孤儿时才继续（见 `ImportModal` 的触发条件）。
 */
export async function collectCloudProgressRefs(
  db: VaultDb,
  filter: { workCid: string; episodeNumber: string },
): Promise<CloudProgressRef[]> {
  const rows = await db.getAll<ProgressRow>(STORE.progress);
  const out: CloudProgressRef[] = [];
  for (const row of rows) {
    if (row.deletedAt) continue;
    const prov = (row as unknown as { provenance?: Record<string, unknown> }).provenance;
    if (!prov) continue;
    if (prov.work_cid !== filter.workCid) continue;
    if (String(prov.episode_number ?? "") !== filter.episodeNumber) continue;
    const index = prov.slice_index;
    out.push({
      sliceCid: row.sliceCid,
      sliceIndex: typeof index === "number" && Number.isFinite(index) ? index : null,
    });
  }
  return out;
}

/**
 * 执行规划好的关联：把云端旧 cid 上的进度 rekey 到新切片 cid 上。
 *
 * 复用 `sliceRebind.applyRebind`（同一段 rekey 逻辑，别写第二份），并给搬过来的行
 * 打 `recovery: { source: "cloud-assoc" }` —— 服务端据此删掉来源 cid 的等级线
 * （经验值不双计），UI 据此打徽标 + 给撤销入口。
 *
 * ⚠️ `applyRebind` 末尾会删掉 `pair.from` 的**切片行** —— 这里 `from` 是云端旧 cid，
 * 本机根本没有该切片，删除是无害空操作。
 */
export async function applyCrossDeviceRebind(
  db: VaultDb,
  plan: CrossDevicePlan,
  episodeCid: string,
): Promise<{ moved: number }> {
  if (!plan.ok || plan.pairs.length === 0) return { moved: 0 };
  const at = new Date().toISOString();
  const result = await applyRebind(db, plan.pairs, { source: "cloud-assoc" });
  // 换机时被暂存的纠正/解析跟着落到新句子上（见 applyStashedPatches）
  await applyStashedPatches(db, plan.pairs);
  const batch: AssociationBatch = { episodeCid, at, pairs: plan.pairs };
  await db.put(STORE.meta, { key: batchKey(episodeCid), value: batch });
  return { moved: result.moved };
}

/**
 * 把暂存的孤儿补丁（纠正 / 解析）套到新切片上（B7）。
 *
 * 换机后 pull 下来的纠正/解析因本地无切片被暂存在 `meta`（见 `sync/snapshot.ts`）；
 * 用户确认接回时，它们跟着 progress 一起落到新句子上：
 *   · 纠正 → 复用 `applyPulledCorrections`（同款 LWW + 覆盖层合并）
 *   · 解析 → 只补空（本地已解析过的为准）
 *
 * 套完清除暂存；没接回的那些（落在孤儿组里的）**保留**，等下次。
 */
async function applyStashedPatches(db: VaultDb, pairs: readonly RebindPair[]): Promise<void> {
  for (const pair of pairs) {
    const key = `${ORPHAN_PATCH_PREFIX}${pair.from}`;
    const record = await db.get<{ key: string; value: OrphanPatch }>(STORE.meta, key);
    const patch = record?.value;
    if (!patch) continue;

    if (patch.correction) {
      const correction = patch.correction as { ja?: unknown; zh?: unknown; readingFixes?: unknown };
      await applyPulledCorrections(db, [{
        slice_cid: pair.to,
        ja: correction.ja,
        zh: correction.zh,
        reading_fixes: correction.readingFixes,
        client_updated_at: patch.at,
      }]);
    }

    if (patch.analysis) {
      const slice = await db.get<SliceRow>(STORE.slices, pair.to);
      if (slice && !slice.deletedAt && !slice.analysis) {
        const analysis = {
          ...(patch.analysis as Record<string, unknown>),
          text: slice.ja,
        } as unknown as SentenceAnalysis;
        if (analysis.engine) await db.put(STORE.slices, { ...slice, analysis });
      }
    }

    await db.delete(STORE.meta, key);
  }
}

/**
 * 撤销一次关联（best-effort）：新行打墓碑、旧行复活。
 *
 * 复活的旧行会带一条**反向** `recovery`（`source: "cloud-assoc-revert"`），
 * 让服务端把新行那条等级线删掉 —— 否则撤销后同句会在 `sync_lines` 里留下两行，
 * 等级虚高。
 *
 * ⚠️ 只撤**确实是这次关联搬来的**行（`recovery.from === pair.from`）；若用户
 * 在关联后又在这句上学了新东西（行进过重算但 recovery 仍在），也会一起撤 ——
 * 文案里如实说明，不做更细的区分。
 */
export async function revertAssociation(
  db: VaultDb,
  episodeCid: string,
): Promise<{ reverted: number }> {
  const record = await db.get<{ key: string; value: AssociationBatch }>(STORE.meta, batchKey(episodeCid));
  const batch = record?.value;
  if (!batch || batch.pairs.length === 0) return { reverted: 0 };
  const now = new Date().toISOString();
  let reverted = 0;

  await db.transaction([STORE.progress], "readwrite", async (tx) => {
    for (const pair of batch.pairs) {
      // 新行（关联搬过来的）→ 打墓碑、清掉 recovery
      const moved = await tx.get<Record<string, unknown>>(STORE.progress, progressCid(pair.to));
      const movedRecovery = moved?.recovery as { from?: string } | undefined;
      if (moved && movedRecovery?.from === pair.from) {
        const { recovery: _drop, ...rest } = moved;
        await tx.put(STORE.progress, { ...rest, deletedAt: now, clientUpdatedAt: now });
      }
      // 旧行（当初被打墓碑的）→ 复活，并写反向 recovery 让服务端删掉新行的等级线
      const old = await tx.get<Record<string, unknown>>(STORE.progress, progressCid(pair.from));
      if (old && old.deletedAt) {
        await tx.put(STORE.progress, {
          ...old,
          deletedAt: null,
          clientUpdatedAt: now,
          recovery: { from: pair.to, at: now, source: "cloud-assoc-revert" },
        });
        reverted += 1;
      }
    }
  });

  await db.delete(STORE.meta, batchKey(episodeCid));
  return { reverted };
}

/** 有没有做过关联（供 UI 决定是否显示「撤销」）。 */
export async function hasAssociation(db: VaultDb, episodeCid: string): Promise<boolean> {
  const record = await db.get<{ key: string; value: AssociationBatch }>(STORE.meta, batchKey(episodeCid));
  return Boolean(record?.value?.pairs?.length);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
