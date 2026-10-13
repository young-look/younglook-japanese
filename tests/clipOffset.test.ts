import { describe, expect, it } from "vitest";
import {
  OFFSET_STEP_MS,
  effectiveWindow,
  formatOffset,
  normalizeOffset,
  offsetFromPlayhead,
  stepOffset,
} from "../src/services/clipOffset";

/**
 * 时间校准的纯逻辑用例。
 *
 * 校准**只平移我们自己的播放时间窗**，不碰视频/字幕文件 ——
 * 这里的用例守两件事：数字可信（估不出就别乱给）、原始时间戳不被污染。
 */

describe("偏移的规范化与显示", () => {
  it("收进 ±10 秒并量化到 10ms", () => {
    expect(normalizeOffset(499.9)).toBe(500);
    expect(normalizeOffset(501.4)).toBe(500);
    expect(normalizeOffset(99_999)).toBe(10_000);
    expect(normalizeOffset(-99_999)).toBe(-10_000);
    expect(normalizeOffset(Number.NaN)).toBe(0);
  });

  it("显示口径：带正负号，零就是「不偏移」", () => {
    expect(formatOffset(0)).toBe("不偏移");
    expect(formatOffset(500)).toBe("+0.50 秒");
    expect(formatOffset(-500)).toBe("−0.50 秒");
  });
});

describe("窗口平移", () => {
  it("整体平移，长度不变", () => {
    expect(effectiveWindow({ startMs: 10_000, endMs: 12_000 }, OFFSET_STEP_MS)).toEqual({
      startMs: 10_500,
      endMs: 12_500,
    });
    expect(effectiveWindow({ startMs: 10_000, endMs: 12_000 }, -500)).toEqual({
      startMs: 9_500,
      endMs: 11_500,
    });
  });

  it("不偏移时原样返回（不要凭空造新对象的值）", () => {
    const window = { startMs: 4_200, endMs: 6_000 };
    expect(effectiveWindow(window, 0)).toEqual(window);
  });

  it("往负方向推到头也不许出现负数时间", () => {
    const shifted = effectiveWindow({ startMs: 200, endMs: 1200 }, -500);
    expect(shifted.startMs).toBe(0);
    expect(shifted.endMs).toBeGreaterThan(shifted.startMs);
  });

  it("原始窗口对象不被改动", () => {
    const window = { startMs: 1_000, endMs: 2_000 };
    effectiveWindow(window, 500);
    expect(window).toEqual({ startMs: 1_000, endMs: 2_000 });
  });
});

describe("手动校准的两个入口", () => {
  it("±0.5s 是步进，不是重新赋值", () => {
    expect(stepOffset(0, 1)).toBe(500);
    expect(stepOffset(500, 1)).toBe(1_000);
    expect(stepOffset(500, -1)).toBe(0);
    expect(stepOffset(0, -1)).toBe(-500);
    expect(stepOffset(9_900, 1)).toBe(10_000); // 顶到上限
  });

  it("「以当前位置为准」= 播放位置 − 字幕句首", () => {
    // 字幕 10.0s 才开始，用户听到人声在 10.6s → 整条视频要 +0.6s
    expect(offsetFromPlayhead(10_600, 10_000)).toBe(600);
    // 人声比字幕早 → 负偏移
    expect(offsetFromPlayhead(9_500, 10_000)).toBe(-500);
    // 夸张的值会被收进上限，不会写出一个荒谬的偏移
    expect(offsetFromPlayhead(500_000, 10_000)).toBe(10_000);
  });
});
