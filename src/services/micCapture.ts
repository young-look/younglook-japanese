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

/**
 * 蓝牙输入设备在**设备名**里的特征词。
 *
 * 覆盖两端常见的写法（同一副耳机在各系统下名字不一样）：
 *   · macOS    CoreAudio 把它报成 "xxx 的 AirPods Pro" / "xx Headset"；
 *   · Windows  同一副耳机注册成两条 ——「立体声（A2DP）」与
 *              「**免提电话 / Hands-Free AG Audio**」，能录音的是后者（HFP）。
 * 命中任一就算蓝牙。认不出名字也不要紧，下面还有采样率那条兜着。
 */
const BLUETOOTH_HINTS = [
  "airpods",
  "airpod",
  "bluetooth",
  "bt-",
  "headset",
  "earbuds",
  "earbud",
  "hands-free",
  "handsfree",
  "耳机",
  "蓝牙",
  "免提",
  "无线",
  "wireless",
];

/**
 * **蓝牙通话模式（HFP）的采样率上限**。
 *
 * A2DP（听歌）与 HFP（通话）是蓝牙上两套互斥的链路：前者 44.1/48kHz 立体声，
 * 后者只有 **8kHz 或 16kHz、单声道** —— 只要应用一开麦克风，整机就被压到后者
 * （Windows 更粗暴：连同一副耳机的放音通道也一起降级）。
 *
 * 所以"实际拿到的采样率 ≤ 16k"是**链路确实处在通话模式**的直接证据 ——
 * 比认设备名更硬：不管耳机什么牌子、系统用什么语言，都逃不过这个数字。
 */
const HFP_MAX_SAMPLE_RATE = 16000;

/** 一支麦克风的"体检结果"。 */
export interface MicInputInfo {
  /** 是不是蓝牙输入（名字 / 采样率任一命中） */
  isBluetooth: boolean;
  /** 设备名，给用户看的（`track.label`，拿不到就是空串） */
  deviceName: string;
  /** 实际采样率（Hz）；拿不到是 0 */
  sampleRate: number;
}

/**
 * 看看这次拿到的**这支麦克风**是不是蓝牙输入 —— 用来提醒用户"这个麦克风采音会差一些"。
 *
 * 🔒 **只做告知，绝不挑设备**（2026-10-16 用户口径）：这里读的是"系统给我们的是什么"，
 * 一件事都不改。想换设备在**系统声音设置**里换，插件跟着走 —— 曾落地过
 * "录音自动避开蓝牙麦"，被明确否决过，别再往回加。
 *
 * 两条判据，任一命中：
 *   · **设备名**含蓝牙特征词（`BLUETOOTH_HINTS`）；
 *   · **采样率 ≤ 16kHz** —— HFP 通话模式的指纹，认不出名字时也能兜住。
 *
 * ⚠️ 必须在 `getUserMedia` **成功之后**调：没授权时浏览器既不给设备名也给不出采样率，
 *    提前枚举只能瞎猜用户当前用的是哪一个。
 */
export function inspectMicInput(stream: MediaStream): MicInputInfo {
  // ⚠️ 用 getTracks()[0]，别用 getAudioTracks()：两者在真浏览器里等价（这条流只有音轨），
  // 但后者会让只桩了 getTracks 的测试环境同步 TypeError —— 而这里是在 start() 里同步调的，
  // 一 throw 就被外层 catch 吃掉，把"麦克风可用"误判成"出问题了"（2026-10-15 实测炸过一轮）。
  const track = stream.getTracks()[0];
  if (!track) return { isBluetooth: false, deviceName: "", sampleRate: 0 };

  const deviceName = track.label || "";
  // getSettings() 在个别环境返回空对象，一律按"拿不到"处理，别让它参与判定
  const sampleRate = Number(track.getSettings?.().sampleRate) || 0;

  const nameHit = BLUETOOTH_HINTS.some((hint) => deviceName.toLowerCase().includes(hint));
  const rateHit = sampleRate > 0 && sampleRate <= HFP_MAX_SAMPLE_RATE;
  return { isBluetooth: nameHit || rateHit, deviceName, sampleRate };
}
