/**
 * 抄写判定（本地版）。
 *
 * 逐层对齐服务端 `core/learning/services/study.py::compare_copy`，四层从严到宽：
 *   1. 一模一样（归一化后）→ correct
 *   2. 等于原句的假名读音 → kana（原句写汉字、敲成「あした」也算过）
 *   3. 逐词摊成读音后对得上 → kana（反过来：原句写假名、敲成「人気者」也算过）
 *   4. 都对不上 → wrong，给 LCS 逐字对照 + 准确率 +「漏了/多了」提示
 *
 * 第 3 层要查「这个字面还能读成什么」的词典背书（见 kanjiReadingIndex）：
 * 没有背书就不认，否则就成了"读音差不多就算对"，敲错的假名会被放过去。
 *
 * ⚠️ **判定通过（correct / kana）时 `ops` 一律为空。** 宽容层放过的写法（全角
 * 「１」敲成汉字「一」、汉字敲成假名）逐字对不上，照原样返回就是一行红字加上
 * 「漏了 1 / 多敲了 一」—— 顶着 100% 的准确率告诉用户"你敲错了"。结论是「对」，
 * 展示就得跟着结论走（见 views/study/practices.ts::renderResult）。
 *
 * 分词器由调用方注入（`CopyTokenize`）—— 它要读磁盘词典、是异步的，只有界面
 * 那边知道路径；拿不到就退回纯字面判定（第 1、4 层），不影响敲错也能标红。
 *
 * ⚠️ 归一化、数字折写法与 LCS 的行为必须与 Python 版逐字符一致，改任何一边都要
 * 跑 `core/learning/tests/test_services.py::CopyComparisonTests` 同组的用例
 * （见 tests/copyCheck.test.ts）。
 */

import { katakanaToHiragana } from "./jaTokenize";
import type { Token } from "../types/entities";

export type CopyOp = {
  op: "ok" | "missing" | "extra";
  expected: string;
  actual: string;
};

export type CopyResult = {
  /** correct：跟原句一模一样；kana：读音对、写法用了别的；wrong：没对上 */
  level: "correct" | "kana" | "wrong" | "empty";
  ok: boolean;
  accuracy: number;
  /** 逐字对照，**只在判错时有内容**：通过时为空数组（宽容放过的写法不该被标红） */
  ops: CopyOp[];
  hint: string;
};

/**
 * 抄写时这些字符不参与比对：标点、引号、空格在敲字时没有区分意义，
 * 把它们算成错会让人很挫败。直接映射成空串（不能级联替换）。
 * 「ー」（长音符）不在清理范围：它是假名的一部分，少了它就不是一个词了。
 */
const PUNCT_CHARS =
  "。、，．.,！!？?：:；;「」『』（）()[]【】〔〕・…‥～〜~\"'\u201C\u201D\u2018\u2019－\u2014\u2013-\u3000";
// 类内特殊字符（- ] \ ^）一律转义，别让「-」在中段变成区间
const PUNCT_RE = new RegExp(`[${PUNCT_CHARS.replace(/[-\]\\^]/gu, "\\$&")}]`, "gu");

/** 抄写比对的归一化：全角转半角、去掉标点与空白。 */
export function normalizeForCopy(text: string): string {
  return (text ?? "")
    .normalize("NFKC")
    .replace(PUNCT_RE, "")
    .replace(/\s+/gu, "");
}

/**
 * 「写法不同、念法相同」的单个数字算同一个字：一 ↔ 1、三 ↔ 3 …
 *
 * 敲「一日」和敲「1日」是一回事，判错只会让人以为要背字幕的写法。
 * 只收单个数字 —— 它们在哪种上下文里都是同一个值。十百千万**不收**：
 * 那是位值，逐字折会把「十一」折成「101」；那类写法交给读音层兜。
 *
 * ⚠️ 只在**字面层**折。折过的串不能喂给分词器：分词器要靠「一人」「一日」
 * 这种原样写法才知道怎么读，折成「1人」它就给不出读音了。
 */
const NUMERAL_FOLD: Record<string, string> = {
  "〇": "0", "零": "0",
  "一": "1", "二": "2", "三": "3", "四": "4", "五": "5",
  "六": "6", "七": "7", "八": "8", "九": "9",
};
const NUMERAL_RE = new RegExp(`[${Object.keys(NUMERAL_FOLD).join("")}]`, "gu");

/** 字面比对用：normalizeForCopy 之后再折一层数字写法（一 ↔ 1）。 */
export function normalizeForLiteral(text: string): string {
  return normalizeForCopy(text).replace(NUMERAL_RE, (char) => NUMERAL_FOLD[char] ?? char);
}

