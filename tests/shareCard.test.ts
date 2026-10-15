/**
 * 分享卡链接的编码 —— 与网页端 `web/src/utils/shareCard.ts` 的
 * `parseShareQuery` 是同一份约定的两处实现，这里的断言就是那份契约：
 * 字段名、顺序无关紧要，**值必须原样可还原**。改格式两边一起改。
 */
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildShareUrl,
  localDay,
  savePngViaSystemDialog,
  shareCardFileName,
  type ShareCardPayload,
} from "../src/services/shareCard";

const PAYLOAD: ShareCardPayload = {
  nickname: "小满",
  streak: 37,
  level: 4,
  levelName: "风暴",
  date: "2026-10-09",
};

describe("buildShareUrl", () => {
  it("线上域名直接拼 /s/", () => {
    expect(buildShareUrl("https://younglook.cc", PAYLOAD)).toBe(
      "https://younglook.cc/s/?n=%E5%B0%8F%E6%BB%A1&s=37&l=4&t=%E9%A3%8E%E6%9A%B4&d=20261009",
    );
  });

  it("本机 vite 前端也走同一条路径", () => {
    expect(buildShareUrl("http://127.0.0.1:5173", PAYLOAD)).toContain(
      "http://127.0.0.1:5173/s/?",
    );
  });

  it("base 带尾斜杠不会拼出双斜杠", () => {
    expect(buildShareUrl("https://younglook.cc/", PAYLOAD)).toMatch(
      /^https:\/\/younglook\.cc\/s\/\?/u,
    );
  });

  it("昵称里的空格按 URLSearchParams 口径编码（+ 号），解析回来不断裂", () => {
    const url = buildShareUrl("https://younglook.cc", { ...PAYLOAD, nickname: "a b" });
    expect(url).toContain("n=a+b");
    const parsed = new URL(url).searchParams;
    expect(parsed.get("n")).toBe("a b");
    expect(parsed.get("s")).toBe("37");
  });
});

describe("localDay", () => {
  it("按本地时区取日（不是 UTC）", () => {
    expect(localDay(new Date(2026, 9, 9, 23, 59))).toBe("2026-10-09");
    expect(localDay(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01");
  });
});

describe("shareCardFileName", () => {
  it("默认名带日期、png 结尾（与网页端「保存图片」同一格式）", () => {
    expect(shareCardFileName("2026-10-15")).toBe("洋流日语-学习卡-2026-10-15.png");
  });

  it("日期缺失时兜底「今天」", () => {
    expect(shareCardFileName("")).toBe("洋流日语-学习卡-今天.png");
  });
});

describe("savePngViaSystemDialog", () => {
  /** 恰好 8 字节 —— PNG 文件头魔数，用来验 base64 → Buffer 的解码没跑偏。 */
  const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
  const PNG_HEAD = Buffer.from("iVBORw0KGgo=", "base64");

  /** 假扮 Obsidian 渲染进程：`window.require("electron")` 给出保存框。 */
  function stubElectron(showSaveDialog: (opts: unknown) => Promise<unknown>): void {
    (globalThis as unknown as { window: unknown }).window = {
      require: (name: string) =>
        name === "electron" ? { remote: { dialog: { showSaveDialog } } } : undefined,
    };
  }

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  it("拿不到系统保存框时返回 undefined（调用方据此告知用户没保存成）", async () => {
    // node 环境里没有 window —— 函数自己兜住，不炸
    await expect(savePngViaSystemDialog("a.png", PNG_DATA_URL)).resolves.toBeUndefined();
  });

  it("用户取消保存框返回 null，一个字节都不写", async () => {
    stubElectron(() => Promise.resolve({ canceled: true }));
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    await expect(savePngViaSystemDialog("a.png", PNG_DATA_URL)).resolves.toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("选了位置就写盘：补 .png 后缀，落盘的是解码后的 PNG 字节", async () => {
    const showSaveDialog = vi.fn(() =>
      Promise.resolve({ filePath: "/tmp/洋流日语-学习卡-2026-10-15" }),
    );
    stubElectron(showSaveDialog);
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    const saved = await savePngViaSystemDialog("洋流日语-学习卡-2026-10-15.png", PNG_DATA_URL);

    expect(saved).toBe("/tmp/洋流日语-学习卡-2026-10-15.png");
    expect(write).toHaveBeenCalledTimes(1);
    const [path, buf] = write.mock.calls[0] as unknown as [string, Buffer];
    expect(path).toBe("/tmp/洋流日语-学习卡-2026-10-15.png");
    expect(buf.equals(PNG_HEAD)).toBe(true);
    // 保存框带默认名 + PNG 过滤器（用户自己选位置的那一步）
    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "洋流日语-学习卡-2026-10-15.png",
        filters: [{ name: "图片", extensions: ["png"] }],
      }),
    );
  });
});
