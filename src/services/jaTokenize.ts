/**
 * 日语分词（本地，离线）。
 *
 * 词表结构逐字段对齐服务端 `ja_morph.tokenize()`（见 types/entities.ts 的 Token），
 * 这样同一句话在两端的形态一致，将来同步/对照不会互相打架。
 *
 * 用 kuromoji（IPADIC）在**插件进程里**跑：发音、词性、原形都能拿到，
 * 不需要联网、不需要用户装 Python。
 *
 * ⚠️ 词典是**运行时**读的（`dict/` 目录，构建时从 node_modules 同步过来），
 * 所以这个模块不能只靠 main.js 工作 —— 发布包必须带 dict/（见 scripts/sync-dict.mjs）。
 *
 * 词典给不了中文释义（IPADIC 是日文词典），释义要么来自剧集词条记忆，
 * 要么由用户开启 AI 后补 —— 所以 Token.def 这里留空，由调用方决定怎么填。
 */

import type { PartOfSpeech, Token } from "../types/entities";
// 实现已下沉到 `core/jaText.ts`（与身份 hash、比对层共用同一份）；这里引入并转发，
// 保持本模块既有的 `katakanaToHiragana` 导出与所有调用点不变。
import { katakanaToHiragana } from "../core/jaText";

export { katakanaToHiragana };

/** 平假名 → 罗马音。只覆盖日语里真正用得上的音，长音符号与 っ 单独处理。 */
const KANA_ROMAJI: Record<string, string> = {
  あ: "a", い: "i", う: "u", え: "e", お: "o",
  か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko",
  が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go",
  さ: "sa", し: "shi", す: "su", せ: "se", そ: "so",
  ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo",
  た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to",
  だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do",
  な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no",
  は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho",
  ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo",
  ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po",
  ま: "ma", み: "mi", む: "mu", め: "me", も: "mo",
  や: "ya", ゆ: "yu", よ: "yo",
  ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro",
  わ: "wa", ゐ: "i", ゑ: "e", を: "o", ん: "n",
  ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o",
  ゃ: "ya", ゅ: "yu", ょ: "yo", ゎ: "wa",
  ゔ: "vu", ー: "",
};

/** 拗音：两个字一起才有正确读音。 */
const YOON: Record<string, string> = {
  きゃ: "kya", きゅ: "kyu", きょ: "kyo", ぎゃ: "gya", ぎゅ: "gyu", ぎょ: "gyo",
  しゃ: "sha", しゅ: "shu", しょ: "sho", じゃ: "ja", じゅ: "ju", じょ: "jo",
  ちゃ: "cha", ちゅ: "chu", ちょ: "cho", ぢゃ: "ja", ぢゅ: "ju", ぢょ: "jo",
  にゃ: "nya", にゅ: "nyu", にょ: "nyo", ひゃ: "hya", ひゅ: "hyu", ひょ: "hyo",
  びゃ: "bya", びゅ: "byu", びょ: "byo", ぴゃ: "pya", ぴゅ: "pyu", ぴょ: "pyo",
  みゃ: "mya", みゅ: "myu", みょ: "myo", りゃ: "rya", りゅ: "ryu", りょ: "ryo",
};

/**
 * typing 口径的**单字**例外：这些假名的注音 ≠ 键序——照着注音敲会出别的假名
 * （敲 o 出来是 お，永远出不了 を）。display 照旧。
 */
const TYPING_KANA: Record<string, string> = {
  を: "wo", ぢ: "di", づ: "du", ゐ: "wi", ゑ: "we", ゎ: "xwa",
  ー: "-",
};

/**
 * typing 口径的拗音/小假名组合：两字一起敲才出目标假名（てぃ 敲 tei 会变 てい）。
 * ぢゃ/ぢゅ/ぢょ 也要覆盖——敲 ja 出来是 じゃ 不是 ぢゃ。
 */
