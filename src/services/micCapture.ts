/**
 * 取麦克风的约束 —— 跟读要的是**原声**，不是"浏览器优化过的声音"。
 *
 * ⚠️ 只写 `{ audio: true }` 是不够的：Chromium 默认把三个"音频处理"全打开
 * （2026-09-25 在本机 Chromium 151 上实测，`track.getSettings()` 返回
 * `autoGainControl / echoCancellation / noiseSuppression` 全是 true）。
 *
 * 其中**自动增益（AGC）会按时间改写音量**。同一段恒定音源录 6 秒，每 0.5 秒一段的 RMS：
 *
 *   默认（三个都开）：-55.1 → -20.7 -20.7 -20.6 -20.7 …（开头低 34dB，之后被压成一条直线）
 *   只关 AGC       ：-240（全静音）→ -20.1 …（降噪/回声消除照样把开头吃掉）
 *   三个全关       ：-25.5 → -17.4 -17.4 -18.1 -16.7 …（保留原始起伏，只剩音源自己的起播斜坡）
 *
 * 也就是说：开着 AGC 时，录出来的音量是浏览器实时算出来的，不是用户自己的音量；
 * 回声消除和降噪也是自适应滤波器，越往后削得越干净。回听就表现为
 * "声音自己变大变小 / 越听越小"，用户会以为是自己没读好（2026-09-25 用户报过）。
 *
 * 这几个约束都不是 `exact`，设备不支持时会被忽略而不是抛错。
 */
export function micConstraints(): MediaTrackConstraints {
  return {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
}
