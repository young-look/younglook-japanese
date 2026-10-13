/**
 * 跟读录音的**首尾空白裁剪**。
 *
 * ── 它做什么 ─────────────────────────────────────────────────────────────
 * 用户按下录音之后常先等几秒才开口（怕没录上），结尾也常拖一截。那段空白留在
 * 文件里只会耽误回放，所以**录完当场剪掉**：
 *
 *     MediaRecorder 的 webm → 解码成 PCM → 找首尾静音 → 裁 → 重编码 opus → 封回 webm
 *
 * 剪完的新文件**就是最终文件**：播放条、本地存档、送服务端核对，用的都是它。
 * **原始录音不留**（2026-10-03 用户口径）。所以这个函数是**入库前的最后一道工序**，
 * 不是"播放时跳过一下"那种旁路 —— 早先那版 `skipSilenceOnPlay` 已整体撤掉，
 * 留着会和这里二次跳过头。
 *
 * ── 代价（认了）─────────────────────────────────────────────────────────
 * · **世代损失**：opus → PCM → opus，两次有损。语音场景听不出来，但严格说是降质。
 *   不留原文件就是为了省掉"哪个才是真身"的歧义 —— 既然只留一份，那这一份得是干净的。
 * · **一个依赖**：`webm-muxer`（MIT、零运行时依赖、压缩后约 28KB）。
 *   手写 EBML 封装我试过 4 轮全败（连 1 秒单簇都封不出被 Chrome 认的 webm），
 *   **别再手搓 EBML**（见 .workbuddy/memory/2026-10-03.md）。
 *
 * ── 一条贯穿的口径：宁可少剪，不可剪到字上 ─────────────────────────────────
 * 用户读的音被剪掉是唯一会招投诉的结果，所以四道保险全在：
 *   1. 判定线取**噪声（10 分位）与语音（98 分位）的几何中点**，不用绝对值 ——
 *      换麦克风、换房间、嗓门大小全都自动吸收，不需要按人校准；
 *      前提是 `micCapture.ts` 关掉了 AGC/降噪，底噪才是真的（实测数据见那儿的注释）。
 *   2. 切点**往里留 0.2 秒余量** —— 判定早了一帧也削不到起音。
 *   3. 空白不够长就不剪 —— 省下的那零点几秒抵不上任何风险。
 *   4. 找不到明确的有声段（整段平、或者噪声大到没有"安静"）→ 整段不剪。
 *
 * 任何一道触发都返回 `blob: null`，调用方继续用**原 blob** ——
 * 判不出来不是判错，与 `readAloudCheck.ts` 同一条口径。
 *
 * ⚠️ **只剪两端，绝不动中间**：句中换气、想词也是空白，剪掉用户会以为自己漏读了。
 */

import { ArrayBufferTarget, Muxer } from "webm-muxer";

/** 分析一帧的时长。20ms 足够细，能把辅音的起音单独框出来。 */
const FRAME_MS = 20;

/**
 * 噪声水平的下限（≈ -66dBFS）。
 *
 * 只在一种情形下起作用：录音开头带一截**真数字静音**（麦克风还没起振、样本整段是 0），
 * 10 分位会取到 0 —— 判定线跟着塌成 0，等于没有判定线。给个地板兜住。
 *
 * ⚠️ 地板**必须远低于真实底噪**。早先这里是 `0.004`，而安静房间里关掉降噪的
 * 麦克风底噪常就在 0.003~0.008 —— 地板于是高过底噪本身，"安静"被判成了"有人在说话"。
 */
const MIN_NOISE_FLOOR = 0.0005;

/**
 * 语音至少要高出噪声这么多倍；达不到就认为这段录音里没有"说话"。
 *
 * 用户整句都在说、一次没停的时候，10 分位会落在说话上，噪声估计就废了。
 * 这条把那种情况拉回来：表现为"找不到有声段"（→ 不剪），而不是拿一个乱来的边界去剪。
 */
const MIN_LOUD_OVER_NOISE = 4;

/** 取**升序**数组的 q 分位（q ∈ [0,1]，越界钳到两端）。 */
function quantile(ascending: Float32Array, q: number): number {
  const index = Math.min(ascending.length - 1, Math.max(0, Math.floor(ascending.length * q)));
  return ascending[index];
}

