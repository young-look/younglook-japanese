/**
 * 字幕解析：把 .ass / .srt / .vtt / .lrc 还原成「一句台词 = 一个切片」的清单。
 *
 * 这是 core/learning/services/subtitle_parser.py 的 TypeScript 移植。
 * 移植的目的不是「看起来像」，而是**两端对同一份文件产出同一个结果** ——
 * 否则服务端缓存的句子分析结果（按「作品 + 句子指纹」存的）会和插件本地对不上。
 *
 * 下面标了「实测」的规则都是踩坑换来的，**不要简化**：
 *
 *  1. 卡拉OK样式名不能用词边界收尾 —— 下划线在正则里算单词字符，
 *     OP_JP 判不出来（实测因此放进来 12000 多条逐字歌词）
 *  2. 语种要按**样式投票**判，不能逐行看假名 —— 「大丈夫」「一生」这类
 *     纯汉字日语句一个假名都没有，逐行判会被当成中文（实测丢 7 条真台词）
 *  3. 中日同行的分隔符：半角斜杠竖线要求**两侧有空格**（防 100人/日 被切开），
 *     真正的判据是两侧语种，不是符号本身
 *  4. 歌词三条：碎行丢弃、**没有文字的时间戳行也要算进边界**、
 *     同一时间戳的中日两行共用结尾（互相当边界会算出 0 秒，两边都没了）
 *  5. 百分秒与毫秒靠小数位数判断，不能统一乘 10 或乘 1
 *
 * 纯函数，不 import obsidian，方便直接单测。
 */

export interface RawLine {
  style: string;
  startMs: number;
  endMs: number;
  text: string;
  speaker: string;
  extra: Record<string, unknown>;
}

export interface Cue {
  index: number;
  startMs: number;
  endMs: number;
  ja: string;
  zh: string;
  style: string;
  speaker: string;
  extra: Record<string, unknown>;
}

/** 解析规则版本。规则改动风险控制：抬版本才能让旧切片有机会重算。 */
export const PARSER_VERSION = 2;

/** 片头片尾、插曲的卡拉OK样式。这些是逐字特效，一行一个音节，必须排除。 */
const KARAOKE_STYLE_RE = /^(?:op|ed|in|song|karaoke|kara|lyric|staff|title)(?:[_\s\-.\d]|$)/i;

/** 覆盖标签 {pos(1,2)}、{an8}、{fade(...)} */
const TAG_RE = /\{[^}]*\}/g;

/** 矢量绘图块：{p1} 到 {p0} 之间是画图指令，不是文字 */
const DRAWING_RE = /\{\\p\s*1\}.*?(?:\{\\p\s*0\}|$)/gis;

/** .ass 的软换行与硬换行 */
const BREAK_RE = /\\[Nn]/g;

/** .ass 的不换行空格 */
const HARD_SPACE_RE = /\\h/g;

const KANA_RE = /[\u3040-\u309f\u30a0-\u30ff]/;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * 只剩标点、音符的行没有学习价值，整句都是这些字符时直接丢掉。
 *
 * 注意这里不能照抄 Python 的 \W：Python 的 \w 是 unicode 感知的，
 * 假名和汉字算「词」，不在 \W 里；而 JS 的 \W 等价于 [^A-Za-z0-9_]，
 * 会把日文整段吞掉 —— 于是「あ」也被判成垃圾行丢掉。
 * 所以用 Unicode 属性转义显式写出「标点 + 符号」来对齐 Python 的语义。
 */
const JUNK_ONLY_RE = /^[\s_♪♫〜～ー…・\-—－\p{P}\p{S}]+$/u;

const ASS_TIME_RE = /^\s*(\d+):(\d{1,2}):(\d{1,2})[.,:](\d{1,3})\s*$/;

