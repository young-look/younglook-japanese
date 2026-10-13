// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "./obsidianDom";

// 必须先装 DOM 扩展再 new 弹窗（搭壳时才碰 DOM，import 顺序无忧）
installObsidianDomHelpers();

import { DialogModal, type DialogAction, type DialogFootOptions } from "../src/ui/dialog";

/**
 * 统一弹窗壳 `DialogModal` 的底栏契约。
 *
 * 这一条是补票：2026-10-08「重新解析」确认窗的「再想想」**点了毫无反应** ——
 * `fillFoot` 的注释写着「默认文案取消、点了关窗」，实现却只是 `cancel.onClick?.()`，
 * 默认那颗 `{ text: "取消" }` 根本没接 close。全项目当时只有新加的那颗窗没传
 * `onClick`，所以只有它关不掉；其余四个弹窗各自手写了一遍 `close()` 才碰巧没事。
 *
 * ⇒ 默认行为必须落在实现里，不能只写在注释里。这组用例钉死两件事：
 *    不给 onClick = 关窗；给了就以调用方的为准（要额外副作用的那几个弹窗靠这条）。
 */

/** 只搭壳、底栏交给用例喂参数的最小弹窗 */
class ProbeModal extends DialogModal {
  lastFoot: HTMLElement | null = null;

  constructor(
    private readonly primary: DialogAction,
    private readonly footOpts: DialogFootOptions,
  ) {
    super({} as never);
  }

  onOpen(): void {
    const { foot } = this.buildShell({ title: "探针", variant: "center" });
    this.lastFoot = foot;
    this.fillFoot(foot, this.primary, this.footOpts);
  }
}

function open(primary: DialogAction, footOpts: DialogFootOptions): ProbeModal {
  const modal = new ProbeModal(primary, footOpts);
  modal.open();
  return modal;
}

function buttonByText(modal: ProbeModal, text: string): HTMLButtonElement {
  const foot = modal.lastFoot;
  const found = foot
    ? Array.from(foot.querySelectorAll("button")).find((b) => b.textContent === text)
    : undefined;
  if (!found) throw new Error(`底栏里找不到按钮「${text}」`);
  return found;
}

describe("弹窗底栏", () => {
  it("取消钮不给 onClick：点它**就是关窗**（不是点了没反应）", () => {
    const modal = open({ text: "确定" }, { cancel: { text: "取消" } });

    buttonByText(modal, "取消").click();

    // 关窗 = 跑完 onClose：内容清空、盒子的类名摘干净（弹窗实例可能被复用）
    expect(modal.contentEl.textContent).toBe("");
    expect(modal.modalEl.classList.contains("yl-dialog")).toBe(false);
  });

  it("不写 cancel：默认那颗「取消」同样关窗", () => {
    const modal = open({ text: "确定" }, {});
    buttonByText(modal, "取消").click();
    expect(modal.contentEl.textContent).toBe("");
  });

  it("取消钮给了 onClick：先关窗再跑调用方的副作用，且只跑一次", () => {
    const onCancel = vi.fn();
    const modal = open(
      { text: "确定" },
      {
        cancel: {
          text: "暂不",
          onClick: () => {
            modal.close();
            onCancel();
          },
        },
      },
    );

    buttonByText(modal, "暂不").click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(modal.contentEl.textContent).toBe("");
  });

  it("cancel: null：只要一颗主钮（没有取消）", () => {
    const modal = open({ text: "知道了" }, { cancel: null });
    expect(buttonByText(modal, "知道了")).toBeTruthy();
    expect(Array.from(modal.contentEl.querySelectorAll("button"))).toHaveLength(1);
  });

  it("主钮点了不自动关窗：关不关由调用方决定（表单类弹窗还要接着用）", () => {
    const onPrimary = vi.fn();
    const modal = open({ text: "确定", onClick: onPrimary }, { cancel: null });

    buttonByText(modal, "确定").click();

    expect(onPrimary).toHaveBeenCalledTimes(1);
    // 底栏重画/校验失败还要留着窗，所以主钮**不能**顺手 close
    expect(modal.contentEl.textContent).not.toBe("");
  });
});
