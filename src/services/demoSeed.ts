/**
 * 内置演示素材：装完插件就能点开学的那一集。
 *
 * 解决的是"装完插件打开是一片空白"：新用户不知道该干什么，也不知道
 * 「导入」要自己准备什么。默认就摆一集现成的，点开就能学，比任何引导文案都清楚。
 *
 * 素材是**插件自带**的，且不从服务器拉：由 esbuild 的 loader 静态打进 main.js
 * （mp4 → dataurl、srt → text，见 `demoAssets.ts`），启动时若插件目录里缺文件，
 * 用内置包落一份到磁盘上再走原有流程。这样社区商店 / BRAT 只装三件套的用户
 * 也有演示素材（`plugin/demo/` 目录不会跟过去，这是 2026-10-12 修掉的静默
 * 缺口）；自建渠道（软链装、手工拷整个目录）磁盘上本来就有文件，恢复不触发。
 *
 * 三条边界：
 *  · **首启铺一次**（`meta.demoSeeded` 标记 + 库为空才算"开箱第一次"）。老用户
 *    升上来不打扰；用户删掉这集之后不能再自动重建 —— 他删就是不想看了，每次
 *    启动都回来会像打不死的小强。
 *  · **素材收进素材库**（跟用户自己导入的走同一条路，见 `mediaStore.ts`）：
 *    插件目录看着稳定，其实 vault 一搬家、插件一重装就变了，指着它的路径
 *    站不住；收进素材库才跟插件目录彻底脱钩。
 *  · **失败一律静默**。插件目录缺文件、导入被重名拦下……都只是"少了一个
 *    演示"，不能拦住插件启动，更不能弹错误框。用户想学的话自己会导入。
 *
 * 除此之外，演示集还**跟随插件自带的素材走**（`syncBundledMaterial`）：
 * 换了 demo.mp4 / demo.srt，库里的演示集下次启动就自动跟上 —— 演示是插件的
 * 门面，发布方迭代它不该要求用户手动手删重导。口径：
 *  · 只换了**视频**：原地换视频素材，句子、学习记录、笔记都不动；
 *  · 换了**字幕**（或素材残缺）：整集重铺 —— 字幕决定句子身份，这是"换内容"
 *    不是"换文件"；演示集上的学习进度本来就是一次性的，不值得做迁移；
 *  · 作品名改过的**历史版本**（见 `DEMO_LEGACY_WORK_TITLES`）按旧素材整集换新，
 *    旧集软删、新集按当前作品名铺进来；
 *  · 用户删掉的（`deletedAt`）永远不重建 —— 换新也一样绕不开这条。
 *
 * 素材的来源与署名见 `plugin/demo/ATTRIBUTION.md`。
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { rowDigest } from "../core/digest";
import { assetCid, normalizeEpisodeNumber } from "../core/ids";
import { log } from "../core/logger";
import { STORE, type VaultDb } from "../storage/db";
import { probeFile } from "../storage/files";
import {
  bundledDemoSubtitleText,
  bundledDemoVideoUrl,
  dataUrlToBytes,
  looksLikeSrt,
} from "./demoAssets";
import { importSubtitle } from "./importer";
import { removeMediaFiles, resolveDemoMediaDir, takeIntoMediaDir } from "./mediaStore";
import { loadEpisodeList, removeEpisode } from "./study";
import type { AssetRow, EpisodeRow, WorkRow } from "../types/entities";

/**
 * ⚠️ 这两个文件是 `plugin/demo/` 里的实物，随插件一起分发，不靠构建生成。
 * 改名字的话 `plugin/demo/` 里的文件也要跟着改。
 */
export const DEMO_VIDEO_FILE = "demo.mp4";
export const DEMO_SUBTITLE_FILE = "demo.srt";

/**
 * 演示集在列表里显示的作品名。
 *
 * 「示例」这个前缀是**功能**不是装饰：用户要能一眼认出这不是自己导的，
 * 才敢放心删（右侧的「移除」按钮就是给这一集准备的）。
 */
