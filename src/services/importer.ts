/**
 * 导入：把用户本机的一套「视频 + 字幕」变成**本地数据行**。
 *
 * 边界（产品的红线，不能含糊）：
 *  - 视频和字幕**都由用户提供**，两样配套、都必填 —— 插件不去下载、不去检索；
 *  - 插件只干一件事：解析字幕、按句子切成「时间戳切片」、和视频对上号。
 *    播放时按时间戳跳播。
 *  - 导入时把素材**复制**一份进素材库（默认在 vault 外，见 services/mediaStore.ts）。
 *    用户原来那份留着不动 —— 以后他整理文件夹、拔硬盘都不影响学习。
 *    素材库本身在**vault 外面**：vault 会被 Sync / iCloud / OneDrive 一起搬走，
 *    一集动画 1~3 GB，不能让几十 GB 的视频去挤用户的云盘。
 *
 * ⚠️ 导入**不往 vault 写任何东西**。笔记是学出来的、不是导入出来的：
 * 用户把一句的三步做完（跟读 + 抄写 + 仿写），那一句才进笔记
 * （见 services/studyNote.ts）。导入就往 vault 里丢一份笔记，只会让用户
 * 在笔记列表里看到一堆自己还没学过的东西。
 *
 * 所有失败都走 `ImportOutcome` 返回，不抛异常 —— 失败原因是给用户看的，
 * 得像人话（「这份字幕里读不出时间轴」），不能是堆栈。
 */

import { rowDigest } from "../core/digest";
import { assetCid, episodeCid, sentenceTextHash, sliceCid, workCid } from "../core/ids";
import { normalizeEpisodeNumber } from "../core/ids";
import type { VaultDb } from "../storage/db";
import { fileExists, probeFile, readTextFile, type FileProbe } from "../storage/files";
import { takeIntoMediaDir } from "./mediaStore";
import { STORE } from "../storage/db";
import {
  buildCues,
  cueStats,
  detectFormat,
  languageOfLines,
  pairByTime,
  parseRawLines,
  PARSER_VERSION,
  type Cue,
  type RawLine,
  type SubtitleFormat,
} from "./subtitle/parse";
import { episodeStem } from "../markdown/templates";
import { applyRebind, planRebind, type RebindPair } from "./sliceRebind";
import {
  collectCloudProgressRefs,
  planCrossDeviceRebind,
  type CrossDevicePlan,
} from "./crossDeviceRebind";
import type { AssetRow, EpisodeRow, SliceRow, WorkRow } from "../types/entities";

export interface SubtitleImportRequest {
  /** 本机字幕文件的绝对路径。日文那份；填反了会自动认出来并纠正。 */
  subtitlePath: string;
  /**
   * 可选：第二份字幕（比如中文单独一份）。网上找不到中日双语合并版很常见，
   * 所以允许两份分开填 —— **两份指向同一个视频**，由导入时按时间轴自动配对。
   */
  translationPath?: string;
  /**
   * 这一集对应的视频文件（本机绝对路径）。**必填** —— 字幕和视频是配套的，
   * 缺一样导入就不成立。只记路径与采样指纹，不上传。
   * 导入时会复制一份进素材库（见 mediaDir）；复制不成功也照样能导入。
   */
  videoPath: string;
  workTitle: string;
  year?: number | null;
  season?: number | null;
  number: number | string;
  episodeTitle?: string;
  /**
   * 素材库目录：**给了就把视频和字幕各复制一份进去**，之后按库里的位置播放。
   * 不传 = 沿用用户原来的路径。
   */
  mediaDir?: string;
}

/** 文件名。素材行的 filename 字段用它 —— 跨平台取路径最后一段。 */
const filenameOf = (path: string): string => path.split(/[\\/]/u).pop() ?? "";

