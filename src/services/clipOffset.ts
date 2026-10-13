/**
 * 时间校准：字幕时间轴相对视频的**全局偏移**。
 *
 * 现实里字幕常见整体早/晚 0.3~1.5 秒（不同压制组、不同片源、OP 前后有剪辑），
 * 表现为"话还没说完字幕就翻页了"。这里存的是**整条视频一个偏移量**，
 * 而不是逐句去调 —— 逐句调既费事，又会让时间轴失去可比性。
 *
 * ⚠️ **只校字幕，绝不碰视频文件。**
 * 这个模块（以及整个插件）对视频文件只有一次只读打开（导入时取指纹），
 * 校准只改"我们自己的时间窗"，视频、字幕文件一个字都不动。
 * 曾经写过一版"自动分析音轨算偏移"，已按用户要求删掉 —— 校准不再读视频。
 *
 * 职责边界（2026-09-28 用户定）：只校**字幕和视频**的错位。**音画不同步**
 * （片源本身声音和画面对不上）不归校准管 —— 请自行更换、调整视频源，
 * 不做"音画轴"（Web Audio 延迟之类），校准弹层里也照此说明。
 *
 * 两条纪律：
 *  1. 偏移存进 `AssetRow.offsetMs`（跟着素材走，将来能同步）；没存过 = 0。
 *  2. 它只是**播放时的平移量**，原始字幕时间戳始终保留原样（导出/回退都不会被污染）。
 */

/** 允许的偏移范围：超过 ±10 秒基本不是偏移问题，是配错片源了。 */
export const MAX_OFFSET_MS = 10_000;
/** 微调步长（0.5 秒）—— 界面上就是 −0.5s / +0.5s 两个按钮。 */
export const OFFSET_STEP_MS = 500;

/** 把偏移收进允许范围，并量化到 10ms（避免出现 +0.4999999 这种值）。 */
export function normalizeOffset(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  const clamped = Math.min(MAX_OFFSET_MS, Math.max(-MAX_OFFSET_MS, ms));
  return Math.round(clamped / 10) * 10;
}

/** 界面上显示的偏移文案：+0.50 秒 / −0.50 秒 / 不偏移。 */
export function formatOffset(ms: number): string {
  const value = normalizeOffset(ms);
  if (value === 0) return "不偏移";
  const seconds = (value / 1000).toFixed(2);
  return value > 0 ? `+${seconds} 秒` : `−${Math.abs(value / 1000).toFixed(2)} 秒`;
}

/** 把偏移应用到某一句的时间窗上。窗口整体平移，长度不变。 */
export function effectiveWindow(
  window: { startMs: number; endMs: number },
  offsetMs: number,
): { startMs: number; endMs: number } {
  const offset = normalizeOffset(offsetMs);
  if (offset === 0) return { startMs: window.startMs, endMs: window.endMs };
  const startMs = Math.max(0, window.startMs + offset);
  return { startMs, endMs: Math.max(startMs + 1, window.endMs + offset) };
}

/**
 * 「以当前位置为准」：用户听着声音点一下，把**当前播放位置**当作这一句的开头，
 * 反推出整条视频需要偏移多少。
 *
 * 比 ±0.5s 盲调快得多 —— 听出来偏了一秒多的时候，手点两下就够了。
 *
 * @param playheadMs 用户点按钮那一瞬间的播放位置
 * @param sliceStartMs 这句话原始的字幕起点
 */
export function offsetFromPlayhead(playheadMs: number, sliceStartMs: number): number {
  return normalizeOffset(playheadMs - sliceStartMs);
}

/** 在当前偏移基础上加减一个步长。 */
export function stepOffset(currentMs: number, steps: number): number {
  return normalizeOffset(normalizeOffset(currentMs) + steps * OFFSET_STEP_MS);
}
