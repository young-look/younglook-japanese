import { describe, expect, it } from "vitest";
import { effectiveJa, effectiveZh, normalizeTextFix } from "../src/services/study";
import type { StudySentence } from "../src/types/entities";

/**
 * 字幕修正（`textFixes`）的取值口径。
 *
 * 🔥 这条是"改日文会不会毁掉已有学习记录"那道保险的核心（用户 2026-10-03 定的方案 A）：
 * **绝对不能去改 `slice.ja` 本身**。日文参与身份派生 ——
 * `sliceCid = sha256(前一句 ⟨US⟩ 本句 ⟨US⟩ 后一句)`（三句 hash），
 * 而进度、录音、单词卡全挂在 cid 上。改那个字段 ⇒ 改一个字，这句的记录全成孤儿。
 *
 * 所以「改日文」只能是**显示时套一层覆盖**，本文件钉的就是这一层。
 */

const base = { ja: "ちょっと待って", zh: "等一下" } as Pick<StudySentence, "ja" | "zh" | "textFixes">;

describe("effectiveJa / effectiveZh", () => {
  it("没改过就返回原片字幕", () => {
    expect(effectiveJa(base)).toBe("ちょっと待って");
    expect(effectiveZh(base)).toBe("等一下");
  });

  it("改过就用改的那份", () => {
    const fixed = { ...base, textFixes: { ja: "ちょっとまって", zh: "等一等" } };
    expect(effectiveJa(fixed)).toBe("ちょっとまって");
    expect(effectiveZh(fixed)).toBe("等一等");
  });

  it("只改日文时，中文仍是原样（不串味）", () => {
    const fixed = { ...base, textFixes: { ja: "ちょっとまって" } };
    expect(effectiveJa(fixed)).toBe("ちょっとまって");
    expect(effectiveZh(fixed)).toBe("等一下");
  });

  it("空串 / 全空白 = 当作没改，回原片字幕", () => {
    //⚠️ 这一条钉的是"清空输入框 = 撤销修正"，不是"显示空白句"。
    // 存进去时 normalizeTextFix 已经把空的剔掉了，这里是第二道防线：
    // 万一有别的路径塞了空串进来，也不能让原句凭空消失。
    const cleared = { ...base, textFixes: { ja: "   ", zh: "" } };
    expect(effectiveJa(cleared)).toBe("ちょっと待って");
    expect(effectiveZh(cleared)).toBe("等一下");
  });
});

describe("normalizeTextFix（弹窗两个输入框 → 存什么）", () => {
  it("两边都填 = 都存", () => {
    expect(normalizeTextFix("新的日文", "新的中文")).toEqual({ ja: "新的日文", zh: "新的中文" });
  });

  it("只填一边 = 只存那一边", () => {
    expect(normalizeTextFix("新的日文", "")).toEqual({ ja: "新的日文" });
    expect(normalizeTextFix("", "新的中文")).toEqual({ zh: "新的中文" });
  });

  it("两边都空 = undefined（把修正整个撤掉）", () => {
    // 这一条最关键：存成空对象而不是 `{ja: "", zh: ""}`，
    // 否则"我什么都不改、只想撤销之前的修正"就撤不掉了。
    expect(normalizeTextFix("", "")).toBeUndefined();
    expect(normalizeTextFix("   ", "\n\t ")).toBeUndefined();
  });

  it("首尾空白被裁掉（用户敲了回车也不该进库）", () => {
    expect(normalizeTextFix("  句子  ", "  译文 ")).toEqual({ ja: "句子", zh: "译文" });
  });
});