const TYPING_YOON: Record<string, string> = {
  ぢゃ: "dya", ぢゅ: "dyu", ぢょ: "dyo",
  てぃ: "thi", てゅ: "thu", でぃ: "dhi", でゅ: "dhu", とぅ: "twu", どぅ: "dwu",
  ふぁ: "fa", ふぃ: "fi", ふぇ: "fe", ふぉ: "fo", ふゅ: "fyu",
  うぃ: "wi", うぇ: "we", うぉ: "wo",
  しぇ: "she", じぇ: "je", ちぇ: "che",
  つぁ: "tsa", つぃ: "tsi", つぇ: "tse", つぉ: "tso",
  いぇ: "ye",
  ゔぁ: "va", ゔぃ: "vi", ゔぇ: "ve", ゔぉ: "vo",
};

const YOON_BY_MODE = { display: YOON, typing: { ...YOON, ...TYPING_YOON } };
const KANA_BY_MODE = { display: KANA_ROMAJI, typing: { ...KANA_ROMAJI, ...TYPING_KANA } };

/**
 * display 口径的**读音特例**：助词 は/へ 读 wa/e（Hepburn 正字）。IPADIC 还把
 * 接续词「では」整个收成一词（不是 で+は 两个助词），一并放行 —— では→dewa。
 * 只认整词读音恰好是表里的假名 —— 词内的 は（はやし、はし）吃不到。
 * typing 口径不吃这套：键序就是 ha/he，照着敲才出得来。顶部注音（怎么读）和
 * 抄写提示（怎么敲）是两个口径，这里只动前者。
 */
const DISPLAY_READING_ROMAJI: Record<string, string> = { は: "wa", へ: "e", では: "dewa" };

/**
 * 单词层的罗马音：带词性上下文，display 口径下助词 は/へ（和接续词 では）
 * 走 wa/e 特例。裸假名串没有词性，走 `kanaToRomaji`。
 */
export function tokenRomaji(
  reading: string,
  pos: PartOfSpeech | undefined,
  mode: "display" | "typing" = "display",
): string {
  if (mode === "display" && (pos === "particle" || pos === "conj")) {
    const special = DISPLAY_READING_ROMAJI[katakanaToHiragana(reading)];
    if (special) return special;
  }
  return kanaToRomaji(reading, mode);
}

/**
 * 假名 → 罗马音，两种口径：
 *  - **display**（默认）：读音注音，Hepburn 风格，给人看——を→o、ん 的分音撇号。
 *    单词解析、笔记用这份；
 *  - **typing**：IME 键序，给抄写提示用——**照着敲出来的假名必须等于目标假名**
 *    （を→wo、ぢ→di、ー→"-"、ん 不带撇号）。
 * は/へ 现表就是 ha/he：typing 口径敲出来正好；display 口径下助词 は/へ 的 wa/e
 * 特例挂不住这里 —— 单看一串假名分不清是助词还是词内假名（端、はし），得靠词性，
 * 在单词层的 `tokenRomaji` 里做。
 */
export function kanaToRomaji(kana: string, mode: "display" | "typing" = "display"): string {
  const hira = katakanaToHiragana(kana).replace(/[・\s]/gu, "");
  const yoon = YOON_BY_MODE[mode];
  const single = KANA_BY_MODE[mode];
  let out = "";
  for (let index = 0; index < hira.length; index += 1) {
    const pair = hira.slice(index, index + 2);
    if (yoon[pair]) {
      out += yoon[pair];
      index += 1;
      continue;
    }
    const char = hira[index];
    if (char === "っ") {
      // 促音：把后一个音的首字母重复一遍（っ + た → tta）
      const next = yoon[hira.slice(index + 1, index + 3)] ?? single[hira[index + 1]] ?? "";
      out += next.slice(0, 1);
      continue;
    }
    if (char === "ん") {
      if (mode === "typing") {
        // 键序不带撇号——那是给人看的分音符号，敲进去会变成字面字符
        out += "n";
        continue;
      }
      // ん 后面跟元音或 y 时用撇号分隔，免得连成一个音节（しんいち → shin'ichi）
      const next = hira[index + 1] ?? "";
      out += /^[あいうえおやゆよ]/u.test(next) ? "n'" : "n";
      continue;
    }
    out += single[char] ?? char;
  }
  return out;
}

