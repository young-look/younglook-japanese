// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "./obsidianDom";

// 必须先装 DOM 扩展再 new 弹窗（搭壳时才碰 DOM，import 顺序无忧）
installObsidianDomHelpers();

import { LocalSpaceModal } from "../src/views/LocalSpaceModal";
import type { Scope } from "./obsidianStub";

/**
 * 首次登录时的**认领窗**（2026-10-09 立 → 2026-10-10 整体重做）。
 *
 * 这张窗是"匿名空间那批数据要不要交给这个账号"的唯一关口。要钉四件事：
 *   1. 壳走全站统一弹窗，正文把**账号**点名（数据要么归它、要么留在这儿）；
 *   2. 中间两张**可点的卡**、单选：点中的那张才带 `is-selected`（青蓝），
 *      另一张回白底 —— 全站的状态色语言靠这一个类名，别用行内样式；
 *   3. 🔥 **没选之前「确定」是禁用的**：不让人稀里糊涂点下去；
 *   4. 三条路各有各的回调（认领 / 不认领 / 放弃登录），互不串；且**选了才关得掉**
 *      —— 锁定档下 Esc / 直接 close() 都拦着（`ui/dialog.ts`）。
 */

const ACCOUNT = { name: "小明", uid: "1a2b3c4d5e6f7788" };

function build(): {
  modal: LocalSpaceModal;
  onClaim: ReturnType<typeof vi.fn>;
  onSkip: ReturnType<typeof vi.fn>;
  onAbort: ReturnType<typeof vi.fn>;
} {
  const onClaim = vi.fn();
  const onSkip = vi.fn();
  const onAbort = vi.fn();
  const modal = new LocalSpaceModal({} as never, { account: ACCOUNT, onClaim, onSkip, onAbort });
  modal.open();
  return { modal, onClaim, onSkip, onAbort };
}

/** 按 data-choice 取那张卡（文案会变，值不会）。 */
function card(modal: LocalSpaceModal, value: "claim" | "keep"): HTMLButtonElement {
  const found = modal.contentEl.querySelector<HTMLButtonElement>(`.yl-choice[data-choice="${value}"]`);
  if (!found) throw new Error(`弹窗里找不到选项卡「${value}」`);
  return found;
}

function buttonByText(modal: LocalSpaceModal, text: string): HTMLButtonElement {
  const found = Array.from(modal.contentEl.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === text,
  );
  if (!found) throw new Error(`弹窗里找不到按钮「${text}」`);
  return found;
}

