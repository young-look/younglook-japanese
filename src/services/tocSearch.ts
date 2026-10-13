/**
 * 目录浮层 + 顶部进度条这一带的纯函数。
 *
 * 抽出来是为了能单测：这里全是"口径"判断与格式化（哪个输入算时间戳、落到哪一句、
 * 时间怎么写），判断错了不会报错，只会安静地跳错句子或显示错时间 ——
 * 正是最需要测试兜底的那类。DOM 一侧（过滤、滚动、高亮、气泡）留在 StudyView 里。
 */

/**
 * 搜索框里的"数字"怎么读（2026-10-02 用户提：输入数字 = 直接搜时间戳）。
 *
 *  · 纯数字 → **秒**（`90` = 1:30）—— 这是用户打"时间戳"最自然的写法
 *  · 带冒号 → `分:秒` / `时:分:秒`（`1:30`、`01:02:03`），跟浮层里显示的时间格式一致
 *  · 尾部多打一个 s / S / 秒 也认（`90s`、`90秒`）
 *  · 全角冒号"："顺手换成半角：中文输入法下打出它是常事
 *
 * 读不出来就返回 `null`，调用方据此走"中日文搜台词"那条路 ——
 * 所以 `女の子`、`1980年` 这类含数字的**文本**不会被误判成时间戳（`1980年` 不是纯数字串，
 * 也不符合 `分:秒` 形态）。
 */
export function parseTocQuery(raw: string): number | null {
  const text = raw.replace(/[：]/g, ":").replace(/\s/g, "").replace(/[sS秒]$/u, "");
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const match = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(text);
  if (!match) return null;
  const hour = Number(match[1] ?? 0);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  // 60 分 / 60 秒是越界写法（`1:75`），当文本处理比硬算成下一秒更不容易出错
  if (minute > 59 || second >= 60) return null;
  return Math.round((hour * 3600 + minute * 60 + second) * 1000);
}

/**
 * 目标时间点落在哪一句：取起点时间最接近的一句。列表空 → `null`。
 *
 * 用"起点距离"而不是"区间包含"：用户打 `90` 时想的是"跳到 1:30 那一块"，
 * 而 1:30 很可能正落在某句的**中间**（句长两三秒），区间判定会挑到邻句去。
 */
export function nearestIndexByTime(
  rows: { index: number; startMs: number }[],
  targetMs: number,
): number | null {
  let best: { index: number; startMs: number } | null = null;
  for (const row of rows) {
    if (!best || Math.abs(row.startMs - targetMs) < Math.abs(best.startMs - targetMs)) best = row;
  }
  return best ? best.index : null;
}

/**
 * 悬停气泡上的时间，格式固定 `00:00:00`（时:分:秒，2026-10-02 用户指定）。
 *
 * 跟目录行里的 `mm:ss` 不是一个口径，别互相顶替：目录一行要窄，只看分秒够了；
 * 气泡是"说清楚这是哪一句"，多一档小时。
 * 小时不封顶（超过 99 小时就写三位），负数与 NaN 一律当 0 —— 气泡里出现 `NaN:NaN` 最难看。
 */
export function formatHms(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(safe / 3600))}:${pad(Math.floor((safe % 3600) / 60))}:${pad(safe % 60)}`;
}
