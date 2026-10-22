/**
 * 跟读核对：录完之后判定"读没读对"，两条路。
 *
 *  · **本地核对**（`checkRecordingLocally`）：只看**有没有声音**。有声音就放行。
 *    零成本、零出网，所有人都有。
 *  · **AI 核对**（`requestReadAloudCheck`）：录音 + 原句 + 词表送到服务端，
 *    服务端**逐词**回对错，原句上按词标绿/标红。**这条路只有内置模型能给** ——
 *    发音评估是本机做不到的事（见 docs/concept/idea.md 第七节）。
 *
 * ── 本地为什么不判"读得对不对" ─────────────────────────────────────────
 * 2026-10-03 用户拍板**撤掉时长判定**。原先本地还查"录音时长是否在原声这一句的
 * 0.5~2 倍之间"，实测这条极容易误伤：正常语速差异、句子中间喘口气、麦克风晚半拍
 * 开始，都会让一次读得挺好的录音被判"读得太快/太久"。而它本来也**判不出真正的
 * 错**（つ 读成 す，时长一模一样）。既然只能挡住"压根没读"，那就只挡这个 ——
 * **有声音就算通过**，"读得准不准"交给内置模型。
 *
 * ── 一条贯穿两条路的口径 ────────────────────────────────────────────────
 * **拿不准的一律算对。** 所以每条检查在"判不了"的时候都走**放行**：音频解不出来
 * 当作有声、服务端没返回的词不标、返回的词面对不上直接丢弃。**宁可漏标，不可错标** ——
 * 错标会让用户照着错的红字去改一个本来读对的词。
 */

import { hostedRequest } from "./ai/hosted";
import type { PluginSettings } from "../settings/types";

// ── 本地核对 ─────────────────────────────────────────────────────────────

/**
 * "有没有声音"的下限（线性幅值，0~1）。
 *
 * 这两个数故意压得很低：它们只负责挡住"压根没出声"（麦克风没选对、权限给了但
 * 输入是静音、误触录了一秒空气），**不是**用来判断"声音够不够大"。
 * 正常说话的峰值至少 0.05，离 0.01 还有五倍余量 —— 麦克风灵敏度的差异
 * 根本碰不到这条线，所以这里用绝对值也是安全的，不需要按人校准。
 */
const MIN_PEAK = 0.01;
const MIN_RMS = 0.002;

/**
 * 本地核对通过时摆在卡片上的那句话（2026-10-03 用户定稿，逐字别改）。
 *
 * 说清两件事：这一遍**只查了有没有声音**（不是"读对了"，我们没那个能力），
 * 以及想要真正的发音评估该去哪儿 —— 句子里的「内置模型」是可点的，见下。
 */
export const LOCAL_OK_MESSAGE = "录音正常（仅判断是否有声音）。如果想评估发音正确性，请使用内置模型";

/** 上面那句话里做成虚线可点入口的四个字（点了问「现在配置吗」） */
export const LOCAL_OK_LINK = "内置模型";

export interface LocalCheckResult {
  ok: boolean;
  /** 不通过时给人看的原因；通过时为空串 */
  reason: string;
}

/**
 * 本地核对：**只要有声音就算通过**。
 *
 * 判不出声音（解不出这个容器/环境不支持）也放行 —— 见文件头的"拿不准算对"。
 */
export async function checkRecordingLocally(audio: Blob): Promise<LocalCheckResult> {
  const silent = await isSilent(audio);
  if (silent === true) {
    return { ok: false, reason: "这次没录到声音，看看麦克风是不是选错了设备，读完再点停下。" };
  }
  return { ok: true, reason: "" };
}

/**
 * 音频是不是几乎没声音。返回 **null = 判不了**（解不出码/环境不支持），
 * 调用方按放行处理。
 */