/**
 * 切点往里留的余量（秒）。
 *
 * 判定"这里是静音的边界"必然有量化误差，留 200ms 就能把误差吃掉 ——
 * 用户听到的第一个音一定是从容的起音，不会被削掉半口。
 */
export const KEEP_MARGIN_SECONDS = 0.2;

/**
 * 某一端的空白短于这个就不剪（秒）。
 *
 * 这是"只在值得的时候动手"的闸门：0.3 秒的空白剪了几乎没收益，
 * 却让判定多一次出错的机会。
 */
export const MIN_TRIM_SECONDS = 0.5;

/**
 * 剪完剩下的有声段短于这个就整段放弃（秒）。
 *
 * 走到这里说明判定多半把大段内容当成了空白（噪底抬得太高之类），
 * 这时原样用原文件 —— 让用户自己听出问题，比我们替他剪掉强。
 */
const MIN_KEPT_SECONDS = 0.5;

/**
 * 重编码用的采样率。
 *
 * 🔥 设备采集常是 **44100Hz**，而 opus **只认标准采样率**（48k/24k/16k…）——
 * 直接把 44100 交给 `AudioEncoder.configure` 会被拒。用 `OfflineAudioContext`
 * 解码就会顺手重采样，所以这里定死 48k 让解码器把 PCM 钉过去。
 */
const TARGET_SAMPLE_RATE = 48000;

/** 编码码率。语音够用，再高只是白占体积（实测 10 秒录音约 45KB）。 */
const OPUS_BITRATE = 64000;

export interface SilenceBounds {
  /** 开头可以剪掉的秒数（已扣掉余量；0 = 这头不剪） */
  lead: number;
  /** 结尾可以剪掉的秒数（已扣掉余量；0 = 这头不剪） */
  tail: number;
}

/** 什么都没得剪。 */
const NOTHING_TO_TRIM: SilenceBounds = { lead: 0, tail: 0 };

/**
 * 从 PCM 里找首尾空白。**纯函数**，不碰 DOM、不解容器，好测。
 *
 * 每一端**独立**决定剪不剪：开头等 5 秒、结尾只等 0.2 秒是常事，
 * 那种情况只剪开头就好，不该因为尾巴不够长就把开头那 5 秒也留着。
 *
 * @returns 可以剪掉的秒数；`null` = 判不出来（数据太短/没有明确的有声段），调用方整段不剪。
 */
