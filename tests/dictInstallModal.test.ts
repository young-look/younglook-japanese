// @vitest-environment jsdom
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "./obsidianDom";

installObsidianDomHelpers();

import { DictInstallModal } from "../src/views/DictInstallModal";
import type { DictManifest } from "../src/services/dictInstall";

/**
 * 「安装日语词典」弹窗（2026-10-11 用户拍板：只在两处提醒）。
 *
 * 这组用例钉的是**用户看得见的承诺**：
 *  · 正文必须说清三件事（多大 / 只下一次且离线可用 / 只装本机不上传）；
 *  · 首次进学习页与点抄写「提示」是**同一个弹窗**，只有副标题不同
 *    （同一件事的两个入口，长相不能有两种）；
 *  · 取消是「以后再说」而不是「取消下载」—— 它不阻塞任何东西。
 *
 * ⚠️ 下载一律把 `fetch` 换成桩：单测不该打真网络（`x.cc` 这个域名是真存在的，
 *    真发出去会拿到别的东西，用例就变成看运气）。
 */

const CONTENT = "BASE-DATA";
const MANIFEST: DictManifest = {
  version: "1",
  files: [
    {
      name: "base.dat.gz",
      url: "https://x.cc/storage/assets/dict/base.dat.gz",
      sha256: createHash("sha256").update(CONTENT).digest("hex"),
      bytes: 17 << 20,
    },
  ],
};

const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yl-dict-modal-"));
  temps.push(dir);
  return dir;
}

function open(reason: "first-run" | "hint", pluginDir = "/nowhere", onInstalled = vi.fn()) {
  const modal = new DictInstallModal({} as never, { manifest: MANIFEST, pluginDir, reason, onInstalled });
  modal.open();
  return { modal, onInstalled };
}

function textOf(root: HTMLElement): string {
  return root.textContent ?? "";
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(text));
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(CONTENT, { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("安装词典弹窗", () => {
  it("正文说清三件事：多大 / 只下一次且离线可用 / 只装本机不上传", () => {
    const { modal } = open("first-run");
    const body = textOf(modal.contentEl);
    expect(body).toContain("17 MB");
    expect(body).toContain("只下载这一次");
    expect(body).toContain("离线也能用");
    expect(body).toContain("不会被上传");
  });

  it("两个入口共用一个弹窗，只有标题下那行小字按场景换", () => {
    const first = open("first-run").modal;
    const hint = open("hint").modal;
    expect(textOf(first.contentEl)).toContain("装好之后才能自动给单词注音");
    expect(textOf(hint.contentEl)).toContain("抄写提示要用它才出得来");
    // 标题是同一个 —— 同一件事不该长两副样子
    expect(first.contentEl.querySelector(".yl-dialog-title")?.textContent).toBe("安装日语词典");
    expect(hint.contentEl.querySelector(".yl-dialog-title")?.textContent).toBe("安装日语词典");
  });

  it("取消钮是「以后再说」（它不阻塞任何东西），主按钮带体积", () => {
    const { modal } = open("hint");
    expect(buttonByText(modal.contentEl, "以后再说")).toBeDefined();
    expect(buttonByText(modal.contentEl, "下载词典")?.textContent).toContain("17 MB");
  });

  it("装好：关窗 + 通知上层就地生效（清缓存、重跑注音那一下）", async () => {
    const pluginDir = tempDir();
    const { modal, onInstalled } = open("hint", pluginDir, vi.fn());
    buttonByText(modal.contentEl, "下载词典")!.click();

    await vi.waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1));
    expect(fs.readFileSync(path.join(pluginDir, "dict", "base.dat.gz"), "utf8")).toBe(CONTENT);
  });

  it("下载失败：窗不关、主按钮变「重试」、状态行说清原因（词典没装上不阻塞任何东西）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("断网");
    }));
    const { modal, onInstalled } = open("hint", tempDir(), vi.fn());
    buttonByText(modal.contentEl, "下载词典")!.click();

    await vi.waitFor(() => {
      expect(textOf(modal.contentEl)).toContain("下载失败");
    });
    expect(buttonByText(modal.contentEl, "重试")).toBeDefined();
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it("sha 对不上也要说成「下载失败」而不是静默装上一本坏词典", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("被中间人换过", { status: 200 })));
    const pluginDir = tempDir();
    const { modal } = open("hint", pluginDir, vi.fn());
    buttonByText(modal.contentEl, "下载词典")!.click();

    await vi.waitFor(() => {
      expect(textOf(modal.contentEl)).toContain("校验失败");
    });
    expect(fs.existsSync(path.join(pluginDir, "dict"))).toBe(false);
  });
});