async function isSilent(audio: Blob): Promise<boolean | null> {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  let ctx: AudioContext | null = null;
  try {
    ctx = new Ctor();
    const buffer = await ctx.decodeAudioData(await audio.arrayBuffer());
    const data = buffer.getChannelData(0);
    if (!data.length) return null;
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const value = Math.abs(data[i]);
      if (value > peak) peak = value;
      sum += data[i] * data[i];
    }
    const rms = Math.sqrt(sum / data.length);
    return peak < MIN_PEAK || rms < MIN_RMS;
  } catch {
    // 解不出这个容器/编码 —— 不是"没声音"，只是我们没法判断
    return null;
  } finally {
    void ctx?.close().catch(() => undefined);
  }
}

// ── AI 核对（服务端）────────────────────────────────────────────────────

/** 送上去的词表条目。index 是本地分词的下标，服务端原样回显用于对账。 */
export interface ReadAloudWord {
  index: number;
  surface: string;
  reading: string;
}

/**
 * 一个词在核对后长什么样（2026-10-19 起三态，原先只有对/错两态）。
 *
 *   ok    读准了 → 绿（完成态字色）
 *   warn  没读准，**但整句分够高、这一遍照样算过** → **黄色提醒**，不是红字错处
 *   bad   没读准，且整句分也不够高 → 红字错处，这一遍判未通过
 *
 * 多出 `warn` 这一档的原因：真机实测同一个词的分能在 34~97 之间来回跳
 * （同一句、同一个人、同一支麦），而整句分稳定在 88~92 —— 逐词分本身
 * 分不开"读对"和"读错"（34 是读对、33 是读错），只有整句分分得开。
 * 所以整句够高时**这一遍判过**，但**不抹掉那个词**：降级成黄，照旧标出来。
 * 用户要的是"别拦我"，不是"别告诉我哪儿可能没读准"。
 */
export type ReadAloudMark = "ok" | "warn" | "bad";

/** 核对结果：`index → 这个词什么样`。**只包含能对上账的词**，对不上的整条丢弃。 */
export interface ReadAloudVerdict {
  /** key = 词在本地分词里的下标 */
  marks: Map<number, ReadAloudMark>;
  /**
   * **这一遍过没过**（服务端口径，不是"一个红词都没有"）：
   * 逐词全读准，或整句分够高（见服务端 pronunciation.SENTENCE_PASS_AT）。
   * 服务端没给这个字段时（老版本）退回"一个红词都没有"。
   */
  allCorrect: boolean;
  /** 有没有降级成黄色的词 —— 有就是"过了，但有几个词可能没读准" */
  hasWarn: boolean;
  /**
   * 对上账且带分数的词里**最低**的那个分（0~1，服务端 Azure 百分制 ÷100）。
   * 没评上分的词（对不上账 / 服务端没给）不参与 —— 拿不准的不拉低档位。
   * 一个带分的词都没有时为 null（此时文案落在默认档）。
   */
  minScore: number | null;
}

interface ReadAloudData {
  words?: Array<{
    index?: number;
    surface?: string;
    correct?: boolean;
    /** 没读准但这一遍照样过 → 黄色提醒（服务端 SENTENCE_PASS_AT 那条判据给的） */
    warn?: boolean;
    score?: number;
  }>;
  all_correct?: boolean;
}

/**
 * AudioContext 的取法。走 `window` 而不是 globalThis：**弹窗里 globalThis 不是
 * 那扇窗**，AudioContext 就拿不到了。取不到返回 null，调用方按"转不了"处理
 * （WAV 转不出来时按原始容器兜底，服务端有 ffmpeg 会救一手）。
 */
function audioContextCtor(): typeof AudioContext | null {
  const env = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return env.AudioContext ?? env.webkitAudioContext ?? null;
}

/**
 * WAV 编码：44 字节头 + 单声道 PCM16（采样率固定 16k，与调用方约定）。
 * 抽成纯函数是为了能直接测头字段与削波行为。
 */
