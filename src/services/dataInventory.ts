/**
 * 「存储」页的盘点 —— 本机每一类数据占多少、在不在、会不会上云。
 *
 * **只算用户自己产生的数据**（2026-10-04 用户拍板）：插件自带的**词典**是插件
 * 分发的内容，不计入。
 *
 * 🔥 **演示素材反过来 —— 下载后就算用户的**（2026-10-14 用户拍板）。10-04 的旧
 *    口径把演示集整个扣掉，前提是它打在 main.js 里、随插件分发；而 10-13 起演示包
 *    改走服务端按需下载（见 `services/demoPack.ts`），用户点首页「示例」的「开始学」
 *    才落进**本机空间的素材库**（与用户自己导入的同一个目录，见 `resolveMediaDir`）——
 *    那几 MB 是用户自己点下来的、真实占着这台机器的盘，存储页必须如实反映：素材清单、
 *    句子原文、学习记录照常计入，与用户自己导入的一视同仁。
 *    ⚠️ 登录认领判据（`spaceData.ts`）仍然排除演示集 —— 那是「要不要把匿名数据
 *       搬进账号」的另一回事，不跟着这里改。
 *
 * 这一层只回答"现在是什么样"，不做任何改写（也没有写库的路径），
 * 三条纪律改动前先读：
 *
 *  1. **只读。** 这里唯一的副作用是 `readdir` / `stat` —— 看清 pc 上的文件。
 *     统计页面自己改数据是灾难：用户只是想看看，回头发现顺序变了、行没了。
 *  2. **句子原文不出这一层。** 出口只有行数和字节数（`utf8Bytes`）；
 *     连历遍都刻意不返回 slices 文本 —— 台词原文不在同步白名单里（见 sync/snapshot.ts），
 *     一个统计面板不该成为新的泄露口。
 *  3. **stat 失败就是结论，不是错误。** 文件被移走、外接盘拔了，那它就是
 *     「不在了」—— 这正是这一页要告诉用户的事实。一律就地降级，不抛。
 */

import { stat } from "node:fs/promises";

import type { PluginSettings } from "../settings/types";
import { STORE, type VaultDb } from "../storage/db";
import { assetShaCid, normalizeTitle } from "../core/ids";
import type {
  AssetRow,
  MyNoteRow,
  ProgressRow,
  RecordLineRow,
  RecordRow,
  SentenceRow,
  StudyDayRow,
  WordRow,
} from "../types/entities";
import type { RecordingRow } from "./recordings";
import { insideMediaRoot, resolveMediaDir } from "./mediaStore";
import { isLoggedIn } from "./notes/mine";
import { ASSET_KEYS, PREF_KEYS } from "./sync/snapshot";

/**
 * 一条数据的去向 —— 页面上只有这两种标签（2026-10-09 用户拍板）：
 *  · `local`  只在这台机器上，不会跟着账号走；
 *  · `cloud`  会跟着账号同步。
 *
 * 🔥 **凡是可以被同步的就是 `cloud`**，不要新造「部分上云」这类混合说法：
 *    一类数据里既有本机又有云端的（比如「句子本身」＝原文＋你改过的覆盖层），
 *    就**拆成两行**分别归位，别在同一行上写一个说不清的方向。
 */
export type DataTrait = "local" | "cloud";

export interface ArchiveRow {
  key: string;
  label: string;
  hint: string;
  /** 条目数；这一类没有"条"的概念时为 null（如「作品与单集」按行数算，有值） */
  count: number | null;
  bytes: number;
  trait: DataTrait;
}

/** 素材清单里的一行（一个视频或一个字幕文件）。 */
export interface MediaFileRow {
  cid: string;
  kind: string;
  filename: string;
  localPath: string;
  bytes: number;
  durationSeconds: number | null;
  language: string;
  /** 现在还在不在原处（本次实时核对的结果） */
  exists: boolean;
  /** 是否已经收进素材库（不在库里的那份是用户自己的文件，删不得） */
  insideMedia: boolean;
}

