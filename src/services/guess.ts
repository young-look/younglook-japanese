/**
 * 从文件名里猜元数据，帮用户少填字段。
 *
 * 猜错的成本很低（弹窗里一眼能看见并改掉），猜对能省掉全部手输 —— 所以规则
 * 宁可保守：认不准就留空。全部是纯函数、确定性，同一个输入永远同一个输出，
 * 可单测 —— 这也是「解析不交给 LLM」的原因：规则免费，LLM 每次都要烧钱。
 *
 * 规则口径对齐后端 core/library/services/parsing.py（网页端资源库用同一套
 * 正则、同一批实测教训：位深标记先摘、区间从原文找、Fin 算完结……），
 * 插件这边只保留「导入一集」用得上的四个字段。
 */

export interface FilenameGuess {
  workTitle: string;
  number: string;
  season: number | null;
  year: number | null;
}

/** 常见视频容器。右键菜单里看到这些扩展名就提供「用洋流导入这一集」。 */
export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  "mp4",
  "mkv",
  "avi",
  "mov",
  "webm",
  "m4v",
  "wmv",
  "flv",
]);

// ── 正则族（与 parsing.py 同源；.test()/.exec() 用的都不带 g，免受 lastIndex 干扰）──

const BRACKET_RE = /[\[【（(]([^\[\]【】()（）]{1,90})[\]】）)]/gu;
/** 标题开头的 `[发布组]` 段。 */
const PREFIX_GROUP_RE = /^\s*[\[【]\s*([^\]】]{1,64}?)\s*[\]】]\s*/u;

const RESOLUTION_RE = /(?<!\d)(2160|1440|1080|720|576|480)\s*[pi](?![a-z])/i;
const UHD_RE = /(?<![0-9A-Za-z])(?:4K|8K|UHD)(?![0-9A-Za-z])/i;
const CODEC_RE = /(?<![A-Za-z])(?:HEVC|x265|h\.?265|H265|AVC|x264|h\.?264|H264|AV1|VP9)(?![A-Za-z0-9])/i;
const AUDIO_RE = /(?<![A-Za-z])(?:FLAC|AAC|Opus|DTS-?HD|DTS|TrueHD|EAC3|AC3|MP3|ALAC|PCM)(?![A-Za-z])/i;
const SOURCE_RE =
  /(?<![A-Za-z])(?:BDRip|BDRemux|BDBOX|BDMV|BD|BluRay|Blu-?ray|WEB-?DL|WEB-?Rip|WEB|Baha|B-Global|BGlobal|Crunchyroll|Netflix|Amazon|Disney\+?|Abema|U-NEXT|Hulu|meWATCH|TVRip|HDTV|TV|DVDRip|DVD)(?![A-Za-z])/i;
const BITDEPTH_RE = /(?<!\d)\d{1,2}\s*-\s*bits?(?!\w)/i;

/** 字幕规格（`简日`、`CHS`、`内封` 这类）—— 括号段沾上它就当规格段丢掉。 */
const SUB_HINT_RE =
  /(?:简日|繁日|简繁日|简繁|简体|繁体|中日|日中|日简|双语|中字|内封|内嵌|硬字幕|外挂|CHS|CHT|JPSC|JPN|BIG5|GB|SC|TC|Subs?)(?![A-Za-z])/iu;
/** 纯字幕组名（带「字幕组/Sub/Raws」字样的短段）。 */
const FANSUB_FULL_RE = /^(?:.{0,20}?(?:字幕组|字幕社|压制组|汉化组|Subs?|Raws?|Fansub))$/iu;
/** 除了元数据啥也不是的段（v2、repack、1080p、10bit、容器名……）。 */
const META_ONLY_FULL_RE =
  /^(?:v\d+|rev\d*|repack|proper|remux|hi10p|ma10p|10bit|8bit|mkv|mp4|ass|srt|sup|subs?|raws?|字幕|字幕组|動畫|动画|繁體|简体|简繁|全集|合集|complete|batch|new|update|fix|\d{3,4}p|\d+bit)$/iu;

const YEAR_FULL_RE = /^(?:19|20)\d{2}$/;
const YEAR_SEARCH_RE = /(?<![\dA-Za-z])(?:19\d{2}|20\d{2})(?![\dA-Za-z])/u;
const PURE_EP_FULL_RE = /^\d{1,3}(?:v\d)?$/iu;
const EP_RANGE_FULL_RE = /^\d{1,3}\s*(?:[-~〜～]|至|to)\s*\d{1,3}$/iu;
const COMPLETE_FULL_RE = /^(?:全集|合集|完结|完結|全\s*\d{1,3}\s*[话話集]|Complete|Batch|Fin)$/iu;