export const DEMO_WORK_TITLE = "示例 · 好きなアニメで日本語を学ぼう";

/**
 * 历史上用过的演示作品名。演示集靠作品名认亲（cid 由名字派生），改了名字，
 * 老库里按旧名字铺的那集就认不出来了 —— 把旧名字登记在这里，同步时会把
 * 它整集换新成当前版本。只增不改：清单里的每个名字都必须是插件历史上
 * 真实铺出去过的，否则会误伤用户自己取的同名作品。
 */
export const DEMO_LEGACY_WORK_TITLES = ["示例 · 一問一答"];

/** 本地库里的"已经铺过演示"标记。放 meta（本机数据、不上行）。 */
export const DEMO_META_KEY = "demoSeeded";

/**
 * 视频小于这个字节数就当没带全（发版漏文件、手工拷贝中断之类的意外）。
 *
 * 半截文件比没有更糟 —— 它会让播放器一直转圈，用户还以为插件坏了。
 */
export const MIN_DEMO_BYTES = 100 * 1024;

/** 只要 host 上这几个字段，不 import 主插件类（否则和 main.ts 转成循环依赖）。 */
export interface DemoSeedHost {
  /** Obsidian 的 PluginManifest.dir 声明成 `string | undefined`，这里原样照搬。 */
  manifest: { dir?: string };
  /**
   * vault 根的**绝对路径**（`FileSystemAdapter.getBasePath()`）。
   *
   * ⚠️ `manifest.dir` 是相对 vault 根的路径（`.obsidian/plugins/young-look`），
   * 不是绝对路径 —— 直接 join 会落到 Obsidian 进程的工作目录去，文件永远"找不到"。
   */
  vaultBasePath: string;
  settings: { mediaDir: string };
}

interface MetaRow {
  key: string;
  value: string;
}

/** 插件自带的 demo 素材，探测完指纹后在整个同步流程里传递。 */
interface BundledMaterial {
  videoPath: string;
  subtitlePath: string;
  videoProbe: Awaited<ReturnType<typeof probeFile>>;
  subtitleProbe: Awaited<ReturnType<typeof probeFile>>;
  mediaDir: string;
}

/** 按作品名认出来的"演示集"（作品行 + 它下面那个无季无集号的集）。 */
interface DemoHit {
  work: WorkRow;
  episode: EpisodeRow;
}

function usable(path: string, minBytes: number): boolean {
  try {
    return existsSync(path) && statSync(path).size >= minBytes;
  } catch {
    return false;
  }
}

/**
 * 插件目录的绝对路径。`manifest.dir` 新旧版本 Obsidian 里形态不一
 * （相对 vault 根 / 绝对路径），相对时必须锚到 vault 根，否则相对的是
 * Obsidian 进程的工作目录 —— 拿到的路径看着对，existsSync 永远 false。
 */
function resolvePluginDir(host: DemoSeedHost): string | null {
  const dir = host.manifest.dir?.trim();
  if (!dir) return null;
  return isAbsolute(dir) ? dir : join(host.vaultBasePath, dir);
}

/**
 * 内置演示素材落盘：插件目录里缺文件时，用打进 main.js 的内置包补一份。
 *
 * 只补**缺的**：磁盘上已有（自建渠道的用户、开发装法）就保持原样，
 * 用户在 demo/ 里改过文件也不覆盖。写失败只 warn 不抛 —— 少一个演示
 * 不该拦住插件启动，下游的 usable() 检查会自然跳过。
 *
 * 参数化 videoUrl / subtitleText 是为了可测：测试环境（vite）里 import
 * 进来的不是 data URL / 不是 SRT 内容，恢复应当整体跳过。
 *
 * @returns 是否写了文件（调用方只用于日志，不影响后续流程）
 */
