/**
 * 本地库（IndexedDB）。
 *
 * ⚠️ 一个刻意的决定，改动前先读：
 *
 * **每个 vault 一个独立数据库**（库名带 vaultKey 后缀）。
 *   Obsidian 的 IndexedDB 跑在 `app://` origin 下，**所有 vault 共享同一个 origin**。
 *   不做隔离的话，用户开第二个 vault 会看到第一个 vault 的学习数据——
 *   这种问题只有到了真实多 vault 环境才会暴露，测试里看不出来。
 *
 * （历史上还有第二条「outbox 必须与业务同事务」，2026-10-06 统一快照同步上线后
 *   outbox 已退役——全量重推不依赖逐行待办。）
 */

/**
 * 库结构版本。**新增 store / 加索引都要 +1** —— 只在 onupgradeneeded 里才建得出来。
 * 历史：5 = 删掉已下线的整句 TTS 读音缓存（`tts`）；
 *       6 = 新增句子笔记（`notes`，2026-10-04「笔记」按钮改版）；
 *       7 = 删掉翻卡复习（`review_events`）与术语补正（`term_memory`）两张从未写入过的表，
 *           words 去掉 `by_due` 索引（翻卡不做，调度字段一并移除）；
 *       8 = 删掉 outbox（待上行队列）—— 2026-10-06 统一快照同步上线，
 *           全量重推不依赖逐行待办，这张"只进不出"的表没有存在意义了；
 *       9 = 便签退役（`notes` 整表删除）—— 2026-10-09「笔记」改版：登录用户的
 *           笔记搬到服务端共享笔记（`/api/v1/notes/`，按账号走），未登录的纯单机
 *           笔记落新表 `my_notes`；快照同步不再携带任何笔记集合。
 *       10 = 清掉 7 个「声明了但全仓零查询」的索引——只删索引不动数据。
 *       11 = 🔥 身份模型重构硬切（2026-10-14 用户拍板）：works/episodes/slices
 *            三表退役，换成 records/assets/sentences/lines——学习记录键改为
 *            「视频+字幕」文件哈希对，句子键 = 三句哈希，旧键体系无法换算，
 *            **升级即全库清空**（不写兼容层，项目无公开市场用户）。用户重新导入即可。
 */
export const DB_VERSION = 11;

/** 库名前缀。改这个等于把所有人的本地数据丢掉，别改。 */
export const DB_PREFIX = "younglook-";

/** 库名（= 前缀 + vault 标识）。 */
export function vaultDbName(key: string): string {
  return `${DB_PREFIX}${key}`;
}

export const STORE = {
  /** 学习记录（键 = 文件哈希对，见 core/ids.ts::recordCid） */
  records: "records",
  /** 素材文件行（键 = A:+文件 sha256，跨记录共享） */
  assets: "assets",
  /** 句子共享内容层（键 = S: 三句哈希；解析与纠错覆盖层挂这里） */
  sentences: "sentences",
  /** 记录层台词表（本地 only，不上云——原文红线） */
  lines: "lines",
  progress: "progress",
  words: "words",
  studyDays: "study_days",
  sessions: "sessions",
  meta: "meta",
  /** BYOK 每次调用的 token 用量（本地私有，不上行同步；见 services/ai/client.ts 的 sink） */
  aiUsage: "ai_usage",
  /** 跟读录音（本地私有，不上行同步；见 services/recordings.ts） */
  recordings: "recordings",
  /**
   * 本机笔记（「笔记」抽屉，2026-10-09 改版）：**未登录时**的纯单机笔记，
   * 键 = 三句 hash。登录用户的笔记存在服务端（`/api/v1/notes/`，按账号走、
   * 对同句的其他登录用户可见），不落这张表 —— 见 services/notes/mine.ts。
   */
  myNotes: "my_notes",
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

interface StoreSpec {
  name: StoreName;
  /** 复合主键（如 lines 的 ["recordCid","index"]）允许是数组 */
  keyPath?: string | string[];
  autoIncrement?: boolean;
  indexes?: Array<{ name: string; keyPath: string | string[]; unique?: boolean }>;
}

const SCHEMA: readonly StoreSpec[] = [
  { name: STORE.records, keyPath: "cid" },
  { name: STORE.assets, keyPath: "cid" },
  { name: STORE.sentences, keyPath: "cid" },
  { name: STORE.lines, keyPath: ["recordCid", "index"] },
  { name: STORE.progress, keyPath: "cid" },
  { name: STORE.words, keyPath: "cid" },
  { name: STORE.studyDays, keyPath: "day" },
  {
    name: STORE.sessions,
    keyPath: "cid",
    indexes: [{ name: "by_record", keyPath: "recordCid" }],
  },
  { name: STORE.meta, keyPath: "key" },
  { name: STORE.aiUsage, keyPath: "id", autoIncrement: true },
  { name: STORE.recordings, keyPath: "sliceCid" },
  { name: STORE.myNotes, keyPath: "hash" },
];

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 请求失败"));
  });
}

