import { describe, expect, it } from "vitest";
import {
  atClipEnd,
  clipLengthMs,
  clipRatio,
  formatClipClock,
  pullBackMs,
  seekTargetMs,
  shouldRestart,
} from "../src/services/clipPlayback";

/**
 * 软切片播放窗口的边界用例。
 *
 * 这两条是用户实测报出来的缺陷（2026-09-25），不是假想：
 * 「播完再点播放没反应」和「进度条显示整片时长」。前者由 shouldRestart 守，
 * 后者由 formatClipClock / clipRatio 的口径守。
 */

const START = 12_000;
const END = 16_500;

describe("播放窗口的边界", () => {
  it("播到句尾之后再点播放 → 判定为需要从头重播", () => {
    expect(shouldRestart(END, START, END)).toBe(true);
    expect(shouldRestart(END + 900, START, END)).toBe(true);
    // 末尾容差内也算结尾（60fps 下最后一帧可能停在 16.4s）
    expect(shouldRestart(END - 100, START, END)).toBe(true);
  });

  it("播到一半点暂停再播 → 不该被拉回开头", () => {
    expect(shouldRestart(START + 1200, START, END)).toBe(false);
    expect(atClipEnd(START + 1200, END)).toBe(false);
  });

  it("位置在窗口之前（刚换句 / 用户往左拖过头）→ 也要从头", () => {
    expect(shouldRestart(START - 3000, START, END)).toBe(true);
  });

  it("播放器已经走到文件末尾（字幕尾巴超出片长）→ 也要从头", () => {
    // 这句话的时间窗末尾超了文件长度，播放器会 ended，此时不该让浏览器自己从 0 播
    expect(shouldRestart(END - 800, START, END, true)).toBe(true);
  });

  it("拖到窗口外会被拉回来，窗口内不动它", () => {
    expect(pullBackMs(START - 500, START, END)).toBe(START);
    expect(pullBackMs(END + 500, START, END)).toBe(END);
    expect(pullBackMs(START + 10, START, END)).toBeNull();
    // 容差内的抖动不管：否则每次播放都会被 seek 打断
    expect(pullBackMs(START - 20, START, END)).toBeNull();
  });

  it("进度条比例永远落在 0~1", () => {
    expect(clipRatio(START, START, END)).toBe(0);
    expect(clipRatio(END, START, END)).toBe(1);
    expect(clipRatio(START + 2250, START, END)).toBeCloseTo(0.5, 3);
    expect(clipRatio(START - 5000, START, END)).toBe(0);
    expect(clipRatio(END + 5000, START, END)).toBe(1);
  });

  it("拖进度条得到的时间点永远在窗口内", () => {
    expect(seekTargetMs(0, START, END)).toBe(START);
    expect(seekTargetMs(1, START, END)).toBe(END);
    expect(seekTargetMs(-3, START, END)).toBe(START);
    expect(seekTargetMs(9, START, END)).toBe(END);
  });

  it("窗口异常时不会算出 0 或负数长度", () => {
    expect(clipLengthMs(5000, 5000)).toBeGreaterThan(0);
    expect(clipLengthMs(5000, 4000)).toBeGreaterThan(0);
  });

  it("时钟只显示本句范围，不出现整片时长", () => {
    expect(formatClipClock(0)).toBe("0:00.0");
    expect(formatClipClock(4200)).toBe("0:04.2");
    expect(formatClipClock(999)).toBe("0:01.0");
    expect(formatClipClock(65_400)).toBe("1:05.4");
    // 整片 3 分多钟也不该出现在这里 —— 学习页看到的永远是本句长度
    expect(formatClipClock(4500)).not.toContain("3:");
  });

});

/**
 * 翻句的自动播放已移除（2026-09-29 用户定：突然出声吓人，切句一律停住）。
 * 这里没有可断言的纯函数了 —— 调用方直接传 `false`，行为靠 showSlice 的实现保证。
 */
