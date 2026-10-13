/**
 * 仿写建议的清理（`cleanSuggestion`）。
 *
 * 用例逐条对应 2026-10-09 从服务端留档里读出来的真实坏形态（15 条统计）：
 * 带引导语前缀的、给并列候选的、和学生原句一字不差的。提示词改了之后模型
 * 应该不再这么写，但**兜底不能只靠提示词** —— 这一层是"宁可漏标"的口径。
 */

import { describe, expect, it } from "vitest";

import { cleanSuggestion } from "../src/services/verdictSuggestion";

const STUDENT = "だからなに　俺の背じゃない";

describe("cleanSuggestion", () => {
  it("正常建议原样留下", () => {
    expect(cleanSuggestion("今日は行かないんだ。", "今日は行く。")).toBe("今日は行かないんだ。");
  });

  it("空串 / 只有空白 → 空串（没有建议）", () => {
    expect(cleanSuggestion("", STUDENT)).toBe("");
    expect(cleanSuggestion("   ", STUDENT)).toBe("");
  });

  it("剥掉模型自己加的引导语前缀（界面会加标签，值里不能再来一个）", () => {
    expect(cleanSuggestion("更自然可以说：俺って本当に天才だったんだね", "俺は天才だ")).toBe(
      "俺って本当に天才だったんだね",
    );
    expect(cleanSuggestion("更自然的说法：今日は行かないんだ。", "今日は行く。")).toBe("今日は行かないんだ。");
    expect(cleanSuggestion("建议改成：早く行こう。", "行こう。")).toBe("早く行こう。");
  });

  it("剥掉整句外面的引号", () => {
    expect(cleanSuggestion("「今日は行かないんだ。」", "今日は行く。")).toBe("今日は行かないんだ。");
    expect(cleanSuggestion("『早く行こう』", "行こう。")).toBe("早く行こう");
  });

  it("并列候选只取第一个", () => {
    expect(cleanSuggestion("彼女はいたの？／彼女、いたの？", "彼女がいる？")).toBe("彼女はいたの？");
  });

  it("与学生原句相同（忽略标点 / 书写形式）→ 丢弃：一字未改还给建议等于白说", () => {
    // 只补了个标点
    expect(cleanSuggestion(`${STUDENT}。`, STUDENT)).toBe("");
    // 全角/半角、空格差异也不算改动
    expect(cleanSuggestion("だからなに 俺の背じゃない", STUDENT)).toBe("");
    // 原来的建议就是原句本身 —— 这正是用户截图里那条
    expect(cleanSuggestion(STUDENT, STUDENT)).toBe("");
  });

  it("整句被引号包着的、内容还是原句 → 剥完引号再比一次，同样丢弃", () => {
    expect(cleanSuggestion(`「${STUDENT}」`, STUDENT)).toBe("");
  });
});
