/**
 * 仿写「更自然的说法」的清理。
 *
 * 模型给的 `suggestion` 是不可信输入。提示词（`hosted_prompts.IMITATION_SYSTEM`）
 * 已经写死「只给一句完整日语、不加引导语、不改意思、和学生那句一样就留空」，
 * 但模型总会漂 —— 这里按**宁可不显示**的口径兜一层，与服务端判定「判不出可用
 * 结论就算不通过」是同一种取向：宁可漏标，不做假。
 *
 * 三道清理，逐条对应 2026-10-09 历史留档里出现过的形态（15 条统计）：
 *   1. 剥引导语前缀 —— 「更自然可以说：…」「建议改成：…」（7 条败在这）；
 *   2. 剥首尾引号 —— 模型常把整句包在「」里；
 *   3. 多候选（`A／B`）只取第一个（6 条给了并列候选）。
 * 最后一道：归一化后与用户原句相同（哪怕只差标点、书写形式）→ 丢弃 ——
 * 「一字未改还给建议」正是这次要堵的最典型的坏形态。
 *
 * ⚠️ 本模块**只管建议句本身**。「suggestion 与 suggestionNote 都非空才显示」
 * 这条展示口径留在渲染处（views/study/practices.ts::renderSuggestion）。
 */

import { normalizeForCopy } from "./copyCheck";

/**
 * 引导语判定词：出现在冒号**左边**、且左边这一小段里带这几个词之一，就当它是
 * 模型自己加的标签。刻意收窄 —— 只有「冒号 + 中文标签词」同时命中才剥，
 * 免得把一句正常的日语切坏。
 */
const LEAD_MARKERS = ["更自然", "更地道", "更好的说法", "更好", "建议", "可以改", "改写", "换成"];

/** 冒号左边的标签最长几个字；超过就不像标签了（正常日语不会这么长）。 */
const LEAD_MAX_CHARS = 16;

/** 剥掉「更自然可以说：」这类引导语前缀。 */
function stripLead(text: string): string {
  const idx = text.search(/[：:]/u);
  if (idx <= 0 || idx > LEAD_MAX_CHARS) return text;
  const head = text.slice(0, idx);
  if (!LEAD_MARKERS.some((marker) => head.includes(marker))) return text;
  return text.slice(idx + 1).trim();
}

/**
 * 清理一条建议句。返回空串 = **不显示**（没建议、或提了等于没提）。
 *
 * @param raw         模型给的建议（或库里留档的那份）
 * @param studentText 学生自己写的句子 —— 建议与它相同就丢弃
 */
export function cleanSuggestion(raw: string, studentText: string): string {
  let text = (raw ?? "").trim();
  if (!text) return "";
  text = stripLead(text);
  // 整句被引号包着时剥掉外壳（只在首尾成对出现时剥，句中的引用不动）
  text = text.replace(/^[\s「『"'“”‘’]+/u, "").replace(/[\s」』"'“”‘’]+$/u, "").trim();
  if (!text) return "";
  // 并列候选只取第一个（提示词已禁止用「／」分隔，这是兜底）
  const first = text.split("／")[0]?.trim();
  if (first) text = first;
  if (!text) return "";
  // 和学生原句一致（忽略标点 / 书写形式）→ 没改动，不显示
  if (normalizeForCopy(text) === normalizeForCopy(studentText)) return "";
  return text;
}