const SRT_BLOCK_RE =
  /(\d{1,2}:\d{1,2}:\d{1,2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{1,2}:\d{1,2}[.,]\d{1,3})/;

/** 一行开头可以有多个时间戳：[00:12.00][01:20.00]同一句，表示这句在两处唱 */
const LRC_STAMP_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** 元数据行：[ti:歌名] [ar:歌手] [offset:+500] 等，不是歌词 */
const LRC_META_RE = /^\[(ti|ar|al|by|re|ve|length|offset|tool|kana)\s*:(.*)\]$/i;

/** 增强型 LRC 的逐字时间戳 <00:12.34>，是词级标记，不是句子边界 */
const LRC_WORD_STAMP_RE = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

/**
 * 中日挤在同一行时的分隔符。
 *
 * 半角的 / 和 | 两侧都要求有空格 —— 正常台词里 100人/日、12/25
 * 这种不带空格的斜杠不该被当成翻译分隔符。全角的 ／ 和 ｜ 不带空格
 * 也是这个意思（中文排版就这么写），不额外要求。
 * 真正的判据始终是两侧的语种，不是符号本身。
 */
const INLINE_SPLIT_RE = /\s+[/|]\s+|[／｜]/;

/** 配对时允许的时间偏差：日文和中文行的时间轴常常差个零点几秒 */
const PAIR_TOLERANCE_MS = 1500;

/** 歌词的两个样式名。不能共用一个 —— 注释见 parseLrc。 */
export const LYRIC_STYLE = "lyric";
export const LYRIC_ZH_STYLE = "lyric_zh";

/** 一句歌词最多切这么长。歌词只标了起点，终点是推算出来的，设个上限更稳。 */
const MAX_LYRIC_MS = 8000;

/** 短于这个长度的歌词行丢掉 —— 实测样本开头的「作词 : 某某」这类署名行就靠这条挡住。 */
const MIN_LYRIC_MS = 800;

/** offset 标签绝对值上限。宁可只偏一点点，也不能让整首歌错位。 */
const MAX_LYRIC_OFFSET_MS = 5000;

// ── 时间戳 ────────────────────────────────────────────────────────────────

/**
 * `0:00:01.34` 转成 1340 毫秒。
 *
 * 小数点后可能是 2 位（.ass 百分秒）也可能是 3 位（.srt 毫秒），
 * 按位数判断，不能统一乘 10 或乘 1。
 */
export function parseTimestamp(value: string): number {
  const match = ASS_TIME_RE.exec(value ?? "");
  if (!match) return 0;
  const [, hour, minute, second, frac] = match;
  const base = Number(hour) * 3600 + Number(minute) * 60 + Number(second);
  let milliseconds: number;
  if (frac.length === 1) milliseconds = Number(frac) * 100;
  else if (frac.length === 2) milliseconds = Number(frac) * 10;
  else milliseconds = Number(frac);
  return base * 1000 + milliseconds;
}

/** LRC 的时间戳和 ass/srt 不同：只有分和秒，没有小时。 */
function lrcMilliseconds(minute: string, second: string, frac: string): number {
  let milliseconds: number;
  if (frac.length === 1) milliseconds = Number(frac) * 100;
  else if (frac.length === 2) milliseconds = Number(frac) * 10;
  else if (frac.length === 3) milliseconds = Number(frac);
  else milliseconds = 0;
  return (Number(minute) * 60 + Number(second)) * 1000 + milliseconds;
}

/**
 * `[offset:+500]` 转成 500 毫秒，拿不准的一律归零。
 *
 * 符号含义各家播放器并不完全一致，按 LRC 规范最通行的读法：正 offset 表示
 * 歌词要比时间戳提早出现。这不是能靠猜定死的东西，所以上层会告诉用户
 * 「时间轴有一半是推算出来的」。
 */
function lrcOffset(value: string): number {
  const text = (value ?? "").trim();
  if (!/^[+-]?\d+$/.test(text)) return 0;
  return Math.max(-MAX_LYRIC_OFFSET_MS, Math.min(MAX_LYRIC_OFFSET_MS, Number(text)));
}

// ── 文本清理 ──────────────────────────────────────────────────────────────

/** 去掉覆盖标签与绘图指令，还原换行。 */
export function stripTags(text: string): string {
  let result = (text ?? "").replace(DRAWING_RE, "");
  result = result.replace(TAG_RE, "");
  result = result.replace(BREAK_RE, "\n");
  result = result.replace(HARD_SPACE_RE, " ");
  // 字幕里用全角空格对齐的情况很多，统一成半角再收拾空白
  result = result.replace(/\u3000/g, " ");
  const lines = result
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0);
  return lines.join("\n").trim();
}

export function isKaraokeStyle(style: string): boolean {
  return KARAOKE_STYLE_RE.test((style ?? "").trim());
}