export function findSilenceBounds(
  samples: Float32Array,
  sampleRate: number,
): SilenceBounds | null {
  const frameSize = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const frameCount = Math.floor(samples.length / frameSize);
  // 少于 1 秒的录音没什么可剪的，也判不准
  if (frameCount < Math.round(1000 / FRAME_MS)) return null;

  const rms = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * frameSize;
    let sum = 0;
    for (let i = 0; i < frameSize; i += 1) {
      const value = samples[start + i];
      sum += value * value;
    }
    rms[frame] = Math.sqrt(sum / frameSize);
  }

  // ── 判定线：噪声（10 分位）与语音（98 分位）的**几何中点** ──────────────
  //
  // 两个分位各自解决一件事：
  //   · 噪声取 10 分位而**不是中位数** —— 用户可能整句都在说（有声段占多数），
  //     中位数会落在说话上，那就没有"安静"可言了。10 分位能穿过大段说话、稳稳落在安静段里。
  //   · 语音取 98 分位而不是最大值 —— 最大值会被咳嗽、碰到桌子这类孤立尖峰抬走；
  //     98 分位要的是"说话时段的典型能量"，顺带对孤立尖峰免疫。
  //
  // 为什么取几何中点、而不是旧的"底噪 × 3"：
  // **真机录音的头尾底噪常常不一样**。开头是用户屏息等着的，结尾是读完那口气、手去够停止键，
  // 尾部那截"安静"轻松就是开头的三四倍。单一倍数在那种录音上必然翻车 ——
  // 尾部安静过不了线，整条尾巴一帧都剪不掉，而头部照剪不误，
  // 用户看到的就是「头剪了、尾没剪」（2026-10-03 实报；复现与回归见 temp/trim-lab/）。
  //
  // 几何中点自带对数缩放：信噪比越大，判定线越贴近噪声一侧，正好落在
  // "尾部那点底噪"与"说话的起音"之间。换麦克风、换房间、嗓门大小全都自动吸收。
  const sorted = Float32Array.from(rms).sort();
  const noise = Math.max(quantile(sorted, 0.1), MIN_NOISE_FLOOR);
  const loud = Math.max(quantile(sorted, 0.98), noise * MIN_LOUD_OVER_NOISE);
  const threshold = Math.sqrt(noise * loud);

  let firstLoud = -1;
  let lastLoud = -1;
  for (let frame = 0; frame < frameCount; frame += 1) {
    if (rms[frame] > threshold) {
      if (firstLoud < 0) firstLoud = frame;
      lastLoud = frame;
    }
  }
  // 整段都过不了线 = 没有明确的有声段（全是静音，或者噪声大到没有安静）。
  // 这两种都判不出来，不剪。
  if (firstLoud < 0) return null;

  const secondsPerFrame = frameSize / sampleRate;
  // 有声段之外的部分才算空白；再往里留 KEEP_MARGIN_SECONDS 的余量。
  const lead = firstLoud * secondsPerFrame - KEEP_MARGIN_SECONDS;
  const tail = (frameCount - 1 - lastLoud) * secondsPerFrame - KEEP_MARGIN_SECONDS;

  const keepLead = lead >= MIN_TRIM_SECONDS ? lead : 0;
  const keepTail = tail >= MIN_TRIM_SECONDS ? tail : 0;
  if (keepLead === 0 && keepTail === 0) return NOTHING_TO_TRIM;

  // 剪完得剩下够长的一段，否则多半是判定出了问题 —— 整段放弃。
  const kept = samples.length / sampleRate - keepLead - keepTail;
  if (kept < MIN_KEPT_SECONDS) return NOTHING_TO_TRIM;

  return { lead: keepLead, tail: keepTail };
}

/**
 * 一次裁剪的结果。
 *
 * ⚠️ `blob: null` **不是失败**，是"这次不用改 / 改不了，照原样用" ——
 * 上层必须写成 `trim.blob ?? 原blob`，别把 null 当成错误弹给用户。
 */
export interface TrimResult {
  /** 剪好的新录音；**没得剪或剪不出来时为 null**，调用方继续用原 blob。 */
  blob: Blob | null;
  /**
   * 这段录音的时长（秒）—— 剪成了就是剪后的，没剪成就是**解码出来的原始时长**。
   * 解码都失败时为 0，那时调用方该退回自己数出来的秒数（计时器那个）。
   */
  seconds: number;
  /** 实际剪掉了多少秒（0 = 没剪）。给测试和排查用。 */
  removed: number;
}

/** 没剪成、也没解出时长。 */
const NO_TRIM: TrimResult = { blob: null, seconds: 0, removed: 0 };

/**
 * 本机能不能做裁剪。
 *
 * 判据是 `AudioEncoder` —— 它是 WebCodecs 的东西，缺了就没法重编码。
 * `OfflineAudioContext` 顺带一起查（解码那步要用）。
 *
 * 本项目**只在桌面端跑**（2026-10-03 用户口径：不做移动端），
 * 所以这里几乎恒为 true；留着这个判断是为了让"环境不支持"时能优雅退回原文件，
 * 而不是抛异常把整条录音流程打断。
 */
export function trimSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.AudioEncoder !== "undefined" &&
    typeof window.OfflineAudioContext !== "undefined"
  );
}

/**
 * 把一段录音的首尾空白剪掉，返回**新的 webm 文件**。
 *
 * 全流程实测约 40ms / 6 秒录音（真 Chromium + 真 MediaRecorder），
 * 用户点完"停下"到能听基本无感。
 *
 * 任何一步出错都返回 `blob: null`，绝不抛 —— 录音流程不该因为裁剪失败而断。
 */
