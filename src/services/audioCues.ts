/**
 * 录音起止的提示音（2026-10-19 加）。
 *
 * ── 为什么要有这两个音 ───────────────────────────────────────────────
 * 点「开始录音」到麦克风真正出声之间隔着拿权限、开设备这些事，界面上只有按钮
 * 变个样 —— **人不知道"现在到底录上没有"**，于是按下就念，一句话的头一两个音
 * 常常没录进去，或者正好卡在设备刚起来的那一段里。给个声音，人就知道该开口了；
 * 结束时再来一个，就知道这一遍到哪儿为止了。
 *
 * ── 为什么是现场合成，不是两个音频文件 ───────────────────────────────
 * 两个 sine 音加一段包络，二十行搞定：零资源、零加载、不会因为打包或更新丢文件，
 * 也不用去管"这个音频要不要进 git"。
 *
 * ── 音色为什么是"上行 = 开场、下行 = 收场" ───────────────────────────
 * 这是苹果那套的模子（语音备忘录 / 相机录像都是：开场一声轻的上行短音，
 * 收场一声下行）。**方向本身就是信息** —— 不用记住"哪个音是开、哪个音是停"，
 * 耳朵一听就知道是"要开始了"还是"结束了"。所以这里只保留这个方向感，
 * 具体音高与时长按"短、轻、不刺耳"来定：
 *   · 短：两音加间隔一共 ~0.2 秒，长一点就成了"等提示音"；
 *   · 轻：峰值 0.18，听清即可，不至于在安静里吓一跳；
 *   · 不刺耳：纯 sine、每个音都带起落包络（直接开关会"啪"一声）。
 *
 * ── 🔒 开场音必须**响完**才开录 ──────────────────────────────────────
 * 提示音要是和录音同时进行，它就会被录进这一遍里，而且正好落在**第一个词头上** ——
 * 那正是发音评估最容易判歪的位置（真机数据：整句 88 分，只有首词被压到 34）。
 * 所以顺序是钉死的：**响完 → 才 `recorder.start()`**，`playRecordingCue("start")`
 * 返回的 Promise 就是"可以开录了"那一下。
 */

/** 提示音的种类。 */
export type RecordingCue = "start" | "stop";

/** 一个音：频率(Hz)、相对 cue 起点的起始时刻(秒)、时长(秒)。 */
export interface CueTone {
  freq: number;
  at: number;
  dur: number;
}

/** 单个音的时长 —— 再长就拖沓，再短听起来像杂音 */
const TONE_DUR = 0.075;
/** 两音之间的间隔 —— 要听得出是"两声"，不能黏成一个 */
const TONE_GAP = 0.055;
/** 起音时间：从 0 直接跳到峰值会"啪"一声 */
const TONE_ATTACK = 0.006;
/** 峰值增益：听清即可，不吵 */
const TONE_PEAK = 0.18;
/**
 * 声音播完之后**再多等**这么久才放行。
 *
 * 蓝牙耳机（AirPods）的输出比调度时刻晚 100~200ms（HFP/缓冲），只按调度时间
 * 放行的话，声音会在 `recorder.start()` 之后才真正播出来 —— 那它就被录进去了。
 * 这点余量是买"开场音不污染第一句话"的保险。
 */
const CUE_TAIL = 0.12;

/** E5 → A5（上行）：开场。 */
const START_HZ = [659.25, 880.0];
/** A5 → E5（下行）：收场。方向与开场相反，耳朵一听就分得开。 */
const STOP_HZ = [880.0, 659.25];

/**
 * 这两个音怎么排。纯函数 —— 好测，也让"上行/下行"这个设计意图有处可钉。
 */
export function cueTones(kind: RecordingCue): CueTone[] {
  const freqs = kind === "start" ? START_HZ : STOP_HZ;
  return freqs.map((freq, i) => ({
    freq,
    at: i * (TONE_DUR + TONE_GAP),
    dur: TONE_DUR,
  }));
}

/** 这一串音从起到落一共多少秒（不含末端余量）。 */
export function cueSeconds(kind: RecordingCue): number {
  const tones = cueTones(kind);
  const last = tones[tones.length - 1];
  return last.at + last.dur;
}

/**
 * AudioContext 的取法（与 readAloudCheck 里那一份同款）。
 * 走 globalThis 而不是裸 `window`：插件跑在 Obsidian 渲染进程里（有 window），
 * 但纯函数测试跑在 node 里（没有）—— 取不到就返回 null，调用方按"放不出声"处理。
 */
function audioContextCtor(): typeof AudioContext | null {
  const env = globalThis as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return env.AudioContext ?? env.webkitAudioContext ?? null;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 排一个带起落包络的 sine 音（exponentialRamp 不能到 0，用 0.0001 收尾）。 */
function scheduleTone(ctx: AudioContext, at: number, freq: number, dur: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(TONE_PEAK, at + TONE_ATTACK);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

/**
 * 播一个提示音。
 *
 * @returns Promise 在**声音播完（含末端余量）**时兑现 —— 开场音要拿它排
 *   "播完再开录"的顺序。放不出声（环境没有 AudioContext / 出错了）也照常兑现：
 *   提示音是锦上添花，**绝不能因为它就把录音卡住**。
 */
export async function playRecordingCue(kind: RecordingCue): Promise<void> {
  const Ctor = audioContextCtor();
  if (!Ctor) return;
  let ctx: AudioContext | null = null;
  try {
    ctx = new Ctor();
    // 浏览器可能给一个 suspended 的上下文（自动播放策略）—— 不 resume 就是静音
    if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
    const from = ctx.currentTime + 0.02; // 避开"现在"这一瞬，排得稳一点
    for (const tone of cueTones(kind)) {
      scheduleTone(ctx, from + tone.at, tone.freq, tone.dur);
    }
    await waitMs((cueSeconds(kind) + CUE_TAIL) * 1000);
  } catch {
    // 出声失败不影响录音本身 —— 提示音不是主流程
  } finally {
    void ctx?.close().catch(() => undefined);
  }
}