/**
 * 一串词**按词**转罗马音 —— 和挨个调 `kanaToRomaji` 的区别是：它看得见邻居。
 *
 * 为什么非得有这一层：kuromoji 会把「やった」切成 **やっ + た** 两个词，而
 * `kanaToRomaji` 是单串转换 —— やっ 走到 っ 时已经在字符串末尾，取不到下一个音的
 * 首字母，促音的双写就整段丢了（ya + ta = **yata**，照着敲出来是 やた，正好教错）。
 * 这里在转完之后回看一眼：**前一个词的读音以 っ 结尾**时，把后一个词的首字母
 * 双写到它头上（ya / tta / no）—— 连起来照着敲正好是 yatta。
 *
 * 🔥 双写归**后一个词**（而不是补在前一个词尾巴上）是刻意的：促音在书写上属于
 * 后一个音节，`tta` 一眼能看出「这里要连敲两下 t」；补成 `yat` 看着像 やと。
 *
 * 单词层的数据（`toToken` 的 `Token.romaji`）不走这里 —— 那是一个词一条记录，
 * 本就没有"下一个词"，落库口径要改得单独定。
 *
 * 条目可以只给读音串（老用法，无词性、没有助词特例），也可以给
 * `{ reading, pos }`—— display 口径下助词 は/へ 就近标成 wa/e。
 */
export interface RomajiEntry {
  reading: string;
  /** 词性：display 口径下助词 は/へ 标 wa/e；省略按普通词转。 */
  pos?: PartOfSpeech;
}

export function romajiTokens(
  entries: readonly (string | RomajiEntry)[],
  mode: "display" | "typing" = "display",
): string[] {
  const readings = entries.map((entry) => (typeof entry === "string" ? entry : entry.reading));
  const out = entries.map((entry) =>
    typeof entry === "string" ? kanaToRomaji(entry, mode) : tokenRomaji(entry.reading, entry.pos, mode),
  );
  for (let i = 1; i < out.length; i += 1) {
    // 前一个词的读音以促音收尾 —— 它的双写只能落在下一个词头上
    if (!katakanaToHiragana(readings[i - 1] ?? "").endsWith("っ")) continue;
    const head = out[i].slice(0, 1);
    // 只双写辅音：后一个词若是符号 / 没读音的汉字（原样透传）或元音开头
    // （っ 后面不接元音行，那是句末的「あっ！」之类），双写等于把字敲错。
    if (!/^[bcdfghjkmnprstvwxyz]$/u.test(head)) continue;
    out[i] = head + out[i];
  }
  return out;
}

/** kuromoji 的词性 → 我们的 PartOfSpeech（口径与服务端 ja_morph 一致）。 */
export function mapPartOfSpeech(pos: string, detail1: string, detail2 = ""): PartOfSpeech {
  switch (pos) {
    case "名詞":
      if (detail1 === "固有名詞") return "proper";
      if (detail1 === "代名詞") return "pron";
      if (detail1 === "接尾") return "suffix";
      if (detail1 === "非自立" || detail2 === "助数詞") return "other";
      return "noun";
    case "動詞":
      // 動詞,非自立 是「〜てしまう」这类补助动词，按助动词口径处理
      return detail1 === "非自立" ? "aux" : "verb";
    case "形容詞":
      return detail1 === "非自立" ? "aux" : "adj";
    case "形容動詞":
      return "adj";
    case "副詞":
      return "adv";
    case "助詞":
      return "particle";
    case "助動詞":
      return "aux";
    case "接続詞":
      return "conj";
    case "接頭詞":
      return "prefix";
    case "記号":
      return "punct";
    default:
      // 連体詞 / 感動詞 / フィラー / その他
      return "other";
  }
}