export function restoreBundledDemo(
  dir: string,
  videoUrl: string,
  subtitleText: string,
): boolean {
  const videoPath = join(dir, DEMO_VIDEO_FILE);
  const subtitlePath = join(dir, DEMO_SUBTITLE_FILE);
  const needVideo = !usable(videoPath, MIN_DEMO_BYTES);
  const needSubtitle = !usable(subtitlePath, 1);
  if (!needVideo && !needSubtitle) return false;

  const videoBytes = needVideo ? dataUrlToBytes(videoUrl) : null;
  if (needVideo && !videoBytes) return false;
  if (needSubtitle && !looksLikeSrt(subtitleText)) return false;

  try {
    mkdirSync(dir, { recursive: true });
    if (videoBytes) writeFileSync(videoPath, videoBytes);
    if (needSubtitle) writeFileSync(subtitlePath, subtitleText, "utf8");
    log.info("已从内置包恢复演示素材到插件目录", { dir });
    return true;
  } catch (error) {
    log.warn("内置演示素材落盘失败（不影响使用）", error);
    return false;
  }
}

/** 补上行摘要。volatile 字段不参与计算，注释见 core/digest.ts。 */
async function seal<T extends Record<string, unknown>>(row: T): Promise<T & { rowDigest: string; rev: number }> {
  return { ...row, rowDigest: await rowDigest(row), rev: 0 };
}

async function markSeeded(db: VaultDb): Promise<void> {
  const marked = await db.get<MetaRow>(STORE.meta, DEMO_META_KEY);
  if (!marked) {
    await db.put(STORE.meta, { key: DEMO_META_KEY, value: new Date().toISOString() } satisfies MetaRow);
  }
}

/**
 * 按作品名把演示集找出来。认亲条件是三重的：作品名精确匹配已知清单、
 * 这部作品活着、集的形状是演示的（无季号、集号留空）—— 用户自己导入的
 * 正片就算碰巧同名，也带着季集号，不会被误认。
 */
async function findDemoEpisodes(db: VaultDb): Promise<{ current: DemoHit | null; legacy: DemoHit[] }> {
  const [works, episodes] = await Promise.all([
    db.getAll<WorkRow>(STORE.works),
    db.getAll<EpisodeRow>(STORE.episodes),
  ]);
  let current: DemoHit | null = null;
  const legacy: DemoHit[] = [];
  for (const episode of episodes) {
    if (episode.deletedAt) continue;
    if (episode.season != null || normalizeEpisodeNumber(episode.number) !== "") continue;
    const work = works.find((row) => row.cid === episode.workCid && !row.deletedAt);
    if (!work) continue;
    if (work.title === DEMO_WORK_TITLE) {
      current = { work, episode };
    } else if (DEMO_LEGACY_WORK_TITLES.includes(work.title)) {
      legacy.push({ work, episode });
    }
  }
  return { current, legacy };
}

/** 这一集还活着的素材行。 */
async function liveAssetsOf(db: VaultDb, episodeCid: string): Promise<AssetRow[]> {
  const rows = await db.getAllByIndex<AssetRow>(STORE.assets, "by_episode", episodeCid);
  return rows.filter((row) => !row.deletedAt);
}

/**
 * 整集换新：把旧的那一集软删（走 `removeEpisode` 的口径：切片、素材、必要的
 * 作品行一起挂 `deletedAt`，学习记录与笔记文件不动），素材库里**插件自己拷的**
 * 旧文件顺手清掉 —— `removeMediaFiles` 双保险只删库内副本，用户原位置的文件
 * 和插件目录里的分发原件碰不到。
 */
async function replaceDemoEpisode(db: VaultDb, hit: DemoHit, mediaDir: string): Promise<boolean> {
  const assets = await liveAssetsOf(db, hit.episode.cid);
  await removeEpisode(db, hit.episode.cid);
  await removeMediaFiles(
    assets.map((row) => row.localPath),
    mediaDir,
  );
  log.info("已移除旧版内置演示，准备换新", { title: hit.work.title });
  return true;
}

