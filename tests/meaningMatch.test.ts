import { describe, expect, it } from "vitest";
import { matchAiReadings, matchMeanings } from "../src/services/meaningMatch";

/**
 * 词义贴回词块的用例。
 *
 * 这一层是纯函数，所以**真拿线上跑出来的那份模型返回**来当用例 —— 不是编的：
 * 「まかせておくれよ」那次，模型把「おくれよ」拆成了「おくれ」+「よ」，
 * 于是按词形精确匹配的那个版本永远给不出释义（用户看到的是「—」）。
 */
describe("词义贴回词块", () => {
  it("精确匹配：词形一致", () => {
    expect(
      matchMeanings([{ surface: "明日", lemma: "明日" }], [{ surface: "明日", meaning: "明天" }]),
    ).toEqual(["明天"]);
  });

  it("精确匹配：模型回的是原形（活用词的辞书形）", () => {
    expect(
      matchMeanings([{ surface: "会お", lemma: "会う" }], [{ surface: "会う", meaning: "见面" }]),
    ).toEqual(["见面"]);
  });

  it("包含匹配：模型把一个词拆成了几个（真实案例「おくれよ」）", () => {
    const tokens = [
      { surface: "まかせ", lemma: "まかせる" },
      { surface: "て", lemma: "て" },
      { surface: "おくれよ", lemma: "おくれる" },
    ];
    const words = [
      { surface: "まかせ", meaning: "交给、委托" },
      { surface: "て", meaning: "连接助词，接补助动词" },
      { surface: "おくれ", meaning: "请（为我）做" },
      { surface: "よ", meaning: "终助词，加强语气" },
    ];
    expect(matchMeanings(tokens, words)).toEqual([
      "交给、委托",
      "连接助词，接补助动词",
      "请（为我）做；终助词，加强语气",
    ]);
  });

  it("拆开的几块按在词块里出现的先后拼，不按模型给的顺序", () => {
    expect(
      matchMeanings(
        [{ surface: "おくれよ", lemma: "おくれる" }],
        [
          { surface: "よ", meaning: "终助词" },
          { surface: "おくれ", meaning: "请（为我）做" },
        ],
      ),
    ).toEqual(["请（为我）做；终助词"]);
  });

  it("一条词义只用一次，不会贴到两个词块上", () => {
    expect(
      matchMeanings(
        [
          { surface: "あい", lemma: "あい" },
          { surface: "あい", lemma: "あい" },
        ],
        [{ surface: "あい", meaning: "爱" }],
      ),
    ).toEqual(["爱", ""]);
  });

  it("空释义不算命中 —— 宁可留空占位，也不把「没讲」伪装成「讲过了」", () => {
    expect(
      matchMeanings([{ surface: "睦", lemma: "睦" }], [{ surface: "睦", meaning: "   " }]),
    ).toEqual([""]);
  });

  it("模型多给的词（句子里没有）不污染任何词块", () => {
    expect(
      matchMeanings(
        [{ surface: "まかせ", lemma: "まかせる" }],
        [
          { surface: "まかせ", meaning: "交给、委托" },
          { surface: "全然違う", meaning: "噪音" },
        ],
      ),
    ).toEqual(["交给、委托"]);
  });

  it("模型什么都没给时不炸，整片留空", () => {
    expect(matchMeanings([{ surface: "睦", lemma: "睦" }], [])).toEqual([""]);
  });
});
describe("AI 句内读音贴回词块（matchAiReadings）", () => {
  const token = (surface: string, lemma?: string) => ({ surface, lemma: lemma ?? surface });

  it("精确命中：AI 的读音整段贴回", () => {
    expect(
      matchAiReadings([token("七夕")], [{ surface: "七夕", reading: "たなばた" }]),
    ).toEqual(["たなばた"]);
  });

  it("模型拆词时按出现先后拼接（读音是拿来敲的，不分隔）", () => {
    expect(
      matchAiReadings(
        [token("おくれよ")],
        [
          { surface: "おくれ", reading: "おくれ" },
          { surface: "よ", reading: "よ" },
        ],
      ),
    ).toEqual(["おくれよ"]);
  });

  it("没读音的词不参与匹配 —— 「没读音」不能伪装成「有」", () => {
    expect(
      matchAiReadings(
        [token("を"), token("する")],
        [
          { surface: "を", reading: "" },
          { surface: "する", reading: "する" },
        ],
      ),
    ).toEqual(["", "する"]);
  });

  it("词典侧没这词的读音时回退由调用方处理，这里只如实返回空", () => {
    expect(matchAiReadings([token("セイヤ")], [])).toEqual([""]);
  });
});
