import { describe, expect, it } from "vitest";
import { STREAK_GRACE, streakOf } from "../src/services/personalStats";

/**
 * 连续学习（streak）的宽限口径用例 —— 2026-10-04 用户拍板：
 * 中间断 ≤ STREAK_GRACE(2) 天链仍算连续，按**学习日**计数
 * （学 3 天 → 断 2 天 → 再学 1 天 = 连续 4 天）。
 *
 * 火焰三态随 current 一起守：active（今天已学）/ grace（断 1~2 天）/
 * idle（从没学或断超宽限，归零）。
 */

const TODAY = "2026-10-04";

/** 以 TODAY 为基准，往回第 i 天（0 = 今天）有学习的日子集合 → counts 表 */
function countsFrom(offsets: number[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const i of offsets) {
    const [y, m, d] = TODAY.split("-").map(Number);
    const day = new Date(y, m - 1, d - i);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(
      day.getDate(),
    ).padStart(2, "0")}`;
    counts.set(key, 3);
  }
  return counts;
}

describe("连续学习：宽限桥接", () => {
  it("用户的原始例子：学 3 天 → 断 2 天 → 今天学了 = 连续 4 天", () => {
    // 3 天在前（-5 -4 -3），第 4、5 天（-2 -1）没学，第 6 天 = 今天
    const s = streakOf(countsFrom([5, 4, 3, 0]), TODAY);
    expect(s.current).toBe(4);
    expect(s.state).toBe("active");
  });

  it("断 1 天也接上；今天还没学 = grace，宽限随断的天数递减", () => {
    const s = streakOf(countsFrom([4, 3, 2, 1]), TODAY);
    expect(s.current).toBe(4);
    expect(s.state).toBe("grace");
    expect(s.graceLeft).toBe(1);

    const s2 = streakOf(countsFrom([5, 4, 3, 2]), TODAY);
    expect(s2.state).toBe("grace");
    expect(s2.graceLeft).toBe(0);
  });

  it("断超过宽限期（3 天）就断链：归零、变灰", () => {
    const s = streakOf(countsFrom([6, 5, 4]), TODAY);
    expect(s.current).toBe(0);
    expect(s.state).toBe("idle");
    expect(s.max).toBe(3); // 那段历史链还在 max 里
  });

  it("每天连续学习 = 平铺天数", () => {
    const s = streakOf(countsFrom([3, 2, 1, 0]), TODAY);
    expect(s.current).toBe(4);
    expect(s.state).toBe("active");
    expect(s.max).toBe(4);
  });

  it("max 用同一口径：两段链被 2 天断点桥成一段", () => {
    // -7 学过，-6 -5 断，-4 又学：日历差 3 ≤ STREAK_GRACE+1，接成一条 2 天的链；
    // 但 -4 距今天 4 天 > 宽限，当前链已断 → current 0、max 2
    const s = streakOf(countsFrom([7, 4]), TODAY);
    expect(s.current).toBe(0);
    expect(s.state).toBe("idle");
    expect(s.max).toBe(2);
  });
});

describe("连续学习：状态与边界", () => {
  it("空记录：idle、0 天、max 0", () => {
    const s = streakOf(new Map(), TODAY);
    expect(s.current).toBe(0);
    expect(s.max).toBe(0);
    expect(s.state).toBe("idle");
    expect(s.graceLeft).toBe(0);
  });

  it("只学过一天且就是今天：active、1 天", () => {
    const s = streakOf(countsFrom([0]), TODAY);
    expect(s.current).toBe(1);
    expect(s.state).toBe("active");
  });

  it("宽限是 2：常量与本文件用例口径一致", () => {
    expect(STREAK_GRACE).toBe(2);
  });
});
