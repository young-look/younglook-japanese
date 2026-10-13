/**
 * 软切片的播放窗口计算。
 *
 * 「软切片」= 不切文件，只把播放限制在这一句的时间窗里（同一份视频换 startMs/endMs）。
 * 这里放的全是**纯函数**：边界判断最容易出错，而它又没法靠肉眼看出来
 * （表现为"点了播放没反应""进度条位置怪"），所以必须在测试里钉住。
 *
 * 两个真实缺陷（用户 2026-09-25 报告）：
 *  1. 播到句尾自动停之后再点播放 —— 没有任何反应。因为当前时间已经在窗口末尾，
 *     一 play 就被 timeupdate 判定"超出窗口"立刻 pause。修法：点播放时先判断
 *     `shouldRestart()`，是就回到窗口开头再播。
 *  2. 原先把播放器的**整片时长**（3 分多钟）露给用户，看着像"切片没生效"。
 *     修法：改用本文件的时间窗口径显示（本句位置 / 本句长度），并且自建控制条
 *     而不挂原生 controls —— 原生那条读的是整个文件的时长，改不掉。
 */

/** 判定"已经在窗口末尾"的容差。太小会让 60fps 的片子漏判，太大则会把中途误判成末尾。 */
export const CLIP_END_EPS_MS = 150;

/** 本句时间窗长度（毫秒）。窗口异常（end <= start）时兜一个最小时长，别算出 0 或负数。 */
export function clipLengthMs(startMs: number, endMs: number): number {
  return Math.max(1, endMs - startMs);
}

/** 当前播放位置 → 窗口内比例（0~1），用于画进度条。 */
export function clipRatio(currentMs: number, startMs: number, endMs: number): number {
  const ratio = (currentMs - startMs) / clipLengthMs(startMs, endMs);
  return Math.min(1, Math.max(0, ratio));
}

/** 已经在窗口末尾（含容差）？用于决定"再点播放"是续播还是重播。 */
export function atClipEnd(currentMs: number, endMs: number): boolean {
  return currentMs >= endMs - CLIP_END_EPS_MS;
}

/**
 * 点播放时是否需要先回到窗口开头。
 *
 * 两个额外条件都要看：
 *  - 位置在窗口**之前**（用户往左拖过头，或者刚换句）→ 回到开头，否则会从上一句中间开始播；
 *  - 播放器已经 `ended`（字幕尾巴超出文件长度时走到文件末尾就会这样）→ 必须回到开头，
 *    不然浏览器会自己从第 0 秒重播，闪一下第一帧才被我们拉回窗口。
 */
export function shouldRestart(
  currentMs: number,
  startMs: number,
  endMs: number,
  ended = false,
): boolean {
  if (ended) return true;
  return atClipEnd(currentMs, endMs) || currentMs < startMs;
}

/**
 * 翻句的自动播放 —— **已移除**（2026-09-29 用户定）。
 *
 * 曾经的规则是"下一句一定播、上一句一定不播"（按方向不对称）；实际用下来
 * 突然出声吓人，翻句一律改为**停住**（调用方直接传 `false`），要播用户自己
 * 点画面或播放键 —— 暂停态下画面中央有播放提示指路（.yl-video-playhint）。
 */

/** 拖动进度条 → 目标时间（毫秒），永远落在窗口内。 */
export function seekTargetMs(ratio: number, startMs: number, endMs: number): number {
  const clamped = Math.min(1, Math.max(0, ratio));
  return startMs + clamped * clipLengthMs(startMs, endMs);
}

/** 把越界的位置拉回窗口。返回 null 表示本来就在窗口内，不需要动。 */
export function pullBackMs(currentMs: number, startMs: number, endMs: number): number | null {
  if (currentMs < startMs - 50) return startMs;
  if (currentMs > endMs + 50) return endMs;
  return null;
}

/**
 * 本句内的时钟："0:04.2"。刻意**只显示本句范围内的位置**，
 * 不显示整个视频的时间轴 —— 那正是让用户误以为"没切片"的东西。
 */
export function formatClipClock(ms: number): string {
  const safe = Math.max(0, ms);
  const totalSeconds = safe / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

