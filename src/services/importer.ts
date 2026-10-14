/**
 * 导入：把用户本机的一套「视频 + 字幕」变成**一条学习记录**。
 *
 * 边界（产品的红线，不能含糊）：
 *  - 视频和字幕**都由用户提供**，两样配套、都必填 —— 插件不去下载、不去检索；
 *  - 插件只干一件事：解析字幕、按句子切成台词行、和视频对上号。播放时按时间戳跳播。
 *  - 导入时把素材**复制**一份进素材库（默认在 vault 外，见 services/mediaStore.ts）。
 *    用户原来那份留着不动 —— 以后他整理文件夹、拔硬盘都不影响学习。
 *    素材库本身在**vault 外面**：vault 会被 Sync / iCloud / OneDrive 一起搬走，
 *    一集动画 1~3 GB，不能让几十 GB 的视频去挤用户的云盘。
 *
 * ⚠️ 导入**不往 vault 写任何东西**。笔记是学出来的、不是导入出来的：
 * 用户把一句的三步做完（跟读 + 抄写 + 仿写），那一句才进笔记。
 * 导入就往 vault 里丢一份笔记，只会让用户在笔记列表里看到一堆自己还没学过的东西。
 *
 * 身份模型（2026-10-14 重构定稿，**没有模糊匹配**）：
 *  - 学习记录的键 = (视频 sha256, 日文字幕 sha256) 的组合哈希（`recordCid`）。
 *    同一对文件的重导 = 同一条记录（补绑/复活）；任何一份换了都是另一条记录。
 *  - 句子的键 = 三句哈希（`sliceCid`），跨记录共享：已学的句子换条记录
 *    依然是已学的，进度/笔记/录音/解析自动跟随，**零搬运代码**。
 *  - 作品名/年份/季集号只是展示字段；同名同集号的不同文件 → 并列新记录，
 *    标题自动缀视频文件名区分。
 *
 * 所有失败都走 `ImportOutcome` 返回，不抛异常 —— 失败原因是给用户看的，
 * 得像人话（「这份字幕里读不出时间轴」），不能是堆栈。
 */

import { rowDigest } from "../core/digest";
import {
  assetShaCid,
  normalizeEpisodeNumber,
  normalizeTitle,
  recordCid,
  sentenceTextHash,
  sliceCid,
} from "../core/ids";
import type { VaultDb } from "../storage/db";
import { STORE } from "../storage/db";
import { fileExists, readTextFile, sha256File } from "../storage/files";
import { takeIntoMediaDir } from "./mediaStore";
import {
  buildCues,
  cueStats,
  detectFormat,
  languageOfLines,
  pairByTime,
  parseRawLines,
  type Cue,
  type RawLine,
  type SubtitleFormat,
} from "./subtitle/parse";
import { episodeStem } from "../markdown/templates";
import type {
  AssetRow,
  RecordLineRow,
  RecordRow,
  SentenceRow,
} from "../types/entities";

export interface SubtitleImportRequest {
  /** 本机字幕文件的绝对路径。日文那份；填反了会自动认出来并纠正。 */
  subtitlePath: string;
  /**
   * 可选：第二份字幕（比如中文单独一份）。网上找不到中日双语合并版很常见，
   * 所以允许两份分开填 —— **两份指向同一个视频**，由导入时按时间轴自动配对。
   */
  translationPath?: string;
  /**
   * 这条学习记录对应的视频文件（本机绝对路径）。**必填** —— 字幕和视频是配套的，
   * 缺一样导入就不成立。只记路径与文件哈希，不上传。
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
  /**
   * 慢阶段的进度回调（UI 挂「正在干什么」状态用，别让用户以为卡死）。
   * 同步回调、只许更新界面，不许抛错 —— 抛了会打断导入。
   */
  onProgress?: (phase: ImportProgress) => void;
}

/** 导入里真正要等的两段：算哈希（几 GB 视频 10~30 秒）、往素材库拷文件（同样秒级起）。 */
export type ImportProgress = "hash" | "save";

/** 文件名。素材行的 filename 字段用它 —— 跨平台取路径最后一段。 */
const filenameOf = (path: string): string => path.split(/[\\/]/u).pop() ?? "";

export interface ImportResult {
  recordCid: string;
  sliceCount: number;
  /** true = 同一对文件的重导/补绑：记录键已存在，复活的或原样更新的 */
  reimported: boolean;
  /** true = 同名同集号但文件不同，标题自动缀了视频文件名以示区分 */
  titleSuffixed: boolean;
  /** 素材没能收进库时给人看的说明（空 = 一切正常）；不拦导入，只在提示里带一句 */
  mediaNote?: string;
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
  const number = normalizeEpisodeNumber(request.number ?? "");

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
  const jaFormat = (swapped ? translationFormat : format)!;
  const zhPath = swapped ? request.subtitlePath : request.translationPath;
  const zhFormat = swapped ? format : translationFormat;

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
  // 缺视频直接拒绝 —— 「字幕进去了、视频悄悄没绑上」比导入失败糟得多，
  // 用户会以为绑上了，学到一半才发现没法播。
  const videoPath = request.videoPath;
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

