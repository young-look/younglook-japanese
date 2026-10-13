import { describe, expect, it } from "vitest";
import { isSameSentence, jaSimilarity, normalizeJa, sameJa } from "../src/services/jaMatch";

describe("日文归一化（只用于比对，绝不写回数据）", () => {
  it("去标点与空白：「。」「、」的有无不改变身份", () => {
    expect(normalizeJa("明日、また会おう。")).toBe(normalizeJa("明日また会おう"));
  });

  it("全角半角折平（NFKC）", () => {
    expect(normalizeJa("ＡＢＣ")).toBe(normalizeJa("ABC"));
  });

  it("片假名与平假名算同一句", () => {
    expect(normalizeJa("アリガトウ")).toBe(normalizeJa("ありがとう"));
  });

  it("长音符「ー」保留（它是假名的一部分，去掉会把「コーヒー」折成「コヒ」）", () => {
    expect(normalizeJa("コーヒー")).not.toBe(normalizeJa("コヒ"));
    expect(sameJa("コーヒー", "コーヒー")).toBe(true);
  });

  it("空串不参与比较", () => {
    expect(normalizeJa("")).toBe("");
    expect(jaSimilarity("", "x")).toBe(0);
    expect(sameJa("", "")).toBe(false);
  });
});

describe("相似度：换字幕的几种真实差异", () => {
  it("一个字没变 → 满分", () => {
    expect(jaSimilarity("明日また会おう", "明日また会おう")).toBe(1);
  });

  it("只差标点 / 空格 → 满分", () => {
    expect(jaSimilarity("明日、また会おう。", "明日 また会おう")).toBe(1);
  });

  it("片假名 / 平假名写法不同 → 满分", () => {
    expect(jaSimilarity("アリガトウ", "ありがとう")).toBe(1);
  });

  it("个别假名不同（常见 OCR/版本差异）→ 仍然算同一句", () => {
    // 「ありがとう」vs「ありがと」：只少了一个假名
    expect(isSameSentence("ありがとう", "ありがと")).toBe(true);
  });

  it("表记差异（いた ↔ 居た）是换字幕最常见的改动，短句也要绑得上", () => {
    // 纯 Dice 对这种差异只给 0.778 —— 一个字炸掉两个 bigram。
    // 所以判定取 max(Dice, 编辑距离)：10 字句改一字 = 0.9
    expect(jaSimilarity("ずっと探していたんだ。", "ずっと探して居たんだ。"))
      .toBeGreaterThanOrEqual(0.85);
    expect(isSameSentence("ずっと探していたんだ。", "ずっと探して居たんだ。")).toBe(true);
  });

  it("完全不同的两句 → 不算同一句", () => {
    expect(isSameSentence("明日また会おう", "さようなら")).toBe(false);
  });

  it("🔒 前缀不误判：「ありがとう」不是「ありがとうございます」", () => {
    // bangumi.ts 那个 similarity 有子串短路分支会给 96 分，这里必须判否
    expect(isSameSentence("ありがとう", "ありがとうございます")).toBe(false);
  });

  it("长度差一倍以上直接判 0（不是同一句）", () => {
    expect(jaSimilarity("あ", "あ".repeat(20))).toBe(0);
  });
});
