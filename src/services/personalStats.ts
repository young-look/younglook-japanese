/**
 * 个人中心的统计聚合 —— 全部**纯函数**，输入本地进度行，输出视图要的形状。
 *
 * 数据源：每条 ProgressRow 的 `completedAt`（完成三步的时刻）。
 * 一句完成 = 一分经验 = 热力图/趋势图上的一个计数。
 * 日期一律按**本地时区**取日（用户在哪个时区，"今天"就该是哪个今天）。
 */
import type { ProgressRow } from "../types/entities";

export interface DayCount {
  /** 'YYYY-MM-DD'（本地日期） */
  day: string;
  count: number;
}

export type StreakState = "active" | "grace" | "idle";

export interface Streak {
  /** 当前连续天数（按**学习日**计：中间断 ≤ STREAK_GRACE 天照旧接上） */
  current: number;
  /** 历史最长连续天数（同一口径） */
  max: number;
  /**
   * 火焰三态（2026-10-04 用户拍板）：
   * active = 连续中（今天已学，红）；
   * grace  = 宽限（最近一次学习在 1~2 天前，蓝/结冰，补学一天就恢复）；
   * idle   = 已熄灭（从未学过或断超过宽限期，灰，从 0 重计）。
   */
  state: StreakState;
  /** state=grace 时离熄灭还差几天（active 为 0，idle 无意义） */
  graceLeft: number;
}

/** 连续学习的宽限期：中间断最多这几天，链仍算连续（2026-10-04 定案）。 */
export const STREAK_GRACE = 2;

function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return localDay(new Date(y, m - 1, d + delta));
}

/** 两个本地日相差几天（b − a）。都取中午算，夏令时半天差不会滚进来。 */
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / 86400000);
}

/** 完成时刻 → 按本地日聚合的句数（只收 completedAt 非空的行）。 */
export function dayCounts(rows: Pick<ProgressRow, "completedAt">[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.completedAt) continue;
    const day = localDay(new Date(row.completedAt));
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return counts;
}

/**
 * 连续学习天数：按**学习日**计数，中间断 ≤ STREAK_GRACE 天由宽限桥接
 * （例：学 3 天 → 断 2 天 → 再学 1 天 = 连续 4 天）。锚点取最近一个学习日：
 * 它在今天（active）或宽限期内（grace）链就还活着，超过宽限（idle）归零。
 */
export function streakOf(counts: Map<string, number>, today = localDay(new Date())): Streak {
  const has = (day: string) => (counts.get(day) ?? 0) > 0;
  // today 可注入（测试用）；默认真实今天

  let anchor: string | null = null;
  for (let i = 0; i <= STREAK_GRACE; i += 1) {
    const day = shiftDay(today, -i);
    if (has(day)) {
      anchor = day;
      break;
    }
  }
  if (!anchor) return { current: 0, max: maxStreak(counts), state: "idle", graceLeft: 0 };

  const state: StreakState = anchor === today ? "active" : "grace";
  const graceLeft = STREAK_GRACE - dayDiff(anchor, today);

  // 从锚点往回数学习日；连续 miss 超过宽限就断，不再往前数
  let current = 0;
  let miss = 0;
  let cursor = anchor;
  while (miss <= STREAK_GRACE) {
    if (has(cursor)) {
      current += 1;
      miss = 0;
    } else {
      miss += 1;
    }
    cursor = shiftDay(cursor, -1);
  }
  return { current, max: Math.max(current, maxStreak(counts)), state, graceLeft };
}

function maxStreak(counts: Map<string, number>): number {
  const days = [...counts.keys()].filter((d) => (counts.get(d) ?? 0) > 0).sort();
  let max = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of days) {
    // 两个学习日之间隔 ≤ 宽限+1 个日历日（= 中间断 ≤ 宽限天）就接上
    run = prev && dayDiff(prev, day) <= STREAK_GRACE + 1 ? run + 1 : 1;
    prev = day;
    if (run > max) max = run;
  }
  return max;
}

/**
 * 热力图序列：以今天结尾、往前铺 `days` 天，并把开头**补齐到周一**
 * （列 = 一周，行 = 周一到周日，与网页端 Heatmap.vue 同构）。
 */
export function heatmapSeries(counts: Map<string, number>, days = 364): DayCount[] {
  const today = localDay(new Date());
  const out: DayCount[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = shiftDay(today, -i);
    out.push({ day, count: counts.get(day) ?? 0 });
  }
  const firstWeekday = new Date(out[0].day + "T12:00:00").getDay(); // 0=周日
  const pad = (firstWeekday + 6) % 7; // 周一为 0
  const head: DayCount[] = [];
  for (let i = pad; i > 0; i--) head.push({ day: shiftDay(out[0].day, -i), count: 0 });
  return [...head, ...out];
}
