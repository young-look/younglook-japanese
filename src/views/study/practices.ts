/**
 * 三步练习（跟读 → 抄写 → 仿写）的界面构件。
 *
 * 2026-10-07 按钮统一口径（用户拍板）：三张卡同一个模型 ——
 *   · **数据一律自动保存，没有「保存」这个概念**：敲的字约 0.8 秒内自动落草稿
 *     （services/studyDrafts，本机）；录音点「停止」那一刻**先上屏能听**，
 *     剪掉首尾空白之后再入库（裁剪是后台的事，见 `startFinalize`）；
 *   · 「检查」是人主动点的验证动作，**可反复点** —— 网络或服务商抖一下导致一次
 *     失败时，再点一次就是重试，用户不需要猜「保存失败该怎么办」（这是这次改口径
 *     的根因）。检查通过后数据照旧落进度行，那一步本来就不用人操心。
 *   · 跟读：「开始录音↔停止」「检查」「重置」—— 「录完即核对」（2026-10-04）
 *     被本条推翻：核对要花一次逐词评估的钱，什么时候查由人定；录完先回听，觉得
 *     行再点「检查」。已存的录音（包括没核对过的）换句回来还能直接检查。
 *   · 抄写 / 仿写：「检查」「重置」「提示」（文字钮）。
 * 麦克风用不了时跟读主按钮位**换脸**成「标记完成」（不经检查记一笔，与仿写
 * 「AI 用不了」同一套换脸口径）—— 那是这张卡在无麦态唯一还能做的事。
 * 「重置」= 这一步完全恢复初始（完成标记、留档、录音、草稿全清）。
 *
 * 几条从实测里换来的规则别简化：
 *   · 留档框和正在敲的框必须是**两个 textarea** —— 受控写回会打断系统输入法组字；
 *   · 录音 blob 的类型不能写死 audio/webm（Obsidian 是 Chromium，问题不大，
 *     但口径统一按录制器自己的 mimeType 来）；
 *   · 取麦克风用 `micConstraints()`，别偷懒写 `{ audio: true }` —— 后者默认开自动增益，
 *     回放音量会被浏览器按时间改写，听起来像"越来越小"；
 *   · 回车不提交抄写 —— 回车在日语输入法里是"确定假名"。
 */

import { Notice, setIcon } from "obsidian";
import type { ProgressRow, StudySentence } from "../../types/entities";
import { normalizeForCopy, type CopyResult } from "../../services/copyCheck";
import { cleanSuggestion } from "../../services/verdictSuggestion";
import { inspectMicInput, micConstraints } from "../../services/micCapture";
import { playRecordingCue } from "../../services/audioCues";
import { trimRecording } from "../../services/audioTrim";
import { effectiveJa } from "../../services/study";
import type { AiGate } from "../../services/ai/gate";
import type { StreamVerdict } from "../../services/ai/client";
import { renderHintLink, renderHintWithRecharge } from "./hintText";
import { createButton, setButtonIcon } from "../../ui/button";
import { formatClipClock } from "../../services/clipPlayback";

const MIN_RECORD_SECONDS = 0.8;
/**
 * 一次录音的墙钟上限（2026-10-05 用户拍板：**有效时间最多 30 秒**）。
 *
 * 到点自动停。裁剪只剪首尾空白、不动中间，所以有效（剪后）时长必然 ≤ 30 秒，
 * 服务端的同一条上限（pronunciation.MAX_AUDIO_SECONDS = 30）永远碰不到 ——
 * 它只防老版本客户端。台词一句撑死十几秒，30 秒已经是宽裕的三倍。
 */
const MAX_RECORD_SECONDS = 30;

/** 按浏览器支持的顺序挑第一个能用的格式，录和放用同一个。 */
function pickMimeType(): string {
  const MR = window.MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== "function") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"];
  return candidates.find((mime) => MR.isTypeSupported(mime)) ?? "";
}


// ── 一步的三态（2026-10-09 用户拍板）─────────────────────────────────────
//
// 以前三张卡都写「已完成 ✓」——**做对和没人判过长得一模一样**，没有区分度。
// 现在拆成三态，措辞与颜色一一对应：
//
//   ok     「正解 ✓」  真的判过、判对了 —— 跟读＝AI 逐词全对、抄写＝逐字对上、
//                      仿写＝AI 判对。青蓝（全站唯一强调色）。
//   bad    「未通过 ✕」判过、判错了。浅红（异常色）。
//   plain  「已完成」  **没人判过**，只记了一笔 —— 本地只查有没有出声、
//                      无麦时点「标记完成」、仿写浅检查放行。灰，不给色：
//                      "完成"不等于"对了"，两者不能长得一样。
//
// 三态之外还有"没做过"= null（什么都不画）。
// ⚠️ 卡片边框（.yl-stepcard-ok / -bad）与这里**同一套口径**，改一边必须改另一边。
export type StepStatus = "ok" | "bad" | "plain";

const STEP_STATUS_TEXT: Record<StepStatus, string> = {
  ok: "正解 ✓",
  bad: "未通过 ✕",
  plain: "已完成",
};

const STEP_STATUS_CLASS: Record<StepStatus, string> = {
  ok: "yl-step-status-ok",
  bad: "yl-step-status-bad",
  plain: "yl-step-status-plain",
};

/**
 * 把三态铺到卡头那枚状态胶囊上：文案 + 颜色类 + tooltip 一起换。
 * 传 `null` = 清空（这一步还没做过）。
 * ⚠️ `yl-step-status-warn` 是 2026-10-09 前的旧档（仿写兜底放行＝黄），现已被
 *    `plain` 取代；这里一并摘掉，免得老视图上挂着一条没人管的类。
 */
function paintStepStatus(el: HTMLElement, status: StepStatus | null, title = ""): void {
  el.removeClass("yl-step-status-ok", "yl-step-status-bad", "yl-step-status-plain", "yl-step-status-warn");
  if (!status) {
    el.setText("");
    el.removeAttribute("title");
    return;
  }
  el.addClass(STEP_STATUS_CLASS[status]);
  el.setText(STEP_STATUS_TEXT[status]);
  if (title) el.setAttr("title", title);
  else el.removeAttribute("title");
}

/**
 * 从进度行推**跟读**这一步的三态 —— 卡片边框（StudyView.refreshStepCards）
 * 与卡头胶囊共用这一条判据，别在两处各写一份。
 *
 * 🔥 跟读的「正解」判据是 `readAloudVerifiedAt` 有值，**不是** `readAloudAt`：
 *    后者只说明"读过了"，本地检查（只查有没有出声）与无麦「标记完成」也会写它。
 *    「未通过」不落库（判错不记完成），所以这里只会回 null / ok / plain。
 */
export function readAloudStatus(progress: ProgressRow | undefined): StepStatus | null {
  if (progress?.readAloudAt == null) return null;
  return progress.readAloudVerifiedAt ? "ok" : "plain";
}

// ── 跟读 ─────────────────────────────────────────────────────────────────
export interface ReadAloudHandle {
  root: HTMLElement;
  load(slice: StudySentence, progress: ProgressRow | undefined): void;
  /** 充值状态变了（刚连上账号 / 刚充上值）后重算按钮文案与提示 */
  refreshGate(): void;
  dispose(): void;
}

/**
 * 一次核对的结论。
 *
 * `wrong` 与 `error` 必须分开：前者是"读了、读得不对"（该重读），
 * 后者是"这次核对没跑成"（换个时间再点就行，不该让用户以为自己读错了）。
 *
 * `link` —— 通过时那句话里可能有一个可点的词（如「内置模型」，见 hintText.ts）。
 * 由上层给（它才知道点了该弹哪个窗），这里只负责铺出来。
 */
export interface ReadVerifyLink {
  /** 要在这句话里做成可点的那几个字 */
  keyword: string;
  onClick: () => void;
}

export type ReadVerifyOutcome =
  | {
      status: "ok";
      message: string;
      /**
       * 这一遍是不是**真的让 AI 逐词核对过**。
       *
       * `false` = 本地只查了有没有出声（未充值 / 分不出词时的降级）—— 过了，
       * 但没人判过发音：卡片写「已完成」（灰）而不是「正解」（青蓝）。
       */
      verified: boolean;
      link?: ReadVerifyLink;
    }
  | { status: "wrong"; message: string }
  | { status: "error"; message: string };

