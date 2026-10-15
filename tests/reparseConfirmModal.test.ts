// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "./obsidianDom";

// 必须先装 DOM 扩展再 new 弹窗（搭壳时才碰 DOM，import 顺序无忧）
installObsidianDomHelpers();

import {
  ReparseConfirmModal,
  type ReparseBlockState,
  type ReparseConfirmOpts,
} from "../src/views/study/ReparseConfirmModal";

/**
 * 「重新解析」确认窗的契约（2026-10-08 拍板，2026-10-15 升级成两块可选）。
 *
 * 一句话：**花钱的动作要先问一句**，而且现在还得**选清这次重算哪一块**。
 * 这张窗是学习页上唯一在"再花一次钱"之前拦一下的地方，所以这几条都得钉住 ——
 *   1. 壳走全站统一弹窗（居中竖版），不是自己写一套；
 *   2. 正文按**实际生效的轨道**说话（内置模型扣余额 / 自定义 Key 不扣余额）；
 *   3. **默认 = 缺哪块勾哪块**，两块都不缺才都勾；
 *   4. **一块都不勾 = 确认钮置灰**（点了没反应最像"坏了"，其实只是没选东西）；
 *   5. 悬停某一行要让背景那一块亮（onHighlight），关窗必须撤掉高亮；
 *   6. 点确认把**勾了什么**交出去，「再想想」什么都不做。
 *
 * 哪一条断了这里必须红：说错"扣谁的"比不提醒更伤（用户以为免费，实际在扣钱）；
 * 默认勾错则用户会为不想刷的那一块再付一次。
 */

const FULL: ReparseBlockState = { missing: false, note: "已有解读内容" };
const MISSING: ReparseBlockState = { missing: true, note: "还没有解读内容" };

function build(overrides: Partial<ReparseConfirmOpts> = {}): {
  modal: ReparseConfirmModal;
  onConfirm: ReturnType<typeof vi.fn>;
  onHighlight: ReturnType<typeof vi.fn>;
} {
  const onConfirm = vi.fn();
  const onHighlight = vi.fn();
  const modal = new ReparseConfirmModal({} as never, {
    aiMode: "hosted",
    explain: FULL,
    words: FULL,
    onHighlight,
    onConfirm,
    ...overrides,
  });
  modal.open();
  return { modal, onConfirm, onHighlight };
}

function buttonByText(modal: ReparseConfirmModal, text: string): HTMLButtonElement {
  const found = Array.from(modal.contentEl.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === text,
  );
  if (!found) throw new Error(`弹窗里找不到按钮「${text}」`);
  return found;
}

function rowFor(modal: ReparseConfirmModal, label: string): HTMLElement {
  const rows = Array.from(modal.contentEl.querySelectorAll<HTMLElement>(".yl-reparse-opt"));
  const found = rows.find((row) => row.textContent?.includes(label));
  if (!found) throw new Error(`弹窗里找不到选项「${label}」`);
  return found;
}

function boxFor(modal: ReparseConfirmModal, label: string): HTMLInputElement {
  const box = rowFor(modal, label).querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!box) throw new Error(`选项「${label}」上没有复选框`);
  return box;
}

