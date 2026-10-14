import { ItemView, Menu, Notice, setIcon, TFile, type WorkspaceLeaf } from "obsidian";
// 品牌 logo：海獭线稿（与网页 web/src/assets/otter-black.png 同一素材），
// esbuild dataurl 内联进 main.js。深色主题下用 CSS filter 反白，见 .yl-brand-mark。
import otterMark from "../assets/otter-black.png";
import { setViewTitle } from "../ui/viewTitle";
import { STORE } from "../storage/db";
import type { VaultDb } from "../storage/db";
import { clockTime } from "../core/clock";
import { ImportModal } from "./ImportModal";
import { EditModal } from "./EditModal";
import { RemoveModal } from "./RemoveModal";
import { ImeHelpModal } from "./ImeHelpModal";
import { CorrectionModal } from "./CorrectionModal";
import { ModelSetupModal } from "./ModelSetupModal";
import { ReparseConfirmModal } from "./study/ReparseConfirmModal";
import { CorrectionSuggestModal } from "./study/CorrectionSuggestModal";
import { localMediaUrl } from "../services/localMedia";
import { compareCopy, type CopyResult, type CopyTokenize } from "../services/copyCheck";
import {
  clipLengthMs,
  clipRatio,
  formatClipClock,
  pullBackMs,
  seekTargetMs,
  shouldRestart,
} from "../services/clipPlayback";
import {
  effectiveWindow,
  formatOffset,
  normalizeOffset,
  stepOffset,
} from "../services/clipOffset";
import { loadVideoOffset, saveVideoOffset } from "../services/clipOffsetStore";
import { formatHms, nearestIndexByTime, parseTocQuery } from "../services/tocSearch";
import { deleteRecording, loadRecording, saveRecording } from "../services/recordings";
import { loadDraft, saveDraft } from "../services/studyDrafts";
import { openNotesDrawer, type NotesDrawerHandle } from "./notesDrawer";
import { loadMyNotes, myNoteFor } from "../services/notes/mine";
import { checkRecordingLocally, LOCAL_OK_LINK, LOCAL_OK_MESSAGE, readAloudPraise, requestReadAloudCheck } from "../services/readAloudCheck";
import {
  appendChatTurn,
  effectiveJa,
  effectiveZh,
  loadRecordList,
  loadProgress,
  loadStudySentences,
  recordReadAloud,
  resetPracticeRecord,
  resumeIndex,
  saveSession,
  saveSliceAnalysis,
  saveSliceReadingFixes,
  saveSliceTextFixes,
  startSession,
  submitCopy,
  submitImitation,
  type RecordListItem,
} from "../services/study";
import {
  buildCopyPractice,
  buildImitation,
  buildReadAloud,
  readAloudStatus,
  type ImitationPracticeHandle,
  type ReadVerifyOutcome,
  type StepStatus,
  type VerifyOutcome,
} from "./study/practices";
import { buildAnalysis, type AnalysisHandle } from "./study/analysis";
import {
  buildAssistant,
  IMITATION_HINT_QUESTION,
  type AssistantHandle,
} from "./study/assistant";
import { resolveAiGate, resolveAiRoute, type AiGate } from "../services/ai/gate";
import type { PluginSettings } from "../settings/types";
import { pluginDirPath, resolveDictPath } from "../services/dictPath";
import { fetchDictManifest, isDictInstalled } from "../services/dictInstall";
import { DictInstallModal } from "./DictInstallModal";
// 演示素材（示例那一集）改走服务端按需下载：不再内联进 main.js（见 services/demoPack.ts）。
import { DEMO_WORK_TITLE, isDemoSeeded } from "../services/demo";
import { fetchDemoManifest } from "../services/demoPack";
import { resolveMediaDir } from "../services/mediaStore";
import { DemoDownloadModal } from "./DemoDownloadModal";
import { explainTargets, tokenize } from "../services/jaTokenize";
import { onClickOutside } from "../core/onClickOutside";
import { blockAnchor, episodeLabel } from "../markdown/templates";
import {
  AiUnavailableError,
  explainSentence,
  explainSentenceStream,
  explainWords,
  isNoBalanceError,
  renderExplanation,
  verifyImitation,
  verifyImitationStream,
  type ExplainInput,
  type ImitationVerdict,
  type SentenceExplanation,
  type StreamVerdict,
  type WordEntry,
} from "../services/ai/client";
import { assetShaCid } from "../core/ids";
import { log } from "../core/logger";
import { recordWordExposure } from "../services/words";
import { matchAiOrigins, matchAiReadings, matchMeanings } from "../services/meaningMatch";
import { POS_LABEL } from "../services/posLabel";
import { romajiTokens } from "../services/jaTokenize";
import {
  CONTENT_POS,
  type AssetRow,
  type ChatTurn,
  type ProgressRow,
  type SentenceAnalysis,
  type SessionRow,
  type StudySentence,
  type Token,
} from "../types/entities";
import type YoungLookPlugin from "../main";
import { createButton, setButtonIcon, setButtonRole } from "../ui/button";

export const VIEW_TYPE_STUDY = "young-look-study";

/**
 * 本机解析结果的产出标记（含版本）。
 *
 * 只认这一版：以后提示词或分词口径改了，把它一抬，旧缓存自然作废
 * （表现是"翻回旧句子按钮又变回 AI 解析"），而不是让用户看到半新半旧的释义。
 * 与 `learning/services/hosted_prompts.ANALYZE_PROMPT_VERSION` 是两回事 ——
 * 那个管服务端那份缓存，这个管本机这份。
 *
 * v3（2026-10-07）：解读由一段自由文本改成**结构化分段**，逐词释义多了英语
 * 外来语词源。v2 存下来的 `explanation` 是字符串，读回来当分段用会直接读到
 * `.words` 是 undefined。
 *
 * v4（2026-10-08）：解读由四段收敛为**三段**（去掉「口语与书面语」），且
 * 「核心单词」改成只讲词义、语法归「核心语法」。旧口径下 `words` 里混着语法，
 * 直接沿用会让用户看到半新半旧的释义，所以抬版本让它自然作废、重解析一次。
 *
 * v5（2026-10-09）：解读再收敛为**两段**（去掉「使用场景」，例句并入「核心语法」）。
 * 同 v4 的道理：旧口径里「核心语法」没有例子，沿用就是半新半旧。
 */
const ANALYSIS_ENGINE = "plugin-ai-v5";

/** 原句 ruby 注音只标带汉字的词：假名词本身就是读音，不用标 */
const KANJI_RE = /[\u3005\u3007\u3400-\u9fff]/u;

/** 句子里真有读音的部分（平/片假名）：罗马音开关只给这些词标，纯符号/英数不掺和 */
const KANA_RE = /[\u3040-\u30ff]/u;

/**
 * 原句里每个词的稳定下标，核对结果按它标色。
 *
 * 挂在 DOM 上而不是靠"第几个 span"去数：分词结果里有的词搭 ruby 骨架、
 * 有的只是纯文本 span，靠顺序数必然错位，错位就是把红标到隔壁词头上。
 */
function tokenIndexAttr(index: number): Record<string, string> {
  return { "data-token-index": String(index) };
}

/** 原句里一个词点击后弹卡要显示的数据 */
interface HeroWordInfo {
  surface: string;
  reading: string;
  /** 已经翻成中文的词性（名词 / 动词 / 助词…） */
  pos: string;
  meaning: string;
  /** 英语外来语的英文原词（如 video）；不是英语借词就是空串 */
  origin: string;
}

/** 跳错位置后，"原来那一句"的黑标在进度条上停留多久（用户 10-02 拍板 10 秒） */
const PROGRESS_MARK_MS = 10_000;

/**
 * 游标与误跳回标的**最小**宽度（px）。
 *
 * 两者都用"一格的宽，但至少 5px"：句子多的时候格子只有 2~3px，2px 细标太难点；
 * 句子少的时候格子本身就宽，标跟着变宽，才对得上"我指的就是这一格"。
 * 不设上限（用户 10-02 明确）。
 */
const PROGRESS_MARK_MIN_PX = 5;

function fmtTs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/**
 * 学习主视图 —— 对齐网页版 `/study` 的形态：
 *
 *   选集页（作品 → 集，带句数/进度/上次学到哪）
 *     └→ 切片学习卡片：左边视频切片 + 解析区，右边跟读 → 抄写 → 仿写
 *
 * 进度、会话都落本地库（IndexedDB），中途退出再进来从上次那句接着来。
 * 逐词解析依赖本地分词，这一版先留位置（见卡片左栏说明）。
 */
export class StudyView extends ItemView {
  private mode: "list" | "card" = "list";

  // 卡片态（进到某一片学习时才有值）
  private item: RecordListItem | null = null;
  private slices: StudySentence[] = [];
  private progressRows = new Map<string, ProgressRow>();
  private session: SessionRow | null = null;
  private index = 0;
  private videoUrl = "";

  // 复用的界面节点（卡片只建一次，换句就地更新）
  private cardBuilt = false;
  private cardTitleEl!: HTMLElement;
  private progressBarEl!: HTMLElement;
  /**
   * 进度条里那条只装"已学/未学"色块的轨道层。
   *
   * 为什么要单独一层：色块需要 `overflow: hidden` 裁圆角，而游标/悬停段/黑标
   * **不能**被裁（首末格会少掉 1~2px）。于是让轨道当条的内层裁圆角，
   * 三处标记与它同在 .yl-progress 里当兄弟，谁也不裁谁。
   */
  private progressTrackEl!: HTMLElement;
  /**
   * 进度条那一行（进度条 + "已学 N / M 句"）—— 悬停时间气泡的定位锚。
   *
   * 气泡**不能挂在进度条里**：它要浮到条**上方**，挂进去会被轨道的裁切范围影响，
   * 纵向定位反而更绕。挂在这一行上（CSS 里给了 `position: relative`），靠 left 定位。
   */
  private progressRowEl!: HTMLElement;
  /** 悬停时浮在格子正上方的时间气泡（00:00:00） */
  private progressTipEl!: HTMLElement;
  /**
   * 点进度条跳走后，"跳走前那一格"留下的黑标 —— 10 秒内慢慢淡出（用户 10-02 提）。
   *
   * 用途是给用户留个回头路：万一点错位置，还看得见自己刚待在哪、点得回去。
   * 0 = 当前没有黑标。
   */
  private progressMarkIndex = 0;
  /** 黑标元素。每次留标时新建 —— 淡出是 CSS 动画，重插会重置计时，所以不能复用。 */
  private progressMarkEl: HTMLElement | null = null;
  private progressMarkTimer: number | null = null;
  /**
   * 进度条上"鼠标指到的那一句"那一段（悬停反馈）。
   *
   * 建一次长期复用：位置变只改 left/width（见 placeProgressMarkAt），
   * 不再每次 refreshProgressBar 重建 —— 重建会让悬停反馈在刷新瞬间闪一下。
   */
  private progressHoverEl!: HTMLElement;
  /**
   * 当前句游标（深蓝）。
   *
   * 建一次长期复用，换句只挪位置。纵向对齐交给 CSS 的 top:0;bottom:0。
   */
  private progressCursorEl!: HTMLElement;
  /** 气泡文本当前对应的句号；0 = 没显示。只为省掉高频 mousemove 里的重复排版 */
  private progressTipIndex = 0;
  private progressLabelEl!: HTMLElement;
  private stepCards: Record<"read" | "copy" | "imitation", HTMLElement> | null = null;
  /** 时间线三步的圆点（✓ / 数字，见 refreshSteps） */
  private tlNos: Record<"read" | "copy" | "imitation", HTMLElement> | null = null;
  /** 原句区（hero）：句子 / 注音 / 翻译独立成区，三个练习步骤与它并列 */
  private heroJaEl: HTMLElement | null = null;
  private heroEl: HTMLElement | null = null;
  private heroZhEl: HTMLElement | null = null;
  private videoEl!: HTMLVideoElement;
  private videoErrorEl!: HTMLElement;
  private videoMetaEl!: HTMLElement;
  private playButton!: HTMLButtonElement;
  private playOverlayEl!: HTMLElement;
  private replayButton!: HTMLButtonElement;
  private muteButton!: HTMLButtonElement;
  private calibButton!: HTMLButtonElement;
  private calibPanel!: HTMLElement;
  private calibValueEl!: HTMLElement;
  /** "点外面关弹层"监听的摘除函数；null = 弹层没开着（监听只在开着时挂，见 onClickOutside） */
  private stopCalibOutside: (() => void) | null = null;
  /** 注音纠错入口（hero 右上角，注音加载成功才出现） */
  private heroFixBtnEl!: HTMLButtonElement;
  /**
   * 当前句可纠的注音（分词 + 读音在 loadHeroReading 里就位后填）；空 = 没有可纠的。
   * **只含带汉字的词** —— 纯假名的读音就是它自己，不给改（用户 10-03 定的口径）。
   */
  private heroAnnotRows: { index: number; surface: string; reading: string }[] = [];
  /** 句中纯假名的词，只为在弹窗里说明「这些为什么没列出来」 */
  private heroLockedWords: string[] = [];
  /**
   * 这一句解析过之后，原句里每个词的弹卡数据（按分词下标对齐）。
   * 空 = 还没解析（词不可点、无虚线）。
   */
  private heroWordInfo: HeroWordInfo[] = [];
  /** 词弹卡的收尾函数（摘监听 + 移除节点）；null = 弹卡没开着 */
  private closeHeroPopoverFn: (() => void) | null = null;
  /** 句子卡"闪一下"的收尾定时器；null = 没在闪（见 flashHero） */
  private heroFlashTimer: number | null = null;
  /**
   * 在开的流式解读。翻页 / 关视图 / 连点「重新解析」都要掐掉它 ——
   * 流式请求是长连接，用户已经不看这一句了还让它跑完，等于白花后面的 token。
   */
  private explainAbort: AbortController | null = null;
  /** 上面那条流属于哪一句（翻页时据此判断该不该掐） */
  private explainStreamCid: string | null = null;
  private clipSlider!: HTMLInputElement;
  private clipClockEl!: HTMLElement;
  /** 时间校准偏移：整条视频共用，只平移我们自己的播放窗口，不改任何文件 */
  private offsetMs = 0;
  private videoAsset: AssetRow | null = null;
  /** 本机词典路径的缓存；undefined = 还没查过，null = 查过但没找到 */
  private dictPathCache: string | null | undefined = undefined;
  private startMs = 0;
  private endMs = 0;
  private nextButton!: HTMLButtonElement;
  // ── 句子笔记（「笔记」按钮，2026-10-09 改版：右侧抽屉，见 notesDrawer.ts）──
  /** 「笔记」按钮：这句写过笔记时文字下有虚线；点开抽屉（上半自己、下半大家） */
  private noteButton!: HTMLButtonElement;
  /**
   * 当前这句的本地分词结果。
   * 解析成功后要把它连同 AI 释义一起存进切片行（见 `persistAnalysis`），
   * 所以留一份；换句时会被下一次 `renderAnalysis` 覆盖。
   */
  private currentTokens: Token[] = [];

