/**
 * 厘 → 元的显示格式化（插件侧唯一一份）。
 *
 * 记账粒度是厘（1 厘 = ¥0.001，2026-10-06 起）：单次消费常低于 1 分，
 * 按 0.01 元显示会把 ¥0.002 放大十倍。能整除到分的照旧两位小数，
 * 有厘位才给三位 —— ¥10、¥9.99、¥9.998（默认档，设置页那种一行小字用）。
 *
 * `opts.fixed` = 定长（2026-10-09 账户页拍板）：**余额卡固定两位、
 * 流水金额与「余」固定三位**（0.25 → 0.250），一列里位数不齐根本对不上账。
 * 网页端 web/src/utils/money.ts 的 yuanMilli 是同一套规则，改这里 = 改那边。
 */
export function yuanMilli(millis: number, opts?: { fixed?: number }): string {
  const m = Number(millis || 0);
  const v = m / 1000;
  if (opts?.fixed != null) return `¥${v.toFixed(opts.fixed)}`;
  return `¥${m % 10 === 0 ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : v.toFixed(3)}`;
}

/**
 * 流水里的增减：符号写在 **¥ 前面**（-¥0.002，不是 ¥-0.002）—— 一列右对齐的
 * 数字里后者的负号很容易看漏，而「这笔是进是出」正是流水唯一要说的事。
 * 与网页端 signedMoneyMilli 逐字同规则（同一套 ASCII +/-，别改成全角）。
 */
export function signedYuanMilli(millis: number, opts?: { fixed?: number }): string {
  const m = Number(millis || 0);
  if (m > 0) return `+${yuanMilli(m, opts)}`;
  if (m < 0) return `-${yuanMilli(-m, opts)}`;
  return yuanMilli(0, opts);
}