/**
 * 按最长公共子序列对齐，返回逐字对照。
 *
 * 不用简单的按位置比较 —— 那样少敲一个字，后面全部标红，用户看不出真正
 * 错在哪。LCS 能区分"漏了一个字"和"这个字敲错了"。句子都很短（几十字符），
 * O(n×m) 足够快。
 */
export function diffCharacters(expected: string, typed: string): CopyOp[] {
  const a = Array.from(expected);
  const b = Array.from(typed);
  const n = a.length;
  const m = b.length;

  // dp[i][j] = a[i:] 与 b[j:] 的最长公共子序列长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: CopyOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: "ok", expected: a[i], actual: b[j] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ op: "missing", expected: a[i], actual: "" });
      i += 1;
    } else {
      ops.push({ op: "extra", expected: "", actual: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ op: "missing", expected: a[i], actual: "" });
    i += 1;
  }
  while (j < m) {
    ops.push({ op: "extra", expected: "", actual: b[j] });
    j += 1;
  }
  return ops;
}

/** 这句话里有没有汉字。 */
export function hasKanji(text: string): boolean {
  return /[\p{Script=Han}]/u.test(text ?? "");
}

function problemCount(ops: readonly CopyOp[]): number {
  return ops.filter((op) => op.op !== "ok").length;
}

// ── 读音宽容层 ────────────────────────────────────────────────────────────

/**
 * 分词口子：把一句切成词。由调用方注入 —— copyCheck 是纯函数模块（好测），
 * 而分词器要读磁盘上的词典、是异步的，只有界面那边知道路径。
 * 词典没装上时传 null，判定退回字面层。
 */
export type CopyTokenize = (text: string) => Promise<Token[]>;

/** 一个词：字面 + 它的假名读音。 */
export type KanaPiece = readonly [surface: string, kana: string];

/**
 * 分词结果 → （整句假名, 逐词片段）。
 * 没有读音的词素（数字、拉丁字母、长音符）用字面占位 —— 它得占住位置，
 * 否则原句里同样位置的字符就对不上了。
 */
export function kanaView(tokens: readonly Token[]): { kana: string; pieces: KanaPiece[] } {
  const pieces: KanaPiece[] = tokens.map((token) => [
    token.surface,
    token.reading || katakanaToHiragana(token.surface),
  ]);
  return {
    kana: katakanaToHiragana(pieces.map((piece) => piece[1]).join("")),
    pieces,
  };
}

/**
 * 「这个字面还能读成什么」—— 宽容的唯一来源。
 *
 * 服务端查的是 Dictionary 表；插件没有那张表，用本地分词器顶：kuromoji 的
 * IPADIC 本身就是词典，单独切一个词时给的是它在别处也成立的读法
 * （「者」单切读 もの，在「人気者」里读 しゃ —— 两条都算数）。
 *
 * 一个汉字往往不止一种读法，而分词器只给上下文里的那一种，这一步补的就是另一半。
 * 没有背书就不认 —— 绝不退化成"读音差不多就算对"。
 */
async function kanjiReadingIndex(
  tokenize: CopyTokenize,
  pieces: readonly KanaPiece[],
): Promise<Map<string, readonly string[]>> {
  const index = new Map<string, readonly string[]>();
  for (const [surface] of pieces) {
    if (index.has(surface) || !hasKanji(surface)) continue;
    const tokens = await tokenize(surface);
    index.set(surface, tokens.map((token) => token.reading).filter(Boolean));
  }
  return index;
}

/**
 * 用户敲的东西能不能逐词贴着原句的读音走到底。
 *
 * 每个词要么读音直接相等，要么是「词典承认这个字面读这个音」。
 * 缺词、多词、读音不同又没背书的，一律不放过 —— 所以这不是模糊匹配，
 * 把错的假名放过去是不可能的。
 *
 * 为什么要先分词：同一个汉字在不同词里读音不同（「者」读 しゃ 也读 もの），
 * 得先知道它在**用户敲的那个词里**应该怎么读，才知道能不能放过这一段。
 * 用 DFS 是因为同一段读音可能有好几种切法，回溯找得到任何一条路就算过。
 */
