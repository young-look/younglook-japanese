/**
 * 分享卡链接的编码 —— 与网页端 `web/src/utils/shareCard.ts` 的
 * `parseShareQuery` 是同一份约定的两处实现，这里的断言就是那份契约：
 * 字段名、顺序无关紧要，**值必须原样可还原**。改格式两边一起改。
 */
import { describe, expect, it } from "vitest";

import { buildShareUrl, localDay, type ShareCardPayload } from "../src/services/shareCard";

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