/**
 * 有假名几乎可以断定是日文。
 *
 * 反过来，纯汉字的中文行没有假名；日文里偶尔出现的纯汉字短句
 * （比如歌名《春日影》）识别不出来，交给样式投票与配对阶段兜底。
 */
export function hasKana(text: string): boolean {
  return KANA_RE.test(text ?? "");
}

export function hasCjk(text: string): boolean {
  return CJK_RE.test(text ?? "");
}

/** 过滤掉只剩标点或音符的行。 */
export function looksLikeText(text: string): boolean {
  const value = text ?? "";
  if (!value.trim()) return false;
  if (JUNK_ONLY_RE.test(value)) return false;
  // 至少得有一个假名或汉字，纯拉丁字母的行（如 "Oh!" 的注音）不进切片
  return hasKana(value) || hasCjk(value);
}

// ── .ass / .ssa ───────────────────────────────────────────────────────────

const DEFAULT_ASS_FIELDS = [
  "layer", "start", "end", "style", "name",
  "margin_l", "margin_r", "margin_v", "effect", "text",
];

/** 从 [Events] 段的 Format 行取列序。实测不同字幕组的列序不一致，写死下标迟早错位。 */
function eventsFields(block: string): string[] {
  for (const line of block.split("\n")) {
    const stripped = line.trim();
    if (stripped.toLowerCase().startsWith("format:")) {
      const names = stripped
        .slice(stripped.indexOf(":") + 1)
        .split(",")
        .map((part) => part.trim().toLowerCase());
      if (names.includes("start") && names.includes("text")) return names;
    }
  }
  return [...DEFAULT_ASS_FIELDS];
}

export function parseAss(text: string): RawLine[] {
  const body = (text ?? "").replace(/^\uFEFF/, "");
  if (!body.toLowerCase().includes("[events]")) return [];

  const parts = body.split(/\[events\]/i);
  if (parts.length < 2) return [];
  const eventBlock = parts[1];

  const fields = eventsFields(eventBlock);
  const indexOf = new Map<string, number>();
  fields.forEach((name, position) => indexOf.set(name, position));
  const textAt = indexOf.get("text") ?? fields.length - 1;

  const lines: RawLine[] = [];
  for (const raw of eventBlock.split("\n")) {
    if (!raw.trim().toLowerCase().startsWith("dialogue:")) continue;
    // Text 是最后一列且本身可能含逗号，所以只能限次分割
    const afterPrefix = raw.slice(raw.indexOf(":") + 1);
    const columns = splitCommaLimited(afterPrefix, fields.length - 1);
    if (columns.length <= textAt) continue;

    const pick = (name: string, fallback = ""): string => {
      const position = indexOf.get(name);
      if (position === undefined || position >= columns.length) return fallback;
      return columns[position].trim();
    };

    const style = pick("style");
    if (isKaraokeStyle(style)) continue;

    const content = stripTags(columns[textAt]);
    if (!looksLikeText(content)) continue;

    const startMs = parseTimestamp(pick("start"));
    const endMs = parseTimestamp(pick("end"));
    if (endMs <= startMs) continue;

    lines.push({ style, startMs, endMs, text: content, speaker: pick("name"), extra: {} });
  }
  return lines;
}

/** JS 的 split 不做次数限制，这里自己实现一遍 s.split(",", maxSplit)。 */
function splitCommaLimited(value: string, maxSplit: number): string[] {
  const result: string[] = [];
  let remaining = value;
  while (result.length < maxSplit) {
    const at = remaining.indexOf(",");
    if (at < 0) break;
    result.push(remaining.slice(0, at));
    remaining = remaining.slice(at + 1);
  }
  result.push(remaining);
  return result;
}

// ── .srt / .vtt ───────────────────────────────────────────────────────────