describe("重新解析确认窗", () => {
  it("壳走统一弹窗：居中竖版档 + 标题行图标", () => {
    const { modal } = build();
    // 宽度/圆角/内距/底栏这些"弹窗长相"只在 ui/dialog.ts 里写一次 —— 这里只认
    // 它挂上的类名，不去量像素（量像素的断言会在换壳那天集体腐坏）
    expect(modal.modalEl.classList.contains("yl-dialog")).toBe(true);
    expect(modal.modalEl.classList.contains("yl-dialog-center")).toBe(true);
    expect(modal.modalEl.querySelector(".yl-dialog-mark")).not.toBeNull();
    expect(modal.contentEl.textContent).toContain("重新解析这一句吗？");
  });

  it("两块都给选项：名字与界面分区一致，各自带位置词兜底", () => {
    const { modal } = build();
    expect(rowFor(modal, "整句解读").textContent).toContain("左下");
    expect(rowFor(modal, "逐词释义").textContent).toContain("右上");
    // 旧口径（"只重算下方解读，要改词表请点纠"）**必须消失**：词表现在可以单独重刷了
    expect(modal.contentEl.textContent).not.toContain("只重新生成下方的解读");
    expect(modal.contentEl.textContent).not.toContain("请点击「纠」按钮");
  });

  it("内置模型：正文说清按用量从余额扣费", () => {
    const { modal } = build();
    expect(modal.contentEl.textContent).toContain("余额扣费");
    expect(modal.contentEl.textContent).not.toContain("不扣余额");
  });

  it("自定义 Key：正文如实说花自己的额度、不扣余额", () => {
    const { modal } = build({ aiMode: "byok" });
    expect(modal.contentEl.textContent).toContain("不扣余额");
  });

  it("默认勾选：两块都不缺 → 都勾", () => {
    const { modal } = build();
    expect(boxFor(modal, "整句解读").checked).toBe(true);
    expect(boxFor(modal, "逐词释义").checked).toBe(true);
    expect(modal.contentEl.textContent).toContain("将要重新生成：整句解读 + 逐词释义");
  });

  it("默认勾选：缺哪块勾哪块（缺词表 → 只勾词表）", () => {
    const { modal } = build({ words: { missing: true, note: "有 2 个词还没有释义" } });
    expect(boxFor(modal, "整句解读").checked).toBe(false);
    expect(boxFor(modal, "逐词释义").checked).toBe(true);
    expect(modal.contentEl.textContent).toContain("将要重新生成：逐词释义");
    // 缺的那行要把原因写出来（默认勾的就是它，用户得看懂为什么）
    expect(modal.contentEl.textContent).toContain("有 2 个词还没有释义");
  });

  it("勾选变了：摘要跟着变，确认钮按「有没有可做的」启停", () => {
    const { modal } = build();
    const confirm = buttonByText(modal, "重新解析");
    expect(confirm.disabled).toBe(false);

    // 整行可点（不只那个小方框）
    rowFor(modal, "逐词释义").click();
    expect(boxFor(modal, "逐词释义").checked).toBe(false);
    expect(modal.contentEl.textContent).toContain("将要重新生成：整句解读");

    // 一块都不勾 → 置灰，并说明原因
    rowFor(modal, "整句解读").click();
    expect(confirm.disabled).toBe(true);
    expect(modal.contentEl.textContent).toContain("两块都没勾");

    // 再点回来 → 又能确认
    rowFor(modal, "整句解读").click();
    expect(confirm.disabled).toBe(false);
  });

  it("点「重新解析」：关窗并把勾选集交出去", () => {
    const { modal, onConfirm } = build();
    rowFor(modal, "整句解读").click(); // 只留词表
    buttonByText(modal, "重新解析").click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0]).toEqual({ explain: false, words: true });
    // onClose 把内容清干净（弹窗实例可能被复用，残留的内容会带进下一次）
    expect(modal.contentEl.textContent).toBe("");
    expect(modal.modalEl.classList.contains("yl-dialog")).toBe(false);
  });

  it("悬停某一行：背景里对应的那块亮起来；移开 / 关窗都要撤掉", () => {
    const { modal, onHighlight } = build();
    rowFor(modal, "整句解读").dispatchEvent(new MouseEvent("mouseenter"));
    expect(onHighlight).toHaveBeenLastCalledWith("explain");
    rowFor(modal, "逐词释义").dispatchEvent(new MouseEvent("mouseenter"));
    expect(onHighlight).toHaveBeenLastCalledWith("words");
    rowFor(modal, "逐词释义").dispatchEvent(new MouseEvent("mouseleave"));
    expect(onHighlight).toHaveBeenLastCalledWith(null);

    // 🔥 关窗（含 ESC / 点遮罩）也必须撤高亮 —— 漏了那张卡会一直亮着，像"还在解析"
    rowFor(modal, "整句解读").dispatchEvent(new MouseEvent("mouseenter"));
    modal.close();
    expect(onHighlight).toHaveBeenLastCalledWith(null);
  });

  it("点「再想想」：关掉窗，什么都不发生（不回调、不扣费）", () => {
    const { modal, onConfirm } = build();
    buttonByText(modal, "再想想").click();
    expect(onConfirm).not.toHaveBeenCalled();
    // 🔥 这颗钮必须真能关掉窗（2026-10-08 用户实机点出过"关不掉"）——
    //    底栏默认行为曾经只写在注释里，没接 close。断言用 onClose 的产物：
    //    内容清空 + 盒子类名摘干净。
    expect(modal.contentEl.textContent).toBe("");
    expect(modal.modalEl.classList.contains("yl-dialog")).toBe(false);
  });
});
