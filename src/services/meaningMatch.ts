/**
 * 把模型返回的词义贴回分词得到的词块。
 *
 * 为什么要单独一层、还要容错匹配：**模型不会老实照抄我们送进去的词表**。
 * 实测（deepseek-flash，2026-09-28，句「まかせておくれよ」）：
 *   送进去的词：まかせ、て、おくれよ
 *   回来的 surface：まかせ、て、**おくれ**、**よ** —— 它把「おくれよ」拆成了两个词。
 * 按词形精确匹配的话「おくれよ」永远配不上，用户看到的就是一个「—」占位
 * （用户反馈的原话是"解析常常出现为空"）。
 *
 * 两轮匹配：
 *  一、**精确**：词形、原形能对上就用它 —— 辞书形与活用形的差异走这条。
 *  二、**包含**：还没配上的词块，看它里面含有哪些**还没被用掉**的词义，
 *      按在词块里出现的先后拼起来（おくれ + よ 走这条）。
 *      用掉的词义不再参与第二轮，避免同一个词义被贴到两个词块上。
 *
 * 返回与 `tokens` 一一对应的释义；没配上的位置是空串。
 *
 * 读音（reading）走**同一套匹配**（`matchAiReadings`）：AI 按句内实际念法给的
 * 假名读音，是抄写提示的数据源之一（比词典注音准：人名/缩约/连浊）。
 * 读音是拿来敲的，包含命中的多段直接拼接（おくれ + よ → おくれよ），不加分隔符。
 */

export interface MeaningEntry {
  surface: string;
  meaning: string;
}

/** 内部匹配器：只管词形，不管词条里的值。命中词条按位返回（未命中 null）。 */
function matchEntries<T extends { surface: string }>(
  tokens: readonly { surface: string; lemma?: string }[],
  entries: T[],
): (T[] | null)[] {
  const used = entries.map(() => false);
  const result: (T[] | null)[] = tokens.map(() => null);

  // 一、精确：先词形，再原形
  tokens.forEach((token, index) => {
    for (const key of [token.surface, token.lemma]) {
      if (!key) continue;
      const hit = entries.findIndex((entry, i) => !used[i] && entry.surface === key);
      if (hit < 0) continue;
      used[hit] = true;
      result[index] = [entries[hit]];
      return;
    }
  });

  // 二、包含：模型把我们的一个词拆成了几个
  tokens.forEach((token, index) => {
    if (result[index]) return;
    const parts: { at: number; entry: T }[] = [];
    entries.forEach((entry, i) => {
      if (used[i]) return;
      const at = token.surface.indexOf(entry.surface);
      if (at < 0) return;
      used[i] = true;
      parts.push({ at, entry });
    });
    if (parts.length === 0) return;
    parts.sort((a, b) => a.at - b.at);
    result[index] = parts.map((part) => part.entry);
  });

  return result;
}

export function matchMeanings(
  tokens: readonly { surface: string; lemma?: string }[],
  words: readonly MeaningEntry[],
): string[] {
  // 空释义不算一条 —— 留着它只会把"没讲"伪装成"讲过了"
  return matchEntries(
    tokens,
    words
      .map((word) => ({
        surface: (word.surface ?? "").trim(),
        meaning: (word.meaning ?? "").trim(),
      }))
      .filter((entry) => entry.surface !== "" && entry.meaning !== ""),
  ).map((hits) => (hits ?? []).map((hit) => hit.meaning).join("；"));
}

/** 同一套匹配，取 AI 词条的句内读音（空的词条不参与——"没读音"不能伪装成"有"）。 */
export function matchAiReadings(
  tokens: readonly { surface: string; lemma?: string }[],
  words: readonly { surface: string; reading?: string }[],
): string[] {
  return matchEntries(
    tokens,
    words
      .map((word) => ({
        surface: (word.surface ?? "").trim(),
        reading: (word.reading ?? "").trim(),
      }))
      .filter((entry) => entry.surface !== "" && entry.reading !== ""),
  ).map((hits) => (hits ?? []).map((hit) => hit.reading).join(""));
}

/**
 * 同一套匹配，取英语外来语的词源（源词条里没有词源的词一律不参与）。
 *
 * 为什么复用 `matchEntries` 而不是按词形精确查表：模型会把一个词拆开
 * （「おくれよ」→「おくれ」+「よ」），精确查表会让那个词在弹卡里
 * 明明有词源却显示不出来 —— 与释义、读音同一个坑，别各写一套。
 */
export function matchAiOrigins(
  tokens: readonly { surface: string; lemma?: string }[],
  words: readonly { surface: string; origin?: string }[],
): string[] {
  return matchEntries(
    tokens,
    words
      .map((word) => ({
        surface: (word.surface ?? "").trim(),
        origin: (word.origin ?? "").trim(),
      }))
      .filter((entry) => entry.surface !== "" && entry.origin !== ""),
  ).map((hits) => (hits ?? []).map((hit) => hit.origin).join(""));
}