/** 素材清单按「同一部作品」分的一组（分桶键 = 归一化标题 + 年份，见 collectInventory）。 */
export interface MediaGroupRow {
  /** 分桶键（展开态记账用） */
  key: string;
  title: string;
  /** 组内学习记录条数（同一部作品的不同剪辑/字幕版本各算一条） */
  records: number;
  /** 组内学习记录的 cid（「删除组素材」要逐条移除记录用） */
  recordCids: string[];
  videoCount: number;
  subtitleCount: number;
  bytes: number;
  /** 需要留意的文件数（不在了 / 没收进素材库） */
  attention: number;
  /** 收进素材库的副本数 —— 只有这些删得掉（组头删除按钮的显示条件看它） */
  inLibraryCount: number;
  /** 收进素材库的副本总体积 */
  inLibraryBytes: number;
  files: MediaFileRow[];
}

/**
 * 插件自己写的那几份小文件。⚠️ 自带的**词典**不算在这里 —— 那是插件分发的
 * 内容，不是用户产生的数据（2026-10-04 用户拍板），页面也就不再出现它。
 */
export interface InventoryPluginPart {
  /** 会跟着账号同步的偏好（`PREF_KEYS`：字幕、播放、视图这些） */
  prefBytes: number;
  /** 只留本机的设置（服务端地址、账号令牌、自备模型的 Key、素材库位置……） */
  localSettingsBytes: number;
  usageCount: number;
  usageBytes: number;
}

export interface InventoryCloudPart {
  /** 上次成功同步的时刻（毫秒）；没同步过为 0 */
  lastSyncAt: number;
  loggedIn: boolean;
  /**
   * 稳态三格（视图层「我数据在哪儿」的唯一判据）：
   *  · `local`  未登录 —— 只在本机，AI 走自带 Key（必然 BYOK）；
   *  · `synced` 登录且有余额 —— 正常云同步；
   *  · `paused` 登录但余额用尽 —— 同步暂停，充值即恢复。
   *
   * 与状态栏那颗灯的稳态档同源（main.ts updateStatusBar）。
   */
  state: CloudSyncState;
  /**
   * 云同步现在是不是被**余额**挡住了（会显示「云同步已暂停」那条带）。
   *
   * 判据与真闸门同源：服务端只管「登录 + 余额 > 0」，余额不够就 403
   * `need=recharge`（见 `services/sync/client.ts`）。这里用本地那份余额
   * （`aiBalanceMillis`，余额的唯一显示源）做静态预测 —— 好处是不依赖
   * 「这一趟同步有没有跑过」，打开存储页就能说清状态。
   *
   * ⚠️ 它只是**预测**，不是「同步真的被挡回来了」的事实：后者是运行时才知道的
   *    （main.ts 的 syncPaused，状态栏那颗灯用它）。两者不一致的窗口只有
   *    「刚充值、插件还没刷到新余额」这一小段。
   */
  paused: boolean;
}

/** 「连过账号」的口径 —— 与云端那一格的 `loggedIn` 同一份判断（access / refresh 有一个就算）。 */
function hasAccount(settings: PluginSettings): boolean {
  return Boolean(settings.authToken.trim() || settings.refreshToken.trim());
}

/**
 * 云同步现在会不会被余额挡住 —— 「存储页那条提醒带要不要画」的判据。
 *
 * 与 `ai/gate.ts::resolveAiRoute` 是同一条钱：**余额 > 0 才有云服务**
 * （AI 走内置模型、同步放行），余额用尽则 AI 退回自带 Key、同步暂停。
 */
export function cloudSyncPaused(settings: PluginSettings): boolean {
  return hasAccount(settings) && settings.aiBalanceMillis <= 0;
}

/** 稳态三格（见 `InventoryCloudPart.state`）。 */
export type CloudSyncState = "local" | "synced" | "paused";

/**
 * 稳态判据 —— 视图层「我数据在哪儿」的唯一口径，别在各处自己拼。
 *
 * 未登录 → `local`；登录后只看余额：> 0 → `synced`，≤ 0 → `paused`。
 * 与 `cloudSyncPaused()` 同源（后者就是本函数 `=== "paused"`）。
 */