describe("认领窗", () => {
  it("壳走统一弹窗：标题行图标 + 标题点明这件事的性质", () => {
    const { modal } = build();
    // 宽度/圆角/内距这些"弹窗长相"只在 ui/dialog.ts 里写一次 —— 这里只认类名
    expect(modal.modalEl.classList.contains("yl-dialog")).toBe(true);
    expect(modal.modalEl.querySelector(".yl-dialog-mark")).not.toBeNull();
    expect(modal.contentEl.textContent).toContain("这台机器上还有没认领的学习数据");
  });

  it("正文点名账号，并把两条路的后果都写出来", () => {
    const { modal } = build();
    const text = modal.contentEl.textContent ?? "";
    expect(text).toContain("小明（UID 1a2b3c4d）");
    // 选"不认领"之后新账号看到的是空的 —— 不说清楚用户会以为是 bug
    expect(text).toContain("空的学习数据");
    // 选哪个都不删东西：用户最怕的是这个
    expect(text).toContain("都不会删掉任何东西");
  });

  it("两张卡都是可点的按钮，初始都没选中（不预选 = 最不易误操作）", () => {
    const { modal } = build();
    const cards = modal.contentEl.querySelectorAll<HTMLButtonElement>(".yl-choice");
    expect(cards).toHaveLength(2);
    for (const el of Array.from(cards)) {
      expect(el.tagName).toBe("BUTTON");
      expect(el.classList.contains("is-selected")).toBe(false);
      expect(el.getAttribute("aria-checked")).toBe("false");
    }
  });

  it("🔥 没选之前「确定」是禁用的 —— 不让人稀里糊涂点下去", () => {
    const { modal, onClaim, onSkip } = build();
    const ok = buttonByText(modal, "确定");
    expect(ok.disabled).toBe(true);
    // 就算硬点也不该有任何反应（防御性：禁用的按钮在真实浏览器里收不到 click）
    ok.click();
    expect(onClaim).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("点一张卡：只有它变选中，且「确定」解禁", () => {
    const { modal } = build();
    card(modal, "claim").click();
    expect(card(modal, "claim").classList.contains("is-selected")).toBe(true);
    expect(card(modal, "claim").getAttribute("aria-checked")).toBe("true");
    expect(card(modal, "keep").classList.contains("is-selected")).toBe(false);
    expect(buttonByText(modal, "确定").disabled).toBe(false);
  });

  it("单选：改点另一张，前一张回到未选中", () => {
    const { modal } = build();
    card(modal, "claim").click();
    card(modal, "keep").click();
    expect(card(modal, "claim").classList.contains("is-selected")).toBe(false);
    expect(card(modal, "keep").classList.contains("is-selected")).toBe(true);
  });

  it("选中「认领给 <账号>」+ 确定 → 只调 onClaim", () => {
    const { modal, onClaim, onSkip, onAbort } = build();
    card(modal, "claim").click();
    buttonByText(modal, "确定").click();
    expect(onClaim).toHaveBeenCalledTimes(1);
    expect(onSkip).not.toHaveBeenCalled();
    expect(onAbort).not.toHaveBeenCalled();
    // 关窗要走 onClose 的收尾（内容清空 + 盒子类名摘干净）
    expect(modal.contentEl.textContent).toBe("");
    expect(modal.modalEl.classList.contains("yl-dialog")).toBe(false);
  });

  it("选中「留在匿名空间」+ 确定 → 只调 onSkip", () => {
    const { modal, onClaim, onSkip, onAbort } = build();
    card(modal, "keep").click();
    buttonByText(modal, "确定").click();
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onClaim).not.toHaveBeenCalled();
    expect(onAbort).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toBe("");
  });

  it("🔥「放弃登录」是第三条路：丢掉这次登录，两条数据路都不走", () => {
    const { modal, onClaim, onSkip, onAbort } = build();
    buttonByText(modal, "放弃登录").click();
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(onClaim).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toBe("");
  });

  it("🔥 必答题锁死：什么都没选时直接 close() 关不掉", () => {
    const { modal, onAbort } = build();
    modal.close();
    expect(onAbort).not.toHaveBeenCalled();
    // 关不掉 = onClose 的收尾没跑：内容还在、盒子类名还在
    expect(modal.contentEl.textContent).not.toBe("");
    expect(modal.modalEl.classList.contains("yl-dialog")).toBe(true);
    expect(modal.modalEl.classList.contains("yl-dialog-locked")).toBe(true);
  });

  it("🔥 Esc 被拦在作用域里：锁定的弹窗按 Esc 也关不掉", () => {
    const { modal } = build();
    const scope = (modal as unknown as { scope: Scope }).scope;
    // 拦下了（handler 返回 false = 阻止默认关窗）
    expect(scope.triggerEscape()).toBe(false);
    expect(modal.modalEl.classList.contains("yl-dialog")).toBe(true);
  });

  it("🔥 一旦走了某条路，锁定解除（否则 close() 会被守卫拦下）", () => {
    const { modal } = build();
    card(modal, "keep").click();
    buttonByText(modal, "确定").click();
    expect(modal.contentEl.textContent).toBe("");
    expect(modal.modalEl.classList.contains("yl-dialog-locked")).toBe(false);
  });
});
