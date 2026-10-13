/**
 * 词库聚合 —— 从**本地已存的解析结果**里收集学过的词。
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
 * 数据都在本地，不需要联网。
 */
import { CONTENT_POS, type SliceRow } from "../types/entities";

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
 * 把一集里完成句的词并进词表。
 *
 * @param slices   这一集的切片行（analysis 存在行上，见 saveSliceAnalysis）
 * @param completed 这一集里已完成句的信息，key = sliceCid
 * @param source   来源标签（如「孤独摇滚 S01E01」）
 * @param into     跨集聚合的词表，key = 词面（同一词跨集累加 seen）
 */
export function collectVocabFromSlices(
  slices: SliceRow[],
  completed: ReadonlyMap<string, SliceLearnInfo>,
  source: string,
  into: Map<string, VocabEntry>,
): void {
  for (const slice of slices) {
    const info = completed.get(slice.cid);
    if (!info) continue;
    const tokens = slice.analysis?.tokens ?? [];
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
}
