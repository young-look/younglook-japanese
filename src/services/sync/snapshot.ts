/**
 * 统一快照通道（2026-10-06 上线，2026-10-07 口径简化）。
 *
 * ## 口径（一句话）
 *
 * **同步 = 整个 IndexedDB，剔除不上云的表**，外加 data.json 里的 5 个偏好键。
 *
 * 不上云的表（`LOCAL_ONLY_STORES`）：
 *   `sentences`/`lines` 台词原文（隐私红线；句子的三个子集 corrections /
 *   analysis / provenance 照常上云）、`recordings` 录音、`aiUsage` 本地用量、
 *   `meta` 本地管道数据。
 * 字段级剥离（表内还有不该走的东西）：`assets.localPath` 本机路径、
 * `assets.available` 本机可用性、`analysis.text` 台词原文、data.json 里的
 * 凭据与服务器指向（走 `PREF_KEYS` 白名单天然排除）。
 * 笔记不在此列（2026-10-09 起走 `/api/v1/notes/` 共享笔记，按账号走）；
 * 老 `notes` / `noteEntries` 集合已退役，服务端白名单同样删了这两个名字。
 *
 * ## 两条纪律（2026-10-07 简化）
 *
 * 1. **每趟传全部行**。不设行数上限、不做扫描游标 —— 那些是「哪行新 / 哪行
 *    挤掉了」这类问题的衍生品，全部删掉。数据多就多传几 MB，那是用户的真实
 *    数据量，用「总量上限 + 留痕告警」兜住，别再逐集合设限。
 * 2. **超过预算自动切块**（`splitSnapshotPayload`）。切块以行为单位，
 *    唯一剩下的那个数字就是 `CHUNK_BUDGET_BYTES`。
 *
 * 同步资格在服务端门禁（登录 + 余额 > 0）；这里不管资格，只管打包与合并。
 * 语义：逐行 LWW（`client_updated_at` 新的赢）、只增不删（软删行照传）。
 */

import { canonicalJson } from "../../core/digest";
import { sha256Hex } from "../../core/hash";
import { progressCid } from "../../core/ids";
import { STORE, type VaultDb } from "../../storage/db";
import type { PluginSettings } from "../../settings/types";
import type {
  AssetRow,
  ProgressRow,
  RecordLineRow,
  RecordRow,
  SentenceAnalysis,
  SentenceRow,
  SessionRow,
  StudyDayRow,
  WordRow,
} from "../../types/entities";
import { applyPulledCorrections } from "../sliceCorrection";

/** 快照里的一行：cid + 整行内容（已过白名单）+ 行时间戳（LWW 依据）。 */
export interface SnapshotRow {
  cid: string;
  data: Record<string, unknown>;
  client_updated_at: string;
  /**
   * 行内容的哈希（`canonicalJson(data)` 的 sha256），**客户端算、服务端原样存**。
   *
   * 为什么要客户端算：服务端落库前还会再过滤一层，它算的哈希和本地算的
   * 必然对不上 —— 那份差异不是我们要抓的漂移。让客户端算、服务端只存，
   * 校验才是自洽的（本地 vs 云端比的是同一套算法）。
   */
  content_hash: string;
}

export type SnapshotCollection =
  | "progress"
  | "words"
  | "study_days"
  | "records"
  | "assets"
  | "sessions"
  | "corrections"
  | "analysis"
  | "settings";
// ⚠️ `notes` 集合已于 2026-10-09 退役；`works`/`episodes` 集合于 2026-10-14
// 身份模型重构退役，合并为 `records`（键 = 文件哈希对，服务端白名单同步改名）。

export interface SnapshotPayload {
  collections: Partial<Record<SnapshotCollection, SnapshotRow[]>>;
}

/**
 * **不上云的本地表**（口径里唯一的清单，别往里加第六个）。
 *
 * `sentences`/`lines` 是台词原文（隐私红线）；句子的三个子集 corrections /
 * analysis / progress 里的 provenance 照常上云 —— 所以它们不是"完全不读"，
 * 是不以整表形式上云。
 * `meta` 同理不是"完全不读"： corrections / analysis 从句子行派生后照常上云，
 * 其余键（路径记录、版式标记等本机管道数据）留本地。
 * `myNotes`（未登录的本机笔记）不在快照集合清单里，效果等同 LOCAL_ONLY ——
 * 登录用户的笔记根本不落本地，未登录的没有身份不该上云。
 */
