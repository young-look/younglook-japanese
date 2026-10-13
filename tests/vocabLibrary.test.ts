/**
 * 词库例句口径（2026-10-09 拍板）：例句**只能是用户自己写的、且真的含有
 * 这个词**的仿写句。不含词的仿写不硬凑、已有的好例句不被后来的坏仿写顶掉。
 */

import { describe, expect, it } from "vitest";
import type { SliceRow } from "../src/types/entities";
import { collectVocabFromSlices, type SliceLearnInfo } from "../src/services/vocabLibrary";

function slice(cid: string, surface: string): SliceRow {
  return {
    cid,
    analysis: {
      tokens: [
        { surface, pos: "noun", reading: "", aiReading: "", romaji: "", def: "" },
      ],
    },
  } as unknown as SliceRow;
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