const EP_CN_RE = /第\s*(\d{1,3}(?:\.\d)?)\s*[集话話]/u;
const EP_MARK_RE = /(?<![A-Za-z0-9])E(?:P)?\s*(\d{1,3})(?:v\d)?(?![0-9])/iu;
const EP_RANGE_RE = /(?<!\d)(\d{1,3})\s*(?:[-~〜～]|至|to)\s*(\d{1,3})(?!\d)/iu;
/**
 * 裸数字。小数只认 `.5`（1.5 这种特别篇）—— `AAC2.0`、`5.1` 这类音频参数
 * 里的数字不能被当成集号；小数点也算「后面跟着的不是干净数字」。
 */
const BARE_NUM_RE = /(?<![\dA-Za-z_.])(\d{1,3}(?:\.5)?)(?:v\d)?(?![\dA-Za-z_.])/gu;
/** 整季合集的关键字：`[01-13]`、`[Fin]`、`全集` —— 说不清单集号，留空给人确认。 */
const COMPLETE_RE = /(?:全集|合集|完结|完結|全\s*\d{1,3}\s*[话話集]|Complete|Batch|(?<![A-Za-z])Fin(?![A-Za-z]))/iu;
const SEASON_EPISODE_RE = /\bS(\d{1,2})E(\d{1,3})\b/iu;
const SEASON_RE = /(?<![A-Za-z0-9])S(?:eason\s*)?(\d{1,2})(?![0-9])|第\s*([一二三四五六七八九十\d]{1,3})\s*季/iu;
const SEASON_CN: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

const CONTAINER_RE = /\.(?:mkv|mp4|avi|ts|m2ts|wmv|rmvb|ass|srt|sup|vtt|lrc|webm|mov|m4v|flv)\b/iu;
/** 散落在括号外的压制标签（场景发布的命名不带括号）。 */
const TITLE_TAG_RE =
  /(?:BDRip|BDRemux|BDBOX|BDMV|BluRay|Blu-?ray|WEB-?DL|WEB-?Rip|Baha|B-Global|BGlobal|Crunchyroll|Netflix|Amazon|Abema|Hulu|TVRip|HDTV|DVDRip|HEVC|x265|h\.?265|H265|AVC|x264|h\.?264|H264|AV1|VP9|FLAC|AAC|Opus|TrueHD|EAC3|AC3|MP3|ALAC|PCM|Hi10P|Ma10P|\d{1,2}\s*-\s*bits?|10bit|8bit|\d{3,4}[pi]\b|4K|8K|UHD)/i;

/** 判断括号里的一段内容是不是「元数据」（可以安全丢掉的）。 */
function isMetaToken(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return true;
  if (META_ONLY_FULL_RE.test(t)) return true;
  if (YEAR_FULL_RE.test(t)) return true;
  if (RESOLUTION_RE.test(t) || UHD_RE.test(t)) return true;
  if (BITDEPTH_RE.test(t)) return true;
  if (CODEC_RE.test(t) || AUDIO_RE.test(t)) return true;
  if (SOURCE_RE.test(t)) return true;
  if (PURE_EP_FULL_RE.test(t)) return true;
  if (EP_RANGE_FULL_RE.test(t)) return true;
  if (COMPLETE_FULL_RE.test(t)) return true;
  if (FANSUB_FULL_RE.test(t)) return true;
  if (SUB_HINT_RE.test(t)) return true;
  return false;
}

export function guessFromFilename(filename: string): FilenameGuess {
  const empty: FilenameGuess = { workTitle: "", number: "", season: null, year: null };
  const base0 = (filename ?? "").replace(/\.[^.]+$/u, "").trim();
  if (!base0) return empty;
  // 压制圈常用 `_` 当空格（BanG_Dream_04_[1080p].mkv），先统一掉，
  // 后面的裸数字识别和标题清洗都受益。
  const base = base0.replace(/_/gu, " ");

  const { number, token } = guessEpisode(base.replace(BITDEPTH_RE, " "));
  const seasonToken = guessSeasonToken(base);
  const yearToken = YEAR_SEARCH_RE.exec(base)?.[0] ?? "";

  return {
    workTitle: guessTitle(base, [token, seasonToken, yearToken]),
    number,
    season: guessSeason(base),
    year: yearToken ? Number(yearToken) : null,
  };
}

