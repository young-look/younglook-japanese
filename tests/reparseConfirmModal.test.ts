// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "./obsidianDom";

// 必须先装 DOM 扩展再 new 弹窗（搭壳时才碰 DOM，import 顺序无忧）
installObsidianDomHelpers();

import { ReparseConfirmModal } from "../src/views/study/ReparseConfirmModal";

/**
 * 「重新解析」确认窗的契约（2026-10-08 用户拍板）。
 *
 * 一句话：**花钱的动作要先问一句**。这张窗是学习页上唯一在"再花一次钱"之前
 * 拦一下的地方，所以三条都得钉住 ——
 *   1. 壳走全站统一弹窗（居中竖版），不是自己写一套；
 *   2. 正文按**实际生效的轨道**说话（内置模型扣余额 / 自定义 Key 不扣余额）；
 *   3.「重新解析」才回调，「再想想」什么都不做。
 *
 * 哪一条断了这里必须红：说错"扣谁的"比不提醒更伤（用户以为免费，实际在扣钱）。
 */

function build(aiMode: "off" | "byok" | "hosted", onConfirm = vi.fn()): {
  modal: ReparseConfirmModal;
  onConfirm: ReturnType<typeof vi.fn>;
} {
  const modal = new ReparseConfirmModal({} as never, { aiMode, onConfirm });
  modal.open();
  return { modal, onConfirm };
}

function buttonByText(modal: ReparseConfirmModal, text: string): HTMLButtonElement {
  const found = Array.from(modal.contentEl.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === text,
  );
  if (!found) throw new Error(`弹窗里找不到按钮「${text}」`);
  return found;
}

describe("重新解析确认窗", () => {
  it("壳走统一弹窗：居中竖版档 + 标题行图标", () => {
    const { modal } = build("hosted");
    // 宽度/圆角/内距/底栏这些"弹窗长相"只在 ui/dialog.ts 里写一次 —— 这里只认
    // 它挂上的类名，不去量像素（量像素的断言会在换壳那天集体腐坏）
    expect(modal.modalEl.classList.contains("yl-dialog")).toBe(true);
    expect(modal.modalEl.classList.contains("yl-dialog-center")).toBe(true);
    expect(modal.modalEl.querySelector(".yl-dialog-mark")).not.toBeNull();
    expect(modal.contentEl.textContent).toContain("重新解析这一句吗？");
  });

  it("内置模型：正文说清「只重算下方解读」以及按用量从余额扣费", () => {
    const { modal } = build("hosted");
    // 花的是钱，所以"花了钱换回什么"必须说准：只重算下方那段文字，
    // 右侧句子卡的逐词释义**不重新解析**（2026-10-08 用户拍板）——
    // 想改那张卡走「纠」，正文里直接把落点说出来。
    expect(modal.contentEl.textContent).toContain("只重新生成下方的解读");
    expect(modal.contentEl.textContent).toContain("请点击「纠」按钮");
    expect(modal.contentEl.textContent).toContain("余额扣费");
    expect(modal.contentEl.textContent).not.toContain("不扣余额");
  });

  it("自定义 Key：正文如实说花自己的额度、不扣余额", () => {
    const { modal } = build("byok");
    expect(modal.contentEl.textContent).toContain("不扣余额");
    expect(modal.contentEl.textContent).toContain("只重新生成下方的解读");
  });

  it("点「重新解析」：关窗并回调 —— 这才是真的再花一次", () => {
    const { modal, onConfirm } = build("hosted");
    buttonByText(modal, "重新解析").click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // onClose 把内容清干净（弹窗实例可能被复用，残留的内容会带进下一次）
    expect(modal.contentEl.textContent).toBe("");
    expect(modal.modalEl.classList.contains("yl-dialog")).toBe(false);
  });

  it("点「再想想」：关掉窗，什么都不发生（不回调、不扣费）", () => {
    const { modal, onConfirm } = build("hosted");
    buttonByText(modal, "再想想").click();
    expect(onConfirm).not.toHaveBeenCalled();
    // 🔥 这颗钮必须真能关掉窗（2026-10-08 用户实机点出过"关不掉"）——
    //    底栏默认行为曾经只写在注释里，没接 close。断言用 onClose 的产物：
    //    内容清空 + 盒子类名摘干净。
    expect(modal.contentEl.textContent).toBe("");
    expect(modal.modalEl.classList.contains("yl-dialog")).toBe(false);
  });
});