export function cloudSyncState(settings: PluginSettings): CloudSyncState {
  if (!hasAccount(settings)) return "local";
  return settings.aiBalanceMillis <= 0 ? "paused" : "synced";
}

/**
 * 一个大类：几行数据加一个合计。
 *
 * 页面上的三个大类都是这个形状（2026-10-10 用户拍板）：**学习档案**（云端同步）、
 * **本地设置**、**视频、字幕与录音**（后两个只在本机）。每一类的去向只有一个 ——
 * 一类数据里既有本机又有云端的，早就拆成两行各归各位了（见 DataTrait）。
 */
export interface InventorySection {
  rows: ArchiveRow[];
  bytes: number;
}

export interface Inventory {
  generatedAt: number;
  mediaDir: string;
  /** 视频、字幕与录音：素材清单 + 字幕的两个衍生品（句子原文、跟读录音） */
  media: {
    groups: MediaGroupRow[];
    count: number;
    /** 找不到这个文件 */
    missing: number;
    /** 留在原来的位置（没收进素材库） */
    outside: number;
    /** 句子原文、跟读录音 —— 台词是字幕的衍生品，跟素材归在一类 */
    rows: ArchiveRow[];
    /** 大类总计 = 素材文件 + 那两行 */
    bytes: number;
  };
  /** 本地设置：只留本机的那部分设置与用量 */
  localSettings: InventorySection;
  /** 学习档案：会跟着账号走的那些 */
  archive: InventorySection;
  cloud: InventoryCloudPart;
  /** 三个大类加起来 —— 也就是「本插件在这台机器上占了多少」（页面 hero 那个数） */
  localBytes: number;
}

export interface InventoryDeps {
  db: VaultDb;
  settings: PluginSettings;
  /** 插件 id（找自带词典目录用，同 StudyView 那处的取法） */
  pluginId: string;
}

/** 一份数据的 UTF-8 字节数。序列化不了（循环引用之类）就当 0，不让统计页挂掉。 */
function utf8Bytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

/** 从一行里挑出几个字段 —— 「这一行到底多大」要按同步的那份口径算时用。 */
function pick(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (row[key] !== undefined) out[key] = row[key];
  return out;
}

/** 从一行里剔掉一个字段（AI 解析结果上云不带整句原文，与 snapshot 同一口径）。 */
function stripKey(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (k !== key) out[k] = v;
  return out;
}

function lives<T extends { deletedAt: string | null }>(rows: readonly T[]): T[] {
  return rows.filter((row) => !row.deletedAt);
}

/** 现在还在不在 + 现在多大。移走的外接盘、整理过的下载目录都会被这里抓出来。 */
async function probePath(path: string): Promise<{ exists: boolean; size: number | null }> {
  if (!path) return { exists: false, size: null };
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return { exists: false, size: null };
  return { exists: true, size: info.size };
}

/**
 * 素材部分：按作品分组，逐个文件实时核对。
 *
 * AssetRow.sizeBytes 是**导入时**记的（那是"入库时的样子"）；这里用实时的大小覆盖它，
 * 因为用户要的是"现在占多少"。核对不到（文件不在了）才退回库里那一份 —— 那至少
 * 说明"它曾经多大"，比显示 0 有用。
 */