export interface ImportResult {
  workCid: string;
  episodeCid: string;
  assetCid: string;
  sliceCount: number;
  /** 换字幕重导时，认回旧句子的条数（0 = 全新导入，没有历史可挂） */
  reboundCount: number;
  /** rekey 搬走的数据条数（进度 + 笔记 + 录音 + 曝光标记） */
  rebindMoved: number;
  /** 素材没能收进库时给人看的说明（空 = 一切正常）；不拦导入，只在提示里带一句 */
  mediaNote?: string;
  /**
   * 跨设备关联规划（换机后把云端旧记录接到本次新切片上）。**只规划、不执行** ——
   * 执行要等用户在弹窗里确认（`views/AssociationModal.ts`）。`ok=false` 时不必弹。
   */
  association?: CrossDevicePlan;
  stats: ReturnType<typeof cueStats>;
}

export type ImportOutcome =
  | { ok: true; result: ImportResult }
  | { ok: false; reason: string; hint?: string };

export async function importSubtitle(
  db: VaultDb,
  request: SubtitleImportRequest,
): Promise<ImportOutcome> {
  const now = new Date().toISOString();

  // 身份先算出来：重名检查和落库都要用，且它不依赖字幕内容
  const workIdentity = await workCid(request.workTitle, request.year ?? null);
  const number = normalizeEpisodeNumber(request.number ?? "");
  const epIdentity = await episodeCid(workIdentity, request.season ?? null, number);

  if (!(await fileExists(request.subtitlePath))) {
    return { ok: false, reason: "找不到这个文件。", hint: "确认文件还在原来的位置。" };
  }

  const format = detectFormat(request.subtitlePath);
  if (!format) {
    return {
      ok: false,
      reason: "这个格式我还不认。",
      hint: "目前支持 .ass / .ssa / .srt / .vtt / .lrc。",
    };
  }

  const probe = await probeFile(request.subtitlePath);
  const primaryRaw = parseRawLines(await readTextFile(request.subtitlePath), format);
  if (primaryRaw.length === 0) {
    return {
      ok: false,
      reason: "这份字幕里读不出带时间轴的台词。",
      hint: "没有时间轴的纯文本歌词没法用；卡拉OK逐字特效也会被排除掉。",
    };
  }

  // ── 第二份字幕（可选）：日语、中文分成两个文件的情况 ────────────────────
  // 网上双语合并版不好找，不能逼用户自己先合并。两份分开填，
  // 导入时按时间轴自动配对 —— 两份文件指向同一个视频。
  let translationFormat: SubtitleFormat | null = null;
  let translationProbe: FileProbe | null = null;
  let translationRaw: RawLine[] | null = null;
  if (request.translationPath) {
    if (!(await fileExists(request.translationPath))) {
      return {
        ok: false,
        reason: "第二份字幕文件找不到。",
        hint: "检查一下路径；两份字幕指的是同一个视频的另一门语言。",
      };
    }
    translationFormat = detectFormat(request.translationPath);
    if (!translationFormat) {
      return {
        ok: false,
        reason: "第二份字幕的格式我还不认。",
        hint: "目前支持 .ass / .ssa / .srt / .vtt / .lrc。",
      };
    }
    translationProbe = await probeFile(request.translationPath);
    translationRaw = parseRawLines(await readTextFile(request.translationPath), translationFormat);
    if (translationRaw.length === 0) {
      return {
        ok: false,
        reason: "第二份字幕里读不出带时间轴的台词。",
        hint: "确认填的是字幕文件，不是纯文本。",
      };
    }
  }

  // ── 语种分工：谁是日文（出句子）、谁是中文（出翻译） ─────────────────────
  // 用户不一定按「先日文后中文」的顺序填，按假名占比自动认出来，填反了也能导。
  const primaryLanguage = languageOfLines(primaryRaw);
  const translationLanguage = translationRaw ? languageOfLines(translationRaw) : null;
  if (translationLanguage !== null && translationLanguage === primaryLanguage) {
    return {
      ok: false,
      reason: "两份字幕是同一种语言，配不成对。",
      hint: "一份要日文、一份要中文；如果手上只有双语合并版，第二份不用填。",
    };
  }
  if (primaryLanguage === "zh" && translationLanguage === null) {
    return {
      ok: false,
      reason: "这份字幕里没有日文，学不了。",
      hint: "如果日语和中文分成两个文件，点「添加字幕文件」把日文那份也填上。",
    };
  }
  const swapped = translationLanguage === "ja" && primaryLanguage === "zh";
  const jaRaw = swapped ? translationRaw! : primaryRaw;
  const zhRaw = swapped ? primaryRaw : translationRaw ?? [];
  const jaPath = swapped ? request.translationPath! : request.subtitlePath;
  const jaProbe = swapped ? translationProbe! : probe;
  const jaFormat = (swapped ? translationFormat : format)!;
  const zhPath = swapped ? request.subtitlePath : request.translationPath;
  const zhProbe = swapped ? probe : translationProbe;

  // 日文文件出句子（双语内嵌的行在解析阶段已经配好 zh）；
  // 中文文件的行按时间轴跨文件配对，补到没有内嵌翻译的句子上。
  const jaCues: Cue[] = buildCues(jaRaw);
  if (jaCues.length === 0) {
    return {
      ok: false,
      reason: "字幕里提不出可以学的日文台词。",
      hint: "确认填的是日文字幕；也可以把日文那份填进第一栏。",
    };
  }
  const crossPairs = zhRaw.length > 0 ? pairByTime(jaCues, zhRaw) : new Map<number, string>();
  const mergedCues: Cue[] = jaCues.map((cue, position) => ({
    ...cue,
    index: position + 1,
    zh: cue.zh || crossPairs.get(position) || "",
  }));

  // ── 视频：必填，和字幕配套 ─────────────────────────────────────────────
  // 缺视频直接拒绝 —— 「字幕进去了、视频悄悄没挂上」比导入失败糟得多，
  // 用户会以为挂上了，学到一半才发现没法播。
  let videoPath = request.videoPath;
  let videoProbe: FileProbe;
  if (!videoPath) {
    return {
      ok: false,
      reason: "视频和字幕要配套，缺一样导不了。",
      hint: "插件不下载也不检索，两样都得你自己提供；填本机绝对路径就行。",
    };
  }
  if (!(await fileExists(videoPath))) {
    return {
      ok: false,
      reason: "视频文件找不到。",
      hint: "检查一下路径 —— 路径要对得上真实文件，复制进素材库之前先得读得到它。",
    };
  }
  videoProbe = await probeFile(videoPath);

  // ── 素材收进素材库（视频 + 字幕） ──────────────────────────────────────
  // 收进来之后就跟用户原来那个文件夹脱钩了：以后他整理 Downloads、拔外接硬盘，
  // 这一集照样能播。失败一律不拦导入 —— 退回原路径 + 一句人话，先让人学起来。
  const mediaWarnings: string[] = [];
  let videoFilePath = videoPath;
  let jaFilePath = jaPath;
  let zhFilePath = zhPath ?? "";
  if (request.mediaDir) {
    const ingest = async (
      sourcePath: string,
      probe: FileProbe,
      label: string,
    ): Promise<string> => {
      const outcome = await takeIntoMediaDir({
        sourcePath,
        mediaDir: request.mediaDir!,
        workTitle: request.workTitle,
        fingerprint: probe.fingerprint,
        sizeBytes: probe.sizeBytes,
      });
      if (outcome.error) mediaWarnings.push(`${label}没能收进素材库：${outcome.error}`);
      return outcome.path;
    };
    videoFilePath = await ingest(videoPath, videoProbe, "视频");
    jaFilePath = await ingest(jaPath, jaProbe, "日文字幕");
    if (zhPath && zhProbe) zhFilePath = await ingest(zhPath, zhProbe, "中文字幕");
  }

  // 切片的身份挂在**日文**字幕上 —— 中文那份只是翻译来源。
  // 这样同一集不管用户用的是双语合并版还是两份分开的文件，
  // 只要日文文件不变，所有切片和学习记录的身份都稳定。
  const assetIdentity = await assetCid("subtitle", jaProbe.fingerprint);

  // ── 重名检查：一个名字只能对应一份笔记 ──────────────────────────────────
  // 笔记名就是「视频名 + 季集号」，两份笔记撞同一个名字会互相覆盖。
  //
  // ⚠️ 判据是**最终的文件名**，不是 cid：同名但年份不同的两集 cid 不一样（年份参与
  // 了 workCid），笔记名却一模一样，只比 cid 会漏过去。
  // 放在这儿（而不是函数开头）是因为要拿日文字幕的指纹，才能把"重导同一个视频"和
  // "另一个视频恰好取了同一个名字"分开 —— 详见 findNameClash。
  const stem = episodeStem(request.workTitle, request.season ?? null, number);
  if (await findNameClash(db, stem, jaProbe.fingerprint, epIdentity)) {
    return {
      ok: false,
      reason: "这个名字已经有笔记了。",
      hint: "同一个名字 + 同样的季号和集号只能有一份笔记。改一下名字，或把季号、集号区分开再导入；不是番剧的视频可以把集号留空。",
    };
  }

  const work: WorkRow = await seal({
    cid: workIdentity,
    title: request.workTitle,
    titleJa: "",
    romaji: "",
    year: request.year ?? null,
    coverUrl: "",
    note: "",
    clientUpdatedAt: now,
    deletedAt: null,
  });

  const episode: EpisodeRow = await seal({
    cid: epIdentity,
    workCid: workIdentity,
    season: request.season ?? null,
    number,
    title: request.episodeTitle ?? "",
    durationMs: mergedCues.length > 0 ? mergedCues[mergedCues.length - 1].endMs : null,
    clientUpdatedAt: now,
    deletedAt: null,
  });

  const asset: AssetRow = await seal({
    cid: assetIdentity,
    kind: "subtitle" as const,
    episodeCid: epIdentity,
    filename: filenameOf(jaFilePath),
    sizeBytes: jaProbe.sizeBytes,
    durationSeconds: null,
    language: "ja",
    subtitleFormat: jaFormat,
    subtitleGroup: "",
    fingerprint: jaProbe.fingerprint,
    fpVersion: jaProbe.fpVersion,
    localPath: jaFilePath,
    available: true,
    clientUpdatedAt: now,
    deletedAt: null,
  });

  // 中文那份也登记成素材（有的话）。它不产生切片，只是翻译来源；
  // cid 同样由内容指纹派生，换台机器身份不变。
  let translationAsset: AssetRow | null = null;
  if (zhFilePath && zhProbe) {
    translationAsset = await seal({
      cid: await assetCid("subtitle", zhProbe.fingerprint),
      kind: "subtitle" as const,
      episodeCid: epIdentity,
      filename: filenameOf(zhFilePath),
      sizeBytes: zhProbe.sizeBytes,
      durationSeconds: null,
      language: "zh",
      subtitleFormat: (swapped ? format : translationFormat)!,
      subtitleGroup: "",
      fingerprint: zhProbe.fingerprint,
      fpVersion: zhProbe.fpVersion,
      localPath: zhFilePath,
      available: true,
      clientUpdatedAt: now,
      deletedAt: null,
    });
  }

  // 视频 asset 与字幕 asset 挂在同一集上；cid 由内容指纹派生，
  // 同一个视频文件无论从哪台机器导入，身份都一致。
  const videoAsset: AssetRow = await seal({
      cid: await assetCid("video", videoProbe.fingerprint),
      kind: "video" as const,
      episodeCid: epIdentity,
      filename: filenameOf(videoFilePath),
      sizeBytes: videoProbe.sizeBytes,
      // 视频时长不在导入时解析 —— 插件环境没有 ffprobe，播放时从 <video> 元数据里读
      durationSeconds: null,
      language: "",
      subtitleFormat: "",
      subtitleGroup: "",
      fingerprint: videoProbe.fingerprint,
      fpVersion: videoProbe.fpVersion,
      localPath: videoFilePath,
      available: true,
      clientUpdatedAt: now,
      deletedAt: null,
    });

  // ── 台词绑定（2026-10-07）：换字幕重导时把学过的东西挂回新句子 ──────────
  //
  // sliceCid 由 assetCid 派生，assetCid 来自字幕文件指纹 —— 换一版字幕，这一集
  // 所有句子的 cid 全部变掉，学过的进度就成了孤儿。这里先按日文相似度认回
  // 旧句子（判据见 jaMatch.ts），再把旧 cid 上的数据 rekey 过来。
  const previousSlices = (await db.getAll<SliceRow>(STORE.slices)).filter(
    (row) => row.episodeCid === epIdentity && !row.deletedAt,
  );
  const previousByCid = new Map(previousSlices.map((row) => [row.cid, row]));
  const matched = planRebind(previousSlices, mergedCues);

  const slices: SliceRow[] = [];
  const rebindPairs: RebindPair[] = [];
  for (const [position, cue] of mergedCues.entries()) {
    // 三句 hash（2026-10-09）：上一句 + 本句 + 下一句的**原片日文**，
    // 首尾句退化为两句。textHash 仍是纯句子指纹（去空白），单独存字段。
    const textHash = await sentenceTextHash(cue.ja);
    const identity = await sliceCid(
      position > 0 ? mergedCues[position - 1].ja : null,
      cue.ja,
      position + 1 < mergedCues.length ? mergedCues[position + 1].ja : null,
    );
    const oldCid = matched.get(position);
    const previous = oldCid ? previousByCid.get(oldCid) : undefined;
    if (previous) rebindPairs.push({ from: previous.cid, to: identity });
    slices.push(
      await seal({
        cid: identity,
        episodeCid: epIdentity,
        assetCid: assetIdentity,
        index: cue.index,
        startMs: cue.startMs,
        endMs: cue.endMs,
        ja: cue.ja,
        zh: cue.zh,
        speaker: cue.speaker,
        textHash,
        parserVersion: PARSER_VERSION,
        // 🔒 换字幕不该抹掉 AI 解析与用户纠错 —— 那是花时间和钱换来的覆盖层。
        // 以前这里是 `analysis: null` 硬写，重导一次就全没了。
        analysis: previous?.analysis ?? null,
        textFixes: previous?.textFixes ?? undefined,
        readingFixes: previous?.readingFixes ?? undefined,
        correctionsUpdatedAt: previous?.correctionsUpdatedAt ?? undefined,
        clientUpdatedAt: now,
        deletedAt: null,
      }),
    );
  }

  // 业务写一个事务落盘（outbox 已退役；同步是全量快照重推）
  await db.transaction([STORE.works, STORE.episodes, STORE.assets, STORE.slices, STORE.meta], "readwrite", async (tx) => {
    await tx.put(STORE.works, work);
    await tx.put(STORE.episodes, episode);
    await tx.put(STORE.assets, asset);
    if (translationAsset) await tx.put(STORE.assets, translationAsset);
    await tx.put(STORE.assets, videoAsset);
    for (const slice of slices) await tx.put(STORE.slices, slice);
  });

  // 旧 cid 上的进度/笔记/录音/曝光标记搬过来（放在写库之后：新切片要先进库）
  const rebind = await applyRebind(db, rebindPairs);

  // ── 跨设备关联（2026-10-09）：云端旧记录 × 本次新切片的对齐规划 ──────────
  //
  // 换机场景：本机 progress 表里有从云端拉回来的旧记录（带 provenance），但本地
  // 没有对应切片 → 孤儿。这里把它们与本次导入的新切片对齐，**只规划不执行** ——
  // 执行要等用户在弹窗里确认（见 `views/AssociationModal.ts`）。
  // 同机换字幕的场景不会命中这里：那种情况由上面的 `sliceRebind` 用日文相似度处理，
  // 云端记录本来就少（本机刚学的行没有 provenance）。
  const cloudRows = await collectCloudProgressRefs(db, {
    workCid: workIdentity,
    episodeNumber: String(number),
  });
  const association = planCrossDeviceRebind(
    cloudRows,
    slices.map((slice) => ({ cid: slice.cid, index: slice.index })),
  );

  return {
    ok: true,
    result: {
      workCid: workIdentity,
      episodeCid: epIdentity,
      assetCid: assetIdentity,
      sliceCount: slices.length,
      reboundCount: rebindPairs.length,
      rebindMoved: rebind.moved,
      mediaNote: mediaWarnings.length > 0 ? mediaWarnings.join("；") : undefined,
      association,
      stats: cueStats(mergedCues),
    },
  };
}

