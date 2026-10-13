/**
 * 台词（日文）相似度 —— 「这是不是同一句」的判断依据。
 *
 * ## 为什么以日文为准
 *
 * 中文翻译可以多种多样（同一句日文，不同字幕组译法完全不同，甚至有漏译、
 * 意译），**日文原句的差异通常很小**：换了字幕版本多半只是标点、全角半角、
 * 长音符、或者个别假名的差别。所以判据只取 `ja`。
 *
 * ⚠️ 比对必须用 `slice.ja`（原片），**不能用 `effectiveJa`**（用户纠过的版本）：
 * 纠错是覆盖层，换字幕后它会被一起搬过去，拿它当判据等于拿自己比对自己。
 *
 * ## 档位
 *
 * 归一化实现在 `core/jaText.ts::normalizeJa`（**与切片身份 hash 共用同一份**，
 * 见那个文件头注释），**只用于比对与身份派生**，绝不写回数据：
 *   · NFKC：全角英数 → 半角（ＡＢＣ → ABC）
 *   · 去空白与标点：「。」「、」「…」「！」的有无不该影响同一句的判断
 *   · 片假名 → 平假名：「ありがとう」与「アリガトウ」是同一句的不同写法
 *   · 长音符「ー」**保留**（它是假名的一部分，去掉会把「コーヒー」折成「コヒ」）
 *
 * 相似度用 bigram Dice 系数：日语没有空格，字符级的二元组重合度对
 * 「改了中间一两个字」这种差异最敏感，也比编辑距离更抗长度抖动。
 */
// 归一化实现已下沉到 `core/jaText.ts`（身份 hash 与比对层必须共用同一口径）。
// 这里只做转发，保持 `services/jaMatch` 的既有对外 API 不变。
import { normalizeJa } from "../core/jaText";

export { normalizeJa };

/** 字符二元组（bigram）。日文不分词，按字符切；长度 < 2 时退化成整串。 */
function bigrams(text: string): string[] {
  if (text.length < 2) return text ? [text] : [];
  const out: string[] = [];
  for (let i = 0; i < text.length - 1; i += 1) out.push(text.slice(i, i + 2));
  return out;
}

/**
 * Dice 系数：`2 * |A∩B| / (|A| + |B|)`，取值 0~1。
 *
 * ⚠️ 这里**故意不抄** `bangumi.ts` 那个 `similarity`：它有一条
 * 「子串短路」分支（`longer.includes(shorter)` 直接给 96 分），拿来判断作品名
 * 没问题，比台词会出事 —— 「ありがとう」是「ありがとうございます」的前缀，
 * 短路分支会把两句完全不同的台词判成同一句。
 */
export function diceCoefficient(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 1 : 0;
  const counts = new Map<string, number>();
  for (const gram of a) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  let hits = 0;
  for (const gram of b) {
    const left = counts.get(gram) ?? 0;
    if (left > 0) {
      hits += 1;
      counts.set(gram, left - 1);
    }
  }
  return (2 * hits) / (a.length + b.length);
}

/** 归一化后完全相同 —— 最常见的「换了字幕但句子一个字没变」。 */
export function sameJa(a: string, b: string): boolean {
  const left = normalizeJa(a);
  const right = normalizeJa(b);
  return left.length > 0 && left === right;
}

/**
 * 绑得上算同一句的最低相似度（归一化后）。
 *
 * 定 0.85 的实测依据：换字幕最常见的差异是**改一两个字的表记**
 * （「いた」↔「居た」）——10 字句只差这一处时编辑距离相似度 = 0.9，
 * Dice 却只有 0.778（bigram 对「改一处」放大了伤害：它炸掉两个二元组）。
 * 所以判定取 Dice 与编辑距离的**最大值**，0.85 的线在两种度量下都站得住。
 *
 * 再往下调要小心：绑错了就是把别人的学习进度挂到别的句子上，比漏绑严重得多。
 * 宁可漏绑（用户重学一句）也别错绑（进度跑到不相关的句子上）。
 */
export const MATCH_THRESHOLD = 0.85;

/** 编辑距离（Levenshtein，含插入/删除/替换）。输入都很短（≤ 几十字），O(n·m) 无所谓。 */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * 两句日文的相似度：`max(Dice, 编辑距离相似度)`。
 *
 * 两条度量各管一头：Dice 对「中间换了几个字」敏感但把伤害放大一倍；
 * 编辑距离精确反映「改了几个字」，对短句更公平。取最大值 = 只要有一条
 * 度量认为够像就算像 —— 但两句**语义无关**的台词在两条度量下都很低，
 * 不会因为取 max 而误绑。
 *
 * 长度差太远直接判 0（长度比 < 0.6）：它能把「ありがとう」vs
 * 「ありがとうございます」这类「一句是另一句的前缀」挡在门外，
 * 不用依赖相似度那条线。
 */
export function jaSimilarity(a: string, b: string): number {
  const left = normalizeJa(a);
  const right = normalizeJa(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  if (longer > 0 && shorter / longer < 0.6) return 0;
  const dice = diceCoefficient(bigrams(left), bigrams(right));
  const editSim = 1 - editDistance(left, right) / longer;
  return Math.max(dice, editSim);
}

/** 过不过得了「同一句」这条线。 */
export function isSameSentence(a: string, b: string): boolean {
  return jaSimilarity(a, b) >= MATCH_THRESHOLD;
}