/**
 * 只换视频：视频文件的指纹和自带的对不上（用户装了新版插件、demo.mp4 重制过），
 * 把新视频收进素材库、旧视频素材行软删。句子、学习记录、时间校准之外的一切原地不动。
 *
 * 旧素材行上手工校准过的播放偏移（offsetMs）不搬 —— 那是对着旧视频校的，
 * 对新视频没有意义。
 */
async function swapDemoVideo(
  db: VaultDb,
  episodeCid: string,
  bundled: BundledMaterial,
): Promise<boolean> {
  const stale = (await liveAssetsOf(db, episodeCid)).filter((row) => row.kind === "video");
  // 先收走旧视频的库内副本，新视频收进素材库时就能落到本来的名字（demo.mp4），
  // 不会一代一代漂移成 "demo (2).mp4"。旧素材行要等下面的事务提交才挂上
  // deletedAt —— 中途崩溃的话，行还在而文件没了，下次启动指纹对不上会自动重换，
  // 不会卡死。
  await removeMediaFiles(stale.map((row) => row.localPath), bundled.mediaDir);
  const ingest = await takeIntoMediaDir({
    sourcePath: bundled.videoPath,
    mediaDir: bundled.mediaDir,
    workTitle: DEMO_WORK_TITLE,
    fingerprint: bundled.videoProbe.fingerprint,
    sizeBytes: bundled.videoProbe.sizeBytes,
  });
  const now = new Date().toISOString();
  const next: AssetRow = await seal({
    cid: await assetCid("video", bundled.videoProbe.fingerprint),
    kind: "video" as const,
    episodeCid,
    filename: ingest.filename,
    sizeBytes: bundled.videoProbe.sizeBytes,
    // 视频时长不在导入时解析 —— 插件环境没有 ffprobe，播放时从 <video> 元数据里读
    durationSeconds: null,
    language: "",
    subtitleFormat: "",
    subtitleGroup: "",
    fingerprint: bundled.videoProbe.fingerprint,
    fpVersion: bundled.videoProbe.fpVersion,
    localPath: ingest.path,
    available: true,
    clientUpdatedAt: now,
    deletedAt: null,
  });
  // ⚠️ 播放时按 `kind === "video" && !deletedAt` 取第一个（StudyView.enterEpisode），
  // 旧的必须先挂上 deletedAt，新的这行才能被取到 —— 顺序在同一事务里无所谓，
  // 两行都在事务提交后才可见。
  await db.transaction([STORE.assets], "readwrite", async (tx) => {
    for (const row of stale) await tx.put(STORE.assets, { ...row, deletedAt: now, clientUpdatedAt: now });
    await tx.put(STORE.assets, next);
  });
  log.info("已把内置演示的视频换成插件自带的新版", { file: ingest.filename });
  return true;
}

/**
 * 把自带素材导成一集。首启和"换新后的补种"共用这一条路 —— 和用户手动导入
 * 走同一个 `importSubtitle`，素材照常收进素材库。
 */
async function seedBundledMaterial(db: VaultDb, bundled: BundledMaterial): Promise<boolean> {
  const outcome = await importSubtitle(db, {
    subtitlePath: bundled.subtitlePath,
    videoPath: bundled.videoPath,
    workTitle: DEMO_WORK_TITLE,
    // 不是番剧，集号留空（留空会排到列表最后，不会跟用户自己的正片抢位置）
    number: "",
    mediaDir: bundled.mediaDir,
  });
  if (!outcome.ok) {
    // 重名是最可能的一种：用户自己导过同名的。不该重试，记一笔走人。
    log.warn("演示素材导入未成功", { reason: outcome.reason });
    return false;
  }
  await markSeeded(db);
  log.info("已铺上内置演示素材", { slices: outcome.result.sliceCount });
  return true;
}