export function readingsLineUp(
  pieces: readonly KanaPiece[],
  targetKana: string,
  readingsOf: (surface: string) => readonly string[],
): boolean {
  const total = targetKana.length;
  const stack: Array<readonly [number, number]> = [[0, 0]];
  const seen = new Set<string>();
  while (stack.length) {
    const [index, pos] = stack.pop() as readonly [number, number];
    const key = `${index}:${pos}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (index === pieces.length) {
      if (pos === total) return true;
      continue;
    }
    const [surface, kana] = pieces[index];
    if (kana && targetKana.startsWith(kana, pos)) stack.push([index + 1, pos + kana.length]);
    if (hasKanji(surface)) {
      // 长的读法先试：「にんきもの」要整段吃掉，别让「もの」这种短读法抢先
      for (const reading of [...readingsOf(surface)].sort((a, b) => b.length - a.length)) {
        if (reading && targetKana.startsWith(reading, pos)) stack.push([index + 1, pos + reading.length]);
      }
    }
  }
  return false;
}

/**
 * 读音对、写法用了别的 —— 提示要跟着方向走：该练汉字的提醒练汉字，
 * 原句本来就是假名的别反过来说。
 *
 * 不带 `ops`：判过了就不画对照（见文件头那条）。这里的差异是**写法**差异，
 * 逐字标红只会让用户以为敲错了，而"该练哪种写法"由 hint 讲清楚。
 */
function passByReading(target: string, attempt: string): CopyResult {
  let hint: string;
  if (hasKanji(target) && !hasKanji(attempt)) {
    hint = "敲对了读音。原句这里写的是汉字，试着用输入法把汉字打出来。";
  } else if (hasKanji(attempt) && !hasKanji(target)) {
    hint = "敲对了读音。原句这里写的是假名，照着字幕敲就行。";
  } else {
    hint = "敲对了读音。";
  }
  return { level: "kana", ok: true, accuracy: 1, ops: [], hint };
}

/**
 * 判断抄写结果。
 *
 * @param tokenize 本地分词口子；传 null / 省略则只走字面层（词典没装上时）。
 */
export async function compareCopy(
  expected: string,
  typed: string,
  tokenize?: CopyTokenize | null,
): Promise<CopyResult> {
  const trimmed = (typed ?? "").trim();
  if (!trimmed) {
    return { level: "empty", ok: false, accuracy: 0, ops: [], hint: "" };
  }

  const target = normalizeForCopy(expected);
  const attempt = normalizeForCopy(trimmed);

  if (normalizeForLiteral(attempt) === normalizeForLiteral(target)) {
    // ops 留空：走到这里说明**折写之后一致**（全角「１」/ 汉字「一」/ 半角「1」
    // 是同一个字），可 target / attempt 本身可能还差着符号。照字面画对照就是
    // 顶着「准确率 100%」标一处红 —— 用户以为敲错了。判定说对，展示就说到对。
    return {
      level: "correct",
      ok: true,
      accuracy: 1,
      ops: [],
      hint: "",
    };
  }

  // ── 读音宽容：两层（等于原句读音 / 逐词读音贴着走）──
  let targetKana = "";
  let attemptKana: string | null = null;
  if (tokenize) {
    targetKana = kanaView(await tokenize(target)).kana;
    const view = kanaView(await tokenize(attempt));
    attemptKana = view.kana;
    if (targetKana) {
      if (attempt === targetKana) return passByReading(target, attempt);
      const index = await kanjiReadingIndex(tokenize, view.pieces);
      if (readingsLineUp(view.pieces, targetKana, (surface) => index.get(surface) ?? [])) {
        return passByReading(target, attempt);
      }
    }
  }

  // ── 判定为错 ──
  // 输入带汉字时另按读音比一次：两种算法里取"看着更接近"的那份展示给用户，
  // 免得汉字和假名逐字对不上，准确率被压到三成、错处也标在无关的位置上。
  let ops = diffCharacters(target, attempt);
  let left = target;
  let right = attempt;
  let byReading = false;
  if (targetKana && attemptKana && attemptKana !== attempt) {
    const candidate = diffCharacters(targetKana, attemptKana);
    if (problemCount(candidate) < problemCount(ops)) {
      ops = candidate;
      left = targetKana;
      right = attemptKana;
      byReading = true;
    }
  }

  const matched = ops.filter((op) => op.op === "ok").length;
  // 分母取两者较长的一个：多敲字时用原句长度当分母会算出 100% 的准确率，
  // 而结果明明是错的，那个数字会误导人
  const denominator = Math.max(left.length, right.length);
  const accuracy = denominator ? Math.round((matched / denominator) * 1000) / 1000 : 0;

  const wrong = ops.filter((op) => op.op === "missing").length;
  const extra = ops.filter((op) => op.op === "extra").length;
  let hint: string;
  if (byReading) hint = wrong || extra ? `读音有 ${wrong + extra} 处对不上` : "再核一遍";
  else if (wrong && !extra) hint = `漏了 ${wrong} 个字`;
  else if (extra && !wrong) hint = `多了 ${extra} 个字`;
  else if (wrong || extra) hint = `有 ${wrong + extra} 处对不上`;
  else hint = "再核一遍";

  return { level: "wrong", ok: false, accuracy, ops, hint };
}