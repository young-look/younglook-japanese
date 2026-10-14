/**
 * 本地学习库的找回与合并（历史事故的收尾，见 services/vaultKey.ts 的说明）。
 *
 * 认回一个库只能救回一份数据；用户可能在不同会话里导入过不同集数，
 * 那些数据散在好几个随机 id 的孤儿库里。所以这里把**属于同一个 vault 的旧库
 * 全部并进认回来的那个库** —— 合并按 cid 做 upsert，天然幂等，
 * 用户不需要重新导入任何东西，视频路径也跟着 asset 行一起回来。
 *
 * 两条安全线：
 *  1. 归属标记（meta.vaultPath）明确对不上的库**绝不合并** —— 那可能是另一个 vault 的；
 *  2. 合并是普通事务直写（outbox 已退役，同步是全量快照重推）。
 */

import { STORE, VaultDb, type StoreName } from "../storage/db";
import { pickLibrary, sameVaultPath, type VaultDbProbe } from "./vaultKey";

/**
 * 需要搬的表。
 *
 * ⚠️ `study_days` 刻意不搬：它以「天」为主键，两份库同一天会互相覆盖，
 * 与其胡乱合并，不如留给以后的"按进度重算"（它是派生数据，不是原始记录）。
 */
const MERGE_STORES: readonly StoreName[] = [
  STORE.records,
  STORE.assets,
  STORE.sentences,
  STORE.lines,
  STORE.progress,
  STORE.sessions,
  STORE.words,
];


export interface RecoveryOutcome {
  /** 认回来的库 id；null = 没找到属于这个 vault 的旧库 */
  adoptedKey: string | null;
  /** 实际并进来的旧库 */
  mergedKeys: string[];
  /** 因为归属标记不符而没敢碰的库 */
  skippedKeys: string[];
  /** 并进来的台词条数 */
  slices: number;
}

export const EMPTY_OUTCOME: RecoveryOutcome = {
  adoptedKey: null,
  mergedKeys: [],
  skippedKeys: [],
  slices: 0,
};

/**
 * 从旧库里认回并合并本地学习数据。
 *
 * @param currentKey 当前正在用的库（空的），不参与候选
 * @param vaultPath  当前 vault 的本机绝对路径
 * @param probes     所有 `younglook-*` 库的探测结果
 */
export async function recoverLocalLibrary(opts: {
  currentKey: string;
  vaultPath: string;
  probes: readonly VaultDbProbe[];
}): Promise<RecoveryOutcome> {
  const picked = pickLibrary(opts.probes, opts.vaultPath, opts.currentKey);
  if (!picked.key) return EMPTY_OUTCOME;

  const target = await VaultDb.open(picked.key);
  const mergedKeys: string[] = [];
  const skippedKeys: string[] = [];
  let slices = 0;
  try {
    for (const probe of opts.probes) {
      if (probe.key === picked.key || probe.sentences === 0) continue;
      // 归属标记写着别的 vault —— 绝不并（多库共用同一个 IndexedDB origin）
      if (probe.vaultPath && !sameVaultPath(probe.vaultPath, opts.vaultPath)) {
        skippedKeys.push(probe.key);
        continue;
      }
      slices += await mergeLibrary(target, probe.key);
      mergedKeys.push(probe.key);
    }
    // 给认回来的库补上归属标记，下次不用再猜
    await target.put(STORE.meta, { key: "vaultPath", value: opts.vaultPath });
  } finally {
    target.close();
  }
  return { adoptedKey: picked.key, mergedKeys, skippedKeys, slices };
}

/** 把一个旧库的内容并进目标库，返回搬过来的台词条数。 */
async function mergeLibrary(target: VaultDb, sourceKey: string): Promise<number> {
  const source = await VaultDb.open(sourceKey);
  let sliceCount = 0;
  try {
    for (const store of MERGE_STORES) {
      const rows = await source.getAll<{ cid?: string }>(store);
      if (rows.length === 0) continue;
      await target.transaction([store], "readwrite", async (tx) => {
        for (const row of rows) await tx.put(store, row);
      });
      if (store === STORE.sentences) sliceCount = rows.length;
    }

  } finally {
    source.close();
  }
  return sliceCount;
}
