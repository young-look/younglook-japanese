import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  explainTargets,
  kanaToRomaji,
  katakanaToHiragana,
  mapPartOfSpeech,
  romajiTokens,
  toToken,
  tokenRomaji,
  tokenize,
} from "../src/services/jaTokenize";

/**
 * 分词这一层的用例。
 *
 * 一半是纯函数的（读音转换、词性映射 —— 口径必须与服务端 ja_word 对齐），
 * 一半是**真拿 kuromoji 跑**（词典就在 node_modules 里，不用 mock）：
 * 假名注音错了会直接把用户教错，所以宁可慢一点也要用真引擎验一遍。
 */

const DICT = join(__dirname, "..", "node_modules", "kuromoji", "dict");
const hasDict = existsSync(join(DICT, "base.dat.gz"));

describe("读音转换", () => {
  it("片假名 → 平假名", () => {
    expect(katakanaToHiragana("コンニチハ")).toBe("こんにちは");
    expect(katakanaToHiragana("カタカナとひらがな")).toBe("かたかなとひらがな");
  });

  it("假名 → 罗马音（含拗音、促音、拨音）", () => {
    expect(kanaToRomaji("あした")).toBe("ashita");
    expect(kanaToRomaji("きょう")).toBe("kyou");
    expect(kanaToRomaji("がっこう")).toBe("gakkou");
    expect(kanaToRomaji("しんぶん")).toBe("shinbun");
    // ん 后面跟元音/や行要加撇号，否则会连读成一个音节
    expect(kanaToRomaji("しんいち")).toBe("shin'ichi");
    // 裸假名串没有词性，は 一律按字面 ha —— 助词读 wa 的特例在单词层（tokenRomaji）
    expect(kanaToRomaji("こんにちは")).toBe("konnichiha");
  });

  it("typing 口径：照着敲出来的假名必须等于目标假名", () => {
    // を 的注音是 o，但敲 o 出来的是 お —— 键序必须是 wo
    expect(kanaToRomaji("を", "typing")).toBe("wo");
    expect(kanaToRomaji("を")).toBe("o");
    // ぢ/づ 敲 ji/zu 出来是 じ/ず；拗音同理（ja → じゃ）
    expect(kanaToRomaji("ぢ", "typing")).toBe("di");
    expect(kanaToRomaji("づ", "typing")).toBe("du");
    expect(kanaToRomaji("ぢゃ", "typing")).toBe("dya");
    expect(kanaToRomaji("ぢゃ")).toBe("ja");
    // 长音符号：display 丢弃，键序是 "-"（コーヒー 得敲 ko-hi-）
    expect(kanaToRomaji("コーヒー", "typing")).toBe("ko-hi-");
    expect(kanaToRomaji("コーヒー")).toBe("kohi");
    // 2026-10-09 用户报的现场句：ボーカル 的键序带长音键，提示行不能把它弄丢
    expect(kanaToRomaji("ボーカル", "typing")).toBe("bo-karu");
    // ん 不带撇号 —— 撇号敲进去会变成字面字符
    expect(kanaToRomaji("しんいち", "typing")).toBe("shinichi");
    // 小假名组合：敲 tei 会变 てい，键序得是 thi
    expect(kanaToRomaji("てぃ", "typing")).toBe("thi");
    expect(kanaToRomaji("ふぁ", "typing")).toBe("fa");
    // は/へ 两口径一致：ha/he 敲出来正好是 は/へ
    expect(kanaToRomaji("は", "typing")).toBe("ha");
    expect(kanaToRomaji("へ", "typing")).toBe("he");
    // 促音的重复在两种口径下一样
    expect(kanaToRomaji("がっこう", "typing")).toBe("gakkou");
  });
});

/**
 * 跨词促音。
 *
 * 背景：kuromoji 会把「やった」切成 やっ + た 两个词，而 kanaToRomaji 是单串转换，
 * 逐词各调一次时 っ 落在字符串末尾、取不到下一个音 → 双写整段丢失（yata）。
 * 抄写提示是**照着敲**的，少一个 t 就是把用户教错，所以这条必须钉住。
 */
