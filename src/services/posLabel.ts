/**
 * 词性 → 中文标签。
 *
 * 学习卡片的解析区和 vault 笔记里的单词表都要用这一份 —— 两边各写一套，
 * 早晚会出现"卡片上写【形容動詞】、笔记里写【形容】"这种对不上的情况。
 */

import type { PartOfSpeech } from "../types/entities";

export const POS_LABEL: Record<PartOfSpeech, string> = {
  noun: "名词",
  proper: "专名",
  pron: "代名",
  suffix: "接尾",
  verb: "动词",
  adj: "形容",
  adv: "副词",
  particle: "助词",
  aux: "助动",
  conj: "接续",
  prefix: "接头",
  punct: "符号",
  other: "其他",
};