export function parseSrt(text: string): RawLine[] {
  const body = normalizeNewlines((text ?? "").replace(/^\uFEFF/, ""));
  const lines: RawLine[] = [];
  for (const block of body.split(/\n\s*\n/)) {
    const match = SRT_BLOCK_RE.exec(block);
    if (!match) continue;
    const content = stripTags(block.slice(match.index + match[0].length));
    if (!looksLikeText(content)) continue;
    const startMs = parseTimestamp(match[1]);
    const endMs = parseTimestamp(match[2]);
    if (endMs <= startMs) continue;
    lines.push({ style: "srt", startMs, endMs, text: content, speaker: "", extra: {} });
  }
  return lines;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// ── .lrc（歌词） ──────────────────────────────────────────────────────────

/**
 * LRC 歌词解析。
 *
 * 歌词和字幕只差一件事，但很要命：**歌词只标了每句开始唱的时间，没有结束
 * 时间**。补齐的办法是拿「下一个更晚的时间点」当结束时间。两条实测细节都不能省：
 *
 *  · 「下一个时间点」不是「下一行」：同一时间戳上的多行（日文原句 + 中文翻译）
 *    要共用同一个结尾，互相当边界会算出 0 秒，两边都被丢掉；
 *  · 没有文字的时间戳行也得算进时间点：[00:05.800] 后面什么都没有，
 *    这是歌词文件用来标「这里有个空隙」的写法。它不生成卡片，但它是上一句的
 *    结束点 —— 不算进去的话，上一句会一路延到下一句开始，中间十几秒空白全被
 *    吃进切片。
 *
 * 语种在解析阶段就按行内文字分流到两个样式名（有假名走日文、只有汉字走中文）。
 * 共用一个样式名的话，投票会把中文行算进日文，那些行就变成一张张只有中文的卡片。
 */
export function parseLrc(text: string): RawLine[] {
  let offset = 0;
  const boundaries = new Set<number>();
  const entries: Array<{ start: number; content: string }> = [];
  const seen = new Set<string>();

  for (const raw of normalizeNewlines((text ?? "").replace(/^\uFEFF/, "")).split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const meta = LRC_META_RE.exec(line);
    if (meta) {
      if (meta[1].toLowerCase() === "offset") offset = lrcOffset(meta[2]);
      continue;
    }

    const stamps = [...line.matchAll(LRC_STAMP_RE)];
    if (stamps.length === 0) {
      // 没有时间点的行不是歌词。整份都没有时间码的话这里返回空列表，
      // 由上层给出「没有时间轴」的结论 —— 纯文本歌词就是这么被挡住的。
      continue;
    }

    const starts = stamps.map((stamp) =>
      Math.max(lrcMilliseconds(stamp[1], stamp[2], stamp[3] ?? "") - offset, 0),
    );
    for (const start of starts) boundaries.add(start);

    const content = stripTags(line.replace(LRC_STAMP_RE, "").replace(LRC_WORD_STAMP_RE, ""));
    if (!looksLikeText(content)) continue;

    for (const start of starts) {
      const key = `${start}|${content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ start, content });
    }
  }

  if (entries.length === 0) return [];

  entries.sort((a, b) => a.start - b.start);
  const timepoints = [...boundaries].sort((a, b) => a - b);
  const following = new Map<number, number>();
  for (let i = 0; i < timepoints.length - 1; i += 1) {
    following.set(timepoints[i], timepoints[i + 1]);
  }

  const lines: RawLine[] = [];
  for (const entry of entries) {
    // 最后一句没有下一句可顶，给一个上限长度
    const next = following.get(entry.start) ?? entry.start + MAX_LYRIC_MS;
    const endMs = Math.min(next, entry.start + MAX_LYRIC_MS);
    if (endMs - entry.start < MIN_LYRIC_MS) continue;
    lines.push({
      style: hasKana(entry.content) ? LYRIC_STYLE : LYRIC_ZH_STYLE,
      startMs: entry.start,
      endMs,
      text: entry.content,
      speaker: "",
      extra: {},
    });
  }
  return lines;
}

// ── 语种判别与配对 ────────────────────────────────────────────────────────

/**
 * 处理「日文和中文压在同一条字幕里」的情况。
 *
 * 两种写法都要认：
 *  · 上下两行 —— 一个样式里用换行把两种语言叠起来；
 *  · 同一行用斜杠隔开 —— 网上流传的双语歌词大多是这种写法。
 *    只认上下两行的话，中文会被当成日文原文的一部分，卡片上的译文栏一片空白。
 *
 * 判定依据不是分隔符本身，而是两侧的语种：一边有假名、另一边只有汉字。
 */
export function splitBilingual(text: string): { ja: string; zh: string } | null {
  let parts = (text ?? "")
    .split("\n")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length < 2) {
    parts = (text ?? "")
      .split(INLINE_SPLIT_RE)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  if (parts.length !== 2) return null;

  const kanaParts = parts.filter((part) => hasKana(part));
  const hanziParts = parts.filter((part) => !hasKana(part) && hasCjk(part));
  if (kanaParts.length === 1 && hanziParts.length === 1) {
    return { ja: kanaParts[0], zh: hanziParts[0] };
  }
  return null;
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * 给每句日文配上最合适的中文 —— 时间轴重叠最多的那条。
 *
 * 没有重叠时退一步找时间上最接近的，但偏差超过容忍度就不配，宁可留空也不配错。
 *
 * 结构上是泛型的：文件内配对（一个文件里日中两种样式）和跨文件配对
 * （日语、中文各自一份文件）用的是同一套逻辑。日文侧只需要时间轴，
 * 中文侧还要有文本，所以拆成两个泛型参数。
 */
export function pairByTime<J extends { startMs: number; endMs: number }>(
  japanese: readonly J[],
  chinese: readonly { startMs: number; endMs: number; text: string }[],
): Map<number, string> {
  const pairs = new Map<number, string>();
  const used = new Set<number>();

  japanese.forEach((jaLine, position) => {
    let bestIndex: number | null = null;
    let bestScore = 0;
    chinese.forEach((zhLine, offset) => {
      if (used.has(offset)) return;
      const score = overlap(jaLine.startMs, jaLine.endMs, zhLine.startMs, zhLine.endMs);
      if (score > bestScore) {
        bestIndex = offset;
        bestScore = score;
      }
    });

    if (bestIndex === null) {
      // 退而求其次：起点最接近，且整体偏移在容忍范围内
      let nearest: number | null = null;
      let distance: number | null = null;
      chinese.forEach((zhLine, offset) => {
        if (used.has(offset)) return;
        const gap = Math.abs(zhLine.startMs - jaLine.startMs);
        if (gap <= PAIR_TOLERANCE_MS && (distance === null || gap < distance)) {
          nearest = offset;
          distance = gap;
        }
      });
      bestIndex = nearest;
    }

    if (bestIndex !== null) {
      used.add(bestIndex);
      pairs.set(position, chinese[bestIndex].text);
    }
  });

  return pairs;
}

/**
 * 整份（或一段）原始字幕行是什么语种 —— 用来决定「日语一份、中文一份」时
 * 谁出句子、谁出翻译。
 *
 * 判据和样式投票一致：有假名的行占比够高就是日文。阈值取三成而不是五成，
 * 因为日文字幕里纯汉字短句比想象中多（人名、招牌、口头禅），取五成容易误伤；
 * 中文字幕则是整份一个假名都没有，三成的阈值完全分得开。
 */
export function languageOfLines(lines: readonly RawLine[]): "ja" | "zh" {
  if (lines.length === 0) return "zh";
  const kanaLines = lines.filter((line) => hasKana(line.text)).length;
  return kanaLines / lines.length >= 0.3 ? "ja" : "zh";
}

/**
 * 一份字幕里**含有哪几门语言** —— 导入弹窗拿它出角标、出「缺哪门」的提醒。
 *
 * 判定和解析端（`styleLanguages`）同源，三种双语排版都要认成「中日都有」：
 *  1. 一行里中日各半（双语合并版，`splitBilingual` 的活儿）；
 *  2. 一个文件两条样式轨（字幕组 ASS：Dial_JP 一轨日文、Dial_CH 一轨中文）——
 *     按样式投票；只看整份假名占比的话，这种文件假名行约一半，
 *     会被误判成「纯日文」，弹「没检测到中文字幕」吓用户
 *     （实测 MyGO 双语 ASS 就这样，其实中文轨占 53%）；
 *  3. 一个样式里的两轨（两轨合并版 SRT，`styleLanguages` 的 dual，
 *     靠时间轴成对认出来）。
 *
 * 投票不出（无样式信息或占比不典型）时退回整份行级判断。
 */
export function containsLanguages(lines: readonly RawLine[]): { ja: boolean; zh: boolean } {
  if (lines.length === 0) return { ja: false, zh: false };
  const bilingual = lines.filter((line) => splitBilingual(line.text) !== null).length;
  if (bilingual / lines.length >= 0.3) return { ja: true, zh: true };

  let ja = false;
  let zh = false;
  for (const language of styleLanguages(lines).values()) {
    if (language === "ja" || language === "dual") ja = true;
    if (language === "zh" || language === "dual") zh = true;
  }
  if (ja || zh) return { ja, zh };

  const kana = lines.filter((line) => hasKana(line.text)).length;
  if (kana / lines.length >= 0.3) return { ja: true, zh: false };
  return { ja: false, zh: lines.some((line) => hasCjk(line.text)) };
}

/** 按格式把字幕文本解析成原始行（不判断语种、不配对）。 */
export function parseRawLines(text: string, format: SubtitleFormat): RawLine[] {
  if (format === "ass") return parseAss(text);
  if (format === "lrc") return parseLrc(text);
  return parseSrt(text);
}

/**
 * 这个样式里是不是「同一句话日中各一条」—— 双轨合并版的真正特征。
 *
 * 光看行级占比分不开两种长得一样的文件：两轨合并版 SRT（日中各一条、
 * 时间戳相同）和真混排 SRT（日一句中一句、时间轴错开）都是一半假名一半纯汉字。
 * 分得开的判据是时间轴：双轨的中文行起点总能找到一条偏差极小的日文行，
 * 真混排找不到（实测 3 秒起步的间隔，远超 1.5 秒容忍度）。
 * 八成的中文行都有日文同行才算 —— 放宽了会把快速对白里的纯汉字日文短句误伤。
 */
function hasTimelineTwins(lines: readonly RawLine[]): boolean {
  const kanaStarts = lines
    .filter((line) => hasKana(line.text))
    .map((line) => line.startMs)
    .sort((a, b) => a - b);
  const zhOnly = lines.filter((line) => !hasKana(line.text) && hasCjk(line.text));
  if (kanaStarts.length === 0 || zhOnly.length === 0) return false;
  let paired = 0;
  for (const line of zhOnly) {
    // kanaStarts 已排序，二分找最近的起点
    let low = 0;
    let high = kanaStarts.length - 1;
    let nearest = Infinity;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const gap = Math.abs(kanaStarts[mid] - line.startMs);
      if (gap < nearest) nearest = gap;
      if (kanaStarts[mid] < line.startMs) low = mid + 1;
      else high = mid - 1;
    }
    if (nearest <= PAIR_TOLERANCE_MS) paired += 1;
  }
  return paired / zhOnly.length >= 0.8;
}

/**
 * 按样式整体判断语种。
 *
 * 不能逐行看假名：日语里「大丈夫」「一生」这类纯汉字短句一个假名都没有，
 * 逐行判断会被当成中文（实测因此丢掉 7 条真台词）。而同一个样式下的语种
 * 是一致的（字幕组不会中日混用同一个样式），所以先按样式投票，
 * 投不出结果时才回退到逐行判断。
 *
 * 「dual」是**同一样式里的两轨**：日中各一条、时间戳几乎相同、样式名相同 ——
 * 两轨合并版 SRT 就长这样。假名行和纯汉字行各占三成以上**且时间轴成对**
 * 时才按 dual 处理；光看占比不行 —— 真混排 SRT 占比和它一模一样，
 * 而日文样式里三成纯汉字短句（快速对白）也不罕见，单看占比会把
 * 「大丈夫」这样的日文原句拆去中文轨（老用例防的就是这个）。
 */
function styleLanguages(rawLines: readonly RawLine[]): Map<string, string> {
  const buckets = new Map<string, RawLine[]>();
  for (const line of rawLines) {
    const bucket = buckets.get(line.style) ?? [];
    bucket.push(line);
    buckets.set(line.style, bucket);
  }

  const languages = new Map<string, string>();
  for (const [style, lines] of buckets) {
    const kanaLines = lines.filter((line) => hasKana(line.text)).length;
    const cjkLines = lines.filter((line) => hasCjk(line.text)).length;
    const zhOnlyLines = lines.filter((line) => !hasKana(line.text) && hasCjk(line.text)).length;
    const kanaRatio = kanaLines / lines.length;
    const zhOnlyRatio = zhOnlyLines / lines.length;
    if (kanaRatio >= 0.3 && zhOnlyRatio >= 0.3 && hasTimelineTwins(lines))
      languages.set(style, "dual");
    else if (kanaRatio >= 0.5) languages.set(style, "ja");
    else if (cjkLines > 0 && kanaLines === 0) languages.set(style, "zh");
    // 一个样式里中日混排（双语字幕常见），交给逐行判断
    else languages.set(style, "mixed");
  }
  return languages;
}

/** 把原始行整理成切片清单（判断语种 + 配对）。 */
export function buildCues(rawLines: RawLine[]): Cue[] {
  const styleLanguage = styleLanguages(rawLines);
  const japanese: RawLine[] = [];
  const chinese: RawLine[] = [];

  for (const line of rawLines) {
    const bilingual = splitBilingual(line.text);
    if (bilingual) {
      // 一条字幕里同时含中日文：直接成句，不用再配对
      japanese.push({
        ...line,
        text: bilingual.ja,
        extra: { ...line.extra, pairedText: bilingual.zh },
      });
      continue;
    }

    const language = styleLanguage.get(line.style) ?? "mixed";
    if (language === "ja") japanese.push(line);
    else if (language === "zh") chinese.push(line);
    else if (language === "dual") {
      // 同一样式里的两轨：有假名走日文轨，纯汉字走中文轨。
      // 纯汉字的日文短句在这种文件里会被归入中文轨 —— 没法分辨，
      // 但它的时间轴和日文原句重叠，最多被当成译文配回去，不丢内容。
      if (hasKana(line.text)) japanese.push(line);
      else if (hasCjk(line.text)) chinese.push(line);
    } else if (hasKana(line.text)) japanese.push(line);
    else if (hasCjk(line.text)) chinese.push(line);
  }

  const pairs = pairByTime(japanese, chinese);

  const cues: Cue[] = japanese.map((line, position) => {
    const paired = line.extra?.pairedText;
    const zh = typeof paired === "string" && paired ? paired : pairs.get(position) ?? "";
    return {
      index: position + 1,
      startMs: line.startMs,
      endMs: line.endMs,
      ja: line.text,
      zh,
      style: line.style,
      speaker: line.speaker,
      extra: line.extra,
    };
  });

  cues.sort((a, b) => (a.startMs - b.startMs) || (a.endMs - b.endMs));
  cues.forEach((cue, position) => {
    cue.index = position + 1;
  });
  return cues;
}

// ── 主入口 ────────────────────────────────────────────────────────────────

export type SubtitleFormat = "ass" | "srt" | "vtt" | "lrc";

export function detectFormat(nameOrPath: string): SubtitleFormat | null {
  const lowered = (nameOrPath ?? "").toLowerCase();
  if (lowered.endsWith(".ass") || lowered.endsWith(".ssa")) return "ass";
  if (lowered.endsWith(".srt")) return "srt";
  if (lowered.endsWith(".vtt")) return "vtt";
  if (lowered.endsWith(".lrc")) return "lrc";
  return null;
}

/** 按格式解析文本为切片清单。 */
export function extractCuesFromText(text: string, format: SubtitleFormat): Cue[] {
  const rawLines =
    format === "ass"
      ? parseAss(text)
      : format === "lrc"
        ? parseLrc(text)
        : parseSrt(text);
  return buildCues(rawLines);
}

/**
 * 解析质量自检 —— 用来判断「这份字幕能不能用来学」。
 *
 * 没有中文的行占比过高，说明语种判别或配对出了问题，值得人工看一眼。
 */
export function cueStats(cues: Cue[]): {
  total: number;
  withoutTranslation?: number;
  translationRatio?: number;
  avgDurationMs?: number;
  shortestMs?: number;
  longestMs?: number;
} {
  const total = cues.length;
  if (total === 0) return { total: 0 };
  const withoutZh = cues.filter((cue) => !cue.zh).length;
  const durations = cues.map((cue) => Math.max(cue.endMs - cue.startMs, 0));
  return {
    total,
    withoutTranslation: withoutZh,
    translationRatio: Math.round((1 - withoutZh / total) * 1000) / 1000,
    avgDurationMs: Math.round(durations.reduce((sum, value) => sum + value, 0) / total),
    shortestMs: Math.min(...durations),
    longestMs: Math.max(...durations),
  };
}