export function buildReadAloud(
  opts: {
    /**
     * 点「检查」时调用（2026-10-07 起不再录完自动跑）—— 由上层判定这份录音：
     * AI 可用走服务端逐词核对，不可用走本地检查（只查有没有出声）。
     * 上层知道句子、词表、充值状态，两条检查路径都在它那儿。
     * 第二个参数是**发起检查时**绑定的句子 cid：核对是出网的，回包时视图可能
     * 已经换句，落库必须认发起时那句（上层按 cid 找切片，不认 currentSlice）。
     */
    onVerify(
      payload: { blob: Blob; mimeType: string; seconds: number },
      sliceCid: string,
    ): Promise<ReadVerifyOutcome>;
    /** 麦克风用不了时点「标记完成」：不做任何检查，直接把这一步记完成 */
    onManualConfirm(sliceCid: string): Promise<void>;
    /** 能不能用 AI 核对（判据就一个：余额 > 0）—— 决定提示行说明是哪种检查 */
    canUseAi(): boolean;
    /** 又要读一遍了 —— 上层撤掉上一次标在原句上的颜色，别让旧红字挂着 */
    onRerecord(): void;
    /** 「重置」：上层清进度行里的跟读记录，并删掉本地存的那份录音 */
    onReset(): Promise<ProgressRow>;
    /** 取这句上次录的音；本地没有（换设备/老数据）返回 null */
    loadRecording(sliceCid: string): Promise<{ blob: Blob; mimeType: string; seconds: number } | null>;
    saveRecording(sliceCid: string, blob: Blob, mimeType: string, seconds: number): Promise<void>;
    /**
     * 检测到**当前这支麦克风是蓝牙输入**时问一句（2026-10-16 用户口径）。
     *
     * 🔒 **只告知，不许挑设备**：插件不换 `deviceId`、不试图改用户的输入源 ——
     * 用户在系统里选了什么就录什么，要不要换由他自己决定（曾做过"录音自动避开
     * 蓝牙麦"，被明确否决）。弹窗归上层：只有它拿得到 App 和设置。
     *
     * @returns `true` = 已经把选择权交给用户，这次录音**先停住**等答复
     *          （去路只有 `onContinue` / `onCancel` 两条）；`false` / 没提供 = 照常录。
     */
    onBluetoothMicHint?(payload: {
      /** 设备名（`track.label`）；拿不到是空串 */
      deviceName: string;
      /** 实际采样率（Hz）；拿不到是 0 */
      sampleRate: number;
      /** 用户选「就用它录」—— 照常开始这次录音 */
      onContinue: () => void;
      /** 用户选「先不录」、或直接把窗关了 —— 取消这次，放开麦克风 */
      onCancel: () => void;
    }): boolean;
  },
): ReadAloudHandle {
  const root = createDiv("yl-practice yl-read");

  // 抄写/仿写都有标题头，跟读原来靠左上角的 chip 标身份 —— 布局改成原句区 +
  // 时间线后 chip 没了，这里补同款标题头（圆点上的编号管顺序，卡内标题管它是什么）。
  // 原句/翻译搬去了独立的 hero 区（StudyView.buildHero），这里只剩录音这件事。
  const header = root.createDiv({ cls: "yl-practice-header" });
  header.createSpan({ cls: "yl-step-title", text: "跟读" });
  const statusEl = header.createSpan({ cls: "yl-step-status" });

  const controls = root.createDiv({ cls: "yl-read-controls" });
  const actions = root.createDiv({ cls: "yl-practice-actions" });

  type Phase = "idle" | "requesting" | "recording" | "review";
  let phase: Phase = "idle";
  let seconds = 0;
  let timer: number | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let stream: MediaStream | null = null;
  let pickedMime = "";
  let finalized = false;
  let audioUrl = "";
  let sliceDone = false;
  /** 当前句子有没有可听的录音（刚录的，或从本地库取回的历史录音） */
  let hasRecording = false;
  /**
   * 用户**有没有开始回听**这一份录音（点过播放键，或拖过进度条）。
   *
   * 🔥 它是"重封装件回来时能不能立刻换播放源"的**唯一闸门**：
   *   · 还没开始听 → 重封装件一回来就**立刻**把 `audio.src` 换成它 —— 第一遍听到的
   *     就是干净 webm（多簇多索引），首播不卡（病根见 `services/audioTrim.ts`）；
   *   · 已经在听了 → **一个字节都不动** —— 换 src 会把正在播（或已拖好位置）的
   *     那一份打断并复位；等这一遍 `ended` 再换（见 `pendingSource`）。
   * 换句 / 重置 / 重录都经 `releaseAudio()`，在那里复位。
   */
  let listeningStarted = false;
  /**
   * 重封装件回来时用户**已经在听**了，就记成"等着换上去"的那一份（`null` = 没有待换）。
   *
   * 只在"已经开始回听"时才会走到这里（`listeningStarted === true`）—— 那时不能立刻
   * 换源（会打断在播的那份），等**这一遍播完（`ended`）**再由 `applyPendingSource()`
   * 挂上去。还没开听的重封装件是**立刻**换的，不走这里。
   * 换句 / 重置 / 重录经 `releaseAudio()` 把它清掉。
   */
  let pendingSource: { blob: Blob; mimeType: string; seconds: number } | null = null;
  /** 异步取历史录音期间可能已经换句了 —— 回来先对一下 cid 再上屏 */
  let loadedSliceCid = "";
  /**
   * **当前这份录音** —— 刚录的，或从本地库取回的历史录音。「检查」查的就是它，
   * 核对完**不清**（2026-10-07 口径：检查可反复点，没查成再点一次就是重试）；
   * 重录会整份换掉，「重置」才清掉。
   *
   * ⚠️ 它跟的是**播放器现在挂着的那一份**：重封装件回来（还没开听）或播完换源时，
   * 它跟着换成那一份（那时它和 `trimmed` 是同一个对象）。
   */
  let current: { blob: Blob; mimeType: string; seconds: number } | null = null;
  /**
   * **送核对 / 存档**的那一份 —— 统一封装（+ 剪首尾空白）后的干净 webm。
   *
   * 🔥 为什么它和 `current` 可能短暂是两件事：
   * 播放源在重封装件回来时是**立刻换**的（第一遍就听干净 webm，首播不卡），
   * 所以在正常时序里它很快就是同一个对象；只有环境不支持 / 解码编码失败时才退回
   * 原始件（`blob: null`），那时送核对退到 `current`。
   * `null` = 重封装还没回来 → 送核对时先 `await trimTask` 再取（见 runCheck）。
   */
  let trimmed: { blob: Blob; mimeType: string; seconds: number } | null = null;
  /** 后台裁剪那一趟活；「检查」会等它落定再送核对。换句/重置/重录会作废（见 finalizeToken）。 */
  let trimTask: Promise<void> | null = null;
  /**
   * 收尾批次的号。`releaseAudio()` 一调就 +1 —— 换句、重置、重录、销毁都经过它，
   * 于是"上一份录音"的后台裁剪回来时认号不对就整份丢掉（既不碰界面、也不存档）。
   * ⚠️ 别改回用 `phase` 判断：新流程里收尾不再有专属相（没有「处理中…」了），
   *    拿相来认批次会认不出来。
   */
  let finalizeToken = 0;
  /** 核对进行中（「检查」点下去到结论回来） */
  let verifying = false;
  /** 「标记完成」进行中（无麦逃生舱，与核对分开 —— 按钮文案各说各的） */
  let marking = false;
  /**
   * 卡头那枚状态胶囊当前是几态（见 StepStatus）。留一份在内存里，是为了
   * 「又要读一遍」时能把上一遍的「未通过」撤掉 —— 那条结论是对上一份录音的，
   * 新录一遍还挂着它，看着像"还是错"。
   */
  let stepStatus: StepStatus | null = null;

  function setStatus(status: StepStatus | null, title = ""): void {
    stepStatus = status;
    paintStepStatus(statusEl, status, title);
  }

  /** 三态的 tooltip —— 跟读这两条过关路径的差别必须说清楚，别让人以为都"判过了"。 */
  const READ_STATUS_TITLE: Record<StepStatus, string> = {
    ok: "AI 逐词核对，每个词都读对了",
    bad: "这一遍读得不太准，重录一遍再试",
    plain: "没人判过发音：本地只查了有没有出声（或没麦时直接记了完成）",
  };
  /** 麦克风为什么用不了；空串 = 可用。load 时重算，取权限失败时也会置上 */
  let micReason = "";

  // ⚠️ 顺序 = 视觉上下（`yl-read-controls` 在 `yl-practice-actions` 之前）：
  // 回听条在上、按钮行在下。**回听条常驻**，所以按钮行的位置永远不会被顶动。
  // ⚠️ 顺序 = 视觉左右（`yl-practice-actions` 是 flex 行）：2026-10-07 口径 ——
  // 三颗钮：本步动作（开始录音 ↔ 停止）、「检查」、「重置」收最右。
  // 🔥 按钮**恒定显示、从不隐藏**（2026-10-03 的教训：显隐来回切会把相邻按钮
  // 顶来顶去，点一下闪一下）。该不该点一律用 disabled 表达，换脸只换字不换位置。
  // 🔥 2026-10-08 二次拍板：三颗钮**不设固定宽度**，跟抄写/仿写一样吃 createButton
  //    基底的 padding、按文案自然宽（用户嫌 92px 定宽太宽）。代价是录音钮换文案时
  //    「检查/重置」会横移一点 —— 用户知情。文案保持短句（最长「取麦克风…」），别撑宽。
  const recordButton = createButton(actions, { role: "primary" });
  const checkButton = createButton(actions, { text: "检查" });
  const resetButton = createButton(actions, { text: "重置" });
  const timerLabel = actions.createSpan({ cls: "yl-muted-sm yl-tabular" });

  // ── 回听条（自绘，2026-10-08 替换掉原生 <audio controls>）────────────────
  // 🔥 它是**常驻**的：从第一秒就在这条线上，没录音时只是整体压暗 + 两个控件 disabled。
  //    原先的写法是录完那一刻才把条显示出来（show），那一下把下面那行按钮整行顶下去 ⇒
  //    「停止」跑到别处、用户还得追着鼠标找。「显示得晚」才是跑位的根因，不是按钮本身。
  // 为什么不留原生那条：它读的是**整个文件**的时长、长相也一个像素都改不动
  // （它是 Chromium 画的），而且跟左侧视频控制条不是一套语言。
  // 三个零件照抄视频控制条：图标钮 + accent 滑杆 + 定宽 tabular 时间。
  const playButton = createButton(controls, { shape: "icon", icon: "play", ariaLabel: "播放" });
  const seekSlider = controls.createEl("input", {
    cls: "yl-read-slider",
    attr: { type: "range", min: "0", max: "1000", step: "1", value: "0", "aria-label": "回听进度" },
  });
  const clockLabel = controls.createSpan({ cls: "yl-muted-sm yl-tabular yl-read-clock" });

  /**
   * 真正出声的元素。**刻意不进 DOM** —— 界面上的条是我们自己画的，
   * 把它挂上去只会在 DOM 里多一个看不见的框（还会带上原生 controls 的样式钩子）。
   */
  const audio = new Audio();
  audio.preload = "auto";

  /**
   * 这张卡片是否已经销毁。**裁剪是异步的**，回来时可能卡片早没了
   * （换页、关面板），那之后一律不许再碰 DOM。
   */
  let disposed = false;

  /** 麦克风为什么用不了；空串 = 可用（环境的静态判断，授权失败在 start() 里另置） */
  function micUnavailableReason(): string {
    if (typeof window.MediaRecorder === "undefined") return "这个环境不支持网页录音";
    const media = navigator.mediaDevices;
    if (!media || typeof media.getUserMedia !== "function") {
      return "当前环境没有把麦克风开放给插件";
    }
    return "";
  }

  /** 提示行：一行只说一件事（下一步 / 结论 / 警告）。warn = 黄字 */
  function setHint(message: string, warn = false): void {
    timerLabel.removeClass("yl-warn-text");
    timerLabel.setText(message);
    if (warn) timerLabel.addClass("yl-warn-text");
  }

  /** 回听条上的总时长：优先信解码出来的；还没解出来时用录音那一刻记下的秒数 */
  function audioDuration(): number {
    if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
    return current?.seconds ?? 0;
  }

  /**
   * 刷新回听条。**这里没有任何显隐** —— 只切"能不能用"和"是什么脸"：
   *   · 没录音 → 整条压暗（`.is-off`）+ 播放钮/滑杆 disabled；
   *   · 有录音 → 亮起来，滑杆走 accent 色，可以拖、可以播。
   * 时长/位置/播放键的脸全在这儿收口，别在别处再改这几个 DOM。
   */
  function refreshPlayer(): void {
    const ready = hasRecording;
    controls.toggleClass("is-off", !ready);
    playButton.disabled = !ready;
    seekSlider.disabled = !ready;
    const playing = !audio.paused;
    // 没录音就把时长也归零 —— 不然「重置」之后条上还挂着上一份的 0:02.5，看着像没清掉
    const duration = ready ? audioDuration() : 0;
    const position = ready ? audio.currentTime : 0;
    seekSlider.value = String(duration > 0 ? Math.round((position / duration) * 1000) : 0);
    // 已播比例喂给 CSS 渐变。滑杆是**整条自己画的**（styles.css `.yl-read-slider`），
    // 它要的 `--yl-fill` 只能在这儿给 —— 直接从 value 换算（0~1000 → 0~100%），
    // 这样"填充终点"和"圆钮位置"永远同源，不会出现条和钮差半格。
    // ⚠️ 别改回 `accent-color`：Obsidian 把 input[type=range] 的 appearance 置成 none，
    //    accent-color 会失效，进度色整条消失（2026-10-08 用户报「完全没改动」的根因）。
    seekSlider.style.setProperty("--yl-fill", `${Number(seekSlider.value) / 10}%`);
    clockLabel.setText(
      `${formatClipClock(position * 1000)} / ${formatClipClock(duration * 1000)}`,
    );
    setButtonIcon(playButton, playing ? "pause" : "play", playing ? "暂停" : "播放");
  }

  playButton.addEventListener("click", () => {
    if (!hasRecording) return;
    // 用户开始回听了：这之后重封装件回来**也不许再立刻换播放源**（见 listeningStarted）
    listeningStarted = true;
    if (audio.paused) {
      // 已经播到尾巴了再点 = 从头再来 —— 不然按下去毫无反应，看着像坏了
      if (Number.isFinite(audio.duration) && audio.currentTime >= audio.duration - 0.05) {
        audio.currentTime = 0;
      }
      // play() 在极少数情况下会 reject（换句打断、解码失败）；这里吞掉，
      // 状态由 play/pause 事件回头刷新，绝不因此打断学习流程。
      void audio.play().catch(() => undefined);
    } else {
      audio.pause();
    }
  });

  seekSlider.addEventListener("input", () => {
    const duration = audioDuration();
    if (!hasRecording || duration <= 0) return;
    // 拖动 = 已经在这份录音上定过位了：同样不许立刻换源（换 `audio.src` 会把位置复位）
    listeningStarted = true;
    audio.currentTime = (Number(seekSlider.value) / 1000) * duration;
    refreshPlayer();
  });

  // 这几个事件把"播放器自己的状态"同步回条上（播放键的脸 + 进度 + 时间）
  for (const event of ["play", "pause", "ended", "timeupdate", "loadedmetadata"] as const) {
    audio.addEventListener(event, refreshPlayer);
  }
  // 🔥 重封装件在**这一遍放完之后**才换上（口径与理由见 `pendingSource`）。
  //    没开听时是立刻换的（见 startFinalize），走到这里 = 用户已经在听的那份，
  //    播完再换，绝不打断在播的那份。
  audio.addEventListener("ended", applyPendingSource);

  function setPhase(next: Phase): void {
    phase = next;
    // 🔥 回听条**常驻**（2026-10-08 用户拍板）：这里只按"有没有录音"刷新它的可用状态，
    // **绝不 show/hide** —— 一显隐就会把下面那行按钮顶来顶去，正是「停止」跑位的根因。
    refreshPlayer();

    // 最左这颗的脸由"能不能录音"决定：
    //   · 能录音 → 「开始录音 ↔ 停止」，requesting 是过场（进行时），
    //     点下去会把正在跑的那一份冲掉，所以置灰；核对/标记中同样锁住（重录会竞态）。
    //   · 不能录音 → 换脸成「标记完成」（不经检查记一笔）。正在记 / 已记过 → 置灰。
    if (micReason) {
      recordButton.disabled = verifying || marking || sliceDone;
      recordButton.setAttr(
        "title",
        sliceDone ? "这一步已经记过了" : "无法使用麦克风：不经检查，直接把这一步记为完成",
      );
    } else {
      recordButton.disabled = verifying || marking || next === "requesting";
      recordButton.removeAttribute("title");
    }

    // 「检查」核对的是 `current` 那份录音：还没录过、录音进行中、已经在核对里 —— 都不可点。
    // 核对完**不清**录音，所以可以反复点（重试 = 再点一次）。
    checkButton.disabled =
      verifying ||
      marking ||
      !current ||
      next === "requesting" ||
      next === "recording";
    checkButton.setText(verifying ? "检查中…" : "检查");
    checkButton.setAttr(
      "title",
      current
        ? "核对这一遍录音；没查成（断网/服务商抖动），再点一次就是重试"
        : "还没有录音：先录一遍再检查",
    );

    // 「重置」= 这一步完全恢复初始。还没做过（没完成、没录音）时无事可重置，
    // 置灰；录音/核对/标记中不可点。
    resetButton.disabled =
      verifying ||
      marking ||
      next === "requesting" ||
      next === "recording" ||
      (!sliceDone && !hasRecording);
    resetButton.setAttr("title", "把这一步完全恢复初始：清掉完成标记和录音，从头再来");

    if (marking) {
      recordButton.setText("标记中…");
    } else if (verifying) {
      // 进行时写在「检查」钮上（它才是这次动作的主语）；录音钮保持原字但置灰
      recordButton.setText(micReason ? "标记完成" : "开始录音");
      setHint(opts.canUseAi() ? "正在逐词核对这一遍…" : "正在检查这一遍…");
    } else if (next === "requesting") {
      // ⚠️ 这句是**整张卡最长的按钮文案**（4 字 + 省略号，正好塞进统一定的 92px）。
      //    加文案前先量一下：超了就要同时调 styles.css 里那颗统一宽度，
      //    否则「开始录音」变宽、整行横移（用户 10-08 点名过的毛病）。
      recordButton.setText("取麦克风…");
    } else if (next === "recording") {
      recordButton.setText("停止");
      setHint(`${seconds.toFixed(1)}s · 读完点「停止」`);
    } else if (micReason) {
      recordButton.setText("标记完成");
      // 麦克风不可用的提示一律黄字（2026-10-07 用户拍板），含已完成态 ——
      // 灰字会让人以为一切正常，其实这一步是降级过的。
      setHint(
        sliceDone
          ? "麦克风不可用。建议使用支持麦克风的设备，否则会降低学习效果。"
          : `${micReason} · 点「标记完成」跳过录音`,
        true,
      );
    } else if (sliceDone) {
      recordButton.setText("开始录音");
      // 核对结论（可能带可点词）通常已经占着这行 —— 结论写在前，别把它冲掉
      timerLabel.setText("已完成 · 想再练点「开始录音」");
    } else if (hasRecording) {
      // 刚录完（或换句回来发现上次的录音还在）：已存好，等人点「检查」。
      // 用哪种检查由充值状态定（AI 逐词 / 本地只查有没有出声），提示行说清楚。
      recordButton.setText("开始录音");
      setHint(
        opts.canUseAi()
          ? "录音已存好 · 点「检查」逐词核对"
          : "录音已存好 · 点「检查」看看有没有录上",
      );
    } else {
      recordButton.setText("开始录音");
      setHint("点「开始录音」，读完点「停止」");
    }
  }

  function cleanup(): void {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    recorder = null;
  }

  /**
   * 把"等着换上去"的重封装件挂上播放条 —— **只在用户已经在听、且这一遍播完（`ended`）时调**。
   *
   * 换 `audio.src` 会把正在播（或已拖好位置）的那一份打断并复位，所以这里绝不能
   * 在播放中途被调到；而"播完了"这个时刻换源是最没有代价的：下一遍本来就从 0 开始。
   * 还没开听的重封装件是**立刻**换的（见 startFinalize），不走这里。
   */
  function applyPendingSource(): void {
    const next = pendingSource;
    if (!next || !hasRecording) return;
    pendingSource = null;
    const previousUrl = audioUrl;
    audioUrl = URL.createObjectURL(next.blob);
    audio.src = audioUrl;
    // 旧的 blob URL 主动放掉 —— `releaseAudio()` 只会 revoke `audioUrl` 当时指向的那个
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    current = next;
    refreshPlayer();
  }

  function releaseAudio(): void {
    // 上一份录音的后台重封装就此作废（换句 / 重置 / 重录 / 销毁都经过这里）。
    // ⚠️ 这一句必须在最前面：作废要"立刻"，晚一行就可能让上一份的存档抢在
    //    「重置」把录音删掉之后落库，把人删掉的录音又救回来。
    finalizeToken += 1;
    trimTask = null;
    trimmed = null;
    // 下一份录音是全新的播放器会话：把"已开始回听"的闸门重新打开
    listeningStarted = false;
    // 还没换上的重封装件也一起丢掉 —— 它属于上一份录音，换到新的一句上就是放错内容
    pendingSource = null;
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      audioUrl = "";
    }
    hasRecording = false;
    // 只在真的在播时才 pause —— 对已经停住的东西调 pause() 没有意义，
    // 而且 jsdom（测试环境）会往 stderr 吐一句 "Not implemented"，白白淹掉真信号。
    if (!audio.paused) audio.pause();
    audio.removeAttribute("src");
    // 不调 audio.load()：jsdom / 部分环境里它是"未实现"，会朝控制台吐一条噪声，
    // 而这里的目的（把上一个 blob 放掉）removeAttribute 已经达成。
    refreshPlayer();
  }

  /**
   * 录完的收尾，两件事**分先后**：
   *
   *   ① **立刻**把**原始录音**摆上播放条 —— 录完就能听，不等任何加工（保底）；
   *   ② 在**后台**把录音统一封装成干净 webm（多簇多索引 + 写死时长，顺带剪首尾空白）。
   *
   * 🔥 为什么"先上原始件、再后台换干净件"（2026-10-15 第三次定位，彻底坐实病根）：
   * 病根不是"播的是哪一份文件"、也不是"冷启动抖动落在留白上"，而是
   * **MediaRecorder 直接产出的 webm 是"单簇 + 单一索引点"**（2026-10-10 已查到、这次
   * 坐实），播放器首播这种文件要**自己找索引** → 开头顿一下；重封装件是多簇多索引，
   * 首播是顺的（用户亲证：老录音——就是重封装过的——第一次播不卡）。
   * 所以"第一遍播原始件"这个方向**本身就是错的**：它让用户第一遍听的恰恰是会卡的那份。
   *
   * 正确做法：重封装只要 ~100ms，远快于人手点播放（≥200ms）—— 重封装件一回来、
   * **只要用户还没开听就立刻换成干净 webm**，第一遍就是顺的；只有用户抢在它回来之前
   * 已经开听了（几乎不可能，但保底）才等这一遍 `ended` 再换，绝不打断在播的那份。
   *
   * ⚠️ **原始件仍然不留**（2026-10-03 口径不变）：进库的、送核对的都是干净 webm，
   * 原始件只活在这次会话的内存里（`releaseAudio()` 一 revoke 就没了）。
   * ⚠️ **不要在这里加"静音预热播放"**（2026-10-15 深夜撤除）：录完麦克风停轨后蓝牙耳机
   *   要从 HFP 切回 A2DP，预热让输出在这个窗口里持续活跃 → 路由卡死 → **回听完全没声**。
   *   录完到点播放之间的自然静默正是系统切设备需要的。
   *
   * @param forSliceCid 重封装是异步的，回来时对一下是不是还这一句；换句 / 重置 / 重录 /
   *   销毁都会经 `releaseAudio()` 把 `finalizeToken` 推进一格，这份结果就整份作废。
   */
  function startFinalize(raw: Blob, mime: string, recorded: number, forSliceCid: string): void {
    // ① 立刻上屏：原始录音直接播（保底 —— 万一重封装失败/慢，用户还是能立刻听到点什么）
    audioUrl = URL.createObjectURL(raw);
    audio.src = audioUrl;
    hasRecording = true;
    current = { blob: raw, mimeType: mime, seconds: Number(recorded.toFixed(1)) };
    trimmed = null;
    setPhase("review");

    // ② 后台统一封装：干净 webm 用来**立刻换播放源（还没开听时）+ 送核对 + 存档**
    const token = finalizeToken;
    trimTask = (async () => {
      try {
        const trim = await trimRecording(raw).catch(() => null);
        if (token !== finalizeToken) return; // 已经换句 / 重置 / 重录了 —— 这份作废
        // 统一封装失败（环境不支持 WebCodecs / 解码 / 编码失败）才退回原始件 ——
        // 绝不因为封装失败把录音弄丢，也绝不因为封装失败让「检查」点不了。
        const blob = trim?.blob ?? raw;
        const mimeType = blob.type || mime;
        // 时长优先用解码出来的那个（没剪成时它也是解码值，比计时器准）；
        // 连解码都失败（`seconds === 0`）才退回计时器数出来的秒数。
        const seconds = Number((trim && trim.seconds > 0 ? trim.seconds : recorded).toFixed(1));
        trimmed = { blob, mimeType, seconds };

        // 🔥 只有**真产出干净 webm**才换源（`trim.blob` 有货）：换源换的是统一封装件，
        //    为的是第一遍就听多簇多索引的干净 webm，首播不卡（病根见 audioTrim.ts）。
        if (trim?.blob) {
          if (listeningStarted) {
            // 用户抢在重封装回来之前已经开听了（几乎不可能，保底）：不打断在播的那份，
            // 记成"待换"，等这一遍 `ended` 再挂上去（见 applyPendingSource）。
            pendingSource = { blob, mimeType, seconds };
          } else {
            // 正常时序：还没开听 → **立刻**把播放源换成干净 webm，第一遍就顺。
            const previousUrl = audioUrl;
            audioUrl = URL.createObjectURL(blob);
            audio.src = audioUrl;
            if (previousUrl) URL.revokeObjectURL(previousUrl);
            current = { blob, mimeType, seconds };
            refreshPlayer();
          }
        }

        // 留一份到本地库：下次打开这句还能听、还能补检查（录音只存本机，不同步）。
        // ⚠️ 存的是**干净 webm**（不是 `current` 里可能还在播的原始件）—— 库里只留一份。
        void opts.saveRecording(forSliceCid, blob, mimeType, seconds).catch(() => {
          // 存不上不挡流程：这次会话里照样能听（核对用的是内存里这份，不受影响）
        });
      } catch {
        // 收尾是"锦上添花"：真撞上预料之外的事，退回原始件就好，不往上冒
        trimmed = null;
      }
    })();
    // 🔥 不自动核对（2026-10-07 用户拍板，推翻 2026-10-04 的「录完即核对」）：
    // 存好、播放条摆上就够了 —— 什么时候查、查不查，由人点「检查」决定。
  }

  /**
   * 「检查」按下后核对**这一遍录音**。核对完**不清**录音 —— 可反复点，
   * 没查成（断网/服务商抖动）再点一次就是重试，不用重录。
   * 核对中锁住录音钮和重置钮：重录会把正在核的那一份冲掉。
   * 结果回来时可能已经换句 / 卡片销毁了（核对是出网的，慢），那种情况一律不碰 DOM。
   *
   * 🔥 送出去的是**统一封装后的干净 webm**（2026-10-10 用户口径：留白不参与判定，
   * 白白多传几秒还给服务端添负担；2026-10-15 起即使没得剪也重封装，多簇多索引）。
   * 后台重封装还没落定就**先等一下**（几十~几百毫秒，按钮已经切成「检查中…」，
   * 不是无声等待）；实在封不出来才退回原始件。
   */
  async function runCheck(forSliceCid: string): Promise<void> {
    const attemptNow = trimmed ?? current;
    if (!attemptNow) return;
    verifying = true;
    setPhase(phase);
    // 后台重封装还在跑就等它 —— 「检查」要的是干净 webm 那份
    if (trimTask) {
      try {
        await trimTask;
      } catch {
        // 重封装不作数（作废 / 出岔子）：下面用 trimmed ?? current 兜底
      }
    }
    if (disposed || loadedSliceCid !== forSliceCid) {
      verifying = false;
      return;
    }
    const attempt = trimmed ?? current;
    if (!attempt) {
      verifying = false;
      setPhase(phase);
      return;
    }
    let outcome: ReadVerifyOutcome;
    try {
      outcome = await opts.onVerify(
        { blob: attempt.blob, mimeType: attempt.mimeType, seconds: attempt.seconds },
        forSliceCid,
      );
    } catch {
      outcome = { status: "error", message: "检查没跑起来，再点一次「检查」试试。" };
    } finally {
      verifying = false;
    }
    if (disposed || loadedSliceCid !== forSliceCid) return;

    setPhase(phase);
    // 🔥 结论必须写在 `setPhase` **之后**：`setPhase` 会把提示行写回默认文案，
    //    先写结论等于写了白写。（进行时那句"正在核对"归 setPhase 的 verifying
    //    分管，这里不用重复写。）
    if (outcome.status === "ok") {
      sliceDone = true;
      // AI 逐词判过 → 正解；本地只查有没有出声 → 已完成（没人判过发音）
      setStatus(outcome.verified ? "ok" : "plain", READ_STATUS_TITLE[outcome.verified ? "ok" : "plain"]);
      // 本地检查通过时那句话里有个可点的词（「内置模型」虚线版）：
      // 配好内置模型之后想真判一遍，重新录一次再检查就会走 AI 核对。
      if (outcome.message) {
        if (outcome.link) {
          timerLabel.removeClass("yl-warn-text");
          renderHintLink(timerLabel, outcome.message, {
            keyword: outcome.link.keyword,
            onClick: outcome.link.onClick,
            dashed: true,
          });
        } else setHint(outcome.message);
      }
      return;
    }
    // 读得不对：**这一步没完成，但结论必须摆在卡上** —— 以前这里只写提示行、
    // 不碰状态，卡片还挂着上一轮的「已完成 ✓」，看着像"读对了"。
    if (outcome.status === "wrong") {
      setStatus("bad", READ_STATUS_TITLE.bad);
      if (outcome.message) setHint(outcome.message, true);
      return;
    }
    // 这次没核对成（断网 / 服务商抖动 / 没余额）—— 是"没查成"，**不是"读错了"**，
    // 状态一律不动，只把原因写进提示行。没余额那档 message 为空 = 弹窗已接管。
    if (outcome.message) setHint(outcome.message, true);
  }

  /** 无麦克风时的逃生舱：不经任何检查，直接把这一步记为完成 */
  async function markDoneWithoutCheck(): Promise<void> {
    const forSliceCid = loadedSliceCid;
    marking = true;
    setPhase(phase);
    try {
      await opts.onManualConfirm(forSliceCid);
    } catch {
      marking = false;
      setPhase(phase);
      new Notice("没记上，再试一次。");
      return;
    }
    marking = false;
    // 记一笔的工夫里可能已经换句了 —— 别把这一句算到下一句头上
    if (disposed || loadedSliceCid !== forSliceCid) return;
    sliceDone = true;
    current = null;
    setStatus("plain", "没经检查，只记了一笔完成");
    setPhase(phase);
  }

  async function start(): Promise<void> {
    if (micReason) return; // 录音钮在无麦态已置灰，这里兜一道
    releaseAudio();
    setPhase("requesting");
    try {
      // ⚠️ 不能只写 `{ audio: true }`：默认开着自动增益，录出来的音量会被浏览器
      // 按时间改写，回听着像"越来越小"（实测数据见 services/micCapture.ts）。
      //
      // 🔒 **不指定 `deviceId`，一律用系统当前默认的输入设备**（2026-10-15 用户口径）：
      // 各用各的 —— 系统输出是 AirPods 就用 AirPods 放，系统输入是 AirPods 麦就用 AirPods 麦录，
      // 是 Mac 内置麦就用内置麦。插件**不替用户挑设备、也不在用户输入/输出之间做交叉选择**：
      // 用户自己在系统声音设置里选了什么，插件就照用什么；想换设备在系统里换，插件跟着走。
      // （曾试过"录音避开蓝牙麦"，被明确否决。）
      stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
    } catch {
      // 授权失败也算"无麦"：此后「标记完成」恒可点（直接记完成），录音钮锁死
      micReason = "拿不到麦克风权限";
      setPhase("idle");
      return;
    }

    // 🔒 拿到麦克风那一下顺手看看**是不是蓝牙输入**（`services/micCapture`）：
    // 蓝牙链路一开麦就被压到通话模式，录出来会闷 —— 让上层问一句。
    // ⚠️ 这里**只告知**：插件绝不替用户挑设备、也不换 `deviceId`（见上面那条口径 ——
    //    （"录音自动避开蓝牙麦"那条已被明确否决）。用户说继续就原样录。
    // ⚠️ 必须在 getUserMedia **之后**才查得到设备名与采样率：没授权时浏览器一个都不给。
    const micInfo = inspectMicInput(stream);
    if (
      micInfo.isBluetooth &&
      opts.onBluetoothMicHint?.({
        deviceName: micInfo.deviceName,
        sampleRate: micInfo.sampleRate,
        onContinue: () => void beginRecording(),
        onCancel: () => {
          // 用户不要这次录音：立刻把麦克风放开（否则指示灯会一直亮着）
          cleanup();
          setPhase("idle");
        },
      })
    ) {
      // 上层把选择权交给用户了 —— 这次先停在这儿，两条去路都在上面。
      // 期间卡片停在 requesting 那一档（录音钮置灰、文案仍是短的那句，别加长），点不动。
      return;
    }
    void beginRecording();
  }

  /**
   * 真正开场 —— 麦克风到手、且确认这一趟要录（中间可能隔着蓝牙提示那句问询）。
   *
   * ⚠️ 开头那道 `!stream` 不是防御性冗余：等用户表态的那段时间里，**换句会走到
   * `abort()`**，它会 `cleanup()` 把流停掉；如果用户在那之后才点「就用它录」，
   * 这里拿到的就已经是 `null` 了 —— 不挡一下会在 `new MediaRecorder(null)` 上炸。
   */
  async function beginRecording(): Promise<void> {
    if (!stream) {
      setPhase("idle");
      return;
    }
    // 🔒 **开场提示音响完才开录**（口径见 services/audioCues.ts 文件头）：
    // 提示音要是和录音同时进行，它就会被录进这一遍里、正好落在**第一个词头上**，
    // 而发音评估最容易判歪的就是那儿（真机数据：整句 88 分，只有首词被压到 34）。
    // 这一下同时也告诉人"现在才真的开始录"，他听到才开口 —— 头就不会丢。
    await playRecordingCue("start");
    // 等这一下的工夫里可能换了句 / 取消了（abort 会把麦克风流停掉）—— 那就别开了
    if (!stream) {
      setPhase("idle");
      return;
    }
    chunks = [];
    finalized = false;
    pickedMime = pickMimeType();
    try {
      recorder = pickedMime ? new MediaRecorder(stream, { mimeType: pickedMime }) : new MediaRecorder(stream);
    } catch {
      recorder = new MediaRecorder(stream);
      pickedMime = recorder.mimeType || "";
    }
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onerror = () => {
      if (finalized) return;
      finalized = true;
      cleanup();
      setPhase("idle");
      setHint("录音中途断了，看看麦克风还在不在，再试一次", true);
    };
    recorder.onstop = () => {
      if (finalized) return;
      finalized = true;
      const mime = recorder?.mimeType || pickedMime || "audio/webm";
      cleanup();
      const recorded = seconds;
      if (!chunks.length) {
        setPhase("idle");
        seconds = 0;
        setHint("这次没录到声音，再试一次吧", true);
        return;
      }
      if (recorded < MIN_RECORD_SECONDS) {
        setPhase("idle");
        seconds = 0;
        setHint("这次几乎是刚点开就停了，像是误触了「停止」。读完再点停止吧", true);
        return;
      }
      const raw = new Blob(chunks, { type: mime });
      chunks = [];
      // 原始件先上屏（录完立刻能听），剪首尾空白挪到后台 —— 两件事都在里面，不抛
      startFinalize(raw, mime, recorded, loadedSliceCid);
    };
    recorder.start();
    seconds = 0;
    timer = window.setInterval(() => {
      seconds += 0.1;
      if (seconds >= MAX_RECORD_SECONDS) {
        // 到顶自动停（2026-10-05：一次录音有效时间最多 30 秒）。
        // 弹个通知说一声 —— 不然读到一半突然停了，用户只会以为坏了。
        stop();
        new Notice("录音到 30 秒自动停了。一句一句来，读慢一点可以分两次录。");
      } else if (phase === "recording") {
        // 计时里带上上限，让人一开始就知道有个 30 秒的天花板
        timerLabel.setText(`${seconds.toFixed(1)}s / ${MAX_RECORD_SECONDS}s · 读完点「停止」`);
      }
    }, 100);
    setPhase("recording");
  }

  function stop(): void {
    if (phase !== "recording") return;
    recorder?.stop();
    // 收场提示音（下行，与开场的上行相反）：点「停止」那一下就响，
    // 人听到就知道这一遍到这儿为止了。它已经在录音之后，录不进去。
    void playRecordingCue("stop");
  }

  /** 换句/销毁时放弃进行中的录音：不收音、不记一笔，省得算到新句子头上。 */
  function abort(): void {
    if (phase === "recording" || phase === "requesting") {
      finalized = true;
      recorder?.stop();
      cleanup();
      chunks = [];
    }
    seconds = 0;
    setPhase("idle");
  }

  // 「检查」：核对当前这份录音。核对完不清 —— 没查成（断网/服务商抖动）
  // 再点一次就是重试，不用重录（2026-10-07 口径的核心）。
  checkButton.addEventListener("click", () => {
    if (checkButton.disabled || !current) return;
    void runCheck(loadedSliceCid);
  });

  recordButton.addEventListener("click", () => {
    if (recordButton.disabled) return;
    // 无麦态这一颗已经换脸成「标记完成」：不经检查，直接记一笔
    if (micReason) {
      void markDoneWithoutCheck();
      return;
    }
    if (phase === "recording") {
      stop();
      return;
    }
    // 只有「闲着」和「录完在看结论」这两种状态能开录。
    // `requesting` 是过场，点下去会把正在跑的那一份冲掉。
    // ⚠️ 后台裁剪**不算过场**（2026-10-10）：录完立刻就能重录，不必等它。
    if (phase !== "idle" && phase !== "review") return;
    // 又要读一遍：上一次标在原句上的红绿先撤掉，否则新录的这一遍还没核，
    // 句子上却挂着上一遍的结论，看着像"已经判过了"
    opts.onRerecord();
    // 上一遍的「未通过」也是针对那份录音的结论 —— 撤掉，别让新的一遍还没查
    // 就顶着红字。正解 / 已完成 不动：那两步"完成"这件事本身没被撤销。
    if (stepStatus === "bad") setStatus(null);
    void start();
  });

  resetButton.addEventListener("click", () => {
    if (resetButton.disabled) return;
    resetButton.disabled = true;
    void opts
      .onReset()
      .then(() => {
        // 完全恢复初始：撤原句标色、撤播放条、作废还没核对的那份录音
        opts.onRerecord();
        abort();
        releaseAudio();
        current = null;
        sliceDone = false;
        setStatus(null);
        setPhase("idle");
      })
      .catch(() => {
        setPhase(phase);
        new Notice("没重置成，再试一次。");
      });
  });

  return {
    root,
    load(slice, progress) {
      abort();
      releaseAudio();
      seconds = 0;
      finalized = false;
      // 换句：这份录音属于上一句，先清掉 —— 本地库里存了的话马上会取回来
      current = null;
      verifying = false;
      marking = false;
      sliceDone = progress?.readAloudAt != null;
      {
        const status = readAloudStatus(progress);
        setStatus(status, status ? READ_STATUS_TITLE[status] : "");
      }
      loadedSliceCid = slice.cid;
      // 麦克风可用性每次 load 重算 —— 环境可能变了（刚授权、刚换设备）
      micReason = micUnavailableReason();
      if (sliceDone) setPhase("review");
      else setPhase("idle");
      // 本地存有这句的录音就把播放条请回来 —— **不管核对过没有**（2026-10-07：
      // 录音自动保存、检查归人点，上次录了没来得及查的，回来直接能查）。
      // 异步取，回来可能已经换句了 —— 对不上 cid 就丢掉；已经开始重录了也别搅局。
      void opts.loadRecording(slice.cid).then((row) => {
        if (!row?.blob || loadedSliceCid !== slice.cid) return;
        if (phase !== "idle" && phase !== "review") return;
        audioUrl = URL.createObjectURL(row.blob);
        audio.src = audioUrl;
        hasRecording = true;
        current = { blob: row.blob, mimeType: row.mimeType, seconds: row.seconds };
        setPhase("review");
      });
    },
    refreshGate() {
      // 充值状态可能刚变（连上账号 / 充上值）：提示行的检查说明跟着改。
      // 核对/标记进行中不重算，免得把进行时文案冲掉。
      if (!verifying && !marking) setPhase(phase);
    },
    dispose() {
      disposed = true;
      abort();
      releaseAudio();
    },
  };
}

