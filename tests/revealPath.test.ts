// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openFolderInShell,
  revealInShell,
  setRequireImpl,
} from "../src/services/revealPath";

/**
 * 「在访达中显示」（2026-10-21 从 spawn 命令行改成 Electron shell）。
 *
 * 钉两件事：
 *  · 拿到 shell 时，路径原样交给它（`showItemInFolder` 选中 / `openPath` 打开），
 *    我们不自己拼命令行、也不自己判断平台；
 *  · **拿不到 electron 就返回 false，绝不抛** —— 调用方正靠这个返回值决定
 *    要不要退化成"把路径复制到剪贴板"。
 */
function stubElectron(shell: unknown, boom = false): void {
  setRequireImpl(
    boom
      ? () => {
          throw new Error("no electron here");
        }
      : () => ({ shell }),
  );
}

afterEach(() => {
  setRequireImpl(null);
});

describe("revealInShell", () => {
  it("把路径交给 Electron 的 showItemInFolder（选中，不是打开）", () => {
    const shell = { showItemInFolder: vi.fn(), openPath: vi.fn() };
    stubElectron(shell);

    expect(revealInShell("/Users/me/あ.mp4")).toBe(true);
    expect(shell.showItemInFolder).toHaveBeenCalledWith("/Users/me/あ.mp4");
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("空路径：一个系统调用都不发", () => {
    const shell = { showItemInFolder: vi.fn(), openPath: vi.fn() };
    stubElectron(shell);
    expect(revealInShell("   ")).toBe(false);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("没有 electron（模块里没 shell / require 直接抛）：返回 false 不抛", () => {
    stubElectron(undefined);
    expect(revealInShell("/tmp/a.mp4")).toBe(false);

    stubElectron(undefined, true);
    expect(() => revealInShell("/tmp/a.mp4")).not.toThrow();
    expect(revealInShell("/tmp/a.mp4")).toBe(false);
  });
});

describe("openFolderInShell", () => {
  it("走 openPath，且不等它的 Promise（打开目录是瞬间的事）", () => {
    const shell = { showItemInFolder: vi.fn(), openPath: vi.fn(async () => "") };
    stubElectron(shell);

    expect(openFolderInShell("/Users/me/media")).toBe(true);
    expect(shell.openPath).toHaveBeenCalledWith("/Users/me/media");
  });

  it("系统报错（openPath 返回非空串）也不影响这次调用的结果", () => {
    const shell = {
      showItemInFolder: vi.fn(),
      openPath: vi.fn(async () => "Failed to open"),
    };
    stubElectron(shell);
    expect(openFolderInShell("/Users/me/media")).toBe(true);
  });

  it("没有 electron：返回 false 不抛", () => {
    stubElectron(undefined);
    expect(openFolderInShell("/Users/me/media")).toBe(false);
  });
});