  // ── 整文件 sha256：身份判定的唯一依据 ─────────────────────────────────
  // 几 GB 的视频要 10~30 秒，先喊一嗓子让 UI 挂状态，再开算。
  request.onProgress?.("hash");
  const [videoSha, jaSha, zhSha] = await Promise.all([
    sha256File(videoPath),
    sha256File(jaPath),
    zhPath ? sha256File(zhPath) : Promise.resolve(null),
  ]);
  const zhSha256 = zhSha ? zhSha.sha256 : null;

  // 学习记录的键：文件对即身份。同一对文件的重导会命中同一个键。
  const recordIdentity = await recordCid(videoSha.sha256, jaSha.sha256);

  // ── 素材收进素材库（视频 + 字幕） ──────────────────────────────────────
  // 收进来之后就跟用户原来那个文件夹脱钩了：以后他整理 Downloads、拔外接硬盘，
  // 这条记录照样能播。失败一律不拦导入 —— 退回原路径 + 一句人话，先让人学起来。
  const mediaWarnings: string[] = [];
  let videoFilePath = videoPath;
  let jaFilePath = jaPath;
  let zhFilePath = zhPath ?? "";
  if (request.mediaDir) {
    request.onProgress?.("save"); // 拷几个 GB 的视频同样要等，UI 别让它干瞪眼
    const ingest = async (
      sourcePath: string,
      sha256: string,
      sizeBytes: number,
      label: string,
    ): Promise<string> => {
      const outcome = await takeIntoMediaDir({
        sourcePath,
        mediaDir: request.mediaDir!,
        workTitle: request.workTitle,
        sha256,
        sizeBytes,
      });
      if (outcome.error) mediaWarnings.push(`${label}没能收进素材库：${outcome.error}`);
      return outcome.path;
    };
    videoFilePath = await ingest(videoPath, videoSha.sha256, videoSha.sizeBytes, "视频");
    jaFilePath = await ingest(jaPath, jaSha.sha256, jaSha.sizeBytes, "日文字幕");
    if (zhPath && zhSha) zhFilePath = await ingest(zhPath, zhSha.sha256, zhSha.sizeBytes, "中文字幕");
  }

  // ── 判定这条记录是「重导/补绑」还是「新记录」 ───────────────────────────
  const existingRecords = await db.getAll<RecordRow>(STORE.records);
  const existing = existingRecords.find((row) => row.cid === recordIdentity);
  const live = existingRecords.filter((row) => !row.deletedAt);

  // 同名同集号的另一条记录（哈希对不同）→ 标题缀视频文件名区分；
  // 缀完还撞（连文件名都一样）再缀哈希短尾。只影响展示，不影响身份。
  let displayTitle = request.workTitle;
  const metaOf = (row: { title: string; year: number | null; season: number | null; number: string }) =>
    `${normalizeTitle(row.title)}|${row.year ?? ""}|${normalizeEpisodeNumber(row.season ?? "")}|${normalizeEpisodeNumber(row.number)}`;
  const myMeta = metaOf({
    title: request.workTitle,
    year: request.year ?? null,
    season: request.season ?? null,
    number,
  });
  const hasMetaTwin = live.some((row) => row.cid !== recordIdentity && metaOf(row) === myMeta);
  if (hasMetaTwin) {
    displayTitle = `${request.workTitle}（${filenameOf(videoPath)}）`;
    while (live.some((row) => row.title === displayTitle)) {
      displayTitle = `${request.workTitle}（${filenameOf(videoPath)}·${videoSha.sha256.slice(0, 6)}）`;
    }
  }

  // 笔记文件名：vault 里一个名字只能有一份笔记。只在新建时分配，重导不折腾。
  const baseStem = episodeStem(request.workTitle, request.season ?? null, number);
  const allocateNoteName = (): string => {
    const taken = new Set(
      live.filter((row) => row.cid !== recordIdentity).map((row) => row.noteName ?? ""),
    );
    if (!taken.has(baseStem)) return baseStem;
    let name = `${baseStem}·${videoSha.sha256.slice(0, 6)}`;
    let round = 2;
    while (taken.has(name)) {
      name = `${baseStem}·${videoSha.sha256.slice(0, 6)}-${round}`;
      round += 1;
    }
    return name;
  };

  const record: RecordRow = await seal({
    cid: recordIdentity,
    videoSha256: videoSha.sha256,
    jaSubSha256: jaSha.sha256,
    zhSubSha256: zhSha256,
    // 重导允许改展示字段（以这次填的为准）；titleSuffixed 时用缀名
    title: displayTitle,
    titleJa: existing?.titleJa ?? "",
    romaji: existing?.romaji ?? "",
    year: request.year ?? null,
    coverUrl: existing?.coverUrl ?? "",
    note: existing?.note ?? "",
    season: request.season ?? null,
    number,
    episodeTitle: request.episodeTitle ?? existing?.episodeTitle ?? "",
    durationMs: mergedCues.length > 0 ? mergedCues[mergedCues.length - 1].endMs : null,
    noteName: existing?.noteName ?? allocateNoteName(),
    clientUpdatedAt: now,
    deletedAt: null, // 复活：软删过的同键记录在这里抬回活行
  });

