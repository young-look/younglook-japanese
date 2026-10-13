/**
 * 本地库（IndexedDB）的库名选择与**历史数据找回**。
 *
 * ⚠️ 这一层是为了修一个真实的丢数据事故（2026-09-25）：
 *
 * `vaultLocalId` 是随机生成的，第一次加载时生成但**没有落盘**，
 * 而库名又直接由它拼成（`younglook-${vaultLocalId}`）。于是每次重载插件
 * 都会拿到一个新随机 id → 打开一个**全新的空库**。用户看到的现象就是
 * "插件一更新，导入的素材和学习记录全没了，又得重新导入"。
 * 数据其实还在原库里，只是再也没人去开它。
 *
 * 所以现在有两件事必须做：
 *  1. 首次加载就把 id 写进 data.json（main.ts 里做）；
 *  2. 万一已经踩过坑（历史随机 id 留下的孤儿库），把装着数据的那个认回来。
 *
 * 认库的判据刻意保守：**宁可不认，也不能把另一个 vault 的库认成自己的**，
 * 因为 Obsidian 所有 vault 共用 `app://` origin，库里没有 vault 信息就可能张冠李戴。
 * 所以新库都会在 meta 里记一条 vaultPath（见 main.ts 的 tagVaultPath），
 * 路径对得上才敢认；对不上时必须"只有一个候选"才认。
 */

export interface VaultDbProbe {
  /** 库名去掉 `younglook-` 前缀之后的 id */
  key: string;
  /** 台词条数 —— 判"这个库有没有东西"的主指标 */
  slices: number;
  /** 学习进度条数 —— 条数相同时的次指标 */
  progress: number;
  /** 库自己记的 vault 绝对路径；老库没有这条，为 null */
  vaultPath: string | null;
}

export interface PickLibraryResult {
  /** 认回来的库 id；不敢认时为 null */
  key: string | null;
  /** 除被选中的之外，还有几个装着数据的库（提示用户"旧库不止一个"） */
  orphans: number;
}

/** 路径比较：macOS 大小写不敏感，末尾斜杠也统一掉。 */
export function sameVaultPath(a: string, b: string): boolean {
  const norm = (value: string) => value.replace(/[/\\]+$/u, "").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * 从探测结果里挑出属于当前 vault 的库。
 *
 * 只做**硬排除**：归属标记明确写着别的 vault 的，绝不认。
 * 没有标记的老库（正是这次事故留下的那批）一律算候选 —— 代价是可能并进来
 * 同一台机器上另一个 vault 的老数据（列表里多出几集，看得见、删得掉），
 * 而拒绝认领的代价是用户白学一场、素材还得重新导入（视频路径找不回来）。
 * 两害相权，认。
 *
 * @param probes     所有 `younglook-*` 库的探测结果
 * @param vaultPath  当前 vault 的本机绝对路径
 * @param excludeKey 当前正在用的库（空库），不参与候选
 */
export function pickLibrary(
  probes: readonly VaultDbProbe[],
  vaultPath: string,
  excludeKey: string,
): PickLibraryResult {
  const usable = probes.filter(
    (probe) =>
      probe.slices > 0 &&
      probe.key !== excludeKey &&
      (!probe.vaultPath || sameVaultPath(probe.vaultPath, vaultPath)),
  );
  if (usable.length === 0) return { key: null, orphans: 0 };

  // 有归属标记就用标记的那批（更可信）；一个标记都没有时，才退而用全部候选
  const tagged = usable.filter((probe) => probe.vaultPath);
  const pool = tagged.length > 0 ? tagged : usable;
  const best = [...pool].sort((a, b) => b.slices - a.slices || b.progress - a.progress)[0];
  return { key: best.key, orphans: usable.length - 1 };
}

/**
 * 从扫到的库 id 里挑出**可以参与认领/合并**的那些（2026-10-09 多账号隔离新增）。
 *
 * 本机现在可以并存好几份学习数据（一份只跟一个账号，见 services/localSpace.ts），
 * 它们**前缀一样、vaultPath 也一样** —— 光看探测结果分不出谁是谁。已登记在
 * settings.spaces 里的库一律要排掉：否则当前空间为空时（例如刚给新账号开出来
 * 的那一份），启动时的认库流程就会把**另一个账号**的空间认回来，隔离全白做。
 *
 * @param keys        `listVaultDatabaseKeys()` 扫到的全部库 id
 * @param current     当前正在用的库（自己当然不参与）
 * @param registered  `settings.spaces` 里已登记的空间 id
 */
export function reclaimableKeys(
  keys: readonly string[],
  current: string,
  registered: readonly string[],
): string[] {
  const taken = new Set<string>([current, ...registered]);
  return keys.filter((key) => !taken.has(key));
}