describe("跨词促音（逐词转换时补上下文）", () => {
  it("词尾 っ 的双写补在下一个词头上：やっ + た → ya / tta", () => {
    expect(romajiTokens(["やっ", "た", "の"])).toEqual(["ya", "tta", "no"]);
    expect(romajiTokens(["やっ", "た", "の"], "typing")).toEqual(["ya", "tta", "no"]);
    // 词内的促音不受影响（本来就在同一个串里）
    expect(romajiTokens(["がっこう", "だ"])).toEqual(["gakkou", "da"]);
  });

  it("双写只认辅音：后面是符号 / 没读音的汉字 / 元音时不动", () => {
    // 句末的「あっ！」后面接标点，不该变成 "、、"
    expect(romajiTokens(["あっ", "、"])).toEqual(["a", "、"]);
    // 读音透传的汉字（没有假名）不该被双写成两个汉字
    expect(romajiTokens(["あっ", "漢字"])).toEqual(["a", "漢字"]);
    // っ 后面不接元音行，万一出现也不许双写元音
    expect(romajiTokens(["あっ", "あ"])).toEqual(["a", "a"]);
  });

  it("空串/单串与 kanaToRomaji 完全一致（不改变既有行为）", () => {
    expect(romajiTokens([])).toEqual([]);
    expect(romajiTokens(["やった"])).toEqual(["yatta"]);
    expect(romajiTokens(["しんいち"], "typing")).toEqual(["shinichi"]);
  });

  it("连着两个促音词也各补各的", () => {
    expect(romajiTokens(["やっ", "た", "っ", "て"])).toEqual(["ya", "tta", "", "tte"]);
  });
});

/**
 * 助词读音特例（display 口径）。
 *
 * 顶部注音是给人看的标准读音：助词 は/へ 读 wa/e（では→dewa、へ→e）。
 * 抄写提示是照着敲的键序：は 就得敲 ha。两个口径各说各的，别再合并。
 * 特例挂单词层（有词性）—— 裸假名串分不清助词 は 和词内 は（はやし）。
 */
describe("助词读音特例", () => {
  it("display 口径：助词 は/へ 标 wa/e，词内/非助词不吃特例", () => {
    expect(tokenRomaji("は", "particle")).toBe("wa");
    expect(tokenRomaji("へ", "particle")).toBe("e");
    // IPADIC 把接续词「では」整个收成一词（不是 で+は 两个助词）—— 截图那句就是这个形态
    expect(tokenRomaji("では", "conj")).toBe("dewa");
    expect(tokenRomaji("デハ", "conj")).toBe("dewa");
    // 词内的 は 是真读 ha
    expect(tokenRomaji("は", "noun")).toBe("ha");
    expect(tokenRomaji("はやし", "noun")).toBe("hayashi");
    // 读音来的是片假名（kuromoji 原始口径）也能吃到特例
    expect(tokenRomaji("ハ", "particle")).toBe("wa");
  });

  it("typing 口径不吃特例：助词 は 的键序就是 ha", () => {
    expect(tokenRomaji("は", "particle", "typing")).toBe("ha");
    expect(tokenRomaji("へ", "particle", "typing")).toBe("he");
  });

  it("romajiTokens 带词性的条目：では → de + wa（typing 仍 de + ha）", () => {
    const entries = [{ reading: "で", pos: "particle" as const }, { reading: "は", pos: "particle" as const }];
    expect(romajiTokens(entries)).toEqual(["de", "wa"]);
    expect(romajiTokens(entries, "typing")).toEqual(["de", "ha"]);
    // 混着裸字符串也行（老用法）
    expect(romajiTokens(["おいわい", { reading: "です", pos: "aux" }])).toEqual(["oiwai", "desu"]);
  });

  it("toToken 落库口径：助词 は 的 romaji 是 wa", () => {
    const token = toToken({
      surface_form: "は",
      basic_form: "は",
      reading: "ハ",
      pos: "助詞",
      pos_detail_1: "係助詞",
      pos_detail_2: "*",
    });
    expect(token.pos).toBe("particle");
    expect(token.romaji).toBe("wa");
  });
});

describe("词性口径", () => {
  it("对应到与服务端一致的十三个标签", () => {
    expect(mapPartOfSpeech("名詞", "一般")).toBe("noun");
    expect(mapPartOfSpeech("名詞", "固有名詞")).toBe("proper");
    expect(mapPartOfSpeech("名詞", "代名詞")).toBe("pron");
    expect(mapPartOfSpeech("名詞", "接尾")).toBe("suffix");
    expect(mapPartOfSpeech("動詞", "自立")).toBe("verb");
    expect(mapPartOfSpeech("動詞", "非自立")).toBe("aux");
    expect(mapPartOfSpeech("形容詞", "自立")).toBe("adj");
    expect(mapPartOfSpeech("形容動詞", "*")).toBe("adj");
    expect(mapPartOfSpeech("助詞", "格助詞")).toBe("particle");
    expect(mapPartOfSpeech("助動詞", "*")).toBe("aux");
    expect(mapPartOfSpeech("副詞", "一般")).toBe("adv");
    expect(mapPartOfSpeech("接続詞", "*")).toBe("conj");
    expect(mapPartOfSpeech("接頭詞", "名詞接続")).toBe("prefix");
    expect(mapPartOfSpeech("記号", "句点")).toBe("punct");
    expect(mapPartOfSpeech("連体詞", "*")).toBe("other");
  });

  it("把 kuromoji 的原始 token 转成我们的形状", () => {
    const token = toToken({
      surface_form: "会おう",
      basic_form: "会う",
      reading: "アオウ",
      pos: "動詞",
      pos_detail_1: "自立",
      pos_detail_2: "*",
    });
    expect(token).toMatchObject({
      surface: "会おう",
      lemma: "会う",
      reading: "あおう",
      romaji: "aou",
      pos: "verb",
    });
  });

  it("没有读音/原形的词（符号）不炸，也不留 *", () => {
    const token = toToken({
      surface_form: "。",
      basic_form: "*",
      reading: "*",
      pos: "記号",
      pos_detail_1: "句点",
      pos_detail_2: "*",
    });
    expect(token.lemma).toBe("。");
    expect(token.pos).toBe("punct");
    expect(token.reading).toBe("");
  });
});