// ── 抄写 ─────────────────────────────────────────────────────────────────

export interface CopyOutcome {
  result: CopyResult;
  progress: ProgressRow;
}

export interface CopyPracticeHandle {
  root: HTMLElement;
  load(slice: StudySentence, progress: ProgressRow | undefined): void;
  setOutcome(outcome: CopyOutcome): void;
  /**
   * 把罗马音行摆出来（不用用户再点一次「提示」）。
   *
   * 给**装完词典**那条路用：用户点「提示」→ 弹「安装词典」→ 装完回来，
   * 他刚才要的就是那行罗马音，让他再点一次是把刚做完的事退回去。
   */
  showRomaji(): void;
  /** 收尾：把还没落库的草稿兜底存掉（关视图/销毁时走） */
  dispose(): void;
}

/** 草稿自动保存的防抖间隔：敲字停了这么久才落库（换句/关视图有兜底，不等它） */
const DRAFT_SAVE_DEBOUNCE_MS = 800;

/**
 * 抄写提示行的「键帽」切分：整串键序按空白拆词，只留**能敲**的词。
 *
 *   · 拉丁键序照留，`-` 也是合法键帽 —— 那是**长音键**（ボーカル → bo-ka-ru，
 *     敲盘上真有这么一颗键）。2026-10-09 用户报「漏单词」就是过滤没认 `-`，
 *     含长音的词整颗凭空消失，提示行只剩前后残句；
 *   · 🔥 **不是键的一律不显示**（2026-10-04 用户拍板）：符号词（『』、。这类）直接丢掉，
 *     不做弱化标记也不留占位 —— 这行唯一的任务就是「告诉我照着敲什么键」，
 *     掺任何不能敲的东西进来，眼睛都要多判一次。
 */