export type TxMode = "readonly" | "readwrite";

/** 事务作用域。只能使用发起事务时声明过的 store。 */
export class TxScope {
  constructor(private readonly tx: IDBTransaction) {}

  private must(store: StoreName): IDBObjectStore {
    const found = this.tx.objectStore(store);
    if (!found) throw new Error(`事务里没有打开 store: ${store}`);
    return found;
  }

  get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return promisify(this.must(store).get(key) as IDBRequest<T | undefined>);
  }

  getAll<T>(store: StoreName, query?: IDBKeyRange | IDBValidKey): Promise<T[]> {
    return promisify(this.must(store).getAll(query) as IDBRequest<T[]>);
  }

  /** 走索引查多条。索引不存在直接抛，方便早点发现 schema 写错。 */
  getAllByIndex<T>(store: StoreName, index: string, query: IDBKeyRange | IDBValidKey): Promise<T[]> {
    const found = this.must(store).index(index);
    if (!found) throw new Error(`store ${store} 上没有索引 ${index}`);
    return promisify(found.getAll(query) as IDBRequest<T[]>);
  }

  count(store: StoreName, query?: IDBKeyRange | IDBValidKey): Promise<number> {
    return promisify(this.must(store).count(query));
  }

  put<T>(store: StoreName, value: T): Promise<IDBValidKey> {
    return promisify(this.must(store).put(value));
  }

  delete(store: StoreName, key: IDBValidKey): Promise<void> {
    return promisify(this.must(store).delete(key));
  }
}

export class VaultDb {
  private constructor(
    private readonly db: IDBDatabase,
    readonly vaultKey: string,
  ) {}

