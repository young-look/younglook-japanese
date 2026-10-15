/**
 * 画卡的兜底路径：canvas 拿不到 2D 上下文时**干净地拒绝**，不画半张卡。
 *
 * 真正"画出来长什么样"由坐标保证 —— `drawShareCard` 与网页端
 * `web/src/utils/shareCard.ts` 的同名函数同坐标（见 services/shareCard.ts
 * 里的警语），那半边由 demo 稿和网页页面的实际渲染背书，node 里没有画布，
 * 这里只守住"画不了就说画不了"这一句：弹窗靠它把占位文字换成
 * 「卡片画失败了 —— 用下面的扫码分享也一样」。
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { drawShareCard, type ShareCardPayload } from "../src/services/shareCard";

const PAYLOAD: ShareCardPayload = {
  nickname: "小满",
  streak: 37,
  level: 4,
  levelName: "风暴",
  date: "2026-10-09",
};

describe("drawShareCard", () => {
  it("画布不可用时拒绝（而不是抛出一半的卡）", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await expect(
      drawShareCard(PAYLOAD, {
        otterSrc: "data:image/png;base64,iVBORw0KGgo=",
        qrText: "https://younglook.cc/s/?n=x",
      }),
    ).rejects.toThrow("canvas unavailable");
    vi.restoreAllMocks();
  });
});