export function romajiKeycaps(text: string): string[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .filter((part) => /^[a-zA-Z'-]+$/.test(part));
}

export function buildCopyPractice(
  opts: {
    /** 「检查」：与原句逐字比对并落库（判定本身在 StudyView，本地不花钱）。
     *  第二个参数是发起检查时绑定的句子 cid —— 判定虽是本地的，落库也得认对句。 */
    onSubmit(typed: string, sliceCid: string): Promise<CopyOutcome>;
    /** 「重置」：上层清掉这步的完成标记、留档和尝试次数 */
    onReset(): Promise<ProgressRow>;
    /** 「提示」用的罗马音：**键盘键序**（IME 键序，を=wo、ぢ=di），照着敲用；拿不到给空串 */
    getRomaji(slice: StudySentence): Promise<string>;
    /**
     * 本机词典装上了没。
     *
     * 没装的话「提示」点开也是空的（`getRomaji` 只能给空串），所以那张卡不摆
     * 罗马音行、转去喊上层弹「安装词典」窗 —— 用户正是在这一刻最想要读音。
     */
    hasDict(): boolean;
    /** 点了「提示」但词典没装上：上层弹安装窗（每次点都弹，用户会忘） */
    onNeedDict(): void;
    /** 草稿自动保存（2026-10-07 口径）：读这句敲了一半的草稿，没有给空串 */
    loadDraft(sliceCid: string): Promise<string>;
    /** 存草稿；空串 = 删（检查通过后留档接管、重置回初始） */
    saveDraft(sliceCid: string, text: string): Promise<void>;
    /** 点头部提示里的「日语输入法」：上层开帮助弹窗（平台差异在上面，卡不管 app/plugin） */
    onImeHelp(): void;
  },
): CopyPracticeHandle {
  const root = createDiv("yl-practice yl-copy");

  const header = root.createDiv({ cls: "yl-practice-header" });
  header.createSpan({ cls: "yl-step-title", text: "抄写" });
  const statusEl = header.createSpan({ cls: "yl-step-status" });
  const imeNotice = header.createSpan({ cls: "yl-muted-sm" });
  /**
   * 头部提示的三个状态（默认 / 粘贴警示 / 还原）共用一个铺法：warn 类挂在
   * 容器上、文案里「日语输入法」永远是可点的（实线下划线 = 该点的出口，
   * hintText.ts 口径）—— setText 会把可点词抹掉，所以两个态都走重铺。
   */
  const paintImeNotice = (message: string, warn = false): void => {
    imeNotice.toggleClass("yl-warn-text", warn);
    renderHintLink(imeNotice, message, { keyword: "日语输入法", onClick: () => opts.onImeHelp() });
  };
  paintImeNotice("请使用日语输入法");

  // 「提示」点开的罗马音行：摆在「抄写」标题和输入框之间，照着打字用
  const romajiEl = root.createDiv({ cls: "yl-copy-romaji" });
  romajiEl.hide();
  /**
   * 罗马音行的铺法：键帽切分见 `romajiKeycaps`。
   * 状态文案（加载中 / 拿不到 / 这一句没分出）**整行走 note 淡字**：它们是说明、
   * 不是要敲的内容，做成键帽会被当成要照着打的东西。
   */
  function paintRomajiNote(text: string): void {
    romajiEl.empty();
    romajiEl.addClass("yl-copy-romaji-note");
    romajiEl.setText(text);
  }
  function paintRomajiKeys(text: string): void {
    romajiEl.empty();
    romajiEl.removeClass("yl-copy-romaji-note");
    const parts = romajiKeycaps(text);
    if (parts.length === 0) {
      paintRomajiNote("这一句没分出罗马音");
      return;
    }
    for (const part of parts) romajiEl.createSpan({ cls: "yl-copy-romaji-key", text: part });
  }

  // 两个状态两个框：留档的那一个是死的；正在敲的走草稿。
  const lockedArea = root.createEl("textarea", {
    cls: "yl-copy-area",
    attr: { rows: "2", disabled: "disabled" },
  });
  const draftArea = root.createEl("textarea", {
    cls: "yl-copy-area",
    attr: { rows: "2", placeholder: "照着上面的原句敲一遍…" },
  });

  // 按钮行语法与跟读卡一致：本步动作（打字即动作）→ 检查 → 重置，「提示」
  // 是小文字钮（2026-10-07 定：保存改名检查 —— 数据自动保存，这颗只管核对）。
  // 🔥 三颗恒定显示，该不该点用 disabled 表达 —— 旧「重敲」的 invisible 占位
  // hack 就是为了防显隐跳动，按钮常驻之后那个 hack 没有存在的理由了。
  const actions = root.createDiv({ cls: "yl-practice-actions" });
  const checkButton = createButton(actions, { role: "primary", text: "检查" });
  const resetButton = createButton(actions, { text: "重置" });
  const hintButton = createButton(actions, {
    shape: "text",
    text: "提示",
    title: "显示键盘键序的罗马音，照着敲",
  });
  const hintEl = actions.createSpan({ cls: "yl-muted-sm" });

  const resultBox = root.createDiv({ cls: "yl-copy-result" });

  let slice: StudySentence | null = null;
  let progress: ProgressRow | undefined;
  let submitting = false;
  let resetting = false;
  let localPassed = false;
  /**
   * 上一次「检查」的结论（null = 还没查过）。抄写是逐字比对，天生只有对/错 ——
   * 但"错"不落库（判错不记完成），所以卡头那枚「未通过 ✕」靠这一份在内存里撑着，
   * 与判定框（resultBox）同生共死：重置 / 换句 一起清。
   */
  let lastResultOk: boolean | null = null;
  let pasteBlockedTimer: number | null = null;
  /** 「提示」开着的罗马音行；换句就收起来 */
  let romajiShown = false;
  /** 草稿防抖落库的定时器；换句/重置/关视图时兜底清掉 */
  let draftTimer: number | null = null;
  /** 敲过还没落库的草稿算脏 —— 兜底 flush 只在脏时写，别拿旧值空转 */
  let draftDirty = false;

  const passed = () => Boolean(progress?.copyDoneAt) || localPassed;
  const locked = () => passed() && Boolean(progress?.copyText) && !resetting;

  /** 抄写这一步的三态。逐字比对是**能判**的，所以没有「已完成（没人判过）」那一档。 */
  const COPY_STATUS_TITLE: Record<StepStatus, string> = {
    ok: "与原句逐字对上了",
    bad: "还没对上：照判定框里标出的地方改完再「检查」",
    plain: "",
  };

  function setStatus(status: StepStatus | null): void {
    paintStepStatus(statusEl, status, status ? COPY_STATUS_TITLE[status] : "");
  }

  /**
   * 把没落库的草稿存掉（2026-10-07 口径：数据自动保存，检查才是人点的）。
   * 锁定态不存 —— 输入框已经藏了，留着的是检查通过前的旧文，别倒回草稿里。
   */
  function flushDraft(): void {
    if (draftTimer !== null) {
      window.clearTimeout(draftTimer);
      draftTimer = null;
    }
    if (!draftDirty || !slice || locked()) return;
    draftDirty = false;
    void opts.saveDraft(slice.cid, draftArea.value);
  }

  function blockPaste(event: ClipboardEvent | DragEvent): void {
    event.preventDefault();
    paintImeNotice("这里不能粘贴，请用日语输入法敲", true);
    if (pasteBlockedTimer !== null) window.clearTimeout(pasteBlockedTimer);
    pasteBlockedTimer = window.setTimeout(() => {
      paintImeNotice("请使用日语输入法");
      pasteBlockedTimer = null;
    }, 2200);
  }

  function renderResult(result: CopyResult): void {
    resultBox.empty();
    if (!result) {
      resultBox.hide();
      return;
    }
    resultBox.show();
    resultBox.removeClass("yl-copy-result-ok", "yl-copy-result-bad");
    resultBox.addClass(result.ok ? "yl-copy-result-ok" : "yl-copy-result-bad");
    const head = resultBox.createDiv({ cls: "yl-copy-result-head" });
    head.createSpan({
      cls: "yl-copy-result-verdict",
      // 读音放过的单独说一声，不然"敲对了"会让人以为写法也跟字幕一致
      text: result.ok ? (result.level === "kana" ? "读音对了" : "敲对了") : result.hint || "还没对上",
    });
    head.createSpan({ cls: "yl-muted-sm yl-tabular", text: `准确率 ${Math.round(result.accuracy * 100)}%` });

    // 判定通过（correct / kana）就不画逐字对照了 —— 宽容层放过的写法（全角「１」
    // 敲成汉字「一」、汉字敲成假名）逐字对不上，画出来必然是一行红字加上
    // 「漏了 1 / 多敲了 一」，顶着 100% 的准确率告诉用户"敲错了"。
    // 结论说对，展示就得跟着说对：只把「原句写的是哪一种」这类提示讲清楚。
    // （对照本身也已经是空的，见 copyCheck.ts —— 这里再拦一道，防别的通过路径漏过来。）
    if (result.ok) {
      if (result.hint) resultBox.createDiv({ cls: "yl-muted-sm", text: result.hint });
      return;
    }

    if (result.ops.length) {
      const line = resultBox.createDiv({ cls: "yl-copy-diff" });
      for (const op of result.ops) {
        const span = line.createSpan({ text: op.op === "missing" ? op.expected : op.actual });
        span.addClass(
          op.op === "ok" ? "yl-op-ok" : op.op === "missing" ? "yl-op-missing" : "yl-op-extra",
        );
        if (op.op !== "ok") span.setAttr("title", op.op === "missing" ? "漏了" : "多敲了");
      }
    }
    const missing = result.ops.filter((op) => op.op === "missing").map((op) => op.expected);
    const extra = result.ops.filter((op) => op.op === "extra").map((op) => op.actual);
    if (missing.length) resultBox.createDiv({ cls: "yl-muted-sm", text: `漏了 ${missing.join("、")}` });
    if (extra.length) resultBox.createDiv({ cls: "yl-muted-sm", text: `多敲了 ${extra.join("、")}` });
  }

  // 判定框的显隐归 renderResult 管，这里不碰 —— 原来这里 hide() 了一下，
  // 提交后「先 renderResult 再 render」，判定刚显示就被抹掉，
  // 敲错了什么提示都看不到（网页版是常驻显示的）。
  function render(): void {
    romajiEl.toggle(romajiShown);
    if (locked()) {
      lockedArea.value = progress?.copyText ?? "";
      lockedArea.show();
      draftArea.hide();
      setStatus("ok");
      checkButton.disabled = true;
      checkButton.setAttr("title", "已经检查通过了；想重来点「重置」");
      resetButton.disabled = resetting;
      resetButton.setAttr("title", "完全恢复初始：清掉留档和完成记录，从头再抄");
      hintEl.setText("上面是你抄过的，留着不动");
      return;
    }
    lockedArea.hide();
    draftArea.show();
    // 过了 = 正解；查过但没对上 = 未通过（浅红）；还没查过 = 不画
    setStatus(passed() ? "ok" : lastResultOk === false ? "bad" : null);
    refreshButtons();
    hintEl.setText("照着原句敲，敲完点「检查」（草稿自动保存）");
  }

  /** 按钮的置灰与说明。输入框每敲一个字都要重算，单独拎出来给 input 监听共用 */
  function refreshButtons(): void {
    const attempts = progress?.copyAttempts ?? 0;
    checkButton.disabled = submitting || resetting || !draftArea.value.trim();
    checkButton.setAttr(
      "title",
      `检查：与原句逐字比对，不对就改完再查${attempts > 0 ? ` · 已试 ${attempts} 次` : ""}`,
    );
    // 这一步还是初始状态（没草稿、没判定框、没完成过）时，重置无事可做
    resetButton.disabled =
      submitting ||
      resetting ||
      (!draftArea.value && !resultBox.textContent && !passed());
    resetButton.setAttr("title", "完全恢复初始：清掉草稿、判定和完成记录");
  }

  draftArea.addEventListener("input", () => {
    refreshButtons();
    // 草稿自动保存：敲字停了约 0.8 秒落一次库；换句/重置/关视图另有兜底
    draftDirty = true;
    if (draftTimer !== null) window.clearTimeout(draftTimer);
    draftTimer = window.setTimeout(flushDraft, DRAFT_SAVE_DEBOUNCE_MS);
  });
  // 回车不提交：回车在日语输入法里是"确定假名"，抢来做提交等于让人敲到一半被判一次
  draftArea.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") event.stopPropagation();
  });
  draftArea.addEventListener("paste", blockPaste);
  draftArea.addEventListener("drop", blockPaste);

  checkButton.addEventListener("click", () => {
    if (checkButton.disabled || !draftArea.value.trim() || !slice) return;
    // 检查前先把没落库的草稿兜底存掉 —— 判定本地就出，万一库里出岔子，
    // 字还在草稿里，再点一次「检查」就是重试
    flushDraft();
    submitting = true;
    checkButton.disabled = true;
    void opts
      .onSubmit(draftArea.value, slice.cid)
      .then((outcome) => {
        submitting = false;
        progress = outcome.progress;
        localPassed = outcome.result.ok;
        lastResultOk = outcome.result.ok;
        if (outcome.result.ok && slice) {
          // 通过 = 留档接管，草稿清掉（「重置」后从空框重新敲）
          draftDirty = false;
          void opts.saveDraft(slice.cid, "");
        }
        renderResult(outcome.result);
        render();
      })
      .catch(() => {
        submitting = false;
        render();
        new Notice("没记上，再点一次「检查」。");
      });
  });

  resetButton.addEventListener("click", () => {
    if (resetButton.disabled || !slice) return;
    resetting = true;
    draftArea.value = "";
    draftDirty = false;
    lastResultOk = null;
    resultBox.empty();
    resultBox.hide();
    render();
    void opts
      .onReset()
      .then((row) => {
        progress = row;
        resetting = false;
        localPassed = false;
        lastResultOk = null;
        render();
        draftArea.focus();
      })
      .catch(() => {
        resetting = false;
        render();
        new Notice("没重置成，再试一次。");
      });
  });

  // 「提示」：在「抄写」标题和输入框之间摆出这句的**键序罗马音**（再点一下收起）。
  // 🔥 点进输入框就收（2026-10-07 用户拍板）：提示行一直挂着，照着键帽敲就成
  // "打字母"了，起不到回忆的作用 —— 看一眼，回输入框时提示行让位，凭记忆敲。
  /** 摆出罗马音行（异步取键序）。装完词典要重放的那一下也走这里。 */
  function revealRomaji(): void {
    if (!slice) return;
    romajiEl.show();
    paintRomajiNote("罗马音加载中…");
    const cid = slice.cid;
    void opts
      .getRomaji(slice)
      .then((romaji) => {
        // 分词是异步的，回来时可能已经换句或收起了 —— 过期结果直接丢
        if (romajiShown && slice?.cid === cid) paintRomajiKeys(romaji || "");
      })
      .catch(() => {
        if (romajiShown && slice?.cid === cid) paintRomajiNote("罗马音拿不到（本机词典没装上？）");
      });
  }

  hintButton.addEventListener("click", () => {
    // 🔥 词典没装上：这一行点开是空的，别摆了 —— 直接喊上层弹「安装词典」窗。
    //    每次点都说（用户会忘），而且这是他**主动要读音**的那一刻，动机最强。
    //    此刻 romajiShown 保持 false，装完由 showRomaji() 补上。
    if (!opts.hasDict()) {
      opts.onNeedDict();
      return;
    }
    romajiShown = !romajiShown;
    if (!romajiShown || !slice) {
      romajiEl.hide();
      return;
    }
    revealRomaji();
  });
  draftArea.addEventListener("focus", () => {
    if (!romajiShown) return;
    romajiShown = false;
    romajiEl.hide();
  });

  return {
    root,
    load(nextSlice, nextProgress) {
      // 换句前把上一句没落库的草稿兜底存掉（此刻 slice/输入框还是上一句的）
      flushDraft();
      slice = nextSlice;
      progress = nextProgress;
      resetting = false;
      localPassed = false;
      lastResultOk = null;
      // 新句子的罗马音和旧句子无关，提示行收起来
      romajiShown = false;
      romajiEl.hide();
      draftArea.value = "";
      resultBox.empty();
      resultBox.hide();
      render();
      // 上次敲了一半的草稿请回来（2026-10-07 口径：草稿自动保存，换句回来还在）。
      // 异步取：对不上句 / 已经锁定 / 用户已经先敲了字 —— 都别盖。
      const cid = nextSlice.cid;
      void opts.loadDraft(cid).then((draft) => {
        if (!draft || slice?.cid !== cid || locked() || draftArea.value) return;
        draftArea.value = draft;
        refreshButtons();
      });
    },
    setOutcome(outcome) {
      progress = outcome.progress;
      localPassed = outcome.result.ok;
      renderResult(outcome.result);
      render();
    },
    showRomaji() {
      // 已经摆着就什么都不做（用户自己开过一次，别把新的那次当第二次点击关掉）
      if (!slice || romajiShown) return;
      romajiShown = true;
      revealRomaji();
    },
    dispose() {
      flushDraft();
    },
  };
}