  /** @param vaultKey 每个 vault 唯一的短标识，直接进库名。 */
  static async open(vaultKey: string): Promise<VaultDb> {
    const name = vaultDbName(vaultKey);
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // v11 = 身份模型硬切：旧键体系（works/episodes/slices）与新键无法换算，
      // 升级即全库清空重建（用户已拍板不写兼容层）。deleteObjectStore 只能
      // 在这个升级事务里调。
      for (const name of Array.from(db.objectStoreNames)) {
        db.deleteObjectStore(name);
      }
      for (const spec of SCHEMA) {
        const store = db.createObjectStore(spec.name, {
          keyPath: spec.keyPath,
          autoIncrement: spec.autoIncrement,
        });
        for (const index of spec.indexes ?? []) {
          store.createIndex(index.name, index.keyPath, { unique: index.unique ?? false });
        }
      }
    };
    const db = await promisify(request);
    return new VaultDb(db, vaultKey);
  }

  close(): void {
    this.db.close();
  }

  /**
   * 在一个事务里跑一串操作。
   *
   * 注意：回调里只能 await IndexedDB 请求。任何 setTimeout / fetch 都会让事务
   * 在等待期间自动提交，随后的操作会拿到 "TransactionInactiveError"。
   */
  async transaction<T>(stores: StoreName[], mode: TxMode, fn: (tx: TxScope) => Promise<T> | T): Promise<T> {
    const tx = this.db.transaction(stores, mode);
    const scope = new TxScope(tx);
    const settled = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB 事务被中止"));
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 事务失败"));
    });
    let result: T;
    try {
      result = await fn(scope);
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // 事务已经结束，abort 会抛；这里不影响原始错误
      }
      throw error;
    }
    await settled;
    return result;
  }

  // ── 单 store 快捷方法 ────────────────────────────────────────────────

  async get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return this.transaction([store], "readonly", (tx) => tx.get<T>(store, key));
  }

  async getAll<T>(store: StoreName, query?: IDBKeyRange | IDBValidKey): Promise<T[]> {
    return this.transaction([store], "readonly", (tx) => tx.getAll<T>(store, query));
  }

  async getAllByIndex<T>(store: StoreName, index: string, query: IDBKeyRange | IDBValidKey): Promise<T[]> {
    return this.transaction([store], "readonly", (tx) => tx.getAllByIndex<T>(store, index, query));
  }

  async put<T>(store: StoreName, value: T): Promise<void> {
    await this.transaction([store], "readwrite", (tx) => tx.put(store, value));
  }

  async bulkPut<T>(store: StoreName, values: readonly T[]): Promise<void> {
    await this.transaction([store], "readwrite", async (tx) => {
      for (const value of values) await tx.put(store, value);
    });
  }

  async delete(store: StoreName, key: IDBValidKey): Promise<void> {
    await this.transaction([store], "readwrite", (tx) => tx.delete(store, key));
  }

  async count(store: StoreName): Promise<number> {
    return this.transaction([store], "readonly", (tx) => tx.count(store));
  }
}

// ── 库探测（找回历史数据用，见 services/vaultKey.ts） ─────────────────────

/** IndexedDB 里已存在的 younglook 库 id 列表。 */
export async function listVaultDatabaseKeys(): Promise<string[]> {
  const factory = indexedDB as IDBFactory & {
    databases?: () => Promise<Array<{ name?: string }>>;
  };
  if (typeof factory.databases !== "function") return [];
  try {
    const list = await factory.databases();
    return list
      .map((entry) => entry.name ?? "")
      .filter((name) => name.startsWith(DB_PREFIX))
      .map((name) => name.slice(DB_PREFIX.length));
  } catch {
    // 探测失败不是错误：退回"用当前库"就行
    return [];
  }
}

/**
 * 打开一个**已存在**的库，数一数里面有什么。
 *
 * 注意：这里不传版本号 —— 传版本号会触发升级流程（甚至覆盖 schema）；
 * 只想看看内容，所以按库自己当前的版本打开。
 */
export async function probeVaultDatabase(
  key: string,
): Promise<{ sentences: number; progress: number; vaultPath: string | null }> {
  let db: IDBDatabase;
  try {
    db = await promisify(indexedDB.open(vaultDbName(key)));
  } catch {
    return { sentences: 0, progress: 0, vaultPath: null };
  }
  try {
    const count = (store: StoreName): Promise<number> =>
      db.objectStoreNames.contains(store)
        ? promisify(db.transaction(store, "readonly").objectStore(store).count())
        : Promise.resolve(0);
    let vaultPath: string | null = null;
    if (db.objectStoreNames.contains(STORE.meta)) {
      const row = (await promisify(
        db.transaction(STORE.meta, "readonly").objectStore(STORE.meta).get("vaultPath"),
      )) as { key: string; value: string } | undefined;
      vaultPath = row?.value ?? null;
    }
    // v11 起句子表叫 sentences；老库（v10 及以前）叫 slices——探测历史库时两个都看
    const legacySlices = db.objectStoreNames.contains("slices")
      ? await promisify(db.transaction("slices", "readonly").objectStore("slices").count())
      : 0;
    const sentences = (await count(STORE.sentences)) || legacySlices;
    return { sentences, progress: await count(STORE.progress), vaultPath };
  } catch {
    return { sentences: 0, progress: 0, vaultPath: null };
  } finally {
    db.close();
  }
}