/**
 * 启动时的演示素材维护入口：**首启铺一次，之后跟随自带素材更新**。
 *
 * 返回是否发生了"用户可见的变化"（铺上了 / 换新了），调用方只用来决定
 * 要不要刷新已打开的视图。
 */
export async function ensureDemoMaterial(host: DemoSeedHost, db: VaultDb): Promise<boolean> {
  try {
    // 素材的归宿是插件目录（plugin/demo/）：内置包刚在上面落过盘，磁盘上还没
    // 有就说明落盘也失败了（权限之类）。缺了不报错、也不落标记 —— 只是这台
    // 机器上"少了一个演示"，下次启动再看一眼。
    const pluginDir = resolvePluginDir(host);
    if (!pluginDir) {
      log.warn("拿不到插件目录，跳过演示素材铺设");
      return false;
    }
    const dir = join(pluginDir, "demo");
    // 公开渠道（BRAT/商店）只装三件套，demo/ 不跟过去 —— 先用内置包落一份，
    // 后面全部按「插件目录里有文件」的老流程走。自建渠道用户这里直接跳过。
    restoreBundledDemo(dir, bundledDemoVideoUrl, bundledDemoSubtitleText);
    const videoPath = join(dir, DEMO_VIDEO_FILE);
    const subtitlePath = join(dir, DEMO_SUBTITLE_FILE);
    if (!usable(videoPath, MIN_DEMO_BYTES) || !usable(subtitlePath, 1)) {
      log.warn("插件目录里缺演示素材，跳过铺设", { dir });
      return false;
    }
    const [videoProbe, subtitleProbe] = await Promise.all([probeFile(videoPath), probeFile(subtitlePath)]);
    if (!videoProbe.fingerprint || !subtitleProbe.fingerprint) return false;
    const bundled: BundledMaterial = {
      videoPath,
      subtitlePath,
      videoProbe,
      subtitleProbe,
      mediaDir: resolveDemoMediaDir(host.settings.mediaDir),
    };

    const { current, legacy } = await findDemoEpisodes(db);
    let acted = false;
    for (const hit of legacy) {
      acted = (await replaceDemoEpisode(db, hit, bundled.mediaDir)) || acted;
    }

    let live = current;
    if (live) {
      const assets = await liveAssetsOf(db, live.episode.cid);
      const jaSub = assets.find((row) => row.kind === "subtitle" && row.language === "ja");
      const video = assets.find((row) => row.kind === "video");
      if (!jaSub || jaSub.fingerprint !== subtitleProbe.fingerprint) {
        // 字幕变了（或素材残缺）：句子身份跟着字幕走，整集重铺。
        acted = (await replaceDemoEpisode(db, live, bundled.mediaDir)) || acted;
        live = null;
      } else if (!video || video.fingerprint !== videoProbe.fingerprint) {
        acted = (await swapDemoVideo(db, live.episode.cid, bundled)) || acted;
      }
    }

    // 演示集在库且与自带素材同步：补齐标记（丢了就补，幂等），完事。
    if (live) {
      await markSeeded(db);
      return acted;
    }

    // 库里没有活着的演示集。三种来历，两种要动手：
    //  · 有标记、这次也没动过旧演示 = 用户删过（或这台机器从没铺成过）：不打扰；
    //  · 没标记 = 先看是不是"开箱第一次" —— 库里已有素材的老用户只落标记；
    //  · 这次刚把旧演示换掉（acted）= 必须把新的补上，标记挡不住这件事。
    const marked = await db.get<MetaRow>(STORE.meta, DEMO_META_KEY);
    if (marked && !acted) return false;
    if (!marked) {
      const existing = await loadEpisodeList(db);
      if (existing.length > 0) {
        await markSeeded(db);
        return acted;
      }
    }
    return (await seedBundledMaterial(db, bundled)) || acted;
  } catch (error) {
    log.warn("铺演示素材失败（不影响使用）", error);
    return false;
  }
}