export async function trimRecording(blob: Blob): Promise<TrimResult> {
  if (!trimSupported()) return NO_TRIM;

  // ── 解码。用 OfflineAudioContext 定死在 48k（见 TARGET_SAMPLE_RATE）。──
  let buffer: AudioBuffer;
  try {
    const ctx = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);
    buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch {
    return NO_TRIM;
  }
  if (!buffer.length || !buffer.sampleRate) return NO_TRIM;

  const seconds = buffer.duration;
  const rate = buffer.sampleRate;

  // 边界只看主声道就够 —— 人说话两个声道内容基本一样，看一个不会漏掉起音。
  const bounds = findSilenceBounds(buffer.getChannelData(0), rate);
  if (!bounds) return { blob: null, seconds, removed: 0 };

  const from = Math.max(0, Math.round(bounds.lead * rate));
  const to = Math.min(buffer.length, buffer.length - Math.round(bounds.tail * rate));
  if (to - from < rate * MIN_KEPT_SECONDS) return { blob: null, seconds, removed: 0 };

  try {
    const trimmed = await encodeWebm(buffer, from, to);
    return { blob: trimmed, seconds: (to - from) / rate, removed: bounds.lead + bounds.tail };
  } catch {
    return { blob: null, seconds, removed: 0 };
  }
}

/**
 * 把 `buffer` 的 `[from, to)` 这一段重编码成 opus 并封成 webm。
 *
 * 🔥 两个坑都踩实过，都会表现成"**不报错，只是解不出来**"：
 *   ① muxer 的 `codec` 必须写 Matroska 的**完整 CodecID `"A_OPUS"`**。
 *      写 `"opus"` 会被原样抄进文件 —— 容器头完全正常，音轨却不被认，
 *      Chrome 只回一句 `DEMUXER_ERROR_NO_SUPPORTED_STREAMS`，不说原因。
 *      当初是靠拿 Chrome 自己录的文件**逐字节比对**才揪出来的（对照组 CodecID = `A_OPUS`）。
 *   ② 采样率必须是 opus 认的标准值（见 TARGET_SAMPLE_RATE）。
 */
async function encodeWebm(buffer: AudioBuffer, from: number, to: number): Promise<Blob> {
  const rate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const frames = to - from;
  const sources: Float32Array[] = [];
  for (let c = 0; c < channels; c += 1) sources.push(buffer.getChannelData(c));

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    audio: { codec: "A_OPUS", sampleRate: rate, numberOfChannels: channels },
    firstTimestampBehavior: "offset",
  });
  // ⚠️ 两个回调里的异常**不会**冒到 `await encoder.flush()` 上 —— 直接 throw 只会变成
  // 一个没人接的全局错误，而主流程拿着半截数据一路走下去。先攒起来，编码完再抛。
  let failure: unknown = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      try {
        muxer.addAudioChunk(chunk, meta);
      } catch (error) {
        failure = failure ?? error;
      }
    },
    error: (error) => {
      failure = failure ?? error;
    },
  });
  encoder.configure({
    codec: "opus",
    sampleRate: rate,
    numberOfChannels: channels,
    bitrate: OPUS_BITRATE,
  });

  // `AudioEncoder` 要**交错**数据，且每帧 `numberOfFrames` 得一样 ——
  // 最后一帧不足就补零（多出来的样本落在有声段之外，听不出来）。
  const chunkFrames = Math.max(1, Math.round((rate * FRAME_MS) / 1000));
  for (let offset = 0; offset < frames; offset += chunkFrames) {
    const take = Math.min(chunkFrames, frames - offset);
    const interleaved = new Float32Array(chunkFrames * channels);
    for (let c = 0; c < channels; c += 1) {
      const src = sources[c];
      for (let i = 0; i < take; i += 1) {
        interleaved[i * channels + c] = src[from + offset + i];
      }
    }
    encoder.encode(
      new AudioData({
        format: "f32",
        sampleRate: rate,
        numberOfFrames: chunkFrames,
        numberOfChannels: channels,
        timestamp: Math.round((offset / rate) * 1_000_000),
        data: interleaved,
      }),
    );
  }

  try {
    await encoder.flush();
  } catch (error) {
    failure = failure ?? error;
  }
  try {
    encoder.close();
  } catch {
    // 已经关了，无所谓
  }
  if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  muxer.finalize();
  return new Blob([target.buffer], { type: "audio/webm" });
}