  // ── 素材行：键 = A: + 文件 sha256，跨记录共享 ──────────────────────────
  const videoAsset: AssetRow = await seal({
    cid: assetShaCid(videoSha.sha256),
    kind: "video" as const,
    sha256: videoSha.sha256,
    filename: filenameOf(videoFilePath),
    sizeBytes: videoSha.sizeBytes,
    language: "",
    subtitleFormat: "",
    // 时间轴校准跟着视频文件走：同一视频换字幕，校准自动还在。
    // 已有素材行时保留旧偏移，别用空值盖掉。
    offsetMs: (await db.get<AssetRow>(STORE.assets, assetShaCid(videoSha.sha256)))?.offsetMs,
    localPath: videoFilePath,
    available: true,
    clientUpdatedAt: now,
    deletedAt: null,
  });

  const jaAsset: AssetRow = await seal({
    cid: assetShaCid(jaSha.sha256),
    kind: "subtitle" as const,
    sha256: jaSha.sha256,
    filename: filenameOf(jaFilePath),
    sizeBytes: jaSha.sizeBytes,
    language: "ja",
    subtitleFormat: jaFormat,
    localPath: jaFilePath,
    available: true,
    clientUpdatedAt: now,
    deletedAt: null,
  });

  let zhAsset: AssetRow | null = null;
  if (zhPath && zhSha) {
    zhAsset = await seal({
      cid: assetShaCid(zhSha.sha256),
      kind: "subtitle" as const,
      sha256: zhSha.sha256,
      filename: filenameOf(zhFilePath),
      sizeBytes: zhSha.sizeBytes,
      language: "zh",
      subtitleFormat: zhFormat!,
      localPath: zhFilePath,
      available: true,
      clientUpdatedAt: now,
      deletedAt: null,
    });
  }

  // ── 句子与台词 ──────────────────────────────────────────────────────────
  // 句子 = 三句哈希寻址的共享层：已存在就**完全不写**——
  // 解析/纠错覆盖层天然保留，学习进度/笔记/录音因为键相同自动命中（零搬运）。
  const sentences = await db.getAll<SentenceRow>(STORE.sentences);
  const existingSentenceCids = new Set(sentences.map((row) => row.cid));
  const newSentences: SentenceRow[] = [];
  const lines: RecordLineRow[] = [];
  for (const [position, cue] of mergedCues.entries()) {
    const identity = await sliceCid(
      position > 0 ? mergedCues[position - 1].ja : null,
      cue.ja,
      position + 1 < mergedCues.length ? mergedCues[position + 1].ja : null,
    );
    if (!existingSentenceCids.has(identity)) {
      newSentences.push(
        await seal({
          cid: identity,
          ja: cue.ja,
          textHash: await sentenceTextHash(cue.ja),
          analysis: null,
          clientUpdatedAt: now,
        }),
      );
      existingSentenceCids.add(identity);
    }
    lines.push({
      recordCid: recordIdentity,
      index: cue.index,
      sentenceCid: identity,
      startMs: cue.startMs,
      endMs: cue.endMs,
      ja: cue.ja,
      zh: cue.zh,
      speaker: cue.speaker,
    });
  }

  // 业务写一个事务落盘（同步是全量快照重推）
  await db.transaction(
    [STORE.records, STORE.assets, STORE.sentences, STORE.lines],
    "readwrite",
    async (tx) => {
      await tx.put(STORE.records, record);
      await tx.put(STORE.assets, videoAsset);
      await tx.put(STORE.assets, jaAsset);
      if (zhAsset) await tx.put(STORE.assets, zhAsset);
      for (const sentence of newSentences) await tx.put(STORE.sentences, sentence);
      // 台词表整段重写：先把这条记录的旧 lines 清掉，再放本次解析结果
      const stale = await tx.getAll<RecordLineRow>(STORE.lines, IDBKeyRange.bound(
        [recordIdentity, 0],
        [recordIdentity, Number.MAX_SAFE_INTEGER],
      ));
      for (const row of stale) await tx.delete(STORE.lines, [row.recordCid, row.index]);
      for (const line of lines) await tx.put(STORE.lines, line);
    },
  );

  return {
    ok: true,
    result: {
      recordCid: recordIdentity,
      sliceCount: lines.length,
      reimported: Boolean(existing),
      titleSuffixed: hasMetaTwin,
      mediaNote: mediaWarnings.length > 0 ? mediaWarnings.join("；") : undefined,
      stats: cueStats(mergedCues),
    },
  };
}

/** 补上行摘要。volatile 字段不参与计算，注释见 core/digest.ts。 */
async function seal<T extends Record<string, unknown>>(row: T): Promise<T & { rowDigest: string; rev: number }> {
  return { ...row, rowDigest: await rowDigest(row), rev: 0 };
}