export async function collectInventory(deps: InventoryDeps): Promise<Inventory> {
  const { db, settings } = deps;
  const mediaDir = resolveMediaDir(settings.mediaDir, settings.activeSpaceId);

  const [records, assets, inventoryParts] = await Promise.all([
    db.getAll<RecordRow>(STORE.records),
    db.getAll<AssetRow>(STORE.assets),
    collectRest(deps),
  ]);

  const liveRecords = lives(records);

  // ── 素材库：群体明细 ──
  /** 素材 cid → 引用它的活记录（分桶、视频时长都从这里来） */
  const recordsByAsset = new Map<string, RecordRow[]>();
  for (const row of liveRecords) {
    for (const sha of [row.videoSha256, row.jaSubSha256, row.zhSubSha256]) {
      if (!sha) continue;
      const cid = assetShaCid(sha);
      const list = recordsByAsset.get(cid) ?? [];
      list.push(row);
      recordsByAsset.set(cid, list);
    }
  }

  const buckets = new Map<string, MediaGroupRow>();
  /** 每组到过哪些记录（「多少条记录」按它算：一份素材常被多条记录共享） */
  const recordsSeen = new Map<string, Set<string>>();
  let mediaCount = 0;
  let mediaBytes = 0;
  let missing = 0;
  let outside = 0;

  for (const row of lives(assets)) {
    if (!row.localPath) continue;
    const usingRecords = recordsByAsset.get(row.cid) ?? [];
    const probe = await probePath(row.localPath);
    const insideMedia = insideMediaRoot(row.localPath, mediaDir);
    if (!probe.exists) missing += 1;
    else if (!insideMedia) outside += 1;

    // 视频时长取引用它的记录里第一个非空的 durationMs（同一视频共享一条素材行）
    const durationMs =
      row.kind === "video"
        ? (usingRecords.find((rec) => rec.durationMs)?.durationMs ?? null)
        : null;

    const file: MediaFileRow = {
      cid: row.cid,
      kind: row.kind,
      filename: row.filename,
      localPath: row.localPath,
      bytes: probe.size ?? row.sizeBytes,
      durationSeconds: durationMs === null ? null : Math.round(durationMs / 1000),
      language: row.language,
      exists: probe.exists,
      insideMedia,
    };

    // 分桶键 = 归一化标题 + 年份（同一部作品的不同剪辑版本归一组）
    const firstTitle = usingRecords[0]?.title ?? "";
    const firstYear = usingRecords[0]?.year ?? null;
    const key = `${normalizeTitle(firstTitle)}|${firstYear ?? ""}`;
    const bucket = buckets.get(key) ?? {
      key,
      title: firstTitle || "没能对上作品名的文件",
      records: 0,
      recordCids: [],
      videoCount: 0,
      subtitleCount: 0,
      bytes: 0,
      attention: 0,
      inLibraryCount: 0,
      inLibraryBytes: 0,
      files: [],
    };
    const recordsOfBucket = recordsSeen.get(key) ?? new Set<string>();
    for (const rec of usingRecords) recordsOfBucket.add(rec.cid);
    recordsSeen.set(key, recordsOfBucket);

    bucket.files.push(file);
    bucket.bytes += file.bytes;
    if (row.kind === "subtitle") bucket.subtitleCount += 1;
    else bucket.videoCount += 1;
    if (!probe.exists || !insideMedia) bucket.attention += 1;
    // 收进素材库的副本：只有这些删得掉（组头删除按钮与弹窗上的数字都看它）
    if (insideMedia) {
      bucket.inLibraryCount += 1;
      bucket.inLibraryBytes += file.bytes;
    }
    buckets.set(key, bucket);

    mediaCount += 1;
    mediaBytes += file.bytes;
  }

  const groups = [...buckets.values()].sort((a, b) => b.bytes - a.bytes);
  for (const group of groups) {
    const seen = recordsSeen.get(group.key);
    group.records = seen?.size ?? 0;
    group.recordCids = [...(seen ?? [])];
    group.files.sort((a, b) => a.filename.localeCompare(b.filename, "ja"));
  }

  const { localSettings, archive, mediaRows, cloud } = inventoryParts;
  const mediaRowsBytes = mediaRows.reduce((sum, row) => sum + row.bytes, 0);

  return {
    generatedAt: Date.now(),
    mediaDir,
    media: {
      groups,
      count: mediaCount,
      missing,
      outside,
      rows: mediaRows,
      bytes: mediaBytes + mediaRowsBytes,
    },
    localSettings,
    archive,
    cloud,
    localBytes: mediaBytes + mediaRowsBytes + localSettings.bytes + archive.bytes,
  };
}