/** kuromoji 的原始 token → 我们的 Token（纯函数，好测）。 */
export function toToken(raw: {
  surface_form: string;
  basic_form: string;
  reading?: string;
  pronunciation?: string;
  pos: string;
  pos_detail_1: string;
  pos_detail_2: string;
}): Token {
  const reading = raw.reading && raw.reading !== "*" ? katakanaToHiragana(raw.reading) : "";
  const surface = raw.surface_form;
  const lemma = raw.basic_form && raw.basic_form !== "*" ? raw.basic_form : surface;
  const pos = mapPartOfSpeech(raw.pos, raw.pos_detail_1, raw.pos_detail_2);
  // 读音缺失（符号/未知词）就拿原词自己转，至少跟读时有个念法
  const romaji = tokenRomaji(reading || surface, pos);
  return {
    surface,
    lemma,
    reading,
    romaji,
    pos,
    def: "",
    meaningSource: "",
  };
}

// ── kuromoji 实例（懒加载 + 单例） ─────────────────────────────────────────

interface RawToken extends Record<string, unknown> {
  surface_form: string;
  basic_form: string;
  pos: string;
  pos_detail_1: string;
  pos_detail_2: string;
}

interface Tokenizer {
  tokenize(text: string): RawToken[];
}

let cached: Promise<Tokenizer> | null = null;

/** 是否已经具备分词能力（界面用它决定显示词表还是提示）。 */
export function hasTokenizer(): boolean {
  return cached !== null;
}

/**
 * 懒加载分词器。失败（词典缺失）返回 null，界面据此给一句人话提示，
 * 而不是抛异常把整个学习页打断。
 */
export async function ensureTokenizer(dictPath: string): Promise<Tokenizer | null> {
  if (!cached) {
    // 缓存的是**失败的 null**，所以下一次调用会重试 —— 词典后装上来也能恢复
    cached = new Promise<Tokenizer>((resolve, reject) => {
      // 懒加载：kuromoji 是 CJS 且要用 fs 读词典，必须留在 Node 侧按需引入
      import("kuromoji")
        .then((module) => {
          const kuromoji = (module as unknown as { default?: unknown }).default ?? module;
          (
            kuromoji as {
              builder(options: { dicPath: string }): {
                build(callback: (error: Error | null, tokenizer: Tokenizer) => void): void;
              };
            }
          )
            .builder({ dicPath: dictPath })
            .build((error, tokenizer) => (error ? reject(error) : resolve(tokenizer)));
        })
        .catch(reject);
    }).catch(() => {
      cached = null;
      return null as unknown as Tokenizer;
    });
  }
  const tokenizer = await cached;
  return tokenizer ?? null;
}

/** 一句话 → 词表。分词器不可用或出错时返回空数组（界面自己决定说什么）。 */
export async function tokenize(dictPath: string, text: string): Promise<Token[]> {
  const tokenizer = await ensureTokenizer(dictPath);
  if (!tokenizer || !text.trim()) return [];
  try {
    return tokenizer.tokenize(text).map((raw) => toToken(raw));
  } catch {
    return [];
  }
}

/**
 * 「这句话要让 AI 解释哪些词」——**除标点外全部**。
 *
 * 口径与服务端 `learning.services.sentence_llm.target_indexes()` 一致，
 * 两端各有一份实现（一边 TS 一边 Python），改一处要改两处：
 * 实词给词义、含汉字的词给读音、助词/助动词给它在句中的作用 —— 用户要的是
 * **每个词都有释义**，漏一个他就能看出来（"每次都漏词"就是这么来的）。
 *
 * 标点不给：没有可解释的内容，列出来只是噪音，还白白多花 token。
 */
export function explainTargets(tokens: Token[]): string[] {
  return tokens.filter((token) => token.pos !== "punct").map((token) => token.surface);
}