export const LOCAL_ONLY_STORES = ["sentences", "lines", "recordings", "aiUsage", "meta"] as const;

/** 客户端簿记字段：不参与「用户数据」本体，上云前剥掉（服务端拉回时补默认值）。 */
const BOOKKEEPING = ["rev", "rowDigest"] as const;

/** 没赶上时间戳补盖的老条目兜底用：纪元 0，任何真实编辑都比它新。 */
const EPOCH_TS = new Date(0).toISOString();

/**
 * 素材元数据白名单（与服务端 `FIELD_WHITELIST['assets']` 一致）。
 *
 * 改成白名单而不是「剔掉 localPath」的原因：黑名单守不住将来 —— 谁往
 * AssetRow 里加一个新字段，它默认就上云了。白名单反过来，加字段的人必须
 * 显式登记。`available`（本机还在不在）与 `localPath` 因此天然排除。
 *
 * ⚠️ 导出给存储页（`dataInventory` 的「文件信息」那一行）复用 —— 页面的口径
 * 就是同步白名单，不许手抄第二份。
 */
export const ASSET_KEYS = [
  "cid", "kind", "sha256", "filename", "sizeBytes",
  "language", "subtitleFormat", "offsetMs", "clientUpdatedAt", "deletedAt",
] as const;

/**
 * 学习记录白名单（与服务端 `FIELD_WHITELIST['records']` 一致）。
 * 展示字段只上 `title`（历史页出处用）；`note`/`noteName` 是本机簿记，不上云。
 */
export const RECORD_KEYS = [
  "cid", "videoSha256", "jaSubSha256", "zhSubSha256",
  "title", "season", "number", "durationMs", "clientUpdatedAt", "deletedAt",
] as const;

/** 偏好同步白名单：设置里只有这些键会上云/被拉回覆盖。凭据与指向永远不在列。 */
export const PREF_KEYS = [
  "vaultFolder",
  "aiMode",
  "autoSyncMinutes",
  "autoOpenPage",
  "lastView",
] as const;

/**
 * 单块字节预算（唯一剩下的那个阈值）。
 *
 * 依据：网关与 Django 都有 20MB 硬顶，撞上就是永久 413。服务端在 8MB
 * 处拦一道（`PAYLOAD_BYTE_CAP`），这里取 6MB 留足余量 —— 正常一趟根本
 * 切不出第二块，切块只是数据量真的涨上去时的兜底。
 */
export const CHUNK_BUDGET_BYTES = 6_000_000;

/**
 * 413 降档重推的下限与次数上限（见 `main.ts::syncStats`）。
 *
 * 客户端按 `CHUNK_BUDGET_BYTES` 切块，但真字节口径下仍可能撞服务端 8MB 护栏。
 * 撞了就 `budget /= 2` 重切再推，最低到这个下限、最多重试 `MAX_CHUNK_ROUNDS` 次 ——
 * 既不会无限降档，也保证绝不会因为「一次撞大包」让同步永久停摆。
 */
export const MIN_CHUNK_BUDGET_BYTES = 256_000;
export const MAX_CHUNK_ROUNDS = 3;

/** 服务端单行上限（`MAX_ROW_BYTES`）；本地算出更大的行就别传了，传了也是丢。 */
const MAX_ROW_BYTES = 64 * 1024;

type Plain = Record<string, unknown>;

/** 还没算哈希的行。打包阶段内部用，出包前统一 `attachHashes` 补上 `content_hash`。 */
type RawRow = Omit<SnapshotRow, "content_hash">;

/** 行内容的稳定哈希：键名排序后序列化再 sha256，两端同一套算法（见 SnapshotRow）。 */
export async function rowHash(data: Plain): Promise<string> {
  return sha256Hex([canonicalJson(data)]);
}