/** 设置、用量、学习档案 —— 与素材部分并行取。 */
async function collectRest(deps: InventoryDeps): Promise<{
  localSettings: InventorySection;
  archive: InventorySection;
  /** 归入「视频、字幕与录音」的那两行（句子原文、跟读录音） */
  mediaRows: ArchiveRow[];
  cloud: InventoryCloudPart;
}> {
  const { db, settings } = deps;
  const [pluginFiles, archiveParts, cloud] = await Promise.all([
    collectPluginPart(deps),
    collectArchivePart(db, settings),
    collectCloudPart(settings),
  ]);

  // 「偏好与页面记忆」是唯一跟着账号走的设置 —— 归进学习档案（2026-10-10 用户拍板：
  // 它记着上次学到哪一页，是学习记录的一部分）；其余设置与用量只留本机。
  const archiveRows: ArchiveRow[] = [
    {
      key: "prefs",
      label: "偏好与页面记忆",
      hint: "字幕、播放这些偏好，以及上次看到哪一页；换台机器接着上次的位置",
      count: 1,
      bytes: pluginFiles.prefBytes,
      trait: "cloud",
    },
    ...archiveParts.archive,
  ];
  const localSettingsRows: ArchiveRow[] = [
    {
      key: "settings-local",
      label: "登录状态与其他设置",
      hint: "登没登录、连的是哪台服务器、素材库放在哪儿",
      count: 1,
      bytes: pluginFiles.localSettingsBytes,
      trait: "local",
    },
    {
      key: "usage",
      label: "自备模型的用量",
      hint: "用你自己的 Key 时每次花了多少；这套数字只给你看",
      count: pluginFiles.usageCount,
      bytes: pluginFiles.usageBytes,
      trait: "local",
    },
    ...archiveParts.localSettings,
  ];

  return {
    localSettings: section(localSettingsRows),
    archive: section(archiveRows),
    mediaRows: archiveParts.media,
    cloud,
  };
}

/** 几行合成一个大类（合计就是各行相加）。 */
function section(rows: ArchiveRow[]): InventorySection {
  return { rows, bytes: rows.reduce((sum, row) => sum + row.bytes, 0) };
}

/**
 * 偏好、其余设置、自备模型的用量 —— 都在 vault 外面。词典不计（插件分发的内容）。
 *
 * 偏好（`PREF_KEYS`）是唯一会跟着账号走的设置；其余键（服务端地址、账号令牌、
 * 自备模型的 Key、素材库位置……）只留本机 —— 两者拆开算，页面上就是两行。
 */
async function collectPluginPart(deps: InventoryDeps): Promise<InventoryPluginPart> {
  const usage = await deps.db.getAll<{
    id?: number;
    ts: string;
    scene: string;
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
  }>(STORE.aiUsage);
  const settings = deps.settings as unknown as Record<string, unknown>;
  const local = { ...settings };
  for (const key of PREF_KEYS) delete local[key];
  return {
    prefBytes: utf8Bytes(pick(settings, PREF_KEYS)),
    localSettingsBytes: utf8Bytes(local),
    usageCount: usage.length,
    usageBytes: utf8Bytes(usage),
  };
}

/**
 * 库里每一类数据一行，并按去向分到三个大类（2026-10-10 用户拍板）：
 *  · `archive`       学习档案 —— 跟着账号走的那些；
 *  · `localSettings` 本地设置 —— 只留本机的设置与「文件放在哪儿」；
 *  · `media`         视频、字幕与录音 —— 句子原文与跟读录音都是字幕的衍生品，
 *                    跟素材归在一类。
 *
 * 「仿写」和「助手对话」没有自己的表 —— 它们挂在句子进度行里，这里按字段拆出来
 * 单列；「句子本身」同理拆成原文（跟素材走）与两个上云的子集（你改过的覆盖层、
 * AI 解析结果）—— **一行的去向只能有一个**，混着的就必须拆（2026-10-09 用户拍板）。
 *
 * 「我的笔记」也是补上的一类：登录后笔记在服务端（这里只报"在云端"），
 * 未登录的落本机 `my_notes` 表。
 */