describe.skipIf(!hasDict)("真拿 kuromoji 跑一遍", () => {
  it("一句话切出来的词、读音、词性都对", async () => {
    const tokens = await tokenize(DICT, "明日また会おう");
    // IPADIC 会把意志形拆成「会お」+「う」（助動詞），MeCab 那边也是这个口径 —— 别改成整块
    expect(tokens.map((token) => token.surface)).toEqual(["明日", "また", "会お", "う"]);

    const tomorrow = tokens[0];
    expect(tomorrow.pos).toBe("noun");
    expect(tomorrow.reading).toBe("あした");
    expect(tomorrow.romaji).toBe("ashita");

    // 活用词要能回到原形，抄写判定和生词本都靠它
    const verb = tokens[2];
    expect(verb.lemma).toBe("会う");
    expect(verb.pos).toBe("verb");
    expect(verb.reading).toBe("あお");
    expect(tokens[3].pos).toBe("aux");
    // 词典加载本身要 1 秒多，整套并行跑时会撞默认的 5 秒超时 —— 给足时间
  }, 30_000);

  it("助词与助动词不会被算成实词", async () => {
    const tokens = await tokenize(DICT, "これは本です");
    const pos = tokens.map((token) => `${token.surface}:${token.pos}`);
    expect(pos).toContain("は:particle");
    expect(pos).toContain("です:aux");
    expect(tokens.find((token) => token.surface === "本")?.reading).toBe("ほん");
    // 助词 は 的注音是标准读音 wa，不是键序 ha（抄写提示那路才是 ha）
    expect(tokens.find((token) => token.surface === "は")?.romaji).toBe("wa");
  }, 30_000);

  it("顶部注音端到端：では お祝いです → dewa oiwai desu（截图反馈的原句）", async () => {
    const tokens = await tokenize(DICT, "では お祝いです");
    // IPADIC 把「では」整个收成接続詞，空格是一个記号 token（读音/注音都空）
    expect(tokens.map((token) => token.surface)).toEqual(["では", " ", "お祝い", "です"]);
    expect(tokens.map((token) => token.romaji)).toEqual(["dewa", "", "oiwai", "desu"]);
  }, 30_000);

  it("空串与纯空白不报错，返回空表", async () => {
    expect(await tokenize(DICT, "")).toEqual([]);
    expect(await tokenize(DICT, "   ")).toEqual([]);
  }, 30_000);
});

describe("送进 AI 的词表", () => {
  /**
   * 口径：**除标点外全部**。用户要的是"每个词都有释义"，
   * 漏掉助词他就会看到一份残缺的词表 —— 这正是以前的表现（"每次都漏词"）。
   * 服务端 `sentence_llm.target_indexes()` 有一份同样的实现，改这里要改那边。
   */
  const tokens = [
    { surface: "睦", lemma: "睦", reading: "むつみ", romaji: "mutsumi", pos: "proper", def: "", meaningSource: "" },
    { surface: "が", lemma: "が", reading: "", romaji: "ga", pos: "particle", def: "", meaningSource: "" },
    { surface: "来", lemma: "来る", reading: "き", romaji: "ki", pos: "verb", def: "", meaningSource: "" },
    { surface: "た", lemma: "た", reading: "", romaji: "ta", pos: "aux", def: "", meaningSource: "" },
    { surface: "。", lemma: "。", reading: "", romaji: "", pos: "punct", def: "", meaningSource: "" },
  ];

  it("助词/助动词都在里面", () => {
    const targets = explainTargets(tokens as never);
    expect(targets).toEqual(["睦", "が", "来", "た"]);
    expect(targets).toContain("が");
    expect(targets).toContain("た");
  });

  it("标点不给 —— 没有可解释的内容，列出来只是白花 token", () => {
    expect(explainTargets(tokens as never)).not.toContain("。");
  });

  it("顺序保持原句词序（模型按这个顺序回，贴回词块才不会错位）", () => {
    expect(explainTargets(tokens as never)).toEqual(tokens.filter((t) => t.pos !== "punct").map((t) => t.surface));
  });

  it("全标点的句子给空表（调用方据此别再花钱）", () => {
    expect(explainTargets([{ surface: "。", pos: "punct" }] as never)).toEqual([]);
  });
});