  private readAloud = buildReadAloud({
    onVerify: (payload, sliceCid) => this.handleVerifyReadAloud(sliceCid, payload),
    canUseAi: () => this.canUseAiReadAloud(),
    onRerecord: () => this.clearReadAloudPaint(),
    onManualConfirm: (sliceCid) => this.handleManualConfirm(sliceCid),
    onReset: () => this.handleReset("read"),
    loadRecording: (sliceCid) => loadRecording(this.db, sliceCid).then((row) => row ?? null),
    saveRecording: (sliceCid, blob, mimeType, seconds) => saveRecording(this.db, sliceCid, blob, mimeType, seconds),
  });
  private copyPractice = buildCopyPractice({
    onSubmit: (typed, sliceCid) => this.handleSubmitCopy(typed, sliceCid),
    onReset: () => this.handleReset("copy"),
    getRomaji: (slice) => this.copyRomaji(slice),
    hasDict: () => this.dictPath() !== null,
    onNeedDict: () => void this.promptDictInstall("hint"),
    loadDraft: (sliceCid) => loadDraft(this.db, "copy", sliceCid),
    saveDraft: (sliceCid, text) => saveDraft(this.db, "copy", sliceCid, text),
    onImeHelp: () => new ImeHelpModal(this.app, this.plugin).open(),
  });
  /**
   * 仿写构件：和解析区一样在 buildCard 里创建。
   * 字段初始化阶段 `this.plugin` 还没赋值（构造函数参数属性是之后才赋的），
   * 想读 settings 就必须等到那时。
   */
  private imitationPractice!: ImitationPracticeHandle;
  /** 解析区：在 buildCard 里创建（字段初始化阶段还拿不到 plugin 实例） */
  private analysis!: AnalysisHandle;
  /** 右下角漂流瓶助手：在 buildCard 里创建（要读 plugin.settings） */
  private assistant!: AssistantHandle;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: YoungLookPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_STUDY;
  }

  /**
   * 页签标题按状态分两截（2026-10-14 用户定）：选集页 = 「洋流」，学习卡 =
   * 「洋流 · 学习页」。页头（页签下面那行）由 setViewTitle 另行写成「首页」/「学习页」。
   */
  getDisplayText(): string {
    return this.mode === "card" ? "洋流 · 学习页" : "洋流";
  }

  getIcon(): string {
    return "book-open";
  }

  private get db(): VaultDb {
    return this.plugin.db;
  }

  async onOpen(): Promise<void> {
    await this.render();
    // 余额的唯一真值在服务端，本地缓存可能过期 —— 充值全在网页完成，插件这边
    // 自己永远不会知道（首次连接时带的余额、之后每次扣费都会写缓存，但"连上账号
    // 之后才去网页充值"这条路没有任何东西触发刷新，门控会一直卡在 need-balance）。
    // 回到学习页就顺手拉一次快照（60 秒节流），拉到了让 AI 按钮就地解锁。
    void this.plugin.refreshAccountProfile().then(() => this.applyAccountState());
    // 词典引导之一：**第一次**进学习页时提醒装词典（一辈子只弹一次，见 settings）
    void this.promptDictInstallIfFirstRun();
  }

  async onClose(): Promise<void> {
    await this.endSession();
    this.readAloud.dispose();
    // 流式解读可能正开着：中断它（剩下的 token 也就不再产生），别对着已销毁的 DOM 继续写
    this.abortExplainStream();
    // 词弹卡挂在 body 上，关视图必须连监听一起摘干净
    this.closeHeroPopover();
    // 句子卡的"闪一下"定时器：关视图后它不该还活着
    this.clearHeroFlash();
    // 抄写/仿写的草稿兜底落库（敲了还没到防抖点就关视图，字不能丢）。
    // 仿写构件在 buildCard 里才创建 —— 没进过学习卡的会话（打开就是选集页）它是空的。
    this.copyPractice.dispose();
    this.imitationPractice?.dispose();
    this.closeCalibration();
    // 笔记抽屉挂在 contentEl 上，随视图销毁一起拆，不用手动关
  }

  async render(): Promise<void> {
    if (this.mode === "card" && this.cardBuilt) {
      // ⚠️ 卡片模式下**不能重建** —— 用户可能正打了一半的字。
      // 连接/退出账号后走这里：只把三个 AI 入口的锁定态就地刷新。
      this.applyAccountState();
      this.syncViewTitle();
      return;
    }
    this.contentEl.empty();
    this.contentEl.addClass("yl-study-root");
    if (this.mode === "card") this.buildCard();
    else await this.buildList();
    this.syncViewTitle();
  }

  /** 页签 / 页头标题（页签带品牌前缀，页头只写页面名，见 ui/viewTitle.ts）。 */
  private syncViewTitle(): void {
    const study = this.mode === "card";
    setViewTitle(this.leaf, this.containerEl, study ? "洋流 · 学习页" : "洋流", study ? "学习页" : "首页");
  }

  /** AI 现在能不能点（含登录状态）。三处入口共用一个判定口，别各自判断。 */
  private getAiGate(): AiGate {
    return resolveAiGate(this.plugin.settings);
  }

  /**
   * 用户主动触发（点「AI 解析」/「提示」/漂流瓶/仿写「检查」）时的门控核实。
   *
   * 余额的唯一真值在服务端，而充值全在网页端完成 —— 插件这边的余额缓存只有
   * 主动去问才会更新，**缓存说不行不能直接判死**（否则网页充完值也永远用不了）。
   * 凡是缓存拦人的，都先强制向服务器核实一次（force 绕过节流），按新快照重判，
   * 确实没钱才拦。其余原因（没开 AI / 缺 Key / 未登录）是本机配置的真值，问
   * 服务器也不会变，直接返回。缓存说能用就不等了 —— 真没钱时请求会被服务端
   * 402 拦下，由 handleOutOfBalance 接住。
   */
  private async checkAiGate(): Promise<AiGate> {
    const local = this.getAiGate();
    if (local.ok || local.reason !== "need-balance") return local;
    await this.plugin.refreshAccountProfile(true);
    this.applyAccountState();
    return this.getAiGate();
  }

  /**
   * AI 门控不放行时的统一出口：界面中央一个小弹窗问一句，确认 → 个人中心
   * 「账户」页。三个入口同一套话术。
   *
   * 没配置（没开 AI / 没登录 / 自定义模型缺 Key）问「现在配置吗」；
   * 没余额也是同一颗壳（2026-10-05 用户拍板：不再单独劝充值 —— 用户可能想改用
   * 自己的模型，充值和自定义模型都在账户页选），只换标题和正文。
   *
   * ⚠️ 学习页**没有登录这件事**（2026-10-02 登录机制改造）：登录 / 注册在网页
   * 完成，这里只管把要配置的人送到账户页 —— 充值也在账户页点，直接跳网页。
   */
  private promptModelSetup(onDecline?: () => void): void {
    const gate = this.getAiGate();
    if (gate.ok) return;
    if (gate.reason === "need-balance") {
      this.promptBalanceSetup(onDecline);
      return;
    }
    // 标题/正文按「为什么被拦」分叉（2026-10-12 拍板）：没登录说登录的事，
    // 自定义模型没配好就说补全的事 —— 一句通用「先配置模型」说不中要害。
    let title = "需要先配置模型";
    let message = "您需要先配置模型，才可以使用 AI 功能，现在配置吗？";
    if (gate.reason === "need-login") {
      title = "需要先登录";
      message = "内置模型按用量扣费，余额记在账号上，需要先登录。现在去账户页吗？";
    } else if (this.plugin.settings.aiMode === "byok") {
      title = "自定义模型还没配好";
      message = "接口地址、API Key、模型名要填全并保存，测试通过后生效。现在去账户页补全吗？";
    }
    new ModelSetupModal(this.app, {
      title,
      message,
      onConfirm: () => this.plugin.openPersonalCenter(this.currentOrigin(), { tab: "wallet" }),
      onDecline,
    }).open();
  }

  /**
   * 没余额的统一弹窗（2026-10-04 用户拍板：名字里带 AI 的按钮，余额为零时
   * 置灰、点了弹这颗窗；卡片里**不再**就地摆余额提示。
   * 注：这套契约现在只适用于「AI 解析」——三步卡的「检查」不被弹窗拦截）。
   * 2026-10-12 文案改版：双轨自由选之后，"当前无可用模型"不再成立 —— 用户
   * 明确选了内置模型，差的只是余额。标题如实说「内置模型余额不足」，正文摆
   * 两条出路（充值继续用内置 / 改用自定义不扣余额），出口不变 —— 账户页。
   */
  private promptBalanceSetup(onDecline?: () => void): void {
    new ModelSetupModal(this.app, {
      title: "内置模型余额不足",
      message:
        "充值后继续用内置模型，或改用自定义模型（用自己的 Key，不扣余额）。现在去账户页处理吗？",
      confirmText: "去账户页",
      onConfirm: () => this.plugin.openPersonalCenter(this.currentOrigin(), { tab: "wallet" }),
      onDecline,
    }).open();
  }

  /**
   * 真问起来才发现没余额（本地缓存放行了、服务端 402）：余额的真值在服务端，
   * 顺手刷一次快照 —— 回来后门控翻成 need-balance，AI 按钮就地置灰 ——
   * 再弹统一弹窗。
   */
  private handleOutOfBalance(): void {
    void this.plugin.refreshAccountProfile().then(() => this.applyAccountState());
    this.promptBalanceSetup();
  }

  /**
   * 跟读核对结论里「内置模型」四个字被点：问一句「现在配置吗」。
   *
   * ⚠️ 这里**不能走 `promptModelSetup`** —— 那个方法第一句是"门控放行就返回"，
   * 而发音评估跟门控是两件事：用户可能已经配了 BYOK（门控 ok），但 BYOK 天生
   * 给不了发音评估（本机做不了，只能送到我们服务端的内置模型）。所以这条路
   * 不看门控，点了一定问。
   */
  private promptHostedModelSetup(): void {
    new ModelSetupModal(this.app, {
      message: "录音的单词发音只能通过内置模型评估，现在配置吗？",
      onConfirm: () => this.plugin.openPersonalCenter(this.currentOrigin(), { tab: "wallet" }),
    }).open();
  }

  /** 充值页的唯一出口。提示语里的「充值」被点时才走到这里，任何 AI 入口都不自动跳。 */
  private openPricing(): void {
    window.open(`${this.plugin.webBase()}/pricing`, "_blank");
  }

  /**
   * 仿写卡上的「提示」（圆圈问号图标钮）。
   *
   * 2026-10-04 用户拍板：跟「AI 解析」同一条门控 —— AI 用不了（含没余额）
   * 不进助手面板，就地弹统一弹窗；以前"卡片里摆一句提示"的行内提示已整个撤掉。
   * （缓存可能过期：面板开着真问出 402 的，由助手面板的 need-balance 出口接住。）
   */
  private async handleImitationHint(): Promise<void> {
    if (!(await this.checkAiGate()).ok) {
      this.promptModelSetup();
      return;
    }
    this.assistant.prompt(IMITATION_HINT_QUESTION);
  }

  /** 个人中心的来路：退出时按它回原位。 */
  private currentOrigin(): { from: "list" } | { from: "study"; recordCid: string; index: number } {
    if (this.mode === "card" && this.item) {
      return { from: "study", recordCid: this.item.record.cid, index: this.index };
    }
    return { from: "list" };
  }

  /**
   * 选集页右上角的账号入口 —— 2026-10-04 起是一颗「个人中心」文字按钮。
   *
   * 原来的 24px 头像 + hover 弹层已删（用户拍板）：一个 24px 小目标加悬停
   * 才见内容，发现成本太高，弹层那点预览（余额 / 模式 / 会员）撑不起独立入口；
   * 这些信息一律进个人中心看，未登录的「连接账号」也在个人中心学习页。
   */
  private mountPersonalCenterButton(parent: HTMLElement): void {
    createButton(parent, {
      text: "个人中心",
      onClick: () => this.plugin.openPersonalCenter(this.currentOrigin()),
    });
  }

  /** 登录状态变了（刚连接上 / 刚退出）：重算已渲染界面的按钮态，不重建 DOM */
  private applyAccountState(): void {
    if (this.cardBuilt) {
      this.analysis.refreshGate();
      this.imitationPractice.refreshGate();
      this.assistant.refreshGate();
      // 充值状态刚变：跟读提示行里"用哪种检查"的说明要跟着换
      this.readAloud.refreshGate();
    }
  }

  // ── 选集页 ───────────────────────────────────────────────────────────────

  private async buildList(): Promise<void> {
    const root = this.contentEl;
    root.empty();

    // 留白与滚动在这一层（跟学习页的 .yl-study-wrap 同一个套路）：
    // contentEl 恒有 .yl-study-root（8px 内边距），这里再补 40px → 正文左边缘 48px，
    // 与学习页逐像素对齐。不这么分层的话：内边距会被 .yl-study-root 的 8px 盖掉一半，
    // 长列表也只能靠宿主 .view-content 滚。
    const listRoot = root.createDiv({ cls: "yl-list-root" });

    // 选集页内容限宽居中：宽屏下横条拉满整个窗口会显得空旷（2026-09-25 用户反馈）
    const list = listRoot.createDiv({ cls: "yl-list-wrap" });

    const header = list.createDiv({ cls: "yl-list-header" });
    // 品牌区（2026-10-04 定稿 = temp/demo/home 方案2 双行徽标）：海獭线稿裸放不加边框，
    // 中文在上、英文小字大字距在下。沿用 h3 保住标题语义，样式见 .yl-brand。
    // h3 自己 flex:1 撑满整行（把右侧按钮推到最右），**可点范围只圈里面的
    // .yl-brand-link**（logo + 文字）—— 2026-10-14 用户：整行可点会误触跳官网。
    const brand = header.createEl("h3", { cls: "yl-brand" });
    const brandLink = brand.createDiv({
      cls: "yl-brand-link",
      attr: { title: "打开洋流日语官网" },
    });
    brandLink.createEl("img", { cls: "yl-brand-mark", attr: { src: otterMark, alt: "" } });
    const brandText = brandLink.createDiv({ cls: "yl-brand-text" });
    brandText.createDiv({ cls: "yl-brand-cn" }).setText("洋流日语");
    brandText.createDiv({ cls: "yl-brand-en" }).setText("YOUNG LOOK");
    // 点击落点 = logo + 附近文字。地址一律走 webBase()：dev 构建落本机 vite
    // （127.0.0.1:5173），发版落 younglook.cc —— 别自己拼 settings.serverUrl，
    // 本机前后端是两个端口（见 config/env.ts）。
    brandLink.onclick = () => window.open(this.plugin.webBase(), "_blank");
    // ⚠️ 别用 Obsidian 的 `mod-cta`：它跟 `--interactive-accent` 走，
    // 用户主题 accent 一变（默认紫），这颗按钮就跟插件定死的青蓝打架 ——
    // 正是 2026-09-30 "这个页面风格还不够一致" 的来源。
    createButton(header, {
      text: "导入视频",
      role: "primary",
      onClick: () => new ImportModal(this.app, this.plugin, "").open(),
    });

    // 账号入口放最右：一颗「个人中心」文字按钮（2026-10-04 头像 + hover 弹层已删）
    this.mountPersonalCenterButton(header);

    // 概览数字贴在列表上方右对齐（2026-10-04 用户反馈：塞进顶栏按钮那行太挤，
    // 单独一行、跟顶栏隔开一点距离，但归属感跟着列表走）。先占位、加载后再填字；
    // 空态整颗摘掉 —— 一行 0 没有指导性。
    const overview = list.createDiv({ cls: "yl-overview yl-muted-sm" });

    const items = await loadRecordList(this.db);

    // 演示素材还没下载：列表最前面摆一条「示例」，点它才谈下载（services/demoPack.ts）。
    // 它是插件分发的东西、不是用户导入的集 —— **不并入 items**，也不计入上面那行概览数字。
    if (!(await isDemoSeeded(this.db))) {
      this.mountDemoPlaceholderRow(list);
    }

    if (items.length === 0) {
      overview.remove();
      const empty = list.createDiv({ cls: "yl-empty" });
      empty.createEl("p", {
        text: "还没有导入任何素材。你可以点击右上角“导入视频”或者先试试上方的示例视频。",
      });
      empty.createEl("p", {
        cls: "yl-muted-sm",
        text: "视频和字幕都留在你原来的位置，插件只记路径，不复制、不上传。",
      });
      return;
    }

    // 概览：原来在「今日练习」侧栏面板上的那几个数字，并到这里来。
    const totalSlices = items.reduce((sum, entry) => sum + entry.total, 0);
    const doneSlices = items.reduce((sum, entry) => sum + entry.completed, 0);
    const summary = [`已导入 ${items.length} 集`, `共 ${totalSlices} 句`];
    if (doneSlices > 0) summary.push(`已学 ${doneSlices} 句（${Math.round((doneSlices / totalSlices) * 100)}%）`);
    // 上报是全量快照重推，没有"待同步条数"这回事 —— 只报最近一次推上去的时刻
    const syncedAt = this.plugin.settings.lastStatsSyncAt;
    if (this.plugin.settings.authToken && syncedAt > 0) summary.push(`最近同步 ${clockTime(syncedAt)}`);
    overview.setText(summary.join(" · "));

    for (const entry of items.filter((candidate) => candidate.videoAvailable)) {
      this.mountEpisodeRow(list, entry);
    }

    // 未绑定视频的集沉底分组（2026-10-14 方案一定稿）：分隔线 + 整行置灰，
    // 点之前就能看出这一集暂时学不了 —— 不用再靠点击后弹 Notice 才知道。
    const unbound = items.filter((candidate) => !candidate.videoAvailable);
    if (unbound.length > 0) {
      list.createDiv({
        cls: "yl-unbound-divider yl-muted-sm",
        text: `以下学习记录文件丢失 · ${unbound.length} 条`,
      });
      for (const entry of unbound) this.mountEpisodeRow(list, entry, { unbound: true });
    }
  }

  /**
   * 首页一集 = 一条横行：标题/进度在左，主按钮 + 「⋯」在右。
   *
   * `unbound` = 未绑定视频的置灰行：主按钮不是「接着学」而是**可点**的「补视频」——
   * 弹的就是「导入视频」那个窗口，名字/年份/季集号按这一集预填好，用户只要把视频
   * 文件选上。recordCid 由「视频 sha256 + 日文字幕 sha256」派生，重新导入同一对文件、
   * 由 sliceRebind 把学习记录挂回原句，不会产生重复集。
   * ⚠️ 置灰只灰「行」，按钮保持正常可点 —— 按钮也灰掉用户会以为插件坏了。
   */
  private mountEpisodeRow(
    list: HTMLElement,
    entry: RecordListItem,
    opts: { unbound?: boolean } = {},
  ): void {
    const row = list.createDiv({
      cls: opts.unbound ? "yl-episode-row yl-unbound" : "yl-episode-row",
    });
    const info = row.createDiv({ cls: "yl-episode-info" });
    // 集号可能留空（不是番剧的单集视频）：留空时那一整段不出现，
    // 不要渲染成"第  集"这种半截话
    const label = episodeLabel(entry.record.season, entry.record.number);
    const head = [entry.record.title || entry.record.titleJa, label].filter(Boolean).join(" · ");
    info.createDiv({
      cls: "yl-episode-title",
      text: `${head}${entry.record.episodeTitle ? ` ${entry.record.episodeTitle}` : ""}`,
    });
    const meta = info.createDiv({ cls: "yl-muted-sm" });
    const parts = [`共 ${entry.total} 句`];
    if (entry.completed > 0) {
      parts.push(`已学 ${entry.completed} 句（${Math.round((entry.completed / entry.total) * 100)}%）`);
    }
    if (entry.lastSession && entry.lastSession.currentIndex > 0) {
      parts.push(`上次学到第 ${entry.lastSession.currentIndex} 句`);
    }
    meta.setText(parts.join(" · "));
    if (entry.completed > 0) {
      const bar = info.createDiv({ cls: "yl-mini-progress" });
      const fill = bar.createDiv({ cls: "yl-mini-progress-fill" });
      fill.style.width = `${Math.round((entry.completed / entry.total) * 100)}%`;
    }

    if (opts.unbound) {
      createButton(row, {
        text: "补视频",
        role: "primary",
        onClick: () =>
          new ImportModal(this.app, this.plugin, "", {
            title: entry.record.title || entry.record.titleJa || "",
            number: entry.record.number,
            season: entry.record.season,
            year: entry.record.year,
          }).open(),
      });
    } else {
      const button = createButton(row, {
        text: entry.lastSession?.currentIndex ? "接着学" : "开始学",
        role: "primary",
        onClick: () => {
          button.disabled = true;
          void this.enterEpisode(entry).finally(() => {
            button.disabled = false;
          });
        },
      });
    }

    // 「⋯」放行尾：主操作最显眼，编辑/移除退进菜单里（2026-10-02 用户定）
    this.mountRowActions(row, entry);
  }

  /**
   * 首页的「示例」占位行 —— 只在演示包还没下载时出现（见 services/demoPack.ts）。
   *
   * 它不是库里的真实集：点「开始学」会先弹窗问要不要下载示例素材，下载成功后才由
   * `importSubtitle` 铺成**真实集**（带进度条、「⋯」菜单那套），这条占位自然消失。
   * 按钮恒为「开始学」（没下过 = 没学过）；「接着学」是下载后真实行走的既有逻辑。
   */
  private mountDemoPlaceholderRow(list: HTMLElement): void {
    const row = list.createDiv({ cls: "yl-episode-row yl-demo-row" });
    const info = row.createDiv({ cls: "yl-episode-info" });
    info.createDiv({ cls: "yl-episode-title", text: DEMO_WORK_TITLE });
    info.createDiv({
      cls: "yl-muted-sm",
      text: "示例素材 · 点「开始学」时下载（仅此一次，下载后可离线学）",
    });
    createButton(row, {
      text: "开始学",
      role: "primary",
      onClick: () => void this.startDemoDownload(),
    });
  }

  /**
   * 点「示例」→ 拉清单 → 弹下载窗 → 导入成功就进这一集。
   *
   * 清单拉不到（连不上服务器 / 线上还没发演示包）只给一句 Notice，不弹窗 —— 没得下
   * 的时候弹出来也只是让用户对着一个点不动的按钮。下载、导入、收素材库都在
   * `installDemoPack` 里完成；这里只负责界面切换。
   */
  private async startDemoDownload(): Promise<void> {
    const manifest = await fetchDemoManifest(this.plugin.settings.serverUrl);
    if (!manifest) {
      new Notice("暂时连不上服务器，稍后再试。");
      return;
    }
    new DemoDownloadModal(this.app, {
      manifest,
      db: this.db,
      // 与用户导入同一个落点：本机空间的素材库（演示素材没有单独的目录）
      mediaDir: resolveMediaDir(this.plugin.settings.mediaDir, this.plugin.settings.activeSpaceId),
      onImported: (recordCid) => void this.openEpisode(recordCid),
    }).open();
  }

  /**
   * 列表行尾的「⋯」更多菜单：编辑、移除都收在这里。
   *
   * 2026-10-02 用户定稿，取代原来的行内「移除」两段式确认 —— 移除太显眼，
   * 而且现在移除弹窗里带「删文件/删笔记」这类真删的选项，值得一次正式的确认；
   * 顺带编辑（改名字、季集号这些固有属性）有了入口。菜单走 Obsidian 原生
   * `Menu`（资源管理器右键同款）：定位、点外关闭、键盘导航都归它管。
   */
  private mountRowActions(row: HTMLElement, entry: RecordListItem): void {
    createButton(row, {
      shape: "icon",
      icon: "more-vertical",
      ariaLabel: "更多操作",
      title: "更多操作",
      onClick: (event) => this.openRowMenu(event, entry),
    });
  }

  private openRowMenu(event: MouseEvent, entry: RecordListItem): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("编辑这一集…")
        .setIcon("pencil")
        .onClick(() => new EditModal(this.app, this.plugin, entry).open()),
    );
    menu.addItem((item) =>
      item
        .setTitle("移除…")
        .setIcon("trash-2")
        .onClick(() =>
          new RemoveModal(this.app, this.plugin, entry, { onRemoved: () => this.render() }).open(),
        ),
    );
    menu.showAtMouseEvent(event);
  }

  // ── 进入一集 ─────────────────────────────────────────────────────────────

  /** 给导入流程用的直入口：导入成功后直接进这一集的学习界面。 */
  async openEpisode(recordCid: string): Promise<void> {
    const items = await loadRecordList(this.db);
    const entry = items.find((candidate) => candidate.record.cid === recordCid);
    if (!entry) {
      await this.render();
      return;
    }
    await this.enterEpisode(entry);
  }

  private async enterEpisode(item: RecordListItem): Promise<void> {
    const slices = await loadStudySentences(this.db, item.record.cid);
    if (slices.length === 0) {
      new Notice("这一集没有可以学的句子。");
      return;
    }
    const allProgress = await this.db.getAll<ProgressRow>(STORE.progress);
    const sliceCids = new Set(slices.map((slice) => slice.cid));
    this.progressRows = new Map(
      allProgress.filter((row) => !row.deletedAt && sliceCids.has(row.sliceCid)).map((row) => [row.sliceCid, row]),
    );

    const videoAsset = await this.db.get<AssetRow>(
      STORE.assets,
      assetShaCid(item.record.videoSha256),
    );
    if (!videoAsset) {
      new Notice("我们没有找到与当前作品绑定的视频，重新导入一次（选同一个视频文件）就能补上。");
      return;
    }
    const url = localMediaUrl(this.app, videoAsset.localPath);
    if (!url) {
      new Notice("视频地址拼不出来，重启 Obsidian 再试一次。");
      return;
    }

    this.item = item;
    this.slices = slices;
    this.session = await startSession(this.db, item.record.cid);
    this.videoUrl = url;
    this.videoAsset = videoAsset;
    this.offsetMs = await loadVideoOffset(this.db, videoAsset.cid);
    this.mode = "card";
    this.cardBuilt = false;
    await this.render();

    const completed = new Set(
      [...this.progressRows.values()].filter((row) => row.completedAt).map((row) => row.sliceCid),
    );
    this.showSlice(resumeIndex(slices, item.lastSession, completed));
  }

  /** 个人中心「退出」回原位：回到指定记录的指定句（不自动播放）。 */
  async restoreTo(recordCid: string, index: number): Promise<void> {
    await this.openEpisode(recordCid);
    this.showSlice(Math.max(1, Math.min(index, this.slices.length)), false);
  }

  /** 个人中心「退出」回列表页（学习页当前不是列表态时用）。 */
  async showList(): Promise<void> {
    this.mode = "list";
    await this.render();
  }

  /** 退出这一集：会话收尾，回选集页。 */
  private async exitEpisode(): Promise<void> {
    await this.endSession();
    this.mode = "list";
    this.cardBuilt = false;
    this.item = null;
    this.slices = [];
    this.progressRows = new Map();
    this.session = null;
    this.index = 0;
    this.videoAsset = null;
    this.offsetMs = 0;
    await this.render();
  }

  private async endSession(): Promise<void> {
    if (!this.session) return;
    const session = this.session;
    this.session = null;
    try {
      session.endedAt = new Date().toISOString();
      await saveSession(this.db, session);
    } catch {
      // 收尾失败不挡着用户走人；下次进这一集会开新会话
    }
  }

  // ── 学习卡片 ─────────────────────────────────────────────────────────────

  private buildCard(): void {
    const root = this.contentEl;
    root.empty();
    this.cardBuilt = true;

    /*
     * 内容包裹层 —— 两侧留白加在**这一层**（见 styles.css 的 .yl-study-wrap）。
     *
     * ⚠️ 别图省事加在 contentEl 自己身上：contentEl 就是 Obsidian 的 `.view-content`，
     * 它自带 padding 规则，插件这边的声明可能被盖掉 —— 表现出来就是"改了样式、重启了
     * Obsidian，页面一点没变"。包一层完全属于插件的元素，留白才是插件说了算。
     * （选集页早就是这么做的：`.yl-list-wrap`。）
     *
     * 注意助手和目录浮层仍然挂在 root 上：它们是 absolute，参照的是 .yl-study-root。
     */
    const wrap = root.createDiv({ cls: "yl-study-wrap" });

    // 顶栏：标题 + 便签 / 笔记 │ 上一句 / 目录 / 下一句 │ 分隔线 │ 退出
    const header = wrap.createDiv({ cls: "yl-card-header" });
    // 标题要吃掉整行富余（flex:1）才能把按钮组推到最右。
    // （个人中心的灰色小字说明行在标题行外面，不占这一行 —— flex:1 留在
    // .yl-card-title 上，两个页面共用。）
    this.cardTitleEl = header.createDiv({ cls: "yl-card-title" });
    const nav = header.createDiv({ cls: "yl-card-nav" });
    // 学习卡片不放账号入口（2026-10-02 用户：这是沉浸式学习页面，头像这类东西别来干扰）。
    // 个人中心 / 登录从选集页标题栏的「个人中心」按钮、插件设置和 AI 门控弹窗进
    // （登录 / 注册在网页完成，插件侧是「连接账号」弹窗收一次性连接码）。
    // 「笔记」：当前这一句的学习笔记 —— 点开右侧抽屉（同目录的规格）：
    // 上半是自己的纯文本笔记（登录存服务端、未登录只在本机），
    // 下半是大家共享的笔记（登录可见）。有笔记时文字下挂虚线。
    // 2026-10-04~05 的黄色贴纸便签随本版退役（UI 交给用户看过再定要不要调）。
    this.noteButton = createButton(nav, {
      text: "笔记",
      onClick: () => this.openNoteDrawer(),
    });
    nav.createDiv({ cls: "yl-card-nav-sep" });
    // 切句一律**不自动播**（2026-09-29 用户定：突然出声吓人），要播自己点画面或播放键
    createButton(nav, { text: "← 上一句", onClick: () => this.showSlice(this.index - 1, false) });
    createButton(nav, { text: "目录", onClick: () => this.openToc() });
    this.nextButton = createButton(nav, {
      text: "下一句 →",
      onClick: () => this.showSlice(this.index + 1, false),
    });
    // 出口钮和功能钮用分隔线切开（同个人中心标题行的语法：分隔线 + 排尾是出口）。
    // 叫「退出」不叫「返回」：这里是结束这一集、会话收尾，页内也没有「退出登录」可撞词。
    nav.createDiv({ cls: "yl-card-nav-sep" });
    createButton(nav, { text: "退出", onClick: () => void this.exitEpisode() });

    // 进度条
    const progressRow = wrap.createDiv({ cls: "yl-progress-row" });
    this.progressRowEl = progressRow;
    this.progressBarEl = progressRow.createDiv({ cls: "yl-progress" });
    // 色块轨道单独一层：它负责裁圆角（overflow:hidden），而外层 .yl-progress 不裁 ——
    // 三处标记（游标 / 悬停段 / 残留回标）与它同在 .yl-progress 里当兄弟，
    // 这样纵向对齐由 CSS 的 top:0;bottom:0 完成，不用 JS 去量条在哪（那会在
    // 卡片刚建、行还没完成布局时量错，标记飘到条上方 —— 10-02 用户实机截图）。
    this.progressTrackEl = this.progressBarEl.createDiv({ cls: "yl-progress-track" });
    // 三处标记都建一次、长期复用：位置变只改 left/width，不再反复创建
    this.progressCursorEl = this.progressBarEl.createDiv({ cls: "yl-progress-cursor" });
    this.progressCursorEl.hide();
    this.progressHoverEl = this.progressBarEl.createDiv({ cls: "yl-progress-hover" });
    this.progressHoverEl.hide();
    this.progressLabelEl = progressRow.createSpan({ cls: "yl-muted-sm yl-tabular" });
    // 悬停气泡（00:00:00）—— 挂在"行"上而不是条上：它要浮到条**上方**，
    // 放条里会被 .yl-progress-track 的裁切范围影响，纵向定位反而更绕。
    this.progressTipEl = progressRow.createDiv({ cls: "yl-progress-tip" });
    this.progressTipEl.hide();
    // 换集/重开卡片时上一集的黑标立刻作废（句号对不上新集了）
    this.clearProgressMark();
    // 点进度条 = 跳到对应的那一句（2026-10-02 用户提）。
    // 整条按句等分（refreshProgressBar 里每段 flexGrow = 句数），所以横向百分比
    // 乘总句数就是目标句号 —— 不用去问每一段 DOM 在哪儿。
    this.progressBarEl.addEventListener("click", (event) => this.jumpByProgressBar(event));
    // 悬停反馈：只亮"鼠标指到的那一句"那一段（用户 10-02 改口径：不要整根高亮）
    this.progressBarEl.addEventListener("mousemove", (event) => this.hoverProgressBar(event));
    this.progressBarEl.addEventListener("mouseleave", () => this.clearProgressHover());

    // 双栏：左视频 + 解析区 / 右三步练习
    const grid = wrap.createDiv({ cls: "yl-card-grid" });
    const left = grid.createDiv({ cls: "yl-left-col" });

    const videoPanel = left.createDiv({ cls: "yl-video-panel" });
    const videoBox = videoPanel.createDiv({ cls: "yl-video-box" });
    // ⚠️ 刻意**不挂原生 controls**：
    //  1. 原生控制条右下角显示的是**整个文件**的时长（3 分多钟），用户会以为"切片没生效"；
    //  2. 原生播放键在句尾之后按下去没反应（一 play 就被时间窗弹回暂停）。
    // 所以自己画一条只在"本句窗口"内工作的控制条。
    this.videoEl = videoBox.createEl("video", {
      attr: { preload: "metadata", playsinline: "true" },
    });
    // 暂停时画面中央的播放提示（切句后视频一定是停着的，图标告诉用户"要播自己点"）。
    // 只做视觉：pointer-events:none，点击穿透到画面 = 点播放，不用单独绑事件。
    this.playOverlayEl = videoBox.createDiv({ cls: "yl-video-playhint" });
    setIcon(this.playOverlayEl, "play");
    this.videoErrorEl = videoPanel.createDiv({ cls: "yl-video-error" });
    this.videoErrorEl.hide();

    const controls = videoPanel.createDiv({ cls: "yl-video-controls" });
    this.playButton = createButton(controls, { shape: "icon", icon: "play", ariaLabel: "播放" });
    this.replayButton = createButton(controls, {
      shape: "icon",
      icon: "rotate-ccw",
      ariaLabel: "重看",
    });
    this.clipSlider = controls.createEl("input", {
      cls: "yl-clip-slider",
      attr: { type: "range", min: "0", max: "1000", step: "1", value: "0", "aria-label": "本句进度" },
    });
    this.clipClockEl = controls.createSpan({ cls: "yl-muted-sm yl-tabular yl-clip-clock" });
    // 按钮和它的浮层共用一个定位锚：浮层贴着按钮右缘往下弹（见 styles.css 的 .yl-calib-anchor）。
    // ⚠️ 别把浮层直接挂进控制条、再靠 right 数值去对齐按钮 —— 那个数值要跟着控制条
    // 的内边距和静音按钮宽度一起算，动一个就偏（2026-09-28 踩过）。
    const calibAnchor = controls.createDiv({ cls: "yl-calib-anchor" });
    this.calibButton = createButton(calibAnchor, {
      shape: "icon",
      icon: "sliders-horizontal",
      ariaLabel: "时间校准",
    });
    this.calibPanel = calibAnchor.createDiv({ cls: "yl-calib-panel" });
    this.calibPanel.hide();
    this.muteButton = createButton(controls, {
      shape: "icon",
      icon: "volume-2",
      ariaLabel: "静音",
    });

    this.videoMetaEl = videoPanel.createDiv({ cls: "yl-video-meta" });

    const view = this;
    this.analysis = buildAnalysis({
      // 花谁的钱要在按钮下面写清楚，别让用户点了才知道扣费（按**实际生效**的轨道，
      // 双轨自由选后 = 用户自己选的那条，见 gate.ts resolveAiRoute）。用 getter：
      // 账户页切轨/充值到账后轨道会变，refreshGate 重算提示语时不能还拿着建卡时的旧值
      get aiMode() {
        return resolveAiRoute(view.plugin.settings);
      },
      getGate: () => this.getAiGate(),
      // 点击时的核实口：缓存拦人的先向服务器核实一次真余额（见 checkAiGate）
      checkGate: () => this.checkAiGate(),
      onNeedSetup: () => this.promptModelSetup(),
      onExplain: (words) => this.handleExplain(words),
      // 已解析过的句子再点「重新解析」：先弹确认窗，点了确认才真的再花一次
      onReparseConfirm: () => this.confirmReparse(),
      onRecharge: () => this.openPricing(),
    });
    left.appendChild(this.analysis.root);

    const right = grid.createDiv({ cls: "yl-right-col" });
    const panel = right.createDiv({ cls: "yl-practice-panel" });

    // 原句区独立成区（2026-09-30 用户拍板的 v4 方案）：句子 + 注音 + 翻译摆在最上面，
    // 跟读/抄写/仿写不再把句子装在自己肚子里，退成与它并列的三个子区域。
    // 注音是渐进增强：句子/翻译同步上屏，分词读音到了再补 ruby 和注音行（见 loadHeroReading）。
    this.buildHero(panel);

    this.imitationPractice = buildImitation({
      onVerify: (text, sliceCid, onFields) => this.handleVerifyImitation(text, sliceCid, onFields),
      onPassUnverified: (text, sliceCid) => this.handleUnverifiedImitation(text, sliceCid),
      onHint: () => this.handleImitationHint(),
      onReset: () => this.handleReset("imitation"),
      getGate: () => this.getAiGate(),
      // 点击/检查时的核实口：缓存拦人的先向服务器核实一次真余额（见 checkAiGate）
      checkGate: () => this.checkAiGate(),
      // 灰字里「开启 AI」被点才弹配置窗 —— 检查本身不再被弹窗拦截
      onNeedSetup: () => this.promptModelSetup(),
      onRecharge: () => this.openPricing(),
      loadDraft: (sliceCid) => loadDraft(this.db, "imitation", sliceCid),
      saveDraft: (sliceCid, text) => saveDraft(this.db, "imitation", sliceCid, text),
    });

    // 三步走时间线：左侧圆点导轨（✓ 已完成 / 高亮当前步 / 灰数字未开始），右侧还是
    // 原来那三个练习构件。完成的卡依旧晕一圈（.yl-stepcard-*，四态口径不变）。
    const timeline = panel.createDiv({ cls: "yl-timeline" });
    type StepKey = "read" | "copy" | "imitation";
    const stepKeys: StepKey[] = ["read", "copy", "imitation"];
    const stepCards = {} as Record<StepKey, HTMLElement>;
    const tlNos = {} as Record<StepKey, HTMLElement>;
    stepKeys.forEach((key, index) => {
      const item = timeline.createDiv({ cls: "yl-tl-item" });
      const rail = item.createDiv({ cls: "yl-tl-rail" });
      tlNos[key] = rail.createSpan({ cls: "yl-tl-no", text: String(index + 1) });
      stepCards[key] = item.createDiv({ cls: "yl-tl-card yl-step-card" });
    });
    this.tlNos = tlNos;
    stepCards.read.appendChild(this.readAloud.root);
    stepCards.copy.appendChild(this.copyPractice.root);
    stepCards.imitation.appendChild(this.imitationPractice.root);
    this.stepCards = stepCards;

    // 右下角的漂流瓶精灵：对着当前这一句追问。
    // 挂在 .yl-study-root 上（absolute），不进 .yl-card-grid —— 那个容器会滚动，
    // 挂进去会被滚走，而"随时能问"正是它的价值。
    this.assistant = buildAssistant({
      onSettings: () => this.plugin.settings,
      // 只在提示语里的「充值」被点时才开充值页，不自动跳（2026-10-02 用户定稿）
      onPricing: () => this.openPricing(),
      getGate: () => this.getAiGate(),
      // 点击/代问时的核实口：缓存拦人的先向服务器核实一次真余额（见 checkAiGate）
      checkGate: () => this.checkAiGate(),
      onNeedSetup: () => this.promptModelSetup(),
      // 真问起来才发现没余额（402）：统一弹「余额用完」窗（主钮仍是去配置），不再就地摆提示
      onNoBalance: () => this.handleOutOfBalance(),
      // 每轮问答都落进进度行：翻走再回来、插件重载之后，之前问的还在
      onTurn: (sliceCid, turn) => this.persistChatTurn(sliceCid, turn),
      // 微信式对话行的用户头像：账号头像图；没设头像时用昵称首字占位（个人中心同款）
      getUserAvatar: () => ({
        url: this.plugin.accountAvatarUrl(),
        initial: (this.plugin.settings.accountProfile?.nickname || "洋").slice(0, 1),
      }),
    });
    root.appendChild(this.assistant.root);

    this.wireVideo();
  }

  private wireVideo(): void {
    const video = this.videoEl;
    video.src = this.videoUrl;
    video.addEventListener("error", () => {
      this.videoErrorEl.setText("视频加载失败：文件可能被移动、改名或占用。重新导入一次选对路径即可。");
      this.videoErrorEl.show();
    });

    // 一句播完自动停：不循环（反复自动播放会干扰跟读，要重看得自己点）
    video.addEventListener("timeupdate", () => {
      if (this.endMs > 0 && video.currentTime * 1000 >= this.endMs) {
        video.pause();
      }
      this.refreshClipControls();
    });
    // 点画面 = 播放/暂停。播到句尾之后再点会先回到本句开头（不然看着像"按了没反应"）
    video.addEventListener("click", () => this.toggleClipPlayback());
    video.addEventListener("play", () => this.refreshClipControls());
    video.addEventListener("pause", () => this.refreshClipControls());
    video.addEventListener("volumechange", () => {
      const muted = video.muted || video.volume === 0;
      setButtonIcon(this.muteButton, muted ? "volume-x" : "volume-2", muted ? "已静音" : "静音");
    });

    // 拖到窗口外面去的拉回来；窗口内的抖动不管（否则每次播放都会被 seek 打断）
    video.addEventListener("seeked", () => {
      const target = pullBackMs(video.currentTime * 1000, this.startMs, this.endMs);
      if (target !== null) video.currentTime = target / 1000;
      this.refreshClipControls();
    });

    this.playButton.addEventListener("click", () => this.toggleClipPlayback());
    this.replayButton.addEventListener("click", () => this.replayClip());
    this.calibButton.addEventListener("click", () => this.toggleCalibration());
    this.muteButton.addEventListener("click", () => {
      video.muted = !video.muted;
      setButtonIcon(this.muteButton, video.muted ? "volume-x" : "volume-2", video.muted ? "已静音" : "静音");
    });
    this.clipSlider.addEventListener("input", () => {
      const ratio = Number(this.clipSlider.value) / 1000;
      video.currentTime = seekTargetMs(ratio, this.startMs, this.endMs) / 1000;
    });
  }

  private toggleClipPlayback(): void {
    const video = this.videoEl;
    if (!video.paused) {
      video.pause();
      return;
    }
    // 已经播到句尾（或位置在句首之前 / 播放器已到文件末尾）→ 先回本句开头再播
    if (shouldRestart(video.currentTime * 1000, this.startMs, this.endMs, video.ended)) {
      video.currentTime = this.startMs / 1000;
    }
    void video.play().catch(() => undefined);
  }

  /** rate = 播放倍速：喇叭 1x、乌龟 0.5x；换句走 setClipWindow 会重置回 1x。 */
  private replayClip(rate = 1): void {
    this.videoEl.playbackRate = rate;
    this.videoEl.currentTime = this.startMs / 1000;
    void this.videoEl.play().catch(() => undefined);
  }

  // ── hero 喇叭：重播本句视频切片 ───────────────────────────────────────────
  //
  // 曾经这里挂过整句 TTS（edge-tts，服务端合成）。10-02 用户拍板整个拿掉：
  // 合成音跟"真人台词 + 跟读模仿"是两回事，出错的姿势还多（服务端没连上、
  // 没登录、注音纠错后要对齐读音……）。现在只做一件最简单、永远不会错的事：
  // 从头再播一遍这句的视频。入口见 hero 的喇叭按钮（直接调 replayClip）。

  // ── 时间校准 ─────────────────────────────────────────────────────────────
  //
  // ⚠️ 校准**只改我们自己的播放时间窗**（startMs/endMs 各加一个偏移量），
  // 视频文件、字幕文件一个字节都不动。所以它可以随时归零，没有任何不可逆的后果。

  private toggleCalibration(): void {
    if (this.calibPanel.isShown()) {
      this.closeCalibration();
      return;
    }
    if (this.calibPanel.childElementCount === 0) this.renderCalibPanel();
    this.renderCalibValue();
    this.calibPanel.show();
    // 点其他位置就关，不必再点一次校准按钮（2026-09-28 用户定，全站弹层统一）。
    // 校准按钮自己不算外面 —— 开着时点它由上面的 toggle 收尾，不会先关再开闪一下。
    this.stopCalibOutside = onClickOutside(
      this.calibPanel,
      () => this.closeCalibration(),
      [this.calibButton],
    );
  }

  /** 弹层的统一关门：面板收起、"点外面"监听摘掉（两种关法共用这一个）。 */
  private closeCalibration(): void {
    this.calibPanel.hide();
    this.stopCalibOutside?.();
    this.stopCalibOutside = null;
  }

  private renderCalibPanel(): void {
    // 版面：**一行按钮 + 一句说明**（2026-09-28 用户："太复杂了，就保留 3 个按钮"）。
    // ⚠️ 别再往回加按钮：「完成」是多余的 —— 校准按钮自己就是开关，再点一下收起；
    // 「以现在听到的为准」也是多余的 —— 要的是微调，两个 ±0.5 秒加一个重置就够。
    const head = this.calibPanel.createDiv({ cls: "yl-calib-head" });
    head.createSpan({ text: "时间校准" });
    head.createSpan({ cls: "yl-muted-sm", text: "本集一起生效" });
    head.createSpan({ cls: "yl-calib-spacer" });
    head.createSpan({ cls: "yl-muted-sm", text: "当前偏移" });
    this.calibValueEl = head.createSpan({ cls: "yl-calib-value yl-tabular" });

    const row = this.calibPanel.createDiv({ cls: "yl-calib-row" });
    createButton(row, {
      text: "−0.5 秒",
      onClick: () => void this.applyOffset(stepOffset(this.offsetMs, -1)),
    });
    createButton(row, { text: "重置", onClick: () => void this.applyOffset(0) });
    createButton(row, {
      text: "+0.5 秒",
      onClick: () => void this.applyOffset(stepOffset(this.offsetMs, 1)),
    });

    this.calibPanel.createDiv({
      cls: "yl-calib-note yl-muted-sm",
      // 职责边界（2026-09-28 用户定）：只校字幕和视频；音画不同步是片源问题，引导换源，不做音画轴
      text: "只校准字幕和视频的错位；音画不同步请自行更换、调整视频源。只调整播放位置，视频和字幕文件不会被改动。",
    });
  }

  private renderCalibValue(): void {
    if (!this.calibValueEl) return;
    this.calibValueEl.setText(formatOffset(this.offsetMs));
    this.calibValueEl.toggleClass("yl-calib-value-on", this.offsetMs !== 0);
    this.calibButton.toggleClass("is-on", this.offsetMs !== 0);
  }

  // ── 句子笔记（「笔记」按钮 → 右侧抽屉，2026-10-09 改版）──────────────────
  // 交互口径：目录同款抽屉（每次打开现建、关闭即拆），上半自己下半大家。
  // 有没有笔记看统一缓存（notes/mine.ts），按钮只负责虚线，不再长驻编辑状态 ——
  // 旧的"贴纸 + 收起即保存"一整套状态机随改版退役。

  /** 当前句的未保存笔记草稿：关抽屉时存下、同句重开还在；换句/关页面即作废 */
  private noteDraft = "";

  /** 开着的笔记抽屉句柄：注音（异步）算完后拿它续刷锚点条；关掉即清 */
  private notesDrawerHandle: NotesDrawerHandle | null = null;

  /** 点「笔记」：对当前这句开抽屉；保存/删除后回调里同步按钮虚线。 */
  private openNoteDrawer(): void {
    const slice = this.currentSlice();
    if (!slice) return;
    this.notesDrawerHandle = openNotesDrawer({
      parent: this.contentEl,
      app: this.app,
      settings: this.plugin.settings,
      db: this.db,
      sliceCid: slice.cid,
      zh: effectiveZh(slice),
      // 锚点条克隆 hero 的句子 DOM：注音三层优先级（手改 > AI > 词典）只养 hero 一处
      sentenceEl: () => this.heroJaEl ?? null,
      onReplay: () => this.replayClip(1),
      draft: this.noteDraft,
      onClose: (draft) => {
        this.noteDraft = draft;
        if (this.notesDrawerHandle?.sliceCid === slice.cid) this.notesDrawerHandle = null;
      },
      onMineChanged: (cid, text) => {
        if (this.currentSlice()?.cid !== cid) return;
        this.noteButton?.toggleClass("has-note", text.trim() !== "");
      },
    });
  }

  /** 虚线跟句走：缓存没拉过就先拉一趟（登录拉服务端、未登录读本机），再读这一句。 */
  private async refreshNoteButton(slice: StudySentence): Promise<void> {
    let text = myNoteFor(slice.cid);
    if (text === "") {
      try {
        const map = await loadMyNotes(this.plugin.settings, this.db);
        text = map.get(slice.cid.slice(2)) ?? "";
      } catch (error) {
        log.warn("读取笔记失败", error);
      }
    }
    if (this.currentSlice()?.cid !== slice.cid) return; // 期间已经翻到别的句子了
    this.noteButton?.toggleClass("has-note", text.trim() !== "");
  }

  /** 改偏移：立即对当前句生效，并落库（整条视频共用）。 */
  private async applyOffset(next: number): Promise<void> {
    const value = normalizeOffset(next);
    const changed = value !== this.offsetMs;
    this.offsetMs = value;
    this.renderCalibValue();
    const slice = this.currentSlice();
    if (slice && changed) {
      // 只重设视频窗口 —— 不能走 showSlice，那会把练习区里正打了一半的字清掉
      this.setClipWindow(slice, !this.videoEl.paused);
    }
    if (!changed || !this.videoAsset) return;
    try {
      this.videoAsset = await saveVideoOffset(this.db, this.videoAsset, value);
    } catch (error) {
      log.warn("保存时间校准失败", error);
      new Notice("校准没能存下来，重载后会还原成上一次的值。");
    }
  }

  /**
   * 设置本句的播放窗口（含校准偏移），并按 `play` 决定【从头播】还是【停住】。
   * 换句与校准都用它，别在别处重复算。
   *
   * ⚠️ 不播时要**显式 pause**：只 seek 不暂停的话，正在播的播放器会顺着新窗口继续响下去
   * —— 那样"上一句一定不播"只在视频本来就停着时才成立（2026-09-27 加）。
   */
  private setClipWindow(slice: StudySentence, play: boolean): void {
    const window = effectiveWindow(slice, this.offsetMs);
    this.startMs = window.startMs;
    this.endMs = window.endMs;
    const applySeek = () => {
      // 换句（含校准重铺）倍速回 1x：慢放只对"这一遍"负责，别顺着新窗口慢下去
      this.videoEl.playbackRate = 1;
      this.videoEl.currentTime = this.startMs / 1000;
      if (play) void this.videoEl.play().catch(() => undefined);
      else this.videoEl.pause();
      // 换窗口后时钟/进度要立刻反映，别停在上一条上
      this.refreshClipControls();
    };
    if (this.videoEl.readyState >= 1) applySeek();
    else this.videoEl.addEventListener("loadedmetadata", () => applySeek(), { once: true });
  }

  /** 控制条只反映**本句窗口**：进度、时钟、按钮状态。 */
  private refreshClipControls(): void {
    if (!this.playButton) return;
    const video = this.videoEl;
    const currentMs = video.currentTime * 1000;
    setButtonIcon(this.playButton, video.paused ? "play" : "pause", video.paused ? "播放" : "暂停");
    // 中央播放提示跟暂停态走：暂停（含刚切句、播到句尾）就亮出来，播起来就藏
    this.playOverlayEl?.toggleClass("yl-on", video.paused);
    const playable = this.endMs > this.startMs;
    this.clipSlider.disabled = !playable;
    const lengthMs = clipLengthMs(this.startMs, this.endMs);
    const shownMs = Math.min(Math.max(currentMs - this.startMs, 0), lengthMs);
    this.clipSlider.value = String(Math.round(clipRatio(currentMs, this.startMs, this.endMs) * 1000));
    this.clipClockEl.setText(`${formatClipClock(shownMs)} / ${formatClipClock(lengthMs)}`);
  }

  /**
   * 切到某一句：就地更新标题、进度、视频时间窗和三个练习区。
   *
   * @param autoPlay `true` = 一定从头播这一句；`false` = 一定停住（正在播也停）；
   *   **不传** = 沿用当前播放状态（正在播就接着播）—— 恢复上次位置、目录跳转这类
   *   不是"翻页"的入口走这条。翻句按钮一律显式传 `false`（切句绝不自动播，
   *   2026-09-29 用户定：突然出声吓人，要播用户自己点）。
   */
  private showSlice(index: number, autoPlay?: boolean): void {
    if (!this.item) return;
    const total = this.slices.length;
    const next = Math.min(total, Math.max(1, index));
    if (index > total) {
      new Notice("已经是最后一句了。点「退出」结束这一集。");
      return;
    }
    if (index < 1) return;
    this.index = next;
    const slice = this.slices[next - 1];

    const label = episodeLabel(this.item.record.season, this.item.record.number);
    this.cardTitleEl.setText(
      `切片学习 · ${[this.item.record.title || this.item.record.titleJa, label]
        .filter(Boolean)
        .join(" ")} · 第 ${next} / ${total} 句`,
    );
    setButtonRole(this.nextButton, this.isComplete(slice) ? "primary" : "default");

    // 视频窗口：同一文件只换时间窗。翻句按钮一律传 false（切句不自动播），
    // 其余入口不传 = 正在播就接着播、停着的等用户点播放。
    const wasPlaying = !this.videoEl.paused && !this.videoEl.ended;
    this.setClipWindow(slice, autoPlay ?? wasPlaying);
    // 说话人放进下面那行说明里；本句长度交给控制条的时钟显示，别在这里重复一遍
    this.videoMetaEl.setText(slice.speaker ? `说话人：${slice.speaker}` : "");
    void this.renderAnalysis(slice);
    this.videoMetaEl.toggle(this.videoMetaEl.textContent !== "");
    this.videoErrorEl.hide();

    const progress = this.progressRows.get(slice.cid);
    this.readAloud.load(slice, progress);
    this.copyPractice.load(slice, progress);
    this.imitationPractice.load(slice, progress);
    // 原句区跟句走：句子/翻译先铺，注音（分词）到了再补
    this.renderHero(slice);
    // 「笔记」按钮跟句走：读这一句的笔记，决定「笔记」两字下面有没有虚线
    void this.refreshNoteButton(slice);
    // 草稿只活在当前句的学习页内：换句即作废；残留的笔记抽屉（正常先关才换得动句，
    // 防御键盘/指令换句的边角）直接拆掉 —— 不播动画，反正没人看着它收
    this.noteDraft = "";
    this.contentEl.querySelector(".yl-nd-overlay")?.remove();
    this.notesDrawerHandle = null;
    // 库里存着的问答记录交给助手还原（这次会话内存里没有时才用得上）
    this.assistant.load(slice, progress?.imitationChat);
    // 已经做过的抄写/仿写就是现成的上下文，助手不用让用户复述
    this.assistant.setContext({
      imitation: progress?.imitationText
        ? {
            text: progress.imitationText,
            // 助手要知道的是"AI 当时怎么判的"。**没核对过就什么都不说** ——
            // 兜底放行（AI 用不了时点核对直接算过）会被说成"判定为通过"，
            // 那是替模型许下一个它从没做过的判定。
            correct: progress.imitationVerifiedAt
              ? progress.imitationFeedback?.correct === true
              : undefined,
            reason:
              progress.imitationVerifiedAt && typeof progress.imitationFeedback?.reason === "string"
                ? progress.imitationFeedback.reason
                : "",
          }
        : null,
    });
    this.refreshSteps(slice);
    this.refreshProgressBar();
    if (this.session) {
      this.session.currentIndex = next;
      void saveSession(this.db, this.session).catch(() => undefined);
    }
  }

  private isComplete(slice: StudySentence): boolean {
    return this.progressRows.get(slice.cid)?.completedAt != null;
  }

  /**
   * 时间线圆点的状态：✓ 已完成 / 高亮第一个没做完的（当前步）/ 灰数字未开始。
   *
   * ⚠️ 圆点判的是「这一步**做没做过**」（`readAloudAt` 不论核不核对都算），
   *    与卡头那枚胶囊判的「**判过没有**」是两个问题 —— 圆点管进度、胶囊管结论。
   *    所以跟读「AI 没核对过」时会出现"圆点 ✓ + 卡头 已完成"的组合，这是对的。
   *    卡片外框的三态见 refreshStepCards，两者口径不要互相抄。
   */
  private refreshSteps(slice: StudySentence): void {
    if (!this.tlNos) return;
    const progress = this.progressRows.get(slice.cid);
    const states = {
      read: progress?.readAloudAt != null,
      copy: progress?.copyDoneAt != null,
      imitation: progress?.imitationCorrect === true,
    };
    const keys = ["read", "copy", "imitation"] as const;
    const activeKey = keys.find((key) => !states[key]);
    keys.forEach((key, index) => {
      const no = this.tlNos![key];
      no.setText(states[key] ? "✓" : String(index + 1));
      no.toggleClass("yl-tl-no-done", states[key]);
      no.toggleClass("yl-tl-no-active", key === activeKey);
    });
    this.refreshStepCards(progress);
  }

  /**
   * 卡片外框的三态（2026-10-09 用户拍板「V2 描边徽章 + V1 彩色边框」）。
   *
   *   `ok`    正解 —— 青蓝边 + 整卡晕一圈
   *   `bad`   未通过 —— 浅红边 + 浅红晕
   *   `plain` 已完成（没人判过）—— **不铺任何底色**，退回中性卡面
   *   null    这一步还没做过 —— 同上，中性
   *
   * 🔥 判据必须与 practices.ts 的 paintStepStatus / readAloudStatus 同一套：
   *    「正解」跟读要 `readAloudVerifiedAt`、抄写要 `copyDoneAt`、仿写要
   *    `imitationVerifiedAt`。少一个"判过"的依据，那一步就会被画成正解。
   *
   * ⚠️ 「未通过」只有仿写落库（`imitationCorrect === false`），所以卡片外框的
   *    红晕只出现在仿写卡上；跟读/抄写判错时那一步**没完成**（不写完成时刻），
   *    外框自然保持中性 —— 红的结论由卡头那枚胶囊承担。
   */
  private refreshStepCards(progress: ProgressRow | undefined): void {
    if (!this.stepCards) return;
    const imitationPass = progress?.imitationCorrect === true;
    const states: Record<"read" | "copy" | "imitation", StepStatus | null> = {
      read: readAloudStatus(progress),
      copy: progress?.copyDoneAt != null ? "ok" : null,
      imitation: !imitationPass
        ? progress?.imitationCorrect === false
          ? "bad"
          : null
        : progress?.imitationVerifiedAt != null
          ? "ok"
          : "plain",
    };
    (Object.keys(states) as Array<keyof typeof states>).forEach((key) => {
      const card = this.stepCards![key];
      card.toggleClass("yl-stepcard-ok", states[key] === "ok");
      card.toggleClass("yl-stepcard-bad", states[key] === "bad");
      card.toggleClass("yl-stepcard-plain", states[key] === "plain");
    });
  }

  // ── 原句区（hero）───────────────────────────────────────────────────────
  // v4 布局：句子/注音/翻译独立成区，不再住在跟读卡里。「再听一遍」就是
  // 重播当前切片（和视频控制条上的重播同一套逻辑）。

  private buildHero(panel: HTMLElement): void {
    this.heroEl = panel.createDiv({ cls: "yl-hero" });
    const hero = this.heroEl;

    // 卡片头一排放全所有操作按钮：喇叭 / 乌龟（慢放）| 弹性空隙 | 纠 / 罗马音。
    // （「原句」小标签 2026-10-02 按用户要求去掉，这一排就是纯按钮。）
    const head = hero.createDiv({ cls: "yl-hero-head" });

    // 喇叭：点了就从头再播一遍这句的视频切片（没有任何合成音）
    // 🔒 原句卡片这一排走 `shape: "hero"` —— 2026-10-02 用户点名保留原样，
    //    不参与全站统一。走组件只是为了「创建按钮只有一个入口」。
    createButton(head, {
      shape: "hero",
      icon: "volume-2",
      ariaLabel: "再听一遍",
      title: "再听一遍",
      onClick: () => this.replayClip(1),
    });

    // 「慢」：0.5 倍速从头再播一遍 —— 还是视频原声，只是慢放（TTS 已下线，别引回来）。
    // 图标先后试过「亀」字 / OpenMoji 线稿 / Twemoji 彩色款，2026-10-02 用户拍板：
    // 都不好看，就用一个「慢」字（跟旁边「纠」字同一套 chip 样式）。
    createButton(head, {
      shape: "hero",
      text: "慢",
      ariaLabel: "0.5 倍速再听一遍",
      title: "0.5 倍速再听一遍",
      onClick: () => this.replayClip(0.5),
    });

    head.createDiv({ cls: "yl-hero-spacer" });

    // 罗马音开关：按钮字面跟当前模式走 —— 默认「あ」= 只给汉字词标假名注音；
    // 点一下变「Aa」= 全句每个词（假名、汉字都算）头顶标罗马音
    // （2026-10-04 用户调整：排在「纠」前面）
    const toggle = createButton(head, {
      shape: "hero",
      cls: "yl-hero-romaji-toggle",
      text: "あ",
      ariaLabel: "罗马音",
      title: "罗马音",
      onClick: () => {
        const on = !hero.hasClass("yl-romaji-on");
        hero.toggleClass("yl-romaji-on", on);
        toggle.toggleClass("active", on);
        toggle.setText(on ? "Aa" : "あ");
        hero.querySelectorAll("rt[data-kana]").forEach((node) => {
          const rt = node as HTMLElement;
          rt.setText(on ? rt.dataset.romaji || rt.dataset.kana || "" : rt.dataset.kana || "");
        });
      },
    });

    // 纠错（单字「纠」）：点开**页正中的弹窗**（CorrectionModal），能改日文/中文/注音。
    // 2026-10-05 用户定：**常驻** —— 字幕本身就有错的可能，纯假名句也要能纠
    // （改的是日文/中文字幕；注音列表里没有它的词而已），别按"有没有带汉字的词"收放。
    this.heroFixBtnEl = createButton(head, {
      shape: "hero",
      text: "纠",
      ariaLabel: "纠错",
      title: "字幕或注音有误？点这里改",
      onClick: () => this.openHeroFix(),
    });

    // 纠错走弹窗，卡片里不再挂就地展开的面板（原先是 `.yl-hero-fix`）
    this.heroJaEl = hero.createDiv({ cls: "yl-hero-ja" });
    this.heroJaEl.setAttr("lang", "ja");
    this.heroZhEl = hero.createDiv({ cls: "yl-hero-zh" });

    // 点词弹卡：**解析过这一句才生效**（没解析时词没有释义，点了没意义）。
    // 事件委托挂在句子容器上绑一次 —— 每次换句都会重铺词 span，逐个绑会漏、会重复。
    this.heroJaEl.addEventListener("click", (event) => {
      if (!this.heroEl?.hasClass("yl-analyzed")) return;
      const span = (event.target as HTMLElement | null)?.closest<HTMLElement>(".yl-hero-w");
      if (!span || !this.heroJaEl?.contains(span)) return;
      const info = this.heroWordInfo[Number(span.dataset.tokenIndex)];
      if (info) this.openHeroWordPopover(span, info);
    });
  }

  /** 切句时同步铺底：句子/翻译立刻上屏，注音（本地分词是异步的）到了再补。 */
  private renderHero(slice: StudySentence): void {
    if (!this.heroJaEl || !this.heroZhEl) return;
    // 换句先复位上一句留下的三个临时态：青蓝（已解析）、压灰（等逐词释义）、
    // 闪烁（词到了）。它们都属于上一句，loadHeroReading 会按本句重定青蓝那一个。
    this.heroEl?.removeClass("yl-analyzed");
    this.clearHeroFlash();
    this.setHeroWordsPending(false);
    this.closeHeroPopover();
    this.heroJaEl.empty();
    // ⚠️ 走 `effectiveJa` / `effectiveZh`（用户在纠错弹窗里改过的版本），
    // 别直接读 slice.ja / .zh —— 那是原片字幕，改了也不该在这里生效。
    // 全视图凡是"给人看 / 喂给模型"的句子都走这两个函数。
    this.heroJaEl.setText(effectiveJa(slice));
    this.heroZhEl.setText(effectiveZh(slice));
    void this.loadHeroReading(slice);
  }

  /**
   * 原句注音：本地分词拼读音，这句 AI 解析过就优先用 AI 的句内读音
   * （口径与抄写提示一致，见 copyRomaji），用户手改过的注音（readingFixes）
   * 又压在 AI 之上 —— 纠错是用户拍的板，说了算。
   *
   * 汉字词标 ruby（词下带虚线提示"有注音"）；假名词也搭 ruby 骨架 —— 罗马音开关
   * 关着时注音位留空（CSS 把空 rt 收掉，不留空隙），开着时头顶标罗马音。
   * 词典/AI 都给不出读音的汉字词注音**留空**（虚线保留 —— 提示这个词注不出音、
   * 可纠；不拿字面自己标自己，燈ちゃん头上标个"燈"就是前车之鉴）。
   * 罗马音的目的就是照顾看不懂假名的人，所以开着时**全句每个词都有注音**，
   * 只标汉字等于没解决看不懂 に/できる 的问题。
   * 开关注音文字挂 data-kana / data-romaji 两份就地切换，不重渲染
   * （假名词的 data-kana 留空，关掉时注音位随 rt:empty 一起收掉）。
   * 纯符号/英数没有读音，不掺和；读音里没假名（分词器给不了读音的汉字词）
   * kanaToRomaji 是原样透传，拿它标头顶等于把汉字再标一遍，也不挂。
   * 词面拼不回原句（分词器吞字/丢标点）就整段放弃 —— 注音标错位
   * 比不标更坑，句子保持切句时的平铺原文。词典没装上同样只显示原文。
   */
  private async loadHeroReading(slice: StudySentence): Promise<void> {
    // 新句先清上一句的可纠词表（纠按钮常驻，不再随注音有无收放）
    this.heroAnnotRows = [];
    this.heroLockedWords = [];
    // "已解析"外观先定下：词典没装 / 分词失败 / 词面拼不回时也要正确复位，
    // 别把上一句的青蓝态与可点词留在没解析的句子上（所以放在所有 early return 之前）。
    this.heroEl?.toggleClass("yl-analyzed", this.isAnalyzed(slice));
    this.heroWordInfo = [];
    const dict = this.dictPath();
    if (!dict) return;
    const ja = effectiveJa(slice);
    const tokens = await tokenize(dict, ja);
    if (!tokens.length || this.currentSlice()?.cid !== slice.cid) return;
    if (!this.heroJaEl) return;
    if (tokens.map((token) => token.surface).join("") !== ja) return;
    const readings = slice.analysis?.done
      ? matchAiReadings(
          tokens,
          slice.analysis.tokens.map((token) => ({ surface: token.surface, reading: token.aiReading ?? "" })),
        )
      : [];
    const fixes = slice.readingFixes ?? {};
    const readingOf = (index: number): string => {
      const fix = fixes[String(index)];
      // surface 对不上（分词口径变了）的纠错自动失效，回默认注音
      if (fix && fix.surface === tokens[index].surface) return fix.reading;
      const token = tokens[index];
      // 词典/AI 都给不了读音的汉字词**留空**（rt:empty 收掉，虚线保留 —— 它现在
      // 顺便提示"这个词注不出音，可去纠"），兜底拿字面等于把汉字标到自己头上
      // （燈ちゃん头上标了个燈，2026-10-05 用户拍板去掉）；假名/标点的字面本身
      // 就是读法/原样，照旧透传
      return readings[index] || token.reading || (KANJI_RE.test(token.surface) ? "" : token.surface);
    };
    const romajiOn = this.heroEl?.hasClass("yl-romaji-on") ?? false;
    // 🔥 整串一起转，跨词促音才不丢（やっ + た → ya / tta）。口径与抄写提示一致：
    // 同一句在同一屏上不能一处写 yata 一处写 yatta。
    // 词性跟着进去 —— display 口径下助词 は/へ 标 wa/e（では→dewa）；抄写提示那路
    // 是 typing 口径，键序照旧 ha/he，两处各说各的没错。
    const romajiList = romajiTokens(
      tokens.map((token, index) => ({ reading: readingOf(index), pos: token.pos })),
    );

    this.heroJaEl.empty();
    tokens.forEach((token, index) => {
      const reading = readingOf(index);
      const romaji = romajiList[index];
      // 读音里没假名时 kanaToRomaji 只会原样透传 —— 那不是罗马音，别拿去标头顶
      const romajiReal = Boolean(romaji) && romaji !== reading;
      // 可点词：分词出来的词都算（标点除外）。解析成功后 .yl-hero-w 才显虚线与手型。
      const clickable = token.pos !== "punct";
      if (!KANJI_RE.test(token.surface)) {
        // 纯假名的词不推给纠错弹窗（读音就是它自己），但要记下来 ——
        // 弹窗里得说明「这些为什么没列出来」，否则用户以为漏了
        if (KANA_RE.test(token.surface)) this.heroLockedWords.push(token.surface);
        // 假名词平时注音位留空（rt:empty 收掉），罗马音开着才头顶标罗马音；
        // 骨架始终搭好，开关切换就地改 rt 文字就行，不用重铺整句
        if (!KANA_RE.test(token.surface) || !romajiReal) {
          this.heroJaEl!.createSpan({
            cls: clickable ? "yl-hero-w" : undefined,
            text: token.surface,
            attr: tokenIndexAttr(index),
          });
          return;
        }
        const word = this.heroJaEl!.createSpan({
          cls: clickable ? "yl-hero-kw-romaji yl-hero-w" : "yl-hero-kw-romaji",
          attr: tokenIndexAttr(index),
        });
        const ruby = word.createEl("ruby");
        ruby.createSpan({ text: token.surface });
        const rt = ruby.createEl("rt", { text: romajiOn ? romaji : "" });
        rt.setAttr("data-kana", "");
        rt.setAttr("data-romaji", romaji);
        return;
      }
      const word = this.heroJaEl!.createSpan({
        cls: clickable ? "yl-hero-kw yl-hero-w" : "yl-hero-kw",
        attr: tokenIndexAttr(index),
      });
      const ruby = word.createEl("ruby");
      ruby.createSpan({ text: token.surface });
      const rt = ruby.createEl("rt", { text: romajiOn && romajiReal ? romaji : reading });
      rt.setAttr("data-kana", reading);
      if (romajiReal) rt.setAttr("data-romaji", romaji);
      this.heroAnnotRows.push({ index, surface: token.surface, reading });
    });

    // 笔记抽屉开着的话，锚点条里的句子（刚克隆的还是打开时的纯文本）补上 ruby 注音
    if (this.notesDrawerHandle?.sliceCid === slice.cid) this.notesDrawerHandle.refreshSentence();

    // 解析过这一句：备好每个词的弹卡数据（读音走三层优先级，释义与词源按词形贴回）。
    // ⚠️ 词形取分词结果（token.surface），别回头去 DOM 读 —— span 里还躺着读音节点。
    if (this.isAnalyzed(slice)) {
      const stored = slice.analysis?.tokens ?? [];
      const meanings = matchMeanings(
        tokens,
        stored.filter((token) => token.def).map((token) => ({ surface: token.surface, meaning: token.def ?? "" })),
      );
      const origins = matchAiOrigins(
        tokens,
        stored.filter((token) => token.origin).map((token) => ({ surface: token.surface, origin: token.origin ?? "" })),
      );
      this.heroWordInfo = tokens.map((token, index) => ({
        surface: token.surface,
        reading: readingOf(index),
        pos: POS_LABEL[token.pos],
        meaning: meanings[index] ?? "",
        origin: origins[index] ?? "",
      }));
    }
  }

  /** 这一句在本机解析过吗（引擎对不上 = 旧口径的解析，当作没解析，等重新解析） */
  private isAnalyzed(slice: StudySentence): boolean {
    return Boolean(slice.analysis?.done && slice.analysis.engine === ANALYSIS_ENGINE);
  }

  /**
   * 点词弹卡（多邻国风的小白卡）：词形 · 读音 · 词性 · 意思（+ 英语外来语的词源）。
   *
   * ⚠️ 挂 `document.body` + `position:fixed`：句子卡片住在 `.yl-right-col`（overflow:auto）
   * 与 `.yl-card-grid`（overflow:hidden）里，自身还是 sticky —— 弹卡若挂在词 span 里做
   * absolute，会被这几层裁掉。body 上用被点词的视口矩形定位，不受裁切影响；
   * 点击时布局早已稳定，量 rect 是安全的（不像"刚建还没布局"那种时序坑）。
   *
   * 位置**默认在词的正下方**（2026-10-07 用户拍板）：词在句子中间，弹卡往下长
   * 才不挡着正在读的句子本身；下面塞不下（句子在视口底部）才翻到上方。
   */
  private openHeroWordPopover(anchor: HTMLElement, info: HeroWordInfo): void {
    this.closeHeroPopover();
    const pop = document.body.createDiv({ cls: "yl-wordpop" });
    pop.createDiv({ cls: "yl-wordpop-surface", text: info.surface });
    if (info.reading && info.reading !== info.surface) {
      pop.createDiv({ cls: "yl-wordpop-reading", text: info.reading });
    }
    if (info.pos) pop.createDiv({ cls: "yl-wordpop-pos", text: info.pos });
    pop.createDiv({ cls: "yl-wordpop-meaning", text: info.meaning || "—" });
    // 英语外来语才补词源（如 コート → coat）；其他语种/和语/汉语词不编语源
    if (info.origin) {
      pop.createDiv({ cls: "yl-wordpop-origin", text: `外来语 · 英语 ${info.origin}` });
    }

    // 先插进 DOM 再量尺寸（offsetWidth 要有布局才拿得到）
    const rect = anchor.getBoundingClientRect();
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    const gap = 8;
    // 默认在词下方；下面放不下就翻到上方（贴底那一行句子就是这种情况）
    let top = rect.bottom + gap;
    if (top + height > window.innerHeight - gap) top = rect.top - height - gap;
    // 水平居中，并夹到视口内
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(gap, Math.min(left, window.innerWidth - width - gap));
    pop.style.top = `${Math.round(top)}px`;
    pop.style.left = `${Math.round(left)}px`;

    const stopOutside = onClickOutside(pop, () => this.closeHeroPopover(), [anchor]);
    // 卡片 sticky、右栏还会滚：滚动 / 改窗口就关掉，省得弹卡飘在错位的词旁边
    const onMove = (): void => this.closeHeroPopover();
    document.addEventListener("scroll", onMove, { capture: true, passive: true });
    window.addEventListener("resize", onMove, { passive: true });

    this.closeHeroPopoverFn = () => {
      stopOutside();
      document.removeEventListener("scroll", onMove, { capture: true });
      window.removeEventListener("resize", onMove);
      pop.remove();
    };
  }

  /** 关掉词弹卡（没开着就是空操作）—— 换句 / 关视图 / 点外面都走这里 */
  private closeHeroPopover(): void {
    const close = this.closeHeroPopoverFn;
    this.closeHeroPopoverFn = null;
    close?.();
  }

  /**
   * 句子卡进入 / 退出「解析中」态：日文压灰。
   *
   * 解析是两次请求（解读 → 逐词释义），**从点下按钮到两块都落地**这段时间里句子卡
   * 的日文压灰，两块到齐（或明确失败）才回到正文色 —— 用户由此知道"上面那张卡
   * 正在变"，而不是点了按钮之后一片死寂（2026-10-07 用户拍板："解析完成之前文字
   * 偏灰，解析完成之后才变成现在这种深色"）。
   *
   * ⚠️ 由 `handleExplain` 压上、由它的每条出口清掉；`renderHero` 换句时也清一次
   * （用户中途翻走，灰不能跟着下一条句子走）。
   */
  private setHeroWordsPending(on: boolean): void {
    this.heroEl?.toggleClass("yl-words-pending", on);
  }

  /**
   * 逐词释义落地：句子卡闪一下。
   *
   * 用户这时多半在看左栏的解读，右上的卡片悄悄从"灰"变成了"青蓝 + 词可点" ——
   * 没有信号就完全错过了。两道信号一起给（2026-10-08 用户挑的 E 方案，见 styles.css
   * 的 @keyframes yl-hero-pulse / yl-hero-sweep）：一道斜光带横扫整张卡说"这里变了"，
   * 一圈加粗描边脉冲说"就是这张卡"。**不整块闪** —— 整块闪读起来像故障。
   * 两道都是 0.95s 一次过，这里的定时器只是兜底摘类（动画被系统设置关掉时也要收干净）。
   */
  private flashHero(): void {
    const hero = this.heroEl;
    if (!hero) return;
    this.clearHeroFlash();
    hero.removeClass("yl-flash");
    // 强制一次重排：同一个动画要在"换句后又解析同一句"时能再播一遍
    void hero.offsetWidth;
    hero.addClass("yl-flash");
    // CSS 动画只负责观感，类的摘除自己兜底 —— 动画被系统设置关掉时也要收干净。
    // ⚠️ 必须**长过最慢的那条动画**（扫光 1.1s）：类一摘 `overflow:hidden` 跟着没了，
    //    扫光带会在最后几帧甩到卡外面去。1.4s = 1.1s + 300ms 余量。
    this.heroFlashTimer = window.setTimeout(() => {
      hero.removeClass("yl-flash");
      this.heroFlashTimer = null;
    }, 1400);
  }

  /** 停掉在闪的动画（换句 / 关视图），别让定时器摸到已经换掉的句子卡 */
  private clearHeroFlash(): void {
    if (this.heroFlashTimer !== null) {
      window.clearTimeout(this.heroFlashTimer);
      this.heroFlashTimer = null;
    }
    this.heroEl?.removeClass("yl-flash");
  }

  // ── 注音纠错 ─────────────────────────────────────────────────────────────
  // 词典/AI 注的音可能错（人名、缩约最常见），字幕本身也可能有错。
  // 2026-10-03：原先是在卡片里就地展开一块面板（只改注音、挤在原句下面），
  // 现在换成页正中的 `CorrectionModal` 弹窗 —— 能变速播放、能改日文/中文/注音。
  // 壳在ui/dialog.ts（全站唯一），字段与说明怎么排见 views/CorrectionModal.ts。

  /**
   * 打开纠错入口（所有句子都能开 —— 字幕都有错的可能，2026-10-05 用户定）。
   *
   * 2026-10-10 用户定：这一句**还没 AI 解析过**时，先弹一颗提醒窗（`CorrectionSuggestModal`），
   * 把"AI 解析会自动补正注音/释义、可能根本不用手改"这层说清楚，主按钮引导先试一次解析。
   * 理由是用户点「纠」就是想手动改，而他多半不知道 AI 解析本来就会顺手改对 —— 不提醒
   * 就是让人白花力气手改。手动纠错照样留着（窗里那颗灰字钮），选了照走原路。
   * 已经解析过的句子再点「纠」＝用户去修 AI 也没弄对的地方，不必再劝，直接开窗。
   */
  private openHeroFix(): void {
    const slice = this.currentSlice();
    if (!slice) return;

    if (this.isAnalyzed(slice)) {
      this.openCorrectionModal(slice);
      return;
    }

    // 翻页 / 关视图的竞态：弹窗开着时用户可能已经翻走。点哪颗都先按当前还在不在
    // 这一句上核实一次（与「重新解析」的确认窗同一条口径），别把动作落到别人身上。
    const stillHere = (): boolean =>
      this.mode === "card" && this.currentSlice()?.cid === slice.cid;

    new CorrectionSuggestModal(this.app, {
      // 主按钮：等价于点一次「AI 解析」按钮（门控 / 词表判定 / 忙态全走那一处）
      onTryAi: () => {
        if (!stillHere()) return;
        this.analysis.runExplain();
      },
      onManual: () => {
        if (!stillHere()) return;
        this.openCorrectionModal(slice);
      },
    }).open();
  }

  /** 纠错弹窗（能改日文/中文/注音）—— 直接开，不带任何前置提醒。 */
  private openCorrectionModal(slice: StudySentence): void {
    const modal = new CorrectionModal(this.app, {
      slice,
      annots: this.heroAnnotRows,
      lockedWords: this.heroLockedWords,
      ja: effectiveJa(slice),
      zh: effectiveZh(slice),
      subtitle: this.correctionSubtitle(slice),
      // 弹窗里那对喇叭/慢就是原句卡同一套：replayClip 从头播，倍速它自己管
      onReplay: (rate) => this.replayClip(rate),
      onTeardown: () => {
        // 关窗把播放器还给宿主：停下、倍速回 1×，别留一句 0.5× 的在响
        this.videoEl.pause();
        this.videoEl.playbackRate = 1;
      },
      onSave: (fixes) => this.persistCorrection(slice, fixes),
    });
    modal.open();
  }

  /** 副标题：作品 · 集 · 第 N 句（与其它弹窗放作品名的口径一致） */
  private correctionSubtitle(slice: StudySentence): string {
    const item = this.item;
    if (!item) return `第 ${this.slices.indexOf(slice) + 1} 句`;
    const label = episodeLabel(item.record.season, item.record.number);
    const head = [item.record.title || item.record.titleJa, label].filter(Boolean).join(" · ");
    return [head, `第 ${this.slices.indexOf(slice) + 1} 句`].filter(Boolean).join(" · ");
  }

  /**
   * 落库纠错结果。
   *
   * 写不进去要**把弹窗留着**（由调用方在onSave 抛错时不 close）——
   * 弹窗一关用户就看不到自己改了什么，等于白改。
   */
  private async persistCorrection(
    slice: StudySentence,
    fixes: { textFixes: StudySentence["textFixes"]; readingFixes: StudySentence["readingFixes"] },
  ): Promise<void> {
    // 先乐观更新内存行：保存成功后要靠它重铺原句与注音
    const nextJa = fixes.textFixes?.ja;
    const nextZh = fixes.textFixes?.zh;
    slice.textFixes = fixes.textFixes;
    slice.readingFixes = fixes.readingFixes;

    try {
      await saveSliceTextFixes(this.db, slice, fixes.textFixes);
      await saveSliceReadingFixes(this.db, slice, fixes.readingFixes);
    } catch (error) {
      log.warn("纠错没存上", error);
      new Notice("纠错没存上，再试一次");
      // 回滚内存行，别让界面停在一个"改了但没存"的状态
      slice.textFixes = fixes.textFixes;
      throw error;
    }

    // ⚠️ **改了日文就要重新分词** —— 原句变了，注音得按新句子重算。
    // 不重铺的话：罗马音开着时看到的是旧句子的音，而输入框里是新句子。
    void this.loadHeroReading(slice);
    // 目录不用主动刷：它是**每次打开现建**的（openToc 先remove 旧的），
    // 重建时读的就是 effectiveJa/slice.zh 那一份。
    this.renderHero(slice);
    if (fixes.textFixes !== undefined && nextJa !== undefined) {
      new Notice("已保存。日文改了之后，这句的注音请顺手核对一遍。", 5000);
    }
  }

  /**
   * 进度条上某个横坐标对应第几句（1-based，夹在 `[1, total]`）。
   *
   * 整条按句等分：落在第 n 格 = 第 n 句（比例 0 → 第 1 句、比例 1 → 末句）；
   * 鼠标贴着条边缘时比例可能略微越界，一律夹回来。
   * 算不出来（没句子 / 条还没布局出宽度）返回 `null` —— 点击与悬停共用这一份换算。
   */
  private progressIndexAt(clientX: number): number | null {
    const total = this.slices.length;
    if (total === 0) return null;
    const rect = this.progressBarEl.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const ratio = (clientX - rect.left) / rect.width;
    return Math.min(total, Math.max(1, Math.floor(ratio * total) + 1));
  }

  /** 点顶部进度条 = 跳到对应的那一句。 */
  private jumpByProgressBar(event: MouseEvent): void {
    const index = this.progressIndexAt(event.clientX);
    if (index == null || index === this.index) return;
    // 跳走之前在"原来那一句"留个黑标：点错了还能在 10 秒内点回来（用户 10-02 提）
    this.markProgressOrigin(this.index);
    this.showSlice(index);
  }

  /**
   * 在第 `index` 句那一格上方摆一枚黑标，10 秒内慢慢淡出。
   *
   * 用户原话是"刚刚所在的位置保持是黑的，一点点变淡，10 秒后消失"——
   * 目的是**防误点**：手滑点到别处后，一眼还能看见自己刚待在哪、点得回去。
   * 所以每次跳走都重新标记（而不是只记第一次），连点多次时黑标跟着"上一次的落点"走。
   *
   * ⚠️ 留的是**跳走前**那一格，不是落点（最容易搞反的地方）。
   *
   * 三处实现要点：
   *  · 颜色是**黑**（`--text-normal`）—— 与当前句游标（蓝）刻意区分开：
   *    同色的话鼠标一移开就分不清哪个是"现在"、哪个是"刚刚离开的地方"（用户 10-02 提）；
   *  · 挂在 `progressRowEl`（行）而不是条上 —— 条会被 `refreshProgressBar` 的
   *    `bar.empty()` 整个重建，标在条里会被连带摘掉；
   *  · 定位用 px（而不是百分比）—— 百分比是相对"行"算的，而行右边还有
   *    "已学 N / M 句"文字，条只占行的一部分，按行宽取百分比会整体偏移。
   *    跟气泡同款做法：量出条在行内的实际宽度再换算。
   */
  private markProgressOrigin(index: number): void {
    const total = this.slices.length;
    if (total === 0 || index <= 0) return;
    this.clearProgressMark();
    this.progressMarkIndex = index;
    const el = this.progressBarEl.createDiv({ cls: "yl-progress-mark" });
    this.progressMarkEl = el;
    // 淡出动画自己会跑完，但动画结束不保证有回调（标签页隐藏时 CSS 动画会停），
    // 所以留一个定时器兜底移除，避免节点越积越多。
    this.progressMarkTimer = window.setTimeout(() => this.clearProgressMark(), PROGRESS_MARK_MS);
    this.placeProgressMarkAt(this.progressMarkEl, index);
  }

  /** 收掉黑标（换集、再次跳走、或 10 秒到点）。定时器一并清掉。 */
  private clearProgressMark(): void {
    if (this.progressMarkTimer != null) {
      window.clearTimeout(this.progressMarkTimer);
      this.progressMarkTimer = null;
    }
    this.progressMarkIndex = 0;
    this.progressMarkEl?.remove();
    this.progressMarkEl = null;
  }

  /**
   * 悬停顶部进度条 = 点亮"鼠标指到的那一句"那一段，并在它正上方浮出这句的时间。
   *
   * 2026-10-02 用户改的口径：**不要整根高亮**，只亮指到的那一格，
   * 鼠标跨过格边界就整段跳到下一格（跳跃式、一段一段换）；时间气泡跟着这一段走，
   * 格式固定 `00:00:00`（用户指定）。所以这里不动任何常驻结构，只挪段和气泡。
   */
  private hoverProgressBar(event: MouseEvent): void {
    const index = this.progressIndexAt(event.clientX);
    if (index == null) return;
    const hover = this.progressHoverEl;
    // 与游标、回标**同一套**定位与宽度（placeProgressMarkAt）：
    // 位置 = 格中心百分比、宽度 = max(5px, 一格%)，三处永远一致。
    this.placeProgressMarkAt(hover, index);
    hover.show();
    if (!this.progressTipEl) return;
    // 文本只在换句时重写：mousemove 每秒几十次，每次都改字等于每次强制排一次版
    if (this.progressTipIndex !== index) {
      const slice = this.slices[index - 1];
      this.progressTipEl.setText(formatHms(effectiveWindow(slice, this.offsetMs).startMs));
      this.progressTipIndex = index;
    }
    this.progressTipEl.show();
    this.placeProgressTip(index);
  }

  /** 悬停离开进度条：亮段与时间气泡一起收掉（气泡的文本缓存一并作废）。 */
  private clearProgressHover(): void {
    this.progressHoverEl.hide();
    this.progressTipEl?.hide();
    this.progressTipIndex = 0;
  }

  /**
   * 把时间气泡摆到"指到的那一格"的正上方。
   *
   * 先按格子中心定位，再往回收半个气泡宽 —— 首格 / 末格时气泡会半个探出条外
   * （条的两端就是这一行的两端），收回来才不越界。
   * 气泡宽度只能量 `offsetWidth`（内容是 `00:00:00` 定长，但字号跟主题走），
   * 所以这一步必须在 `tip.show()` 之后调。
   */
  private placeProgressTip(index: number): void {
    const total = this.slices.length;
    if (total === 0) return;
    const barRect = this.progressBarEl.getBoundingClientRect();
    const rowRect = this.progressRowEl.getBoundingClientRect();
    if (barRect.width <= 0) return;
    // 进度条是这一行的第一个子元素（左边没有别的东西），"格中心"直接按条内比例换算即可
    const center = barRect.left - rowRect.left + ((index - 0.5) / total) * barRect.width;
    const half = this.progressTipEl.offsetWidth / 2;
    // 窗口极窄时 row 可能比气泡还窄：先把下限兜住，免得 max/min 打起来算出负数
    const right = Math.max(half, rowRect.width - half);
    this.progressTipEl.style.left = `${Math.min(Math.max(center, half), right)}px`;
  }

  /**
   * 三处标记（游标 / 悬停段 / 残留回标）的**共同定位**：摆到第 `index` 句那一格的中心。
   *
   * 2026-10-02 用户要求三处**同宽同源**（一格的宽、最小 5px、不设上限），
   * 于是三者的定位也一起收进这一份 —— 挂都在 `progressRowEl`（行）上、位置都用 px。
   *
   * ⚠️ 为什么三处都得挂在**行**上、而不是条里：
   *  · 条里有 `overflow: hidden`（给色块裁圆角）⇒ 5px 的标在**首/末格会被裁掉约 1px**
   *    （实测 `visibleW` 只剩 3.95px）。悬停段尤其不能被裁 —— 它靠位置指认是哪一句；
   *  · 悬停段还会被 `refreshProgressBar` 的 `bar.empty()` 连带摘掉。
   * 挂行上后两者都不再是问题。
   *
   * 用 px 而不是百分比：百分比是相对"行"算的，而行右边还有"已学 N / M 句"文字，
   * 条只占行的一部分，按行宽取百分比会整体偏移。跟气泡同款做法。
   */
  /**
   * 三处标记（游标 / 悬停段 / 残留回标）的**共同定位**：摆到第 `index` 句那一格的中心。
   *
   * 挂载位置：三处都在 `.yl-progress`（条）里，与 `.yl-progress-track` 同级当兄弟。
   *  · 挂条里、而不是条外那一行：条是 `position: relative` 的定位基准，
   *    横向百分比直接相对条宽算，**不再需要量 rect**，也就不会因为"卡片刚建、
   *    行还没完成布局"而量错位置（10-02 实机踩过：标记飘到了条上方）。
   *  · 与轨道同级的理由：轨道要 `overflow: hidden` 裁色块圆角，标记不能被裁。
   *
   * 纵向对齐**完全交给 CSS**（`top: 0; bottom: 0`）—— JS 只写横向。
   * 之前用 `barRect.top - rowRect.top` 算 top 是"一次性测量"，布局时序一变就飘。
   *
   * @param index 第几句（1-based）
   */
  private placeProgressMarkAt(el: HTMLElement | null, index: number): void {
    const total = this.slices.length;
    if (!el || total === 0) return;
    // 横向：格中心 = (index-0.5)/总句数，百分比相对条宽；居中交给 CSS 的 translateX(-50%)。
    // 纵向：CSS 已给 top:0;bottom:0，天然与条等高，无需干预。
    el.style.left = `${((index - 0.5) / total) * 100}%`;
    // 宽度：一格的宽（100/总句数 %），但最小 5px。用 `max()` 表达 —— 句数少时
    // 跟着格宽变宽（不设上限，用户明确要），句数多时垫到 5px 好点。
    // ⚠️ 必须用 max() 而不是先在 JS 里算 px 再写死：写成 px 后窗口拖宽变窄
    //    就不会跟着变（游标每次 refresh 会重摆，但回标/悬停段不刷新）。
    el.style.width = `max(${PROGRESS_MARK_MIN_PX}px, ${100 / total}%)`;
  }

  private refreshProgressBar(): void {
    const track = this.progressTrackEl;
    //⚠️ 只清**轨道**这一层，不能 `bar.empty()` 清整条：游标 / 悬停段是条里的
    //    长期节点（建一次复用），清整条会把它们连带摘掉，还得重建、易闪。
    track.empty();
    // 把整集按"学过/没学过"压成连续的色块：一句只有一两个像素宽，先合并再画
    const runs: { done: boolean; count: number }[] = [];
    for (const slice of this.slices) {
      const done = this.isComplete(slice);
      const last = runs[runs.length - 1];
      if (last && last.done === done) last.count += 1;
      else runs.push({ done, count: 1 });
    }
    for (const run of runs) {
      const segment = track.createDiv({ cls: run.done ? "yl-progress-run yl-progress-done" : "yl-progress-run" });
      segment.style.flexGrow = String(run.count);
    }
    const total = this.slices.length;
    // 游标挪到当前句；没有句子时藏起来（否则会停在 left:0 像个"第 0 句"）
    if (total > 0) {
      this.placeProgressMarkAt(this.progressCursorEl, this.index);
      this.progressCursorEl.show();
    } else {
      this.progressCursorEl.hide();
    }
    const doneCount = this.slices.filter((slice) => this.isComplete(slice)).length;
    this.progressLabelEl.setText(`已学 ${doneCount} / ${total} 句`);
  }

  // ── 目录（整集台词） ─────────────────────────────────────────────────────

  private openToc(): void {
    if (!this.item) return;
    const existing = this.contentEl.querySelector(".yl-toc-overlay");
    existing?.remove();

    const overlay = this.contentEl.createDiv({ cls: "yl-toc-overlay" });
    const panel = overlay.createDiv({ cls: "yl-toc-panel" });
    /*
     * 关闭收口（2026-10-09 用户拍板"关闭时快速向右缩回"）：加 is-closing 播
     * 滑出动画，transitionend + 定时兜底后再拆 DOM。三条关闭路径
     * （点遮罩 / 叉叉 / 点行跳句）全部走它，别再各自裸 remove。
     */
    let tocClosing = false;
    const closeToc = (): void => {
      if (tocClosing) return;
      tocClosing = true;
      overlay.addClass("is-closing");
      panel.addEventListener(
        "transitionend",
        (event) => {
          if (event.target === panel && event.propertyName === "transform") overlay.remove();
        },
        { once: true },
      );
      window.setTimeout(() => overlay.remove(), 200); // 兜底：transitionend 偶发不来
    };
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeToc();
    });
    /*
     * 头部一行三件事：标题 / 搜索框 / 关闭。
     *
     * 搜索框（2026-10-02 用户提）夹在中间，`flex: 1` 吃掉剩余宽度，
     * 关闭按钮天然留在最右（用户特意交代"叉叉放最右边"）。
     * 原来的"共 N 句"让位给搜索框，挪到底部跟"已学完"并成一句。
     */
    const header = panel.createDiv({ cls: "yl-toc-header" });
    header.createSpan({ cls: "yl-toc-title", text: "目录" });
    const search = header.createEl("input", {
      cls: "yl-toc-search",
      attr: {
        type: "text",
        placeholder: "搜台词，或输入秒数跳转",
        "aria-label": "搜索中日文台词，或输入秒数跳转",
      },
    });
    createButton(header, {
      shape: "icon",
      small: true,
      icon: "x",
      ariaLabel: "关闭",
      onClick: () => closeToc(),
    });

    const list = panel.createDiv({ cls: "yl-toc-list" });
    // 每行的可搜内容与时间点先收好：搜索时直接在这份账上算，不再回读 DOM
    const rows: { index: number; startMs: number; haystack: string; el: HTMLElement }[] = [];
    for (const slice of this.slices) {
      const done = this.isComplete(slice);
      const row = list.createDiv({
        cls: `yl-toc-item${slice.index === this.index ? " yl-toc-current" : ""}`,
      });
      row.setAttr("data-index", String(slice.index));
      // 目录里的时间按校准后的实际播放位置显示 —— 否则用户照着跳会跳错地方
      const startMs = effectiveWindow(slice, this.offsetMs).startMs;
      const timeText = fmtTs(startMs);
      row.createSpan({ cls: "yl-toc-time yl-tabular", text: timeText });
      const text = row.createDiv({ cls: "yl-toc-text" });
      // 目录与搜索也跟着用户改过的字幕走（否则改完字在目录里搜不到）
      text.createDiv({ cls: `yl-toc-ja${done ? " yl-toc-done" : ""}`, text: effectiveJa(slice) });
      const zh = effectiveZh(slice);
      if (zh) text.createDiv({ cls: "yl-toc-zh", text: zh });
      row.createSpan({ cls: "yl-toc-mark", text: slice.index === this.index ? "在学" : done ? "✓" : "" });
      row.addEventListener("click", () => {
        // 先换句（内容在遮罩底下换，不被动画拖慢），再播抽屉收起
        this.showSlice(slice.index);
        closeToc();
      });
      rows.push({
        index: slice.index,
        startMs,
        haystack: `${effectiveJa(slice)}\n${zh}\n${timeText}`.toLowerCase(),
        el: row,
      });
    }

    const empty = list.createDiv({ cls: "yl-toc-empty", text: "没有匹配的台词。" });
    empty.hide();

    const footer = panel.createDiv({ cls: "yl-toc-footer" });
    const doneCount = this.slices.filter((slice) => this.isComplete(slice)).length;
    const idleFooter = `共 ${this.slices.length} 句 · 已学完 ${doneCount} 句`;
    footer.setText(idleFooter);

    /*
     * 搜索的两种读法（同 parseTocQuery 的注释）：
     *
     *  · 数字 / 分:秒 → **时间戳定位**：不筛掉别的句子，把最接近的那一句滚到眼前圈一下。
     *    用户想的是"跳到 1:30 那块"，把列表筛成一行反而丢了上下文。
     *  · 其余 → **台词过滤**：中日文任一命中即留（`haystack` 里 ja 和 zh 都在），
     *    连时间戳文本也能搜（打 `0:07` 也会命中那句 —— 但那串先被判成时间戳，走上面那条）。
     */
    const applySearch = (): void => {
      const query = search.value.trim();
      for (const entry of rows) {
        entry.el.removeClass("yl-toc-hit");
        entry.el.show();
      }
      if (!query) {
        empty.hide();
        footer.setText(idleFooter);
        return;
      }
      const targetMs = parseTocQuery(query);
      if (targetMs != null) {
        empty.hide();
        const hitIndex = nearestIndexByTime(rows, targetMs);
        const hit = hitIndex == null ? undefined : rows.find((entry) => entry.index === hitIndex);
        if (!hit) return;
        hit.el.addClass("yl-toc-hit");
        hit.el.scrollIntoView({ block: "center" });
        footer.setText(`已跳到第 ${hit.index} 句（${fmtTs(hit.startMs)}）`);
        return;
      }
      const needle = query.toLowerCase();
      let hits = 0;
      for (const entry of rows) {
        const match = entry.haystack.includes(needle);
        entry.el.toggle(match);
        if (match) hits += 1;
      }
      empty.toggle(hits === 0);
      footer.setText(hits === 0 ? "没有匹配的台词。" : `匹配 ${hits} 句`);
    };
    search.addEventListener("input", applySearch);
    // 打开目录就能直接打关键词，不用先点一下输入框。
    // ⚠️ preventScroll 必须给（2026-10-09 用户报"点目录页面主体跟着动"）：
    // focus 时 panel 还在滑入途中（translateX(100%) 视口外），浏览器会滚
    // 最近滚动容器去追焦点元素 → 主体被横向拽走。只聚焦、不滚动。
    window.setTimeout(() => search.focus({ preventScroll: true }), 0);

    // 滑入：先让 translateX(100%) 的初态生效（强制回流），再加 is-open 播过渡
    void panel.offsetWidth;
    overlay.addClass("is-open");
    panel.addClass("is-open");
  }

  // ── 三步的落库 ───────────────────────────────────────────────────────────

  private currentSlice(): StudySentence | null {
    return this.slices[this.index - 1] ?? null;
  }

  /**
   * 按 cid 取切片。核对/提交是出网或至少异步的，回包时视图可能已经换句 ——
   * 落库必须认**发起时**那句（卡片传上来的 cid），不认回包时刻的当前句。
   * 2026-10-07 起三步卡全部走这里：以前「检查」的时机归自动流程，翻句竞态
   * 窗口小；现在时机归人，点完检查再去翻句是正常操作，不能把 A 句的结果
   * 记到 B 句头上。
   */
  private sliceByCid(sliceCid: string): StudySentence | null {
    return this.slices.find((slice) => slice.cid === sliceCid) ?? null;
  }

  /** 每一步落库之后的统一收尾。 */
  private async afterProgress(slice: StudySentence, row: ProgressRow): Promise<void> {
    this.progressRows.set(slice.cid, row);
    this.refreshSteps(slice);
    this.refreshProgressBar();
    if (this.nextButton) {
      setButtonRole(this.nextButton, row.completedAt != null ? "primary" : "default");
    }
  }

  /**
   * 「有没有充值过」—— **只看余额**（2026-10-02 用户拍板：只有一条钱，
   * 会员/订阅制已取消，判据就是 `ai_balance_millis > 0`）。
   * 只用来决定跟读提示行里"这次核对用哪种检查"的说明（AI 逐词核对 / 本地检查）。
   */
  private canUseAiReadAloud(): boolean {
    return this.plugin.settings.aiBalanceMillis > 0;
  }

  /**
   * 跟读记一笔。两条核对路径（本地 / 服务端）共用同一条落库口。
   *
   * `verified` 分的就是这两条：AI 逐词全对 = true（卡片说「正解」），
   * 本地只查有没有出声 / 无麦「标记完成」= false（卡片说「已完成」）。
   */
  private async markReadAloudDone(
    slice: StudySentence,
    seconds: number | null,
    verified: boolean,
  ): Promise<void> {
    await this.afterProgress(slice, await recordReadAloud(this.db, slice, seconds, verified));
  }

  /**
   * 本地核对（未充值用户，或已充值但这一句分不出词时降级走这里）。
   *
   * 只有一条判据：**有没有出声**。有声音就算通过，然后在卡片上说清"我们评估不了
   * 发音、想评估可以用内置模型"——那句话里「内置模型」是可点的（虚线），点了才问
   * 「现在配置吗」，界面不自动跳（与「充值」那条同口径）。
   */
  private async localReadAloudCheck(slice: StudySentence, payload: {
    blob: Blob;
    seconds: number;
  }): Promise<ReadVerifyOutcome> {
    const local = await checkRecordingLocally(payload.blob);
    if (!local.ok) return { status: "wrong", message: local.reason };
    await this.markReadAloudDone(slice, payload.seconds, false);
    return {
      status: "ok",
      // 没人判过发音 —— 这不算「正解」，只算「完成」（见 ReadVerifyOutcome.ok.verified）
      verified: false,
      message: LOCAL_OK_MESSAGE,
      link: { keyword: LOCAL_OK_LINK, onClick: () => this.promptHostedModelSetup() },
    };
  }

  /**
   * 跟读的核对。点「检查」才走这里（2026-10-07 用户拍板：不再录完自动核对，
   * 推翻 2026-10-04 的「录完即核对」）—— 有录音不等于过，读得准不准由这一遍
   * 核对说了算；核对可以反复点：没查成（网络/服务商抖动）再点一次就是重试，
   * 读错的重录一遍。
   *
   * 落库认 `sliceCid`（发起检查时绑定的那句），不认回包时刻的当前句 ——
   * 检查的时机归人，点完检查去翻句是正常操作（见 sliceByCid）。
   *
   * 两条路按充值状态分：
   *  · 未充值 → 本地核对：有声音就算过，另外告诉他想评估发音要用内置模型；
   *  · 已充值 → 送服务端逐词核对，原句上按词标绿/标红。
   *
   * ⚠️ 只有"确定读错"才判 wrong：拿不准的一律放行（见 readAloudCheck.ts 文件头）。
   * 全对时**撤掉所有颜色**（保留默认色），不是标一整句绿。
   */
  private async handleVerifyReadAloud(sliceCid: string, payload: {
    blob: Blob;
    mimeType: string;
    seconds: number;
  }): Promise<ReadVerifyOutcome> {
    const slice = this.sliceByCid(sliceCid);
    if (!slice) return { status: "error", message: "这一句已经不在了，换一句再试。" };
    const referenceMs = Math.max(0, slice.endMs - slice.startMs);

    // ── 一、未充值：本地核对（只查有没有出声，见 readAloudCheck.ts 文件头） ──
    if (!this.canUseAiReadAloud()) {
      // 缓存说没充值也先向服务器核实一次（充值在网页端完成，缓存可能只是旧的）；
      // 服务器也确认没钱才降级本地检查，别让充了值的人一直拿不到逐词核对。
      await this.plugin.refreshAccountProfile(true);
      if (!this.canUseAiReadAloud()) {
        return this.localReadAloudCheck(slice, payload);
      }
    }

    // ── 二、已充值：送服务端逐词核对 ───────────────────────────────────
    // 词表来自本机分词。分不出词（本机词典没装）时降级成本地检查 ——
    // 那种情况至少还能过，别把人卡死在这一句上。
    // 读音走注音同款三层来源（sliceReadings）：顶部注音标 はるひかげ、核对也得
    // 按はるひかげ 判 —— 参考文本（kana）和词表 reading 与注音同口径，
    // 不然展示一个读音、检查按另一个读音判，就是自相矛盾。
    const readings = this.sliceReadings(slice, this.currentTokens);
    const words = this.currentTokens.map((token, index) => ({
      index,
      surface: token.surface,
      reading: readings[index],
    }));
    if (!words.length) {
      return this.localReadAloudCheck(slice, payload);
    }
    // 整句假名读音 = 服务端评估的参考文本（2026-10-07 改口径）：汉字参考下
    // Azure 按自家词典定读音，春日影→はるひかげ 这类特读会被判错。读音给不出的
    // 汉字词拿词面顶上占位，别让参考文本整段错位。
    const kana = this.currentTokens
      .map((token, index) => readings[index] || token.surface)
      .join("");

    try {
      const verdict = await requestReadAloudCheck(this.plugin.settings, {
        ja: effectiveJa(slice),
        kana,
        words,
        audio: payload.blob,
        mimeType: payload.mimeType,
        seconds: payload.seconds,
        referenceMs,
      });
      if (!verdict.allCorrect) {
        this.paintReadAloud(verdict.marks);
        return { status: "wrong", message: "原句上标红的词读得不太准，重录一遍再试试。" };
      }
      this.clearReadAloudPaint();
      await this.markReadAloudDone(slice, payload.seconds, true);
      // 全对后的灰字按逐词最低分给三档夸奖（2026-10-11 拍板）：
      // ≥0.9 最高档、≥0.7 次档、其余默认 —— 档位判定在 readAloudPraise 里
      return { status: "ok", verified: true, message: readAloudPraise(verdict.minScore) };
    } catch (error) {
      // 余额不够 / 没登录 / 连不上 —— 都是"这次没核对成"，**不是**"读错了"。
      // 没余额那档 message 留空 = 弹窗已接管，卡片不再就地摆余额提示。
      if (isNoBalanceError(error)) {
        this.handleOutOfBalance();
        return { status: "error", message: "" };
      }
      const message =
        // 检查是用户点的，录音还摆在卡上 —— 重试就是再点一次「检查」（2026-10-07）
        error instanceof AiUnavailableError ? error.message : "核对没跑起来，再点一次「检查」试试。";
      return { status: "error", message };
    }
  }

  /**
   * 原句上按词标色：读对绿、读错红。
   *
   * 只标服务端**回了对账通过**的词（surface 与本地分词一致），
   * 其余一律不标 —— 标错位比不标更坑。
   */
  private paintReadAloud(marks: Map<number, boolean>): void {
    this.clearReadAloudPaint();
    if (!this.heroJaEl) return;
    this.heroJaEl.querySelectorAll<HTMLElement>("[data-token-index]").forEach((span) => {
      const index = Number(span.getAttr("data-token-index"));
      const correct = marks.get(index);
      if (correct === true) span.addClass("yl-read-ok");
      else if (correct === false) span.addClass("yl-read-bad");
    });
  }

  /** 撤掉原句上的核对颜色（换句、重读、全对时都走这里） */
  private clearReadAloudPaint(): void {
    if (!this.heroJaEl) return;
    this.heroJaEl
      .querySelectorAll<HTMLElement>("[data-token-index]")
      .forEach((span) => span.removeClass("yl-read-ok", "yl-read-bad"));
  }

  private async handleManualConfirm(sliceCid: string): Promise<void> {
    const slice = this.sliceByCid(sliceCid);
    if (!slice) return;
    // 无麦克风的逃生舱：压根没检查，所以是「已完成」而不是「正解」
    await this.afterProgress(slice, await recordReadAloud(this.db, slice, null, false));
  }

  private async handleSubmitCopy(
    typed: string,
    sliceCid: string,
  ): Promise<{ result: CopyResult; progress: ProgressRow }> {
    const slice = this.sliceByCid(sliceCid);
    if (!slice) throw new Error("这一句已经不在了");
    const result = await compareCopy(effectiveJa(slice), typed, this.copyTokenizer());
    const row = await submitCopy(this.db, slice, { text: typed, passed: result.ok });
    await this.afterProgress(slice, row);
    return { result, progress: row };
  }

  /**
   * 「重置」：把这一步**完全恢复初始**（2026-10-04 用户拍板）—— 完成标记、
   * 留档、尝试次数全清。跟读比另外两步多两件事：删掉本地存的录音、撤掉
   * 原句上的逐词标色 —— 那份录音属于被清掉的记录，留着就成了
   * "没读过却有录音"的怪状态。抄写/仿写还要删掉自动保存的草稿（studyDrafts）——
   * 重置要的是"回到没敲过"，敲了一半的字留着就成了"重置不干净"。
   */
  private async handleReset(step: "read" | "copy" | "imitation"): Promise<ProgressRow> {
    const slice = this.currentSlice();
    if (!slice) throw new Error("没有当前句子");
    if (step === "read") {
      await deleteRecording(this.db, slice.cid);
      this.clearReadAloudPaint();
    } else {
      await saveDraft(this.db, step, slice.cid, "");
    }
    const row = await resetPracticeRecord(this.db, slice, step);
    await this.afterProgress(slice, row);
    return row;
  }

  // ── 单词解析（本地分词 + 可选 AI 释义） ─────────────────────────────────

  /** 本机词典路径（懒解析一次）。拿不到说明发布包缺 `dict/`。 */
  private dictPath(): string | null {
    if (this.dictPathCache === undefined) {
      this.dictPathCache = resolveDictPath(this.app, this.plugin.manifest.id);
    }
    return this.dictPathCache;
  }

  // ── 词典引导（2026-10-11 用户拍板：只在两处，别再加第三处）──────────────
  //  ① 第一次进学习页 —— 一天到晚弹就成骚扰，所以一辈子只弹一次（settings 记标记）；
  //  ② 之后每次点抄写卡的「提示」—— 那是用户主动要读音的那一刻，动机最强。
  // 其余位置（原句注音位、个人中心）**刻意不放**：那里发现性差，且会把页面变脏。

  /** 词典要装到哪：`<插件目录>/dict`。拿不到文件系统（移动端）返回 null。 */
  private dictInstallDir(): string | null {
    return pluginDirPath(this.app, this.plugin.manifest.id);
  }

  /**
   * ① 第一次进学习页：词典没装上就提醒一次。
   *
   * 老用户（软链装法 / 自己装过）本来就有词典 —— 先判磁盘，有就**只补标记不弹窗**，
   * 免得给已经用得好好的用户弹一个"请安装词典"。
   */
  private async promptDictInstallIfFirstRun(): Promise<void> {
    if (this.plugin.settings.dictPromptSeen) return;
    const dir = this.dictInstallDir();
    if (!dir || isDictInstalled(dir) || this.dictPath()) {
      this.plugin.settings.dictPromptSeen = true;
      void this.plugin.saveSettings();
      return;
    }
    await this.promptDictInstall("first-run");
  }

  /**
   * 弹「安装日语词典」窗。
   *
   * 开窗前先取服务端清单：拿不到清单这个窗就没有能做的事（主按钮点下去只会失败），
   * 那种情况下只给一条提示，别摆一个点了没用的窗。
   *
   * `first-run` 那条路在**决定弹之后**就记标记（它只该出现一次）；网络那次失败
   * 不算"出现过"，下次进来还会试。`hint` 那条路不记 —— 它本来就该每次都提醒。
   */
  private async promptDictInstall(reason: "first-run" | "hint"): Promise<void> {
    const dir = this.dictInstallDir();
    if (!dir) return;
    if (isDictInstalled(dir)) {
      this.onDictInstalled();
      return;
    }
    const manifest = await fetchDictManifest(this.plugin.settings.serverUrl);
    if (!manifest) {
      new Notice("词典下载地址连不上，稍后再试一次。", 8000);
      return;
    }
    if (reason === "first-run") {
      this.plugin.settings.dictPromptSeen = true;
      void this.plugin.saveSettings();
    }
    const fromHint = reason === "hint";
    new DictInstallModal(this.app, {
      manifest,
      pluginDir: dir,
      reason,
      onInstalled: () => {
        this.onDictInstalled();
        // 用户是在"要罗马音"的那一刻被拦下来的 —— 装完直接把那行补上，
        // 让他再点一次「提示」是把刚做完的事退回去。
        if (fromHint) this.copyPractice.showRomaji();
      },
    }).open();
  }

  /**
   * 词典装好了 —— **就地生效**，不用重载插件。
   *
   * 两件必须做的事：
   *  · 🔥 清掉 `dictPathCache`（里面很可能正缓存着 **null** —— 装之前查过一次）；
   *  · 重跑当前这一句的分词：`currentTokens` 是"送哪些词进 AI"的底账，词典没装时
   *    它是空的，不清算的话用户装完词典去点「AI 解析」仍然是空词表。
   *    顺带把原句注音补上（`loadHeroReading`）。
   * （分词器那边缓存的正是失败态，下次调用会自己重试，见 jaTokenize。）
   */
  private onDictInstalled(): void {
    this.dictPathCache = undefined;
    if (this.mode !== "card") return;
    const slice = this.currentSlice();
    if (!slice) return;
    void this.loadHeroReading(slice);
    void this.renderAnalysis(slice);
  }

  /**
   * 抄写判定用的分词口子。
   * 词典没装上时返回 null：判定退回字面层（敲错照样标红），只是少了
   * 「读音对、写法用了别的也算过」这一层 —— 不能因此把核对整个挡住。
   */
  private copyTokenizer(): CopyTokenize | null {
    const dict = this.dictPath();
    if (!dict) return null;
    return (text: string) => tokenize(dict, text);
  }

  /**
   * 整句逐词读音：三层来源与原句注音同款 —— **用户纠过的注音**（readingFixes）
   * > 这句 **AI 解析过**的句内读音（人名、缩约、连浊它比词典准，且已落库不再
   * 花钱）> 本机词典。跟读核对（参考文本 kana + 词表 reading）和抄写提示都从
   * 这来：展示什么读音、就按什么读音核对，两处各说各话就是自相矛盾。
   * 汉字词读音缺失留空 —— 抄写提示把它跳过；跟读那路拿词面占位（见
   * handleVerifyReadAloud），别拿字面冒充读音。
   */
  private sliceReadings(slice: StudySentence, tokens: Token[]): string[] {
    const aiReadings = slice.analysis?.done
      ? matchAiReadings(
          tokens,
          slice.analysis.tokens.map((token) => ({ surface: token.surface, reading: token.aiReading ?? "" })),
        )
      : [];
    const fixes = slice.readingFixes ?? {};
    return tokens.map((token, index) => {
      const fix = fixes[String(index)];
      // surface 对不上（分词口径变了）的纠错自动失效，回默认读音
      if (fix && fix.surface === token.surface) return fix.reading;
      return aiReadings[index] || token.reading || (KANJI_RE.test(token.surface) ? "" : token.surface);
    });
  }

  /**
   * 抄写「提示」的罗马音：本地分词拼出来，不发请求也不花钱。
   *
   * 口径是 **IME 键序**（kanaToRomaji 的 typing 模式）——提示是拿来照着敲的，
   * 敲出来的假名必须和目标一致（を 是 wo，注音 o 留在解析区）。
   * 读音走 sliceReadings 的三层来源（纠音 > AI 解析 > 词典），与原句注音、
   * 跟读核对同口径。提示永远不主动触发 AI，花钱的动作只有「AI 解析」按钮。
   */
  private async copyRomaji(slice: StudySentence): Promise<string> {
    const dict = this.dictPath();
    if (!dict) return "";
    const tokens = await tokenize(dict, effectiveJa(slice));
    const readings = this.sliceReadings(slice, tokens);
    // 🔥 必须整串一起转（romajiTokens），不能逐词各调一次 kanaToRomaji：
    // kuromoji 把「やった」切成 やっ + た，单转的话 っ 在词尾取不到下一个音，
    // 双写丢失成 yata —— 照着敲出来是 やた，提示反而把人教错。
    // 只传读音不传词性 —— typing 口径要的就是键序，助词 は 也得敲 ha。
    return romajiTokens(
      readings.map((reading) => ({ reading })),
      "typing",
    )
      .filter(Boolean)
      .join(" ");
  }

  private async renderAnalysis(slice: StudySentence): Promise<void> {
    // 换句就掐掉上一句还在跑的流式解读：那份解读已经没有观众了，
    // 让它跑完只是替用户继续花钱（中断时服务端也不会扣费）
    if (this.explainStreamCid && this.explainStreamCid !== slice.cid) {
      this.abortExplainStream();
    }
    this.analysis.load(slice);
    this.currentTokens = [];
    const dict = this.dictPath();
    if (!dict) {
      this.analysis.showUnavailable("本机词典没装上（插件目录缺 dict/），换完整发布包就能恢复。");
      return;
    }
    const tokens = await tokenize(dict, effectiveJa(slice));
    // 分词是异步的，回来时用户可能已经翻到下一句了 —— 过期结果直接丢
    if (this.currentSlice()?.cid !== slice.cid) return;
    this.currentTokens = tokens;
    this.analysis.showTokens(tokens, tokens.length === 0 ? "这一句没能分出词来。" : undefined);

    // 开卡埋点：这些词现在正摆在用户眼前，各记一次曝光（同一句只记一次，
    // 见 services/words.ts）。熟练度是看板的输入，但**绝不能挡住渲染** ——
    // 记不下来顶多是熟练度少涨一点，卡住就是整张卡打不开。
    await recordWordExposure(this.db, slice.cid, tokens).catch((error: unknown) => {
      log.warn("记单词曝光失败", error);
    });

    // 🔥 本机已经解析过这一句：直接把上次的结果铺开，**不再发请求**
    // （也就不会再扣一次钱）。这条路径同时兜住了"翻走再翻回来"。
    if (slice.analysis?.done && slice.analysis.engine === ANALYSIS_ENGINE) {
      this.analysis.showCached(slice.analysis);
      this.feedAssistant(slice.analysis);
    }
  }

  /**
   * 把已讲过的解析喂给助手 —— 用户追问时不用再复述"这句在讲什么"。
   * 实时解析出来的那份和从缓存读出来的那份都走这里。
   *
   * 解读在这儿是**拼成一段纯文本**再给出去的（`renderExplanation`）：助手那边
   * 只需要"已经讲过什么"，不需要知道分段的形状 —— 服务端 `ask_context_prompt`
   * 也只认这个字符串字段。
   */
  private feedAssistant(analysis: SentenceAnalysis): void {
    this.assistant.setContext({
      analysis: {
        translation: analysis.translation ?? "",
        words: analysis.tokens
          .filter((token) => token.def)
          .map((token) => ({ surface: token.surface, meaning: token.def ?? "" })),
        explanation: renderExplanation(analysis.explanation),
      },
    });
  }

  /**
   * 解析要带的语境：作品名 + 这句在字幕里的前后句（原文，没有就空串）。
   * 有的番剧/视频有专属词汇或行话，光看单句模型断不出来；但解析对象始终是
   * 中间那一句，语境只是参考（口径写在 ANALYZE_SYSTEM 里）。
   * 按 cid 找下标而不是用 this.index：笔记补记的句子可能不是当前正在看的那句。
   */
  private explainContextFor(slice: StudySentence): { work: string; prevJa: string; nextJa: string } {
    const index = this.slices.findIndex((row) => row.cid === slice.cid);
    return {
      work: (this.item?.record.title ?? "").trim(),
      prevJa: index > 0 ? effectiveJa(this.slices[index - 1]) : "",
      nextJa: index >= 0 && index + 1 < this.slices.length ? effectiveJa(this.slices[index + 1]) : "",
    };
  }

  /**
   * 点「AI 解析」→ **两块并行发出**（2026-10-08 用户拍板）。
   *
   * 第一块是解读，**真流式**：模型每吐一段就上屏一段（不再是"等整份回来再
   * 打字机重放"）；第二块是逐词释义（句子卡上的点词弹卡），**与解读同时发出**
   * —— 两块是同一句的两个独立问题，服务端的并发锁按块分道，互不阻塞。词表
   * 因此更早到，句子卡更早点亮。
   *
   * 第二块失败**只重试它自己**（用户定的口径），解读照常留着 ——
   * 没必要为了词表把已经看到的东西清掉。两块都成功才落库：只落一半的话，
   * 翻回这句会显示成"解析过了"，但词点不开。
   *
   * 🔥 整个过程里句子卡的日文**压灰**（2026-10-07 用户拍板"解析完成之前文字偏灰，
   * 解析完成之后才变成现在这种深色"）：从点下按钮到两块都落地是一段看不见的等待，
   * 压灰就是"上面那张卡正在变"。⚠️ **每条出口都要清掉**（失败 / 翻页 / 拿不到词表），
   * 漏一条就会把灰永久留在卡上。
   *
   * `refresh` = 这次是「重新解析」触发的（见 `reparseExplanation`）：只影响左侧
   * 解读那块要不要让服务端**跳过缓存**重算，两块并发的骨架不变。
   */
  private async handleExplain(words: string[], refresh = false): Promise<void> {
    const slice = this.currentSlice();
    if (!slice) return;
    const settings = this.plugin.settings;
    // 纠错句：日文被用户改过（textFixes.ja 有值）→ 解析走私有缓存，登记原片三句 hash
    const corrected = Boolean(slice.textFixes?.ja?.trim());
    const input = {
      ja: effectiveJa(slice),
      zh: effectiveZh(slice),
      words,
      ...this.explainContextFor(slice),
      corrected,
      originHash: corrected ? slice.cid.slice(2) : undefined,
    };

    // 连点「重新解析」时先掐掉上一路 —— 两条流同时往同一块 DOM 写字是乱的
    this.abortExplainStream();
    const controller = new AbortController();
    this.explainAbort = controller;
    this.explainStreamCid = slice.cid;

    // 从这一刻起压灰，直到两块都到齐（或明确失败）—— 见下方每条 return 前的清态
    this.setHeroWordsPending(true);
    this.analysis.beginStream();

    // 逐词释义**同时**发出：它不显示成文字，没必要等解读（词表早到早点亮句子卡）
    const wordsTask = this.fetchWords(input, slice, settings);

    // ── 第一块：解读（流式）。边生成边上屏，不等词表 ────────────────────
    const streamed = await this.streamExplanation(input, settings, controller, slice, refresh);
    if (streamed.aborted) return; // 翻页了 / 用户掐了 / 余额窗已经弹了
    if (streamed.partial) {
      // 已经有字上屏、流却断了：留着已显示的部分，只说这次没生成完
      this.analysis.streamFailed(streamed.errorMessage);
      this.setHeroWordsPending(false);
      return;
    }
    this.analysis.showExplanation(streamed.explanation, streamed.errorMessage);
    if (!streamed.explanation) {
      // 解析成功但没给回可用的解读：别把灰留在卡上
      this.setHeroWordsPending(false);
      return; // 提示已由 showExplanation 给出
    }
    // 讲过的东西喂给助手（这一刻还没有词表，词到了会再喂一次）
    this.assistant.setContext({
      analysis: {
        translation: streamed.explanation.translation,
        words: [],
        explanation: renderExplanation(streamed.explanation.sections),
      },
    });

    // ── 第二块：逐词释义（早在路上跑着，这里只是收口）──────────────────
    const wordList = await wordsTask;
    if (this.currentSlice()?.cid !== slice.cid) {
      // 用户已经翻走：别去动现在这张卡的日文颜色，也別闪
      this.setHeroWordsPending(false);
      return;
    }
    if (!wordList) {
      this.setHeroWordsPending(false);
      return; // fetchWords 已经如实报过了
    }

    // 存下来。⚠️ 存失败不弹错：结果是好的，用户已经在看了，
    // 大不了下次再点一次 —— 为了"留档"把这次成功变成失败是划不来的。
    await this.persistAnalysis(slice, streamed.explanation, wordList).catch((error: unknown) => {
      log.warn("解析结果没能存进本地库", error);
    });
    this.analysis.wordsReady();
    // AI 的句内读音刚落库：原句区的 ruby / 注音行按新读音重铺一遍
    // （此前铺的是词典注音；loadHeroReading 里有 cid 守卫，翻走了就静默丢弃）。
    // 重铺顺带带上 `.yl-analyzed`（青蓝）与可点词数据，所以等它铺完再闪。
    await this.loadHeroReading(slice);
    if (this.currentSlice()?.cid !== slice.cid) return;
    this.setHeroWordsPending(false);
    this.flashHero();
  }

  /**
   * 「重新解析」= 只重算**左侧的解读那一块**（2026-10-08 用户拍板）。
   *
   * 右侧句子卡（逐词释义 / 句内读音 / 词源 / 可点词）**不重新解析**：那些东西没有变，
   * 再跑一遍等于让用户为同一份词表再付一次钱，卡片还会重铺一次、闪一下。所以这条路
   * **不发 words 请求、不压灰、不重铺读音、不闪卡**，只管左边那段文字。
   *
   * 与 `handleExplain` 的分工：共用同一个流式出口（`streamExplanation`）—— 两条路
   * 各写一份解析逻辑，必然有一处先腐坏；差别只在"要不要第二块"和"落库怎么合"。
   *
   * 🔥 与首次解析**唯一的实质差别**是 `refresh=true`：让服务端**跳过解析缓存**
   * 重算这一块，并把新结果覆盖写回缓存（之后谁命中这一句拿到的都是新那版）。
   * 不带它的话，服务端无条件回缓存里那一份 —— 用户点的"重新解析"看上去就是
   * 按了没反应（2026-10-08 实机报的）。这层意思**只在内置模型那条路上存在**；
   * BYOK 本来每次都真调用户自己的端点，`refresh` 到不了界面上任何地方。
   *
   * 唯一的例外见正文第一条注释：这一句还没有落档记录时按首次解析走（两块一起，
   * **左侧照样带 `refresh`**）。
   */
  private async reparseExplanation(): Promise<void> {
    const slice = this.currentSlice();
    if (!slice) return;
    const settings = this.plugin.settings;
    const corrected = Boolean(slice.textFixes?.ja?.trim());
    const input = {
      ja: effectiveJa(slice),
      zh: effectiveZh(slice),
      // 词表仍要带上：它只是解读提示词里的【本句分词参考】，不发第二次请求
      words: explainTargets(this.currentTokens),
      ...this.explainContextFor(slice),
      corrected,
      originHash: corrected ? slice.cid.slice(2) : undefined,
    };

    // ⚠️ 例外一条（别删）：这一句**还没有落档的解析记录**时（上一遍两块里词表那块
    // 失败过），左侧解读没有可合并的宿主 —— 只重算左边等于"这次解析留不下来、卡片也
    // 永远亮不起来"，用户反复点却什么都不会变。这种时候退回"两块一起"的老路。
    // 这不是"重新解析右侧"：右侧本来就没有东西可解析，这是它的**第一次**解析。
    if (!slice.analysis?.done || slice.analysis.engine !== ANALYSIS_ENGINE) {
      log.info("[yl-reparse] 这一句还没有落档记录，按首次解析走（两块一起）", { cid: slice.cid });
      await this.handleExplain(input.words, true);
      return;
    }

    // 连点「重新解析」先掐掉上一路 —— 两条流同时往同一块 DOM 写字是乱的
    this.abortExplainStream();
    const controller = new AbortController();
    this.explainAbort = controller;
    this.explainStreamCid = slice.cid;

    // ⚠️ 这里**不压灰**：句子卡不参与这次解析 —— 压灰会让用户以为上面那张卡也在变
    //（它不会变）。
    this.analysis.beginStream();

    // 🔥 `refresh=true` 是这条链路的**全部意义**：不带它，服务端照旧回解析缓存里
    // 那一份，用户点的"重新解析"看上去就是没反应（2026-10-08 实机报的）。
    // 带上之后服务端跳过缓存重算，并把新结果覆盖写回缓存 —— 最新的一条为准。
    const streamed = await this.streamExplanation(input, settings, controller, slice, true);
    if (streamed.aborted) return;
    if (streamed.partial) {
      // 已有字上屏、流却断了：留着已显示的部分，只说这次没生成完
      this.analysis.streamFailed(streamed.errorMessage);
      return;
    }
    this.analysis.showExplanation(streamed.explanation, streamed.errorMessage);
    if (!streamed.explanation) return; // 提示已由 showExplanation 给出

    // 讲的还是这一句，只是解读换了：把新解读并进已有的那份记录（词表原样保留），
    // 再把**整份**喂给助手 —— 助手要的是"已经讲过什么"，只喂解读那一半等于把
    // 词表从它脑子里抹掉（上面已经确认过这份记录可合并，正常不会走到 null；
    // 真走到就什么都不动，别拿半份去覆盖它已有的上下文）。
    const merged = await this.mergeExplanation(slice, streamed.explanation);
    if (merged) this.feedAssistant(merged);
    this.analysis.explanationRefreshed(Boolean(merged?.tokens.length));
  }

  /**
   * 重新解析的落库：把新解读**就地合并**进这一句已有的解析记录。
   *
   * 句子卡那份（词表 / 句内读音 / 词源）**原样保留** —— 这次压根没重新解析它们，
   * 覆盖或清空都等于把用户已经拿到的东西弄丢。
   *
   * ⚠️ 这一句还没有可合并的记录时（上一遍两块里词表那块失败过）**绝不落库**：
   * 落一条没有词表的记录，翻回来会显示成"解析过了"但词点不开、卡片也不亮 ——
   * 那正是 `persistAnalysis` 那条"两块齐了才落库"的规矩要防的东西，别在这儿绕开它。
   * 这种情况下界面上的解读照旧更新（用户看得到这次解析的结果），只是不留档。
   *
   * @returns 合并后的那份；没有可合并的记录时返回 null
   */
  private async mergeExplanation(
    slice: StudySentence,
    explanation: SentenceExplanation,
  ): Promise<SentenceAnalysis | null> {
    const previous = slice.analysis;
    if (!previous?.done || previous.engine !== ANALYSIS_ENGINE) {
      log.warn("[yl-reparse] 这一句还没有可合并的解析记录，只更新界面、不落库", {
        cid: slice.cid,
      });
      return null;
    }
    // 词表、读音、词源、missingDefinitions 全部沿用 previous（`...previous` 就是
    // 这个意思）—— 只换解读与译文。romaji 也不动：它由本地分词拼出来，与这次无关。
    const merged: SentenceAnalysis = {
      ...previous,
      engine: ANALYSIS_ENGINE,
      text: effectiveJa(slice),
      explanation: explanation.sections,
      translation: explanation.translation,
    };
    // 内存里那份先换上；落库失败只该影响"下次翻回来"，不该让这次的结果白给
    slice.analysis = merged;
    await saveSliceAnalysis(this.db, slice, merged).catch((error: unknown) => {
      log.warn("重新解析的结果没能存进本地库", error);
    });
    // 解析落库即刷新笔记（与首次解析同一条口径）
    return merged;
  }

  /**
   * 「重新解析」的确认出口 —— 解析区弹统一弹窗问一句，**用户点了确认才再花一次**。
   *
   * 为什么不在解析区里直接问（2026-10-08 用户拍板）：得按**实际生效的轨道**说话。
   * "扣谁的"这层判断（`resolveAiRoute`，双轨自由选后即用户选的那条）只在视图
   * 这层拿得到；解析区只负责"问"，不猜钱的事。
   *
   * 确认 = 走 `reparseExplanation`（**只重算左侧解读那一块**，2026-10-08 用户拍板）。
   * 别在这儿另写一条解析路径，也别回到 `handleExplain` —— 前者必然与流式出口腐开，
   * 后者会把句子卡那一块一起重算（多花一次词表的钱）。
   */
  private confirmReparse(): void {
    const slice = this.currentSlice();
    log.info("[yl-reparse] 弹确认窗", { cid: slice?.cid ?? null, mode: this.mode, tokens: this.currentTokens.length });
    new ReparseConfirmModal(this.app, {
      // 建窗这一刻的实际轨道（不是 settings.aiMode 的原值）：文案说错比不说更糟
      aiMode: resolveAiRoute(this.plugin.settings),
      onConfirm: () => {
        // 弹窗开着的时候用户可能翻页 / 关视图了：那这一下不该再落到别人身上。
        // 词表在这里现算一次，只为两件事：判断"这一句有没有词可送给模型"、
        // 留一条可查的日志。真正的词表解析（第二块请求）在 `reparseExplanation`
        // 里根本不会发生 —— 它的底账是 `currentTokens`（本机分词），不是 API 回的。
        if (this.mode !== "card" || !this.currentSlice()) {
          log.warn("[yl-reparse] 确认时已经不在这一句上，丢弃", { mode: this.mode });
          return;
        }
        const words = explainTargets(this.currentTokens);
        // ⚠️ 这里**不能静静 return**（2026-10-08 用户报"点了重新解析没反应"）：
        // 发不出去就必须说出来，否则界面零反馈 —— 用户只能反复点，看不出任何变化。
        if (words.length === 0) {
          log.warn("[yl-reparse] 这一句没有可解析的词，不发请求");
          this.analysis.wordsFailed("这一句没能分出词来，没法重新解析。");
          return;
        }
        log.info("[yl-reparse] 确认，发请求", { cid: this.currentSlice()?.cid ?? null, words: words.length });
        void this.reparseExplanation();
      },
    }).open();
  }

  /**
   * 解读这一块：**流式**取，取不到就退回非流式。
   *
   * 三条路要分清楚：
   *   · 正常：边生成边 `pushFields` 上屏，最后以整份解析结果为准收口；
   *   · 已经有字上屏、流却断了：如实说"这次没生成完"（`partial`），**不推倒
   *     重来** —— 重来等于再花一次钱，而且用户已经看到的内容会跳一下；
   *   · 一个字都没到就失败：退回一次非流式请求。老服务端 / 中间网关不认 SSE
   *     时这条退路就是"流式坏了也能用"与"整个功能不可用"的差别。
   *
   * ⚠️ `refresh` 要**两条出口都带**（流式 + 非流式退路）：这条退路存在的意义是
   * "流式坏了也能用"，漏传它就变成"流式一坏，重新解析又回去读缓存"—— 那正是
   * 用户报的那个 bug，只是换了个触发条件。
   */
  private async streamExplanation(
    input: ExplainInput,
    settings: PluginSettings,
    controller: AbortController,
    slice: StudySentence,
    refresh = false,
  ): Promise<
    | { aborted: true }
    | { aborted: false; partial: boolean; explanation: SentenceExplanation | null; errorMessage: string }
  > {
    const stale = (): boolean =>
      controller.signal.aborted || this.currentSlice()?.cid !== slice.cid;
    let arrived = false;

    try {
      const { explanation } = await explainSentenceStream(
        input,
        settings,
        (fields) => {
          if (stale()) return;
          if (fields.translation || Object.keys(fields.sections).length > 0) arrived = true;
          this.analysis.pushFields(fields);
        },
        controller.signal,
        { refresh },
      );
      return { aborted: false, partial: false, explanation, errorMessage: "" };
    } catch (error) {
      // 自己掐的（翻页 / 关视图）：静默，别给已经不在这一句上的人摆错误
      if (stale()) return { aborted: true };
      if (isNoBalanceError(error)) {
        this.setHeroWordsPending(false);
        this.handleOutOfBalance();
        return { aborted: true };
      }
      if (arrived) {
        return { aborted: false, partial: true, explanation: null, errorMessage: this.aiMessage(error) };
      }
      try {
        const explanation = await explainSentence(input, settings, { refresh });
        return { aborted: false, partial: false, explanation, errorMessage: "" };
      } catch (retryError) {
        if (isNoBalanceError(retryError)) {
          this.setHeroWordsPending(false);
          this.handleOutOfBalance();
          return { aborted: true };
        }
        return {
          aborted: false, partial: false,
          explanation: null, errorMessage: this.aiMessage(retryError),
        };
      }
    }
  }

  /** 中断在开的流式解读（翻页 / 关视图 / 重新解析）。中断后剩下的 token 不再产生。 */
  private abortExplainStream(): void {
    this.explainAbort?.abort();
    this.explainAbort = null;
    this.explainStreamCid = null;
  }

  /**
   * 第二块请求 + **失败重试一次**（只重试这一步，解读不动）。
   *
   * 返回 null = 这次拿不到词表（已经通过解析区如实告诉用户了）。
   * 没余额不走重试：再试一次还是 402，该做的是弹充值窗而不是重试。
   */
  private async fetchWords(
    input: ExplainInput,
    slice: StudySentence,
    settings: PluginSettings,
  ): Promise<WordEntry[] | null> {
    const attempt = async (): Promise<WordEntry[] | null> => explainWords(input, settings);
    /** 报错前先确认用户还停在这一句：两块并行之后，翻页后到达的错误提示
     *  会落到**新那句**的卡片上（那是最难查的一类串台）。 */
    const report = (message: string): void => {
      if (this.currentSlice()?.cid !== slice.cid) return;
      this.analysis.wordsFailed(message);
    };
    let words: WordEntry[] | null = null;
    try {
      words = await attempt();
    } catch (error) {
      if (isNoBalanceError(error)) {
        report("");
        this.handleOutOfBalance();
        return null;
      }
      // 网络抖一下／模型这次空手而归：再试一次。重试前确认用户还停在这一句 ——
      // 已经翻走了就没必要再花这笔钱
      if (this.currentSlice()?.cid !== slice.cid) return null;
      try {
        words = await attempt();
      } catch (retryError) {
        if (isNoBalanceError(retryError)) {
          report("");
          this.handleOutOfBalance();
          return null;
        }
        report(this.aiMessage(retryError));
        return null;
      }
    }
    if (!words || words.length === 0) {
      report("逐词释义这次没拿到，可以再点一次重新解析。");
      return null;
    }
    return words;
  }

  /**
   * 把这次的解析落进切片行 —— 翻回来不用再点、也不再花钱。
   *
   * ⚠️ **两块都拿到了才调用**（解读 + 逐词释义）：只落一半的话，翻回这句会
   * 显示成"解析过了"，但句子卡不点亮、词点不开，用户还得再点一次「重新解析」——
   * 不如当时就不落。
   *
   * 词块带的是**本地分词**的结果（`this.currentTokens`），AI 只往上面贴释义、
   * 句内读音与词源；这样与界面看到的那一份结构一致，读回来渲染时不差分毫。
   */
  private async persistAnalysis(
    slice: StudySentence,
    explanation: SentenceExplanation,
    words: WordEntry[],
  ): Promise<void> {
    const tokens = this.currentTokens;
    // ⚠️ 三样都用 match* 贴，不要按词形精确查表：模型会把一个词拆开
    // （「おくれよ」→「おくれ」+「よ」），精确查表存下来的这份就缺东西，
    // 翻回这句时界面跟着缺（见 services/meaningMatch）。
    const meanings = matchMeanings(tokens, words);
    // AI 的句内读音走同一套匹配贴上去：抄写提示优先用它（比词典注音准）
    const readings = matchAiReadings(tokens, words);
    // 英语外来语的词源：只有英语借词才有，其他词条在这里根本不存在
    const origins = matchAiOrigins(tokens, words);
    const enriched: Token[] = tokens.map((token, index) => {
      const next: Token = { ...token };
      const meaning = meanings[index] ?? "";
      const aiReading = readings[index] || undefined;
      const origin = origins[index] || undefined;
      if (meaning) {
        next.def = meaning;
        next.meaningSource = "llm";
      }
      if (aiReading) next.aiReading = aiReading;
      if (origin) next.origin = origin;
      return next;
    });
    const missing = enriched
      .filter((token) => CONTENT_POS.has(token.pos) && !token.def)
      .map((token) => token.surface);

    const analysis: SentenceAnalysis = {
      engine: ANALYSIS_ENGINE,
      text: effectiveJa(slice),
      romaji: tokens.map((token) => token.romaji).filter(Boolean).join(" "),
      tokens: enriched,
      explanation: explanation.sections,
      missingDefinitions: missing,
      definitionsComplete: missing.length === 0,
      done: true,
      translation: explanation.translation,
    };

    // 内存里那份先换上：后面重铺原句（青蓝态 / 可点词 / 弹卡数据）读的就是它，
    // 落库失败只该影响"下次翻回来"，不该让这一次的词点不开
    slice.analysis = analysis;
    await saveSliceAnalysis(this.db, slice, analysis);
    // 解析落库即刷新笔记（2026-10-07 定稿）：学过的句子当场补全，零成本不挡人
  }

  /** 记一轮助手问答。写库失败只记日志：聊天不因为它而中断。 */
  private persistChatTurn(sliceCid: string, turn: ChatTurn): void {
    const slice = this.slices.find((row) => row.cid === sliceCid);
    if (!slice) return;
    const { ts: _ts, ...rest } = turn;
    void appendChatTurn(this.db, slice, rest).catch((error: unknown) => {
      log.warn("对话没能存进本地库", error);
    });
  }

  /** AI 出错统一转成人话，别把堆栈丢给用户。 */
  private aiMessage(error: unknown): string {
    if (error instanceof AiUnavailableError) return error.message;
    log.warn("AI 调用失败", error);
    return "AI 没连上（网络或 Key 的问题），可以稍后再试。";
  }

  // ── 仿写核对 ─────────────────────────────────────────────────────────────

  /**
   * AI 判定一句仿写（「检查」且 AI 可用时走这里）。默认**真流式**（2026-10-09）：
   * `onFields` 把生成中的判定文字交出去边判边显示；最终以整份判定为准，
   * 落库也只认整份。`onFields` 缺省（流式不可用的调用方）退回非流式一次拿全。
   *
   * ⚠️ 判定结果会**同时落库**：判错 → 这一步退回未完成（没通过就得改）。
   * 判对 → `verified: true`，也就是说只有真让 AI 判过的才算过。
   * AI 用不了时走的是另一个入口（`handleUnverifiedImitation`），不在这里。
   * 落库认 `sliceCid`（发起检查时绑定的那句）—— 判定要出网，回包时可能已经
   * 换句了（见 sliceByCid）。
   */
  private async handleVerifyImitation(
    text: string,
    sliceCid: string,
    onFields?: (fields: StreamVerdict) => void,
  ): Promise<VerifyOutcome> {
    const slice = this.sliceByCid(sliceCid);
    if (!slice) return { status: "error", message: "这一句已经不在了，换一句再试。" };
    const input = { ja: effectiveJa(slice), zh: effectiveZh(slice), text };
    let verdict: ImitationVerdict;
    try {
      verdict = onFields
        ? await verifyImitationStream(input, this.plugin.settings, onFields)
        : await verifyImitation(input, this.plugin.settings);
    } catch (error) {
      // 没余额不再就地摆提示（2026-10-04 用户拍板）：message 留空 = 弹窗已接管
      if (isNoBalanceError(error)) {
        this.handleOutOfBalance();
        return { status: "error", message: "" };
      }
      return { status: "error", message: this.aiMessage(error) };
    }
    const row = await submitImitation(this.db, slice, {
      text,
      correct: verdict.correct,
      verified: true,
      // 理由/建议/中文意思一起留档 —— 以前拿到就丢了，助手追问"上次为什么判错"永远是空的
      // （`correct` 也带上：展示侧要靠它认这份评语还算不算数）
      feedback: {
        correct: verdict.correct,
        reason: verdict.reason,
        suggestion: verdict.suggestion,
        suggestionNote: verdict.suggestionNote,
        translation: verdict.translation,
      },
    });
    await this.afterProgress(slice, row);
    // 落库后的行交回给卡片，它本地那份进度行靠这个对齐（不再自己拼一份）
    return { status: "ok", verdict, progress: row };
  }

  /**
   * AI 用不了时点「检查」的**浅检查放行**：卡片侧已查过"写了句子、且不是照抄
   * 原句"，这里只负责落库。
   *
   * 为什么要有这条路：仿写是三步里的一步，卡住它整句就学不完、笔记也写不出来 ——
   * 没登录、没填 Key 的用户不该被 AI 判定的可用性挡在学习之外。
   * 但 `verified: false` 必须落下去：卡片上标黄、上行也不收（见
   * `ProgressRow.imitationVerifiedAt`），**不冒充"AI 判过"**。
   */
  private async handleUnverifiedImitation(text: string, sliceCid: string): Promise<ProgressRow> {
    const slice = this.sliceByCid(sliceCid);
    if (!slice) throw new Error("这一句已经不在了");
    const row = await submitImitation(this.db, slice, { text, correct: true, verified: false });
    await this.afterProgress(slice, row);
    return row;
  }
}
