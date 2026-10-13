// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { installObsidianDomHelpers } from "./obsidianDom";

// 必须先装 DOM 扩展再渲染（createEl / addClass 是 Obsidian 给 HTMLElement 打的补丁）
installObsidianDomHelpers();

import { renderMiniMarkdown } from "../src/ui/miniMarkdown";

function render(markdown: string): HTMLElement {
  const el = document.createElement("div");
  renderMiniMarkdown(el, markdown);
  return el;
}

/** 取所有加粗的文本内容 */
function strongTexts(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll("strong")).map((s) => s.textContent ?? "");
}

/** 整个容器的纯文本（各块用 | 拼接，便于断言字面星号是否还在） */
function allText(el: HTMLElement): string {
  return el.textContent ?? "";
}

describe("极简 markdown 渲染", () => {
  it("普通的 **加粗**、`行内代码`、列表、分段照旧", () => {
    const el = render("整句：**どれだけ楽にさせたか** です\n\n- 第一条\n- 第二条");
    expect(strongTexts(el)).toEqual(["どれだけ楽にさせたか"]);
    expect(el.querySelectorAll("li").length).toBe(2);
  });

  it("跨行加粗能拼回一行 —— 2026-10-10 实机截图原样复现", () => {
    // 模型把长句加粗写到换行两侧：旧行为 = 字面 `*` 挂在正文里
    const el = render("- **どれだけ気持ちよくさせたか分かって\nる？**");
    expect(strongTexts(el)).toEqual(["どれだけ気持ちよくさせたか分かってる？"]);
    // 字面星号不许残留
    expect(allText(el)).not.toContain("*");
    // 仍是一个列表项（不是散成段落）
    expect(el.querySelectorAll("li").length).toBe(1);
  });

  it("折行拼接处两边都是 CJK 就直接接上，不塞空格", () => {
    const el = render("**結果として、何も\n起きなかった** そうです");
    expect(strongTexts(el)).toEqual(["結果として、何も起きなかった"]);
  });

  it("折行拼接处是英文单词就补一个空格", () => {
    const el = render("**this is a long\nsentence** here");
    expect(strongTexts(el)).toEqual(["this is a long sentence"]);
  });

  it("`**` 开头的段落行不是列表项（第一个 `*` 不被吃掉）", () => {
    const el = render("**加粗的开头**：后面还有正文");
    // 旧行为：整行被当成 `*` 列表项、吃掉一个 `*`，正文里剩 `*加粗的开头**：…`
    expect(el.querySelectorAll("li").length).toBe(0);
    expect(strongTexts(el)).toEqual(["加粗的开头"]);
    expect(allText(el)).not.toContain("*");
  });

  it("流式半截（闭合 `**` 还没来）不崩，字面星号先垫着，下一帧重渲染闭合", () => {
    const el = render("- **どれだけ気持ちよくさせたか分かって");
    expect(el.querySelectorAll("li").length).toBe(1);
    // 半截时还没有成对的加粗
    expect(strongTexts(el)).toEqual([]);
    // 补上闭合行重渲染（assistant.ts 每帧 empty() 后重画）
    const el2 = document.createElement("div");
    renderMiniMarkdown(el2, "- **どれだけ気持ちよくさせたか分かって\nる？**");
    expect(strongTexts(el2)).toEqual(["どれだけ気持ちよくさせたか分かってる？"]);
  });

  it("多段里只有一段跨行：别的行不受影响", () => {
    const el = render("前面一段普通话。\n\n- 要点 **これが本当に行末で\n切れてて** 大丈夫\n\n收尾一段。");
    expect(strongTexts(el)).toEqual(["これが本当に行末で切れてて"]);
    expect(el.querySelectorAll("p").length).toBe(2);
    expect(el.querySelectorAll("li").length).toBe(1);
  });
});
