/**
 * 词库聚合 —— 从**已存下来的解析结果**里收集学过的词。
 *
 * 口径（2026-10-04 改版，用户拍板去掉熟练度分档）：
 *  · 只收**完成三步的句子**（progress.completedAt 有值）里出现的实词
 *    （CONTENT_POS，助词/标点这类不进词库）；
 *  · 每个词记：读音 / 罗马音 / 释义 / 学习次数（在多少个已完成句里出现过）/
 *    最近学习时间 / 例句（**用户自己的仿写，且必须真的含有这个词**——含这个词的
 *    已完成句里最近一条写了仿写的；没写过或仿写里没这个词就空着，界面不硬凑）；
 *  · 释义取 AI 给的 `def`（matchMeanings 贴上去的那份），没有就空着——
 *    界面上明说"还没有释义"，不拿本机分词硬凑。
 *
 * ⚠️ **词库不认"本机有没有素材"**（2026-10-14 用户拍板）：AI 解析（含 tokens）
 * 是**上云**的（`analysis` 集合），同步拉回来就有。所以已完成句子的词不论素材在
 * 不在本机都算得出来，总词汇量是一个**确定值** —— 会随"这台机器导没导素材"忽大
 * 忽小，那是统计口径的错，不是用户数据变了。本机没有切片行的那些句走
 * `collectVocabFromAnalyses`（调用方负责把解析结果取来：本地句子行，或同步暂存的
 * 孤儿补丁），出处用 progress 行内嵌的 provenance。
 *
 * 数据都在本地，不需要联网。
 */
import { CONTENT_POS, type SentenceAnalysis, type StudySentence, type Token } from "../types/entities";

export interface VocabEntry {
  surface: string;
  reading: string;
  romaji: string;
  meaning: string;
  /** 第一次遇到这个词的来源（作品 + 集数），展示用 */
  source: string;
  /** 在已完成句中出现的次数（= 曝光次数的本地近似） */
  seen: number;
  /** 最近一次在已完成句里遇到它的时刻（完成时刻） */
  lastSeenAt: string;
  /** 例句 = 用户的仿写（含这个词的已完成句里最近的一条）；没写过是空串 */
  example: string;
  /** example 对应那次完成时刻，只用来判断"更近的仿写顶掉旧的"，界面不展示 */
  exampleAt: string;
}

/** 一条已完成句里词库聚合要用的信息。 */
export interface SliceLearnInfo {
  /** 完成时刻 */
  at: string;
  /** 用户为这句写的仿写（没写是空串） */
  imitation: string;
}

/**
 * 一句完成句的词并进词表 —— 收词规则的唯一实现。
 *
 * `collectVocabFromSlices`（本机切片）与 `collectVocabFromAnalyses`（孤儿句）
 * 共用它：两种来源的句走的是同一套规则，不该分叉。
 *
 * @param tokens   这一句的解析结果（AI 分词；没解析过是空数组）
 * @param info     这句的完成信息（时刻 + 用户写的仿写）
 * @param source   来源标签（如「孤独摇滚 · 第 1 集」）
 * @param into     跨句聚合的词表，key = 词面（同一词跨句累加 seen）
 */
export function collectVocabFromTokens(
  tokens: readonly Token[],
  info: SliceLearnInfo,
  source: string,
  into: Map<string, VocabEntry>,
): void {
  for (const token of tokens) {
    if (!CONTENT_POS.has(token.pos)) continue;
    if (!token.surface.trim()) continue;
    const existing = into.get(token.surface);
    if (existing) {
      existing.seen += 1;
      if (info.at > existing.lastSeenAt) existing.lastSeenAt = info.at;
      // 释义只在空缺时补——先到的 AI 释义不后被词典 reading 顶掉
      if (!existing.meaning && token.def) existing.meaning = token.def;
      if (!existing.reading) existing.reading = token.reading || token.aiReading || "";
      if (!existing.romaji) existing.romaji = token.romaji || "";
      // 例句跟"最近一次学"走：最近那句写了仿写、**仿写里真有这个词**才用，
      // 没写保留旧的那条。词不在句子里就不算例句 —— 词库不摆别人的句子充数。
      if (info.imitation && info.imitation.includes(token.surface) && info.at >= existing.exampleAt) {
        existing.example = info.imitation;
        existing.exampleAt = info.at;
      }
      continue;
    }
    const example = info.imitation && info.imitation.includes(token.surface) ? info.imitation : "";
    into.set(token.surface, {
      surface: token.surface,
      reading: token.reading || token.aiReading || "",
      romaji: token.romaji || "",
      meaning: token.def ?? "",
      source,
      seen: 1,
      lastSeenAt: info.at,
      example,
      exampleAt: example ? info.at : "",
    });
  }
}

/**
 * 把一集里完成句的词并进词表。
 *
 * @param slices   这一集的切片行（analysis 存在行上，见 saveSliceAnalysis）
 * @param completed 这一集里已完成句的信息，key = sliceCid
 * @param source   来源标签（如「孤独摇滚 · 第 1 集」）
 * @param into     跨集聚合的词表，key = 词面（同一词跨集累加 seen）
 */
export function collectVocabFromSlices(
  slices: StudySentence[],
  completed: ReadonlyMap<string, SliceLearnInfo>,
  source: string,
  into: Map<string, VocabEntry>,
): void {
  for (const slice of slices) {
    const info = completed.get(slice.cid);
    if (!info) continue;
    collectVocabFromTokens(slice.analysis?.tokens ?? [], info, source, into);
  }
}

/**
 * 把**孤儿句**（本机没有切片行）的词并进词表。
 *
 * 存在的理由见文件头：解析随同步回来了，这些句的词算得出来，就该算进去 ——
 * 否则换台机器、或把素材移掉，总词汇量凭空少一截。
 *
 * @param analyses  sliceCid → AI 解析（没解析过的句不在表里，跳过）
 * @param completed 已完成句的信息，key = sliceCid
 * @param labelOf   出处标签（调用方从本机记录名 / progress 行的 provenance 取）
 * @param into      跨句聚合的词表
 */
export function collectVocabFromAnalyses(
  analyses: ReadonlyMap<string, SentenceAnalysis>,
  completed: ReadonlyMap<string, SliceLearnInfo>,
  labelOf: (sliceCid: string) => string,
  into: Map<string, VocabEntry>,
): void {
  for (const [sliceCid, analysis] of analyses) {
    const info = completed.get(sliceCid);
    if (!info) continue;
    collectVocabFromTokens(analysis.tokens ?? [], info, labelOf(sliceCid), into);
  }
}