/** 集号优先级与 parsing.py 一致：SxxE > 第N集 > E/EP 标记 > 合集/多裸数字（留空）> 唯一裸数字。 */
function guessEpisode(base: string): { number: string; token: string } {
  const norm = (v: string) => String(Number(v));
  const sxxe = SEASON_EPISODE_RE.exec(base);
  if (sxxe) return { number: norm(sxxe[2]), token: sxxe[0] };

  const cn = EP_CN_RE.exec(base);
  if (cn) return { number: norm(cn[1]), token: cn[0] };

  const mark = EP_MARK_RE.exec(base);
  if (mark) return { number: norm(mark[1]), token: mark[0] };

  // 整季合集/区间：猜不出是哪一集，宁空勿错
  if (EP_RANGE_RE.test(base) || COMPLETE_RE.test(base)) return { number: "", token: "" };

  // 裸数字只在「有且只有一个」时才认 —— 像《86》这种以数字开头的作品名，
  // 86 和真正的集号会同时出现，认哪个都是赌，不如留给人。
  const bareNumbers = new Set<string>();
  let bareToken = "";
  for (const match of base.match(BARE_NUM_RE) ?? []) {
    bareNumbers.add(String(Number(match.replace(/v\d+$/iu, ""))));
    if (!bareToken) bareToken = match;
  }
  if (bareNumbers.size === 1 && bareToken) {
    return { number: [...bareNumbers][0], token: bareToken };
  }
  return { number: "", token: "" };
}

function guessSeason(base: string): number | null {
  const sxxe = SEASON_EPISODE_RE.exec(base);
  if (sxxe) return Number(sxxe[1]);
  const m = SEASON_RE.exec(base);
  if (!m) return null;
  if (m[1]) return Number(m[1]);
  const cn = m[2] ?? "";
  if (!cn) return null;
  if (/\d/u.test(cn)) return Number(cn);
  return SEASON_CN[cn] ?? null;
}

/** 季标记原文（S01 / 第2季），从标题里原样删掉时用。 */
function guessSeasonToken(base: string): string {
  if (SEASON_EPISODE_RE.test(base)) return ""; // S01E04 整段算集号 token，不重复删
  return SEASON_RE.exec(base)?.[0] ?? "";
}

/**
 * 作品名：括号里的元数据丢掉、其余还原成正文，再按 `/` 拆候选取最长的。
 *
 * `[Nekomoe kissaten] BanG Dream! It's MyGO!!!!! [04][BDRip]` 这种命名里，
 * 开头第一段是字幕组名，无论像不像元数据都要让位；正文里剩下的最长候选
 * 通常是最完整的作品名（parsing.py 同款规则）。
 */
function guessTitle(base: string, stripTokens: string[]): string {
  const withPrefixDropped = extractTitle(base, true);
  const title = withPrefixDropped || extractTitle(base, false);
  if (!title) return "";
  return cleanTitle(title, stripTokens);
}

function extractTitle(base: string, dropPrefix: boolean): string {
  let working = base;
  if (dropPrefix) {
    const prefix = PREFIX_GROUP_RE.exec(working);
    if (prefix) working = working.slice(prefix[0].length);
  }
  // 是元数据的括号段抹成空格，不是的还原成普通文本（可能就是作品名）
  const body = working.replace(BRACKET_RE, (_m, inner: string) => (isMetaToken(inner) ? " " : ` ${inner} `));
  const text = body.replace(CONTAINER_RE, " ").replace(/\s{2,}/gu, " ").trim();
  if (!text) return "";

  const titles: string[] = [];
  for (const raw of text.split(/\s*[/／|｜]\s*/u)) {
    // 散落的压制标签之后多半是技术参数了（Under Ninja S01E04 1080p WEB-DL…），
    // 从第一个标签处截断，别把后半截垃圾带进作品名
    const cut = raw.search(TITLE_TAG_RE);
    const part = (cut >= 0 ? raw.slice(0, cut) : raw)
      .trim()
      .replace(/^[-–—·|]+|[-–—·|]+$/gu, "")
      .trim();
    if (part.length < 2) continue;
    if (isMetaToken(part)) continue;
    if (!titles.includes(part)) titles.push(part);
  }
  if (!titles.length) return "";
  return titles.sort((a, b) => b.length - a.length)[0];
}

function cleanTitle(raw: string, stripTokens: string[]): string {
  let value = raw;
  for (const token of stripTokens) {
    if (!token) continue;
    value = value.split(token).join(" ");
  }
  return (
    value
      .replace(TITLE_TAG_RE, " ")
      // 下划线就是空格；但连字符只在被空格包住时才是分隔符 ——
      // Eighty-Six 这种官方标题里的连字符要保住。
      .replace(/_/gu, " ")
      .replace(/\s+[-–—·|]+\s+/gu, " ")
      .replace(/^[-–—·|]+|[-–—·|]+$/gu, "")
      .replace(/\s{2,}/gu, " ")
      .replace(/^[「『"'\s]+|[」』"'\s]+$/gu, "")
      .trim() || raw.trim()
  );
}