async function collectArchivePart(
  db: VaultDb,
  settings: PluginSettings,
): Promise<{ archive: ArchiveRow[]; localSettings: ArchiveRow[]; media: ArchiveRow[] }> {
  const [progress, sentences, lines, words, days, recordings, myNotes, assets] = await Promise.all([
    db.getAll<ProgressRow>(STORE.progress),
    db.getAll<SentenceRow>(STORE.sentences),
    db.getAll<RecordLineRow>(STORE.lines),
    db.getAll<WordRow>(STORE.words),
    db.getAll<StudyDayRow>(STORE.studyDays),
    db.getAll<RecordingRow>(STORE.recordings),
    db.getAll<MyNoteRow>(STORE.myNotes),
    db.getAll<AssetRow>(STORE.assets),
  ]);

  const liveProgress = lives(progress);
  const imitationRows = liveProgress.filter((row) => (row.imitationText ?? "").trim().length > 0);
  const chatRows = liveProgress.filter((row) => (row.imitationChat ?? []).length > 0);
  // 录音是 Blob，JSON 序列化会把它摊成 {} —— 大小必须按 blob 自己报的算
  let recordingsBytes = 0;
  for (const row of recordings) {
    recordingsBytes += row.blob?.size ?? 0;
    recordingsBytes += utf8Bytes({
      sliceCid: row.sliceCid,
      mimeType: row.mimeType,
      seconds: row.seconds,
      savedAt: row.savedAt,
    });
  }

  // 演示包下载后就是本机上的真实数据（2026-10-14 用户拍板，见文件头）：素材、
  // 台词、记录一视同仁，不再按作品名扣掉；学没学它（进度、录音、句子层沉淀）
  // 同样照常计入。
  const [records] = await Promise.all([db.getAll<RecordRow>(STORE.records)]);

  const liveAssets = lives(assets);
  const liveLines = lines;

  // 句子层：被台词行引用到的句子才算数（没人引的孤儿行不计）。
  // ⚠️ sentences 行没有 deletedAt（句子层没有删除概念），不走 lives()。
  const sentenceCidsInUse = new Set(liveLines.map((row) => row.sentenceCid));
  const liveSentences = sentences.filter((row) => sentenceCidsInUse.has(row.cid));

  // 句子本身的两个上云子集：你改过的覆盖层（corrections）与 AI 解析结果（analysis）。
  const correctionsRows = liveSentences.filter(
    (row) =>
      (row.textFixes?.ja ?? "").trim().length > 0 ||
      (row.textFixes?.zh ?? "").trim().length > 0 ||
      Object.keys(row.readingFixes ?? {}).length > 0,
  );
  const analysisRows = liveSentences.filter((row) => row.analysis);

  // 我的笔记：登录后笔记存在服务端（本机不留一份），未登录才落本机这张表。
  const loggedIn = isLoggedIn(settings);
  const liveNotes = myNotes.filter((row) => row.text.trim().length > 0);

  // ── 学习档案：会跟着账号走的那些 ────────────────────────────────────────
  const archive: ArchiveRow[] = [
    {
      key: "progress",
      label: "句子进度",
      hint: "每一句做到哪一步、什么时候做完的",
      count: liveProgress.length,
      bytes: utf8Bytes(liveProgress),
      trait: "cloud",
    },
    {
      key: "imitation",
      label: "你写的仿写",
      hint: "你自己敲下来的句子，以及 AI 的评语",
      count: imitationRows.length,
      bytes: utf8Bytes(imitationRows.map((row) => ({
        text: row.imitationText,
        feedback: row.imitationFeedback,
      }))),
      trait: "cloud",
    },
    {
      key: "chat",
      label: "和小助手的对话",
      hint: "逐句问过的每一轮，跟着句子进度存",
      count: chatRows.length,
      bytes: utf8Bytes(chatRows.map((row) => row.imitationChat)),
      trait: "cloud",
    },
    {
      key: "words",
      label: "词库",
      hint: "单词、读音、释义、熟练度、曝光次数",
      count: lives(words).length,
      bytes: utf8Bytes(lives(words)),
      trait: "cloud",
    },
    {
      key: "days",
      label: "每日统计",
      hint: "每天学了几句、多久、几个新词",
      count: days.length,
      bytes: utf8Bytes(days),
      trait: "cloud",
    },
    {
      key: "records",
      label: "学习记录",
      hint: "每条记录的标题、季集号这些展示信息",
      count: lives(records).length,
      bytes: utf8Bytes(lives(records)),
      trait: "cloud",
    },
    {
      key: "slices-corrections",
      label: "你改过的台词 / 翻译 / 注音",
      hint: "你在纠错里手改过的句子；改了哪句就带哪句",
      count: correctionsRows.length,
      bytes: utf8Bytes(correctionsRows.map((row) => ({
        ja: row.textFixes?.ja ?? "",
        zh: row.textFixes?.zh ?? "",
        readingFixes: row.readingFixes ?? {},
      }))),
      trait: "cloud",
    },
    {
      key: "slices-analysis",
      label: "AI 解析结果",
      hint: "逐词释义、解读和译文；换台机器不用重新解析",
      count: analysisRows.length,
      bytes: utf8Bytes(
        analysisRows.map((row) =>
          stripKey(row.analysis as unknown as Record<string, unknown>, "text"),
        ),
      ),
      trait: "cloud",
    },
    {
      key: "assets-info",
      label: "文件信息",
      hint: "每个文件的名字、大小、语种；不含它放在哪儿",
      count: liveAssets.length,
      bytes: utf8Bytes(
        liveAssets.map((row) => pick(row as unknown as Record<string, unknown>, ASSET_KEYS)),
      ),
      trait: "cloud",
    },
    {
      key: "my-notes",
      label: "我的笔记",
      hint: loggedIn
        ? "跟着你的账号存在云端，这台机器上不留一份"
        : "还没登录，先存在这台机器；登录后跟着账号走",
      count: loggedIn ? null : liveNotes.length,
      bytes: loggedIn ? 0 : utf8Bytes(liveNotes),
      trait: "cloud",
    },
  ];

  // ── 视频、字幕与录音：台词原文与跟读录音都是字幕的衍生品，跟素材归在一类 ──
  const media: ArchiveRow[] = [
    {
      key: "slices-text",
      label: "句子原文",
      hint: "日文原句、译文和出现的时间；台词原文不出这台机器",
      count: liveLines.length,
      bytes: utf8Bytes(
        liveLines.map((row) =>
          pick(row as unknown as Record<string, unknown>, [
            "ja", "zh", "index", "startMs", "endMs", "speaker",
          ]),
        ),
      ),
      trait: "local",
    },
    {
      key: "recordings",
      label: "跟读录音",
      hint: "练发音时录下来的声音",
      count: recordings.length,
      bytes: recordingsBytes,
      trait: "local",
    },
  ];

  // ── 本地设置：每个文件放在这台机器的哪个位置 ────────────────────────────
  const localSettings: ArchiveRow[] = [
    {
      key: "assets-local",
      label: "文件在本机的位置",
      hint: "每个视频、字幕文件放在你这台机器的哪个位置",
      count: liveAssets.length,
      bytes: utf8Bytes(liveAssets.map((row) => ({ localPath: row.localPath, available: row.available }))),
      trait: "local",
    },
  ];

  return { archive, localSettings, media };
}

/**
 * 云端那一格：现在处在哪个状态。
 *
 * ⚠️ 2026-10-10 用户拍板：**不再称「推上去会有多大」** —— 页面上已经不摆这个数字，
 * 那就别为它把整包数据组装一遍（每开一次存储页都要序列化一遍全部行，纯白花）。
 * 需要知道"某类会不会上云"看那一行的去向（`DataTrait`）就够了。
 */
function collectCloudPart(settings: PluginSettings): InventoryCloudPart {
  return {
    lastSyncAt: Number.isFinite(settings.lastStatsSyncAt) ? settings.lastStatsSyncAt : 0,
    loggedIn: hasAccount(settings),
    paused: cloudSyncPaused(settings),
    state: cloudSyncState(settings),
  };
}