/** 补上行摘要。volatile 字段不参与计算，注释见 core/digest.ts。 */
async function seal<T extends Record<string, unknown>>(row: T): Promise<T & { rowDigest: string; rev: number }> {
  return { ...row, rowDigest: await rowDigest(row), rev: 0 };
}

/**
 * 有没有另一集已经占用了这个笔记名，撞上了返回那份笔记所属的视频名。
 *
 * 按"最终的文件名"比，不按 cid 比 —— 同名但年份不同的两集 cid 是不同的
 * （年份参与了 workCid），文件名却完全一样，只比 cid 会漏过去。
 *
 * 放行的两种情况：
 *
 * 1. **同一份日文字幕**（指纹相同）：那是"同一个视频重来一次"。为什么这件事非得看
 *    指纹不可：cid 只由"名字 + 年份 + 季集号"派生，季集都留空的单集视频里，"重导
 *    同一个视频"和"另一个视频恰好取了同名"算出来的 cid 一模一样 —— 数据层面它就是
 *    同一个东西，只有素材指纹能把两者分开。
 * 2. **同一集**（`episode.cid === sameEpisodeCid`）：撞名只可能发生在「不同集恰好
 *    共用同一 stem」；episodeCid 由「作品名 + 年份 + 季/集号」派生，相同即数据层面
 *    的同一集。
 *
 *    🔥 2026-10-09 放宽：这一条以前还要求**视频指纹一致**（只换字幕文件）。换机重导
 *    时视频、字幕都可能是新版本（指纹全不同），于是明明同一集却被拦在门外 —— 用户
 *    被迫改名，而改名会让 episodeCid 变掉，`sliceRebind` 的旧句集随之扫空，学习记录
 *    全成孤儿。现在只要 episodeCid 相同就放行，交给 `sliceRebind` 按日文相似度挂回
 *    （2026-10-09 归一化加档后，标点/假名写法差异在身份层即对上）。
 *
 * ⚠️ episodeCid **不同**（名字相同但年份/季集不同）是**新的一集**，笔记会真的撞在一起，
 * 照样拦 —— 不放开这一条。
 */
async function findNameClash(
  db: VaultDb,
  stem: string,
  fingerprint: string | null,
  sameEpisodeCid: string | null = null,
): Promise<string | null> {
  const episodes = await db.getAll<EpisodeRow>(STORE.episodes);
  if (episodes.length === 0) return null;
  const works = new Map((await db.getAll<WorkRow>(STORE.works)).map((row) => [row.cid, row]));
  const assets = fingerprint ? await db.getAll<AssetRow>(STORE.assets) : [];
  for (const episode of episodes) {
    if (episode.deletedAt) continue;
    const work = works.get(episode.workCid);
    if (!work || work.deletedAt) continue;
    const title = work.title || work.titleJa || "未命名";
    if (episodeStem(title, episode.season, episode.number) !== stem) continue;
    const sameMaterial = assets.some(
      (row) =>
        row.episodeCid === episode.cid &&
        row.kind === "subtitle" &&
        row.language === "ja" &&
        row.fingerprint === fingerprint,
    );
    if (sameMaterial) continue;
    // 同一集（episodeCid 相同）→ 放行，交给 sliceRebind 挂数据（见头注释第 2 条）
    if (sameEpisodeCid && episode.cid === sameEpisodeCid) continue;
    return title;
  }
  return null;
}