function stripKeys(row: Plain, keys: readonly string[]): Plain {
  const out: Plain = {};
  for (const [key, value] of Object.entries(row)) {
    if (!keys.includes(key)) out[key] = value;
  }
  return out;
}

function pickKeys(row: Plain, keys: readonly string[]): Plain {
  const out: Plain = {};
  for (const key of keys) {
    if (row[key] !== undefined) out[key] = row[key];
  }
  return out;
}

function tsMs(value: string): number {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * 行的真实 UTF-8 字节数（与服务端 `_row_bytes` 同口径）。
 *
 * ⚠️ 绝不能用 `JSON.stringify().length` —— 它数的是 **UTF-16 码元数**，一个汉字 /
 * 假名算 1，而 UTF-8 要 3 字节，中日文重的行会低估约 3 倍，带来两个后果：
 *   · `splitSnapshotPayload` 按 6MB 预算切出的块，真实字节可能到 ~18MB → 撞服务端
 *     `PAYLOAD_BYTE_CAP = 8MB` 护栏 → 413；
 *   · `MAX_ROW_BYTES`（64KB）行级判断同样低估 → 本地以为没超、服务端按真字节判超
 *     → **静默丢行**（审计 P1-8）。
 */
const UTF8_ENCODER = new TextEncoder();

function rowBytes(row: RawRow): number {
  return UTF8_ENCODER.encode(JSON.stringify(row)).length;
}

function newestFirst(rows: RawRow[]): RawRow[] {
  return rows.slice().sort((a, b) => tsMs(b.client_updated_at) - tsMs(a.client_updated_at));
}

// ── 打包 ────────────────────────────────────────────────────────────────

/**
 * 读本地库，构造每个集合的**全量**行（按时间倒序）。
 *
 * progress 行完成三步时内嵌 `provenance`（snake_case）——
 * 服务端等级投影靠它，换机后本地没有句子行时历史页也靠它显示出处。
 * 出处 join：progress → lines（本机哪条记录包含这句）→ records。
 */
async function buildAllRows(
  db: VaultDb,
  settings: PluginSettings,
): Promise<Record<SnapshotCollection, RawRow[]>> {
  const [progress, words, days, records, assets, sessions, sentences, lines, meta] =
    await Promise.all([
      db.getAll<ProgressRow>(STORE.progress),
      db.getAll<WordRow>(STORE.words),
      db.getAll<StudyDayRow>(STORE.studyDays),
      db.getAll<RecordRow>(STORE.records),
      db.getAll<AssetRow>(STORE.assets),
      db.getAll<SessionRow>(STORE.sessions),
      db.getAll<SentenceRow>(STORE.sentences),
      db.getAll<RecordLineRow>(STORE.lines),
      db.getAll<{ key: string; value: string }>(STORE.meta),
    ]);

  const liveRecords = records.filter((row) => !row.deletedAt);
  const linesBySentence = new Map<string, RecordLineRow>();
  for (const line of lines) {
    // 一句可以出现在多条记录里，出处取先遇到的那条（排序稳定即可）
    if (!linesBySentence.has(line.sentenceCid)) linesBySentence.set(line.sentenceCid, line);
  }
  const recordById = new Map(liveRecords.map((row) => [row.cid, row]));

  /** progress → lines → records 的出处 join；断一环就不带（等级投影随之跳过）。 */
  function provenance(row: ProgressRow): Plain | null {
    const line = linesBySentence.get(row.sliceCid);
    if (!line) return null;
    const record = recordById.get(line.recordCid);
    if (!record) return null;
    return {
      record_cid: record.cid,
      record_title: record.title || record.titleJa || "",
      episode_number: record.number,
      slice_index: line.index,
    };
  }

  const progressRows: RawRow[] = progress.map((row) => {
    const data: Plain = { ...stripKeys(row as unknown as Plain, BOOKKEEPING) };
    if (row.completedAt) {
      const prov = provenance(row);
      if (prov) data.provenance = prov;
    }
    return { cid: row.cid, data, client_updated_at: row.clientUpdatedAt };
  });

  const correctionsRows: RawRow[] = sentences
    .filter((row) => row.correctionsUpdatedAt)
    .map((row) => ({
      cid: row.cid,
      data: {
        sliceCid: row.cid,
        ja: row.textFixes?.ja ?? "",
        zh: row.textFixes?.zh ?? "",
        readingFixes: row.readingFixes ?? {},
      },
      client_updated_at: row.correctionsUpdatedAt ?? "",
    }));

  // AI 解析结果：剔除整句 text（那等于把台词原文带上云）；token 词面在上，
  // 换机后不用重新解析、不再扣一次费（2026-10-06 拍板，覆盖「AI 读音不同步」旧口径）。
  // ⚠️ 这里**不过滤 `done`**：半份（只有解读那一块，2026-10-15）照样上行 ——
  // "解析不许因为另一块没到就丢"这条对换机同样成立；拉回来那份读侧认得（见下方 pull）。
  const analysisRows: RawRow[] = sentences
    .filter((row) => row.analysis)
    .map((row) => ({
      cid: row.cid,
      data: stripKeys(row.analysis as unknown as Plain, ["text"]),
      client_updated_at: row.clientUpdatedAt,
    }));


  const settingsRow: RawRow = {
    cid: "settings",
    data: Object.fromEntries(PREF_KEYS.map((key) => [key, (settings as unknown as Plain)[key]])),
    client_updated_at: settings.prefsUpdatedAt || new Date().toISOString(),
  };

  return {
    progress: newestFirst(progressRows),
    words: newestFirst(
      words.filter((row) => !row.deletedAt).map((row) => ({
        cid: row.cid,
        data: stripKeys(row as unknown as Plain, BOOKKEEPING),
        client_updated_at: row.clientUpdatedAt,
      })),
    ),
    study_days: newestFirst(
      days.map((row) => ({
        cid: row.day,
        data: row as unknown as Plain,
        client_updated_at: row.clientUpdatedAt,
      })),
    ),
    records: newestFirst(
      records.map((row) => ({
        cid: row.cid,
        data: pickKeys(row as unknown as Plain, RECORD_KEYS),
        client_updated_at: row.clientUpdatedAt,
      })),
    ),
    assets: newestFirst(
      assets.map((row) => ({
        cid: row.cid,
        data: pickKeys(row as unknown as Plain, ASSET_KEYS),
        client_updated_at: row.clientUpdatedAt,
      })),
    ),
    sessions: newestFirst(
      sessions.map((row) => ({
        cid: row.cid,
        data: stripKeys(row as unknown as Plain, BOOKKEEPING),
        client_updated_at: row.clientUpdatedAt,
      })),
    ),
    corrections: newestFirst(correctionsRows),
    analysis: newestFirst(analysisRows),
    settings: [settingsRow],
  };
}

/**
 * 补哈希 + 丢掉超大的行。
 *
 * 超 `MAX_ROW_BYTES` 的行服务端一定会丢（并计 skipped），本地算出来就别传 ——
 * 传了白占一趟的体量，还让校验永远对不上（本地有、云端没有 = 天天报漂移）。
 */
async function attachHashes(rows: RawRow[]): Promise<SnapshotRow[]> {
  const out: SnapshotRow[] = [];
  for (const row of rows) {
    if (rowBytes(row) > MAX_ROW_BYTES) continue;
    out.push({ ...row, content_hash: await rowHash(row.data) });
  }
  return out;
}

export interface SnapshotBuildResult {
  /** 全量行（已带 content_hash）；本地库多大它就是多大，没有截断这回事 */
  collections: Record<SnapshotCollection, SnapshotRow[]>;
  /** 全量行的真实 UTF-8 字节数（与服务端 `_row_bytes` 同口径；服务端还会再量一次） */
  bytes: number;
}

/**
 * 读本地库，构造每个集合的**全量**行。
 *
 * 没有游标、没有行数上限、没有「新改动插队」—— 每趟就是整个库。
 */
export async function buildSnapshotPayload(
  db: VaultDb,
  settings: PluginSettings,
): Promise<SnapshotBuildResult> {
  const all = await buildAllRows(db, settings);
  const collections = {} as Record<SnapshotCollection, SnapshotRow[]>;
  let bytes = 0;
  for (const name of Object.keys(all) as SnapshotCollection[]) {
    const rows = await attachHashes(all[name] ?? []);
    collections[name] = rows;
    for (const row of rows) bytes += rowBytes(row);
  }
  return { collections, bytes };
}

/**
 * 按字节把全量行切成若干块（**以行为单位，一行不会被切开**）。
 *
 * 为什么还要切：网关与 Django 有 20MB 硬顶，撞上就是永久 413。正常用户
 * 一趟切不出第二块，这只是数据量涨上去后的兜底 —— 代价是多几个请求，
 * 换来的是「多大的库都能传完」。
 *
 * 单行比整块预算还大时（理论上不会：服务端单行上限 64KB，预算 6MB），
 * 它单独成一块，让服务端按坏行丢掉并计 skipped。
 */
export function splitSnapshotPayload(
  collections: Record<SnapshotCollection, SnapshotRow[]>,
  maxBytes: number = CHUNK_BUDGET_BYTES,
): SnapshotPayload[] {
  const chunks: SnapshotPayload[] = [];
  let current: Partial<Record<SnapshotCollection, SnapshotRow[]>> = {};
  let used = 0;

  const flush = (): void => {
    if (Object.keys(current).length > 0) chunks.push({ collections: current });
    current = {};
    used = 0;
  };

  for (const name of Object.keys(collections) as SnapshotCollection[]) {
    for (const row of collections[name] ?? []) {
      const size = rowBytes(row);
      if (used > 0 && used + size > maxBytes) flush();
      const bucket = (current[name] ??= []);
      bucket.push(row);
      used += size;
    }
  }
  flush();
  return chunks;
}

// ── 每日校验（2026-10-07）──────────────────────────────────────────────

/** 云端行清单里的一条。 */
export interface ManifestEntry {
  collection: string;
  cid: string;
  content_hash: string;
}

export interface VerifyDiff {
  /** 本地有、云端没有（或者云端那行还没参与校验） */
  missing: string[];
  /** 两边都有但哈希不同 */
  mismatched: string[];
  /** 云端有、本地没有 —— 不计入漂移（只增不删，那可能是另一台设备的） */
  extra: number;
}

/**
 * 本地全量行 vs 云端清单 的比对。
 *
 * 判据是**内容哈希**，不是行数、也不是最后更新时间：改一句笔记、调一次
 * 熟练度都不会改变行数，弱校验会漏检 —— 那这道校验就白装了。
 *
 * ⚠️ 方向是「云端 ⊇ 本地」：本地删掉的行云端还在（只增不删），云端多出来的
 * 行不算漂移。所以**换机后已删除的行会复活**是这个模型的固有边界，
 * 不是 bug —— 别拿它当故障查。
 */
export function diffManifest(
  collections: Record<SnapshotCollection, SnapshotRow[]>,
  rows: ManifestEntry[],
): VerifyDiff {
  const cloud = new Map<string, string>();
  for (const entry of rows) cloud.set(`${entry.collection}\u0000${entry.cid}`, entry.content_hash);

  const missing: string[] = [];
  const mismatched: string[] = [];
  const seen = new Set<string>();
  for (const name of Object.keys(collections) as SnapshotCollection[]) {
    for (const row of collections[name] ?? []) {
      const key = `${name}\u0000${row.cid}`;
      seen.add(key);
      const hash = cloud.get(key);
      if (hash === undefined) missing.push(key);
      else if (hash !== row.content_hash) mismatched.push(key);
    }
  }
  let extra = 0;
  for (const key of cloud.keys()) if (!seen.has(key)) extra += 1;
  return { missing, mismatched, extra };
}

// ── 合并 ────────────────────────────────────────────────────────────────

/** 拉回来做合并的行：哈希可选（它是上行的校验凭证，合并用不上）。 */
export type SnapshotMergeRow = Omit<SnapshotRow, "content_hash"> & { content_hash?: string };

/** 时间戳解不出来 = 脏行，直接丢（与笔记/纠正合并同一纪律）。 */
function sane(row: SnapshotMergeRow): boolean {
  return Boolean(row.cid) && Boolean(row.client_updated_at) && !Number.isNaN(Date.parse(row.client_updated_at));
}

/** cid 键集合的通用合并：LWW 整行覆盖，本地簿记字段尽量保留。 */
async function mergeCidRows(
  db: VaultDb,
  store: Parameters<VaultDb["get"]>[0],
  rows: SnapshotMergeRow[],
  transform?: (data: Plain) => Plain,
): Promise<number> {
  let applied = 0;
  for (const pulled of rows) {
    if (!sane(pulled)) continue;
    const local = await db.get<Plain>(store, pulled.cid);
    if (local && tsMs(String(local.clientUpdatedAt ?? "")) >= tsMs(pulled.client_updated_at)) continue;
    const data: Plain = {
      ...(transform ? transform(pulled.data) : pulled.data),
      cid: pulled.cid,
      clientUpdatedAt: pulled.client_updated_at,
      rev: typeof local?.rev === "number" ? local.rev : 0,
      rowDigest: typeof local?.rowDigest === "string" ? local.rowDigest : "",
    };
    await db.put(store, data);
    applied += 1;
  }
  return applied;
}

export interface ApplySnapshotResult {
  /** 各集合实际写入行数（settings 不计） */
  applied: number;
  /** 偏好有没有被云端覆盖（调用方据此 saveSettings） */
  settingsChanged: boolean;
}

/**
 * 孤儿补丁的 `meta` 键前缀。
 *
 * 换机后本地没有句子行时，云端的纠正/解析原本是**直接丢弃**的（指望素材重导后
 * 句子哈希相同、下一趟 pull 补上）。但用户重导的往往是**另一版字幕**（哈希不同），
 * 永远补不上 —— 于是把补丁暂存下来；同哈希重导时句子行回来，下一趟 pull 直接挂上。
 */
export const ORPHAN_PATCH_PREFIX = "orphanPatch:";

/** 一条暂存的孤儿补丁（纠正 / 解析至少有一个）。 */
export interface OrphanPatch {
  correction?: { ja?: unknown; zh?: unknown; readingFixes?: unknown };
  analysis?: Plain;
  /** 补丁的原始时间戳（LWW 依据） */
  at: string;
}

/**
 * 暂存孤儿补丁 —— **只在确有孤儿 progress 行时写**。
 *
 * 判据：该 `sliceCid` 在本机有 progress 行（且不是墓碑）、却没有切片行。这正是
 * 「换机后从云端拉回了学习记录、素材还没重导（或重导成了另一版）」的形态。稳态下
 * （正常重导 / 从没导入过）不写 `meta`，不打乱本地管道数据。
 */
async function stashOrphanPatches(
  db: VaultDb,
  patches: ReadonlyArray<{ sliceCid: string; patch: OrphanPatch }>,
): Promise<number> {
  let stashed = 0;
  for (const { sliceCid, patch } of patches) {
    const progress = await db.get<ProgressRow>(STORE.progress, progressCid(sliceCid));
    if (!progress || progress.deletedAt) continue;
    const key = `${ORPHAN_PATCH_PREFIX}${sliceCid}`;
    const record = await db.get<{ key: string; value: OrphanPatch }>(STORE.meta, key);
    const value: OrphanPatch = {
      correction: patch.correction ?? record?.value.correction,
      analysis: patch.analysis ?? record?.value.analysis,
      at: patch.at,
    };
    await db.put(STORE.meta, { key, value });
    stashed += 1;
  }
  return stashed;
}

/**
 * 把服务端下拉的快照合并进本地库（逐集合 LWW）。
 *
 * 换机场景：本地空库 → 全收；素材重导后 cid 相同的切片行回来，
 * 进度/纠正/解析按 cid 自动挂回。slices/recordings/meta 不在集合里，
 * 一个字节都不会被云端动。笔记不在快照里（2026-10-09 起走
 * `/api/v1/notes/`），云端动不了它。
 */
export async function applySnapshotPull(
  db: VaultDb,
  settings: PluginSettings,
  collections: Partial<Record<SnapshotCollection, SnapshotMergeRow[]>>,
): Promise<ApplySnapshotResult> {
  let applied = 0;

  // progress 保留 provenance：本地没有句子行时，历史页靠它显示出处（孤儿行兜底）
  applied += await mergeCidRows(db, STORE.progress, collections.progress ?? []);
  applied += await mergeCidRows(db, STORE.words, collections.words ?? []);
  applied += await mergeCidRows(db, STORE.records, collections.records ?? []);
  applied += await mergeCidRows(db, STORE.assets, collections.assets ?? []);
  applied += await mergeCidRows(db, STORE.sessions, collections.sessions ?? []);

  // study_days 键是 day（不是 cid），数据里自带
  for (const pulled of collections.study_days ?? []) {
    if (!sane(pulled)) continue;
    const day = typeof pulled.data.day === "string" ? pulled.data.day : "";
    if (!day || day !== pulled.cid) continue;
    const local = await db.get<StudyDayRow>(STORE.studyDays, day);
    if (local && tsMs(local.clientUpdatedAt) >= tsMs(pulled.client_updated_at)) continue;
    await db.put(STORE.studyDays, { ...pulled.data, day, clientUpdatedAt: pulled.client_updated_at } as unknown as Plain);
    applied += 1;
  }

  // 纠正：复用老通道的合并器（同一套 LWW + 墓碑语义）。
  // 本地没这句时不再直接丢 —— 收集成孤儿补丁，循环后统一暂存（见下）。
  const orphanPatches: Array<{ sliceCid: string; patch: OrphanPatch }> = [];
  applied += await applyPulledCorrections(
    db,
    (collections.corrections ?? []).map((pulled) => ({
      slice_cid: pulled.cid,
      ja: pulled.data.ja,
      zh: pulled.data.zh,
      reading_fixes: pulled.data.readingFixes,
      client_updated_at: pulled.client_updated_at,
    })),
    {
      onOrphan: (orphan) => {
        orphanPatches.push({
          sliceCid: orphan.sliceCid,
          patch: {
            correction: { ja: orphan.ja, zh: orphan.zh, readingFixes: orphan.reading_fixes },
            at: orphan.client_updated_at,
          },
        });
      },
    },
  );

  // AI 解析：只补空（本地没解析过才收）—— 本地重解析过的永远是最新事实。
  // 本地没有该句子行时同样暂存为孤儿补丁（换机重导另一版字幕后等接回）。
  for (const pulled of collections.analysis ?? []) {
    if (!sane(pulled)) continue;
    const local = await db.get<SentenceRow>(STORE.sentences, pulled.cid);
    if (!local) {
      orphanPatches.push({
        sliceCid: pulled.cid,
        patch: { analysis: pulled.data, at: pulled.client_updated_at },
      });
      continue;
    }
    // 本地**已经解析完整**的就不收（本地重解析过的永远是最新事实）。
    // ⚠️ 2026-10-15：**半份不算"解析过"** —— 解读那块到手就先单独落了库
    //     （`done:false`，见 StudyView.persistExplanationOnly），拿它当"有"，
    //     云端那份完整记录就永远进不来，用户在这台机器上只剩半句。
    if (local.analysis?.done) continue;
    const analysis = { ...pulled.data, text: local.ja } as unknown as SentenceAnalysis;
    if (!analysis.engine) continue;
    await db.put(STORE.sentences, { ...local, analysis });
    applied += 1;
  }

  // 孤儿补丁统一暂存（只在确有孤儿 progress 行时写 —— 见 stashOrphanPatches）
  await stashOrphanPatches(db, orphanPatches);

  // 偏好：整包 LWW，且只有白名单键会落到本地设置（凭据不可能被云端覆盖）
  let settingsChanged = false;
  const settingsRows = collections.settings ?? [];
  const pulledSettings = settingsRows.find((row) => row.cid === "settings");
  if (pulledSettings && sane(pulledSettings)) {
    if (tsMs(settings.prefsUpdatedAt) < tsMs(pulledSettings.client_updated_at)) {
      for (const key of PREF_KEYS) {
        if (pulledSettings.data[key] !== undefined) {
          (settings as unknown as Plain)[key] = pulledSettings.data[key];
        }
      }
      settings.prefsUpdatedAt = pulledSettings.client_updated_at;
      settingsChanged = true;
    }
  }

  return { applied, settingsChanged };
}
