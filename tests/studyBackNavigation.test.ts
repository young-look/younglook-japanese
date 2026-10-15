// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "./obsidianDom";
import type { WorkspaceLeaf } from "obsidian";
import { StudyView, type CardOrigin } from "../src/views/StudyView";
import type YoungLookPlugin from "../src/main";

// 卡片构件（buildReadAloud / buildCopyPractice）在构造 StudyView 时就跑，先装 DOM 扩展
installObsidianDomHelpers();

/**
 * 学习卡片顶栏「返回」的**来路契约**（2026-10-14 用户拍板）。
 *
 * 「返回」不是一律回选集页 —— 它退到卡片的来路（见 StudyView 的 CardOrigin）：
 *
 * · `"history"` —— 卡片是历史页「打开」**新开 tab** 跳进来的（main.jumpToSentence），
 *   这条路绕过了选集页，上一个页面是历史页：返回要**收回这张卡片**（关掉它自己那个
 *   tab）并把用户送回历史页，**不能**渲染选集页。
 * · `"list"`    —— 从选集页进来的：返回 = 渲染选集页，不碰 tab、不去历史页。
 *
 * 钉住这条是因为它踩过一次：第一版只把文案「退出」改成「返回」，行为没动 —— 从历史页
 * 跳进来的卡片返回后落到选集页，用户根本回不到历史页。
 */

/** 造一个"已经进了卡片、来路是 origin"的 StudyView，并把三处外部动作换成间谍。 */
function setup(origin: CardOrigin) {
  const detach = vi.fn();
  const leaf = { detach } as unknown as WorkspaceLeaf;
  const revealHistoryPage = vi.fn();
  const plugin = { revealHistoryPage } as unknown as YoungLookPlugin;
  const view = new StudyView(leaf, plugin);
  // 私有态直接摆位：进卡片时由 enterEpisode 写，这里只是复现"已经在卡片里"
  (view as unknown as { cardOrigin: CardOrigin }).cardOrigin = origin;
  // 选集页那条路要渲染整个列表（要库、要 DOM），这不是本用例要验的东西 —— 拦掉
  const render = vi
    .spyOn(view as unknown as { render(): Promise<void> }, "render")
    .mockResolvedValue(undefined);
  const exitEpisode = (view as unknown as { exitEpisode(): Promise<void> }).exitEpisode();
  return { exitEpisode, detach, revealHistoryPage, render };
}

describe("学习卡片「返回」按来路退", () => {
  it("从历史页「打开」进来的：收回这张卡片、回历史页，不渲染选集页", async () => {
    const { exitEpisode, detach, revealHistoryPage, render } = setup("history");
    await exitEpisode;
    expect(revealHistoryPage).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
  });

  it("从选集页进来的：回选集页（渲染列表），不关 tab、不去历史页", async () => {
    const { exitEpisode, detach, revealHistoryPage, render } = setup("list");
    await exitEpisode;
    expect(render).toHaveBeenCalledTimes(1);
    expect(revealHistoryPage).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
  });
});