// ── 仿写 ─────────────────────────────────────────────────────────────────

export interface ImitationPracticeHandle {
  root: HTMLElement;
  load(slice: StudySentence, progress: ProgressRow | undefined): void;
  /** 登录状态变了（刚连接上 / 刚退出）后重算提示文案 */
  refreshGate(): void;
  /** 收尾：把还没落库的草稿兜底存掉（关视图/销毁时走） */
  dispose(): void;
}

/**
 * 「AI 核对」的结果。
 *
 * `ok` 里必须带上**落库后的进度行** —— 卡片本地那份 `progress` 靠它对齐。
 * 以前判对之后还要再走一次「保存」才拿得到行，同一个结论写了两遍库。
 * `error` 的 `message` 允许为空：那是"没余额、统一弹窗已接管"的信号，
 * 卡片**不得**再就地摆一句余额提示（2026-10-04 用户拍板）。
 */
export type VerifyOutcome =
  | {
      status: "ok";
      verdict: VerdictView;
      progress: ProgressRow;
    }
  | { status: "error"; message: string };

/**
 * 判定框要显示的那几项。`suggestion` 与 `suggestionNote` **成对** —— 只给一句
 * 半截建议、或说不出改了哪里，都不显示（见 `renderSuggestion`）。
 */
export type VerdictView = {
  correct: boolean;
  reason: string;
  /** 改写建议句（一句完整日语，不含「更自然的说法：」标签） */
  suggestion: string;
  /** suggestion 改了哪里的一句中文说明 */
  suggestionNote: string;
  translation: string;
};