export function encodeWav16kMono(mono: Float32Array): ArrayBuffer {
  const bytes = new ArrayBuffer(44 + mono.length * 2);
  const view = new DataView(bytes);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + mono.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);       // fmt 块长
  view.setUint16(20, 1, true);        // PCM
  view.setUint16(22, 1, true);        // 单声道
  view.setUint32(24, 16000, true);
  view.setUint32(28, 16000 * 2, true); // 字节率 = 采样率 × 2 字节
  view.setUint16(32, 2, true);        // 块对齐
  view.setUint16(34, 16, true);       // 位深
  ascii(36, "data");
  view.setUint32(40, mono.length * 2, true);
  for (let i = 0; i < mono.length; i += 1) {
    const s = Math.max(-1, Math.min(1, mono[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

/**
 * 把任意浏览器录音（webm/opus、mp4/aac）转成 **16k 单声道 16bit PCM WAV**。
 *
 * 为什么在插件端转：Azure 发音评估的短音频 REST 接口只吃 WAV，而服务端
 * 不该背音频转码的负担（机器上未必有 ffmpeg）。WebAudio decode 出来
 * 重采样到 16k 单声道，一手 WAV 编码器 30 行，零依赖。
 *
 * 转不出来（解不了码/没有 AudioContext）返回 null —— 调用方按**原始容器**
 * 兜底上传，服务端有 ffmpeg 时仍能救一手，没有则报明确的格式错误。
 */
export async function toWav16kMono(audio: Blob): Promise<Blob | null> {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  let ctx: AudioContext | null = null;
  try {
    ctx = new Ctor();
    const buffer = await ctx.decodeAudioData(await audio.arrayBuffer());
    // 混到单声道（取各声道平均），再按整数步长重采样到 16k。
    // 语音识别不在乎那点混叠 —— 16k 只收 8k 以下频率，线性插值足矣。
    const chanCount = Math.min(buffer.numberOfChannels, 2);
    const channels: Float32Array[] = [];
    for (let c = 0; c < chanCount; c += 1) channels.push(buffer.getChannelData(c));
    const srcRate = buffer.sampleRate;
    const dstRate = 16000;
    const dstLen = Math.max(1, Math.floor((buffer.length * dstRate) / srcRate));
    const mono = new Float32Array(dstLen);
    for (let i = 0; i < dstLen; i += 1) {
      const srcPos = Math.min(Math.floor((i * srcRate) / dstRate), buffer.length - 1);
      let sum = 0;
      for (let c = 0; c < chanCount; c += 1) sum += channels[c][srcPos];
      mono[i] = sum / chanCount;
    }
    return new Blob([encodeWav16kMono(mono)], { type: "audio/wav" });
  } catch {
    return null;
  } finally {
    void ctx?.close().catch(() => undefined);
  }
}

/**
 * AI 核对：把录音和原句送服务端，换回逐词对错。
 *
 * 录音先转成 16k 单声道 WAV（Azure 发音评估只吃这个容器，见
 * toWav16kMono）—— 转不出来时按原始容器兜底，服务端有 ffmpeg 会救一手。
 * 走 multipart（音频是文件，塞 JSON 会把体积撑大三分之一）。
 */
export async function requestReadAloudCheck(
  settings: PluginSettings,
  params: {
    ja: string;
    /** 整句假名读音（与注音同口径）：服务端评估参考文本优先用它。
     * 汉字参考下 Azure 按自家词典定读音，春日影→はるひかげ 这类特读会被判错。 */
    kana: string;
    words: ReadAloudWord[];
    audio: Blob;
    mimeType: string;
    seconds: number;
    referenceMs: number;
  },
): Promise<ReadAloudVerdict> {
  const form = new FormData();
  const wav = await toWav16kMono(params.audio);
  if (wav) {
    form.append("audio", wav, "read-aloud.wav");
  } else {
    // 文件名给个带扩展名的，服务端按后缀判断容器更省事（内容仍是录制器原始 mime）
    const ext = params.mimeType.includes("mp4") ? "m4a" : "webm";
    form.append("audio", params.audio, `read-aloud.${ext}`);
  }
  form.append("ja", params.ja);
  form.append("kana", params.kana);
  form.append("words", JSON.stringify(params.words));
  form.append("audio_seconds", String(params.seconds));
  form.append("reference_ms", String(Math.round(params.referenceMs)));

  const { data } = await hostedRequest<ReadAloudData>(settings, "read-aloud", form);
  // "这一遍过没过"由服务端给（整句分够高也算过），客户端不再自己数红词
  return alignVerdict(data.words ?? [], params.words, data.all_correct);
}

/**
 * 把服务端返回的逐词结果**对账**到本地词表上。
 *
 * 为什么必须回显 surface 再比对：两端的分词口径只要漂一点（服务端换模型、
 * 客户端词典版本不同），第 3 个词就可能变成第 4 个词。那种情况下照着 index
 * 直接标，等于把"读错了"标到隔壁那个读对的词头上 —— 用户会照着红字去改
 * 一个本来读对的词。**对不上就整条丢弃，宁可少标。**
 */
export function alignVerdict(
  raw: Array<{
    index?: number;
    surface?: string;
    correct?: boolean;
    warn?: boolean;
    score?: number;
  }>,
  expected: ReadAloudWord[],
  /** 服务端给的"这一遍过没过"；缺席（老服务端）退回"一个红词都没有" */
  passed?: boolean,
): ReadAloudVerdict {
  const marks = new Map<number, ReadAloudMark>();
  const serverPassed = passed === true;
  let bad = 0;
  let warned = 0;
  let minScore: number | null = null;
  for (const item of raw) {
    if (typeof item.index !== "number") continue;
    const target = expected.find((word) => word.index === item.index);
    if (!target || target.surface !== (item.surface ?? "")) continue;
    const correct = item.correct !== false;
    // 服务端说这一遍过了，那这个词就**只能是黄，不能是红** ——
    // "通过"却标一红字是自相矛盾的展示（降级不改写分数，分照记）
    const mark: ReadAloudMark = correct ? "ok" : serverPassed || item.warn === true ? "warn" : "bad";
    marks.set(item.index, mark);
    if (mark === "bad") bad += 1;
    if (mark === "warn") warned += 1;
    // 最低分只统计**读对且带分**的词 —— 标红/标黄的词再低也不影响夸奖档位
    // （有黄词时走「基本都读对了。」，根本不到夸奖档），null 分不参与。
    if (correct && typeof item.score === "number" && Number.isFinite(item.score)) {
      minScore = minScore === null ? item.score : Math.min(minScore, item.score);
    }
  }
  return { marks, allCorrect: passed ?? bad === 0, hasWarn: warned > 0, minScore };
}

// ── 全对时的夸奖档位（2026-10-11 用户拍板，逐词最低分三档）──────────────

/** 档位线（0~1 分制）。逐词最低分 ≥ 0.9 最高档、≥ 0.7 次档、其余（含 null）默认档。 */
const PRAISE_GREAT = 0.9;
const PRAISE_GOOD = 0.7;

/** 默认档那句话（2026-10-08 定稿，逐字别改）。 */
export const READ_OK_MESSAGE = "每个词都读对了。";

/**
 * 「过了，但有几个词可能没读准」那句话（2026-10-19 用户定稿，逐字别改）。
 *
 * 与上面那句的分工：整句分够高 → 这一遍**判过（正解）**，但没读准的词标成黄色
 * 提醒。这时候不能说「每个词都读对了」—— 那是假话；也不能判未通过 —— 那是
 * 跟整句 88 分自相矛盾。所以是这一句。
 */
export const READ_ALMOST_OK_MESSAGE = "基本都读对了。";

/**
 * 全对时卡片上的灰字：按逐词最低分给三档夸奖。
 * 调用方保证只在 `allCorrect` 时调用 —— 有词读错时根本走不到这。
 */
export function readAloudPraise(minScore: number | null): string {
  if (minScore !== null && minScore >= PRAISE_GREAT) return "你的发音非常标准！";
  if (minScore !== null && minScore >= PRAISE_GOOD) return "读得非常准了。";
  return READ_OK_MESSAGE;
}
