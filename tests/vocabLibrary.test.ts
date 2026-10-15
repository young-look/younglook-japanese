/**
 * 词库例句口径（2026-10-09 拍板）：例句**只能是用户自己写的、且真的含有
 * 这个词**的仿写句。不含词的仿写不硬凑、已有的好例句不被后来的坏仿写顶掉。
 */

import { describe, expect, it } from "vitest";
import type { SentenceAnalysis, StudySentence } from "../src/types/entities";
import {
  collectVocabFromAnalyses,
  collectVocabFromSlices,
  type SliceLearnInfo,
} from "../src/services/vocabLibrary";

function slice(cid: string, surface: string): StudySentence {
  return {
    cid,
    analysis: {
      tokens: [
        { surface, pos: "noun", reading: "", aiReading: "", romaji: "", def: "" },
      ],
    },
  } as unknown as StudySentence;
}

function analysis(surface: string): SentenceAnalysis {
  return {
    tokens: [{ surface, pos: "noun", reading: "", aiReading: "", romaji: "", def: "" }],
  } as unknown as SentenceAnalysis;
}

const AT1 = "2026-10-01T10:00:00Z";
const AT2 = "2026-10-02T10:00:00Z";

function info(imitation: string, at: string): SliceLearnInfo {
  return { at, imitation };
}

describe("词库例句：仿写必须包含该词", () => {
  it("仿写含有这个词 → 收作例句", () => {
    const into = new Map();
    collectVocabFromSlices([slice("S:1", "春日影")], new Map([["S:1", info("今日は春日影を弾いた", AT1)]]), "t", into);
    expect(into.get("春日影")?.example).toBe("今日は春日影を弾いた");
  });

  it("仿写不含这个词 → 例句空着，不硬凑", () => {
    const into = new Map();
    collectVocabFromSlices([slice("S:1", "春日影")], new Map([["S:1", info("今日は晴れです", AT1)]]), "t", into);
    expect(into.get("春日影")?.example).toBe("");
    expect(into.get("春日影")?.exampleAt).toBe("");
  });

  it("没写仿写 → 例句空着", () => {
    const into = new Map();
    collectVocabFromSlices([slice("S:1", "春日影")], new Map([["S:1", info("", AT1)]]), "t", into);
    expect(into.get("春日影")?.example).toBe("");
  });

  it("更近的仿写不含词 → 顶不掉已有的好例句", () => {
    const into = new Map();
    collectVocabFromSlices(
      [slice("S:1", "春日影"), slice("S:2", "春日影")],
      new Map([
        ["S:1", info("春日影を弾いた", AT1)],
        ["S:2", info("今日は晴れです", AT2)],
      ]),
      "t",
      into,
    );
    expect(into.get("春日影")?.example).toBe("春日影を弾いた");
    expect(into.get("春日影")?.exampleAt).toBe(AT1);
    // 但"最近学习时间"照常更新 —— 两件事别绑死
    expect(into.get("春日影")?.lastSeenAt).toBe(AT2);
  });

  it("更近的仿写含词 → 顶掉旧例句", () => {
    const into = new Map();
    collectVocabFromSlices(
      [slice("S:1", "春日影"), slice("S:2", "春日影")],
      new Map([
        ["S:1", info("春日影を弾いた", AT1)],
        ["S:2", info("また春日影やったの？", AT2)],
      ]),
      "t",
      into,
    );
    expect(into.get("春日影")?.example).toBe("また春日影やったの？");
    expect(into.get("春日影")?.exampleAt).toBe(AT2);
  });
});

/**
 * 总词汇量的口径不认"本机有没有素材"（2026-10-14 用户拍板）：AI 解析随同步回来，
 * 本机没有切片行的孤儿句**照样计入** —— 换台机器、或把素材移掉，词库不能凭空少一截。
 */
describe("词库收词：孤儿句照样计入", () => {
  it("本机没有切片行的完成句，词照样进词库", () => {
    const into = new Map();
    collectVocabFromAnalyses(
      new Map([["S:orphan", analysis("春日影")]]),
      new Map([["S:orphan", info("春日影を弾いた", AT1)]]),
      () => "孤独摇滚 · 第 1 集",
      into,
    );
    expect(into.get("春日影")?.seen).toBe(1);
    expect(into.get("春日影")?.source).toBe("孤独摇滚 · 第 1 集");
    expect(into.get("春日影")?.example).toBe("春日影を弾いた");
  });

  it("孤儿句与本机切片的词合并累加，出处按各自的句走", () => {
    const into = new Map();
    collectVocabFromSlices([slice("S:1", "春日影")], new Map([["S:1", info("", AT1)]]), "本机那集", into);
    collectVocabFromAnalyses(
      new Map([["S:orphan", analysis("春日影")]]),
      new Map([["S:orphan", info("", AT2)]]),
      () => "云端那集",
      into,
    );
    expect(into.get("春日影")?.seen).toBe(2);
    // 先到的那个记出处（与本机切片同一规则，不为孤儿句另开一套）
    expect(into.get("春日影")?.source).toBe("本机那集");
    expect(into.get("春日影")?.lastSeenAt).toBe(AT2);
  });

  it("没解析过的孤儿句不计入（没有 tokens 就没有词，不是漏算）", () => {
    const into = new Map();
    collectVocabFromAnalyses(
      new Map([["S:orphan", { tokens: [] } as unknown as SentenceAnalysis]]),
      new Map([["S:orphan", info("春日影を弾いた", AT1)]]),
      () => "t",
      into,
    );
    expect(into.size).toBe(0);
  });
});