/**
 * 渲染「更自然的说法」这一块。**建议句与区别说明两个都非空才显示** ——
 * 这正是 2026-10-09 那次改口径要的形态：先说完整句子，再说清它和学生写的
 * 差在哪；给不全就干脆不说（宁可漏标）。
 *
 * 三处渲染（流式两处 + 落库回显）全走这里，别在各处再拼一遍 —— 以前同一个
 * 评语散在三处，前缀「更自然的说法：」也是各加各的。
 */
function renderSuggestion(
  box: HTMLElement,
  suggestion: string,
  suggestionNote: string,
  studentText: string,
): void {
  const cleaned = cleanSuggestion(suggestion, studentText);
  const note = (suggestionNote ?? "").trim();
  if (!cleaned || !note) return;
  box.createDiv({ cls: "yl-verdict-suggest", text: `更自然的说法：${cleaned}` });
  box.createDiv({ cls: "yl-verdict-suggest-note", text: note });
}

/** 没经过 AI 核对时那句话的前半截（措辞是用户 2026-09-27 定的，别自己改） */
const UNVERIFIED_NOTICE = "这个仿写未经过 AI 检查正确性";

/**
 * 仿写卡片。
 *
 * 按钮语法与抄写卡一致（2026-10-07 用户拍板）：「检查」「重置」「提示」。
 * 草稿自动保存（敲了就在，services/studyDrafts）；「检查」= 用当前环境能用的
 * 最深检查核对这一句，**不被弹窗拦截**：
 *   · AI 可用 → 送 AI 判定，判对了这一步才算过；
 *   · AI 用不了 → **浅检查**（写没写句子、且不是照抄原句）→ 记成「已完成」（灰），
 *     上行不收（见 `ProgressRow.imitationVerifiedAt`）；灰字里的「开启 AI」是
 *     虚线可点词，点了才弹「配置模型」窗 —— 配置是用户的主动选择，不再借道检查。
 */
export function buildImitation(opts: {
  /**
   * 「检查」且 AI 可用：送 AI 判定。带发起检查时绑定的句子 cid（回包可能已换句）。
   * `onFields` 给了就走**真流式**（2026-10-09）：判定框里的文字边生成边铺。
   */
  onVerify(
    text: string,
    sliceCid: string,
    onFields?: (fields: StreamVerdict) => void,
  ): Promise<VerifyOutcome>;
  /** AI 不可用时「检查」的浅检查放行（落库时标成"未核对"） */
  onPassUnverified(text: string, sliceCid: string): Promise<ProgressRow>;
  /** 「提示」：打开助手面板，自动问一句引导仿写的话 */
  onHint(): void;
  /** 提示语里的「充值」被点时打开充值页 —— 跳转只发生在这一下，不自动跳 */
  onRecharge: () => void;
  /** AI 现在能不能真判（含登录状态）。每次渲染提示语/按钮说明时用，别缓存 */
  getGate(): AiGate;
  /**
   * 「检查」/「提示」触发时的门控核实：本地缓存说不行不能直接判死 —— 余额
   * 真值在服务端，充值在网页端完成，插件这边只有主动去问才知道。
   * 实现在上层（StudyView）。
   */
  checkGate(): Promise<AiGate>;
  /** 灰字里「开启 AI」被点 → 弹「配置模型」窗（不带兜底回调，只做配置） */
  onNeedSetup(): void;
  /** 「重置」：上层清掉这步的完成标记、留档和评语 */
  onReset(): Promise<ProgressRow>;
  /** 草稿自动保存（2026-10-07 口径）：读这句敲了一半的草稿，没有给空串 */
  loadDraft(sliceCid: string): Promise<string>;
  /** 存草稿；空串 = 删（检查通过后留档接管、重置回初始） */
  saveDraft(sliceCid: string, text: string): Promise<void>;
}): ImitationPracticeHandle {
  const root = createDiv("yl-practice yl-imitation");

  const header = root.createDiv({ cls: "yl-practice-header" });
  header.createSpan({ cls: "yl-step-title", text: "仿写" });
  const statusEl = header.createSpan({ cls: "yl-step-status" });

  const lockedArea = root.createEl("textarea", {
    cls: "yl-copy-area",
    attr: { rows: "2", disabled: "disabled" },
  });
  const draftArea = root.createEl("textarea", {
    cls: "yl-copy-area",
    attr: { rows: "2", placeholder: "照着原句的结构，造一个内容不同的日语句子…" },
  });

  // 按钮行语法与抄写卡一致：检查、重置，「提示」是小文字钮（2026-10-07 定）。
  const actions = root.createDiv({ cls: "yl-practice-actions" });
  const checkButton = createButton(actions, { role: "primary", text: "检查" });
  const resetButton = createButton(actions, { text: "重置" });
  const hintButton = createButton(actions, {
    shape: "text",
    text: "提示",
    title: "卡住了？让 AI 引导你怎么写",
  });
  const hintEl = actions.createSpan({ cls: "yl-muted-sm" });

  const verdictBox = root.createDiv({ cls: "yl-verdict" });
  verdictBox.hide();

  let slice: StudySentence | null = null;
  let progress: ProgressRow | undefined;
  /** 判定 / 浅检查放行进行中 */
  let busy = false;
  let resetting = false;
  /** 草稿防抖落库的定时器；换句/重置/关视图时兜底清掉 */
  let draftTimer: number | null = null;
  /** 敲过还没落库的草稿算脏 —— 兜底 flush 只在脏时写，别拿旧值空转 */
  let draftDirty = false;

  const done = () => progress?.imitationCorrect === true;
  const locked = () => done() && Boolean(progress?.imitationText) && !resetting;
  /** 过了、但没真让 AI 看过（AI 不可用时的浅检查放行） */
  const unverified = () => progress?.imitationCorrect === true && !progress.imitationVerifiedAt;

  /**
   * 把没落库的草稿存掉（2026-10-07 口径：数据自动保存，检查才是人点的）。
   * 锁定态不存 —— 输入框已经藏了，留着的是检查通过前的旧文，别倒回草稿里。
   */
  function flushDraft(): void {
    if (draftTimer !== null) {
      window.clearTimeout(draftTimer);
      draftTimer = null;
    }
    if (!draftDirty || !slice || locked()) return;
    draftDirty = false;
    void opts.saveDraft(slice.cid, draftArea.value);
  }

  /**
   * 进度行里留着的那份 AI 评语 —— 只有它和当前结论**对得上**才算数。
   *
   * 结论换了而评语没换（比如判错之后又走了一次兜底放行），这种残片一律不认，
   * 否则卡片会出现「已完成 ✓」配一段"为什么没通过"的理由。`submitImitation` 已经把
   * "没评语"的路径写成清空，这里是第二道防线。
   */
  function storedVerdict(): VerdictView | null {
    const fb = progress?.imitationFeedback;
    if (!fb || typeof fb.correct !== "boolean") return null;
    if (progress?.imitationCorrect !== fb.correct) return null;
    return {
      correct: fb.correct,
      reason: typeof fb.reason === "string" ? fb.reason : "",
      suggestion: typeof fb.suggestion === "string" ? fb.suggestion : "",
      suggestionNote: typeof fb.suggestionNote === "string" ? fb.suggestionNote : "",
      translation: typeof fb.translation === "string" ? fb.translation : "",
    };
  }

  /** 浅检查放行的那句话 —— 登录状态不同，后半句的指向也不同 */
  function unverifiedNotice(): string {
    const gate = opts.getGate();
    // 「请登录」对没开 AI / 没填 Key 的人是错的指向，得按门控说的原因来讲
    if (!gate.ok && gate.reason !== "need-login") return `${UNVERIFIED_NOTICE}，${gate.message}`;
    return `${UNVERIFIED_NOTICE}，请登录后开启 AI`;
  }

  /**
   * 头部状态：这一步**到底算不算过、有没有真让 AI 看过**，必须写出来。
   *
   * 三态严格跟着进度行走（2026-10-09 与卡片边框、跟读/抄写统一口径，见 StepStatus）：
   *   · `imitationCorrect === false`        → 未通过 ✕（浅红，还会退回让用户改）
   *   · `true` + `imitationVerifiedAt` 有值 → 正解 ✓（青蓝，AI 判过）
   *   · `true` + 没有核对时刻               → 已完成（灰，浅检查放行 / 没人判过）
   * 🔥 状态必须跟数据一致：进度记的是"对"，展示就不能说"还没核对"；
   *    反过来，没核过的也不能冒充"AI 判过"。
   */
  function renderStatus(): void {
    if (progress?.imitationCorrect === false) {
      paintStepStatus(statusEl, "bad", "AI 没通过这句，改完再点「检查」");
      return;
    }
    if (progress?.imitationCorrect === true) {
      if (progress.imitationVerifiedAt) {
        paintStepStatus(statusEl, "ok", "经过 AI 判定，这句可以了");
      } else {
        // 没人判过：灰色「已完成」。**为什么没人判**（没登录 / 没配模型）由
        // tooltip 与卡片底部的黄字提示行说 —— 那两句要带门控原因，不是死文案。
        paintStepStatus(statusEl, "plain", unverifiedNotice());
      }
      return;
    }
    paintStepStatus(statusEl, null);
  }

  /** 提示行：一行只说一件事。warn = 黄字 */
  function setHint(message: string, warn = false): void {
    hintEl.removeClass("yl-warn-text");
    hintEl.setText(message);
    if (warn) hintEl.addClass("yl-warn-text");
  }

  /** 提示文案：能判就说怎么用，不能判就说清「检查」会怎么收这一步 */
  function renderHint(): void {
    hintEl.removeClass("yl-warn-text");
    if (opts.getGate().ok) {
      hintEl.setText("照着原句的结构写一句，写完点「检查」，AI 会判定这句日语");
      return;
    }
    renderHintLink(
      hintEl,
      "AI 还不能用：「检查」只检查写没写句子 · 想真判一遍，先「开启 AI」",
      { keyword: "开启 AI", onClick: () => opts.onNeedSetup(), dashed: true },
    );
  }

  /** 按钮的置灰与说明。草稿每敲一个字都要重算，单独拎出来给 input 监听共用 */
  function refreshButtons(): void {
    const gate = opts.getGate();
    checkButton.disabled = busy || resetting || !draftArea.value.trim();
    checkButton.setAttr(
      "title",
      gate.ok
        ? "让 AI 判定这句对不对；没判成（断网/服务商抖动），再点一次就是重试"
        : "AI 还不能用：只检查写没写句子，记「已完成」",
    );
    // 这一步还是初始状态（没草稿、也没存过任何结论）时，重置无事可做
    resetButton.disabled =
      busy || resetting || (!draftArea.value && progress?.imitationCorrect == null);
    resetButton.setAttr("title", "完全恢复初始：清掉留档、评语和完成记录");
  }

  function render(): void {
    // 判定框跟着进度行里那份评语走：判过就一直看得到"为什么"。
    // 以前它只在点「保存」那一瞬间存在，切走再回来，「未通过 ✕」就成了没下文的两字。
    renderVerdict(storedVerdict());
    renderStatus();
    if (locked()) {
      lockedArea.value = progress?.imitationText ?? "";
      lockedArea.show();
      draftArea.hide();
      checkButton.disabled = true;
      checkButton.setAttr("title", "已经检查通过了；想重来点「重置」");
      resetButton.disabled = resetting;
      resetButton.setAttr("title", "完全恢复初始：清掉留档、评语和完成记录，从头再仿");
      if (unverified()) {
        // 浅检查放行过的那句：把"没经过 AI 检查"明说出来，别让人以为 AI 认可了
        hintEl.addClass("yl-warn-text");
        hintEl.setText(unverifiedNotice());
      } else {
        hintEl.removeClass("yl-warn-text");
        hintEl.setText("上面是你仿写过的，留着不动");
      }
      return;
    }
    lockedArea.hide();
    draftArea.show();
    refreshButtons();
    renderHint();
  }

  hintButton.addEventListener("click", () => {
    if (!slice) return;
    opts.onHint();
  });

  // 内容为空时「检查」置灰（三张卡同一口径）；草稿防抖自动落库
  draftArea.addEventListener("input", () => {
    refreshButtons();
    draftDirty = true;
    if (draftTimer !== null) window.clearTimeout(draftTimer);
    draftTimer = window.setTimeout(flushDraft, DRAFT_SAVE_DEBOUNCE_MS);
  });

  checkButton.addEventListener("click", () => {
    if (!slice || busy) return;
    const text = draftArea.value.trim();
    if (!text) {
      setHint("先写一句再检查。", true);
      return;
    }

    // 检查前先把没落库的草稿兜底存掉 —— AI 判定要出网，字先落在草稿里
    flushDraft();
    // 整个检查（含向服务器核实余额）都算忙：核实要打一次网络，期间保持不可点
    busy = true;
    checkButton.disabled = true;
    void (async () => {
      // 缓存说 AI 用不了也先向服务器核实一次（充值在网页端完成，缓存可能只是
      // 旧的）；服务器也确认没钱才走浅检查放行 —— 别让充了值的人被记「未核对」。
      // 核实本身要出网 —— 挂了不算"AI 用不了"，就是这次没查成，再点一次即可。
      let gate: Awaited<ReturnType<typeof opts.checkGate>>;
      try {
        gate = await opts.checkGate();
      } catch {
        setHint("检查没成功，再点一次「检查」试试。", true);
        return;
      }
      if (!gate.ok) {
        // AI 用不了：不做任何弹窗拦截 ——「检查」用浅检查收下这一步。
        // 只查两件事：写了句子、且不是照抄原句。过了记「已完成」（灰 —— 没人判过）。
        if (normalizeForCopy(text) === normalizeForCopy(effectiveJa(slice))) {
          setHint("仿写要造一个内容不同的句子，不能照抄原句", true);
          return;
        }
        setHint("AI 现在用不了，先按「已完成」记上…");
        try {
          progress = await opts.onPassUnverified(text, slice.cid);
          draftDirty = false;
          void opts.saveDraft(slice.cid, "");
          render();
        } catch {
          new Notice("没记上，再点一次「检查」。");
        }
        return;
      }

      checkButton.setText("判定中…");
      setHint("正在让 AI 看这一句…");
      // 真流式（2026-10-09）：判定框里的文字边生成边铺。结论头（「这句可以了/
      // 再改一下」）**不**在流式里出 —— 判定要等落库才算数，半截时摆结论会骗人。
      let streamArrived = false;
      try {
        const outcome = await opts.onVerify(text, slice.cid, (fields) => {
          // 建议句与区别说明**成对**才算一条要显示的内容 —— 只到半截（或模型
          // 没给区别说明）时不算，别为它把空判定框亮出来（见 renderSuggestion）
          const showSuggestion = Boolean(
            cleanSuggestion(fields.suggestion, text) && (fields.suggestionNote ?? "").trim(),
          );
          if (!fields.reason && !fields.translation && !showSuggestion) return;
          streamArrived = true;
          verdictBox.empty();
          // 上一份判定可能带着 ok/bad 配色：流式阶段还没有结论，配色一并摘掉
          verdictBox.removeClass("yl-verdict-ok");
          verdictBox.removeClass("yl-verdict-bad");
          if (fields.reason) verdictBox.createDiv({ cls: "yl-muted-sm", text: fields.reason });
          if (fields.translation) verdictBox.createDiv({ cls: "yl-muted-sm", text: `你写的是：${fields.translation}` });
          renderSuggestion(verdictBox, fields.suggestion, fields.suggestionNote, text);
          verdictBox.show();
        });
        if (outcome.status === "error") {
          // message 为空 = 上层已弹统一弹窗接管（没余额那档），卡片不再就地重复
          if (outcome.message) {
            hintEl.addClass("yl-warn-text");
            renderHintWithRecharge(hintEl, outcome.message, opts.onRecharge);
          }
          // 流到一半才断的：已显示的判定文字**留着**（那是模型的真实产出，
          // 抹掉等于白等）—— 只是不摆结论头，也不算过
          if (!streamArrived) renderVerdict(null);
          return;
        }
        // 判定与进度行都由调用方落库后给回来 —— 这里不再自己拼一份，
        // 也不再有"判对之后再走一次保存"的第二遍写。
        progress = outcome.progress;
        if (outcome.verdict.correct && slice) {
          // 判对 = 留档接管，草稿清掉（「重置」后从空框重新写）
          draftDirty = false;
          void opts.saveDraft(slice.cid, "");
        }
        renderVerdict(outcome.verdict);
        render();
      } catch {
        setHint("检查没成功，再点一次「检查」试试。", true);
      }
    })().finally(() => {
      busy = false;
      checkButton.setText("检查");
      refreshButtons();
    });
  });

  resetButton.addEventListener("click", () => {
    if (resetButton.disabled || !slice) return;
    resetting = true;
    draftArea.value = "";
    draftDirty = false;
    void opts
      .onReset()
      .then((row) => {
        progress = row;
        resetting = false;
        render();
        draftArea.focus();
      })
      .catch(() => {
        resetting = false;
        render();
        new Notice("没重置成，再试一次。");
      });
  });

  function renderVerdict(verdict: VerdictView | null): void {
    verdictBox.empty();
    if (!verdict) {
      verdictBox.hide();
      return;
    }
    verdictBox.toggleClass("yl-verdict-ok", verdict.correct);
    verdictBox.toggleClass("yl-verdict-bad", !verdict.correct);
    const head = verdictBox.createDiv({ cls: "yl-verdict-head" });
    const icon = head.createSpan({ cls: "yl-verdict-icon" });
    setIcon(icon, verdict.correct ? "check-circle-2" : "x-circle");
    head.createSpan({ text: verdict.correct ? "这句可以了" : "再改一下" });
    if (verdict.reason) verdictBox.createDiv({ cls: "yl-muted-sm", text: verdict.reason });
    if (verdict.translation) verdictBox.createDiv({ cls: "yl-muted-sm", text: `你写的是：${verdict.translation}` });
    renderSuggestion(verdictBox, verdict.suggestion, verdict.suggestionNote, progress?.imitationText ?? "");
    verdictBox.show();
  }

  return {
    root,
    load(nextSlice, nextProgress) {
      // 换句前把上一句没落库的草稿兜底存掉（此刻 slice/输入框还是上一句的）
      flushDraft();
      slice = nextSlice;
      progress = nextProgress;
      resetting = false;
      draftDirty = false;
      // 上次没通过的那句放回输入框：状态写着「未通过 ✕」却给一个空框让人重敲，
      // 等于把"改一改就能过"变成"从头再写一遍"。（老数据没有草稿行，先按
      // 旧口径用留档文本铺上；meta 草稿到了再看要不要覆盖。）
      draftArea.value =
        nextProgress?.imitationCorrect === false ? (nextProgress.imitationText ?? "") : "";
      render();
      // 上次敲了一半的草稿请回来（2026-10-07 口径：草稿自动保存，换句回来还在）。
      // 异步取：对不上句 / 已经锁定 / 用户已经先敲了字 —— 都别盖。
      const cid = nextSlice.cid;
      void opts.loadDraft(cid).then((draft) => {
        if (!draft || slice?.cid !== cid || locked() || draftDirty) return;
        draftArea.value = draft;
        refreshButtons();
      });
    },
    refreshGate() {
      // 门控变了（刚连上账号 / 刚退出）：按钮说明与提示行跟着改。
      // 留档态 / 核对进行中不动提示文案，别把结论冲掉。
      if (!locked() && !busy) {
        refreshButtons();
        if (!hintEl.hasClass("yl-warn-text")) renderHint();
      }
    },
    dispose() {
      flushDraft();
    },
  };
}
