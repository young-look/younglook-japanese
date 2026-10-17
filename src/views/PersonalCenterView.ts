import { ItemView, Notice, setIcon, TFile, type WorkspaceLeaf } from "obsidian";
import type YoungLookPlugin from "../main";
import { chat } from "../services/ai/client";
import { byokUiState } from "../services/ai/gate";
import {
  fetchWallet,
  sceneText,
  txnName,
  txnSubNote,
  type WalletPayload,
  type WalletTransactionRow,
} from "../services/billingApi";
import { levelFromExp } from "../services/level";
import { modelPlaceholder } from "../settings/providers";
import { shareCardPayloadFrom } from "../services/shareCard";
import { dayCounts, heatmapSeries, STREAK_GRACE, streakOf } from "../services/personalStats";
import { effectiveJa, effectiveZh, loadStudySentences } from "../services/study";
import {
  collectVocabFromAnalyses,
  collectVocabFromSlices,
  type SliceLearnInfo,
  type VocabEntry,
} from "../services/vocabLibrary";
import { ORPHAN_PATCH_PREFIX, type OrphanPatch } from "../services/sync/snapshot";
import { assetShaCid } from "../core/ids";
import { blockAnchor } from "../markdown/templates";
import { fileExists } from "../storage/files";
import { STORE } from "../storage/db";
import type {
  AssetRow,
  ProgressRow,
  RecordRow,
  SentenceAnalysis,
  /** 句子表的一行。本文件已有历史页的 `SentenceRow`（渲染用的一行），撞名 → 别名 */
  SentenceRow as SentenceDbRow,
  StudySentence,
} from "../types/entities";
import { loadMyNotes, peekMyNotes } from "../services/notes/mine";
import { ShareCardModal } from "./ShareCardModal";
import { FeedbackModal } from "./FeedbackModal";
import { ProfileEditCard } from "./ProfileEditCard";
import { submitFeedback } from "../services/feedbackApi";
import { log } from "../core/logger";
import { createButton } from "../ui/button";
import { signedYuanMilli as signedYuan, yuanMilli as yuan } from "../ui/money";
import { setViewTitle } from "../ui/viewTitle";
import {
  ICON_FLAKE,
  ICON_FLAME,
  ICON_TOTAL,
  ICON_VOCAB,
  LEVEL_ICONS,
} from "../ui/statIcons";
import { ConnectCodeModal } from "./ConnectCodeModal";
import { DataPane } from "./dataSection";
import { buildHistorySection, type HistoryPage, type HistorySection, type HistorySource } from "./historySection";
import { buildProviderSelect } from "./providerSelect";
import {
  buildSpendSection,
  windowRangeOf,
  type SpendPage,
  type SpendSection,
  type SpendSource,
} from "./spendSection";
import { buildVocabSection, type VocabSection } from "./vocabSection";

export const VIEW_TYPE_PERSONAL = "young-look-personal-center";

/** 消费记录一页多少条。服务端夹在 1..100（WalletView.MAX_LIMIT），本机那条轨跟着走 */
const SPEND_PAGE_SIZE = 30;

/** 学习历史一页多少条（窗口内滚动，见 views/historySection.ts） */
const HISTORY_PAGE_SIZE = 30;

type TabKey = "profile" | "wallet" | "vocab" | "sentences" | "data";

/**
 * 导航五项（2026-10-01：6 项 → 4 项；2026-10-02：4 项 → 3 项；同日再加回一项至 4 项）。
 * 「统计」与「总览」先合成「学习」；同日学习内容整体并入资料页（buildLearnSection），
 * 「学习」页签取消 —— 页签只留"要填/要看的东西"，学习读数归资料页常驻。
 * 「钱包」更名「设置」并挪到词库右边（双轨的输入表单、余额、消费记录都在里面）。
 * 2026-10-02 夜：**新增「数据」**，位置由用户指定在**词库与设置之间**：它回答的是
 * "这些学习记录到底占了多少地方、哪些会离开这台机器" —— 查增删改看清体验 intermediate
 * 的一些长期疑虑，跟"填东西"（设置）和"背单词"（词库）都不是一路货，所以单独一项。
 * 2026-10-04：「数据」更名「存储」—— 这一页说的是占地与去向，"数据"太泛；
 * 同日**新增「历史」**（用户指定在词库后面，初名「句库」）：学完的每一句一条账，
 * 点了跳回学习页原句，附每句的笔记深链。
 * 2026-10-05：「资料」更名「我的」，「设置」更名「账户」
 * —— 里面装的是模型与消费，叫"设置"名不副实。
 *
 * 五项摆在标题行右上角的药丸组里（原左栏 rail 已撤）。
 */
const TAB_DEFS: { key: TabKey; label: string }[] = [
  { key: "profile", label: "我的" },
  { key: "vocab", label: "词库" },
  { key: "sentences", label: "历史" },
  { key: "data", label: "存储" },
  { key: "wallet", label: "账户" },
];

/**
 * 页签下的灰色小字说明（2026-10-04 用户拍板；2026-10-17 全量改写一版）。
 *
 * 2026-10-17 起版式变了：标题行左槽由**本页签的名字**占着（「个人中心」只在
 * 「我的」这一页——而且它的位置被身份头占掉了）。说明行因此跟标题长在一起：
 * 标题 + 这行小字是一个左对齐的两行块，右侧仍是药丸导航，标题行高度固定
 * （见 styles.css 的 .yl-card-header / .yl-pc-head）。
 *
 * 「账户」页签原来没有这一行（2026-10-10 撤掉：一行灰字说不清双轨二选一），
 * 2026-10-17 补回一句只交代"这页能看到什么"，二选一的关系仍由 renderWallet
 * 顶部的黑字说明块（.yl-pc-guide）讲。
 */
const TAB_SUBS: Partial<Record<TabKey, string>> = {
  vocab: "学过的句子里出现过的词：读音、释义、例句，按最近学到排。",
  sentences: "学完的每一句都在这里，笔记跟在句下；点「打开」回到学它的位置。",
  data: "只算你自己产生的数据：各占多少、存在哪、哪些会上云。",
  wallet: "AI 走哪条轨道、余额还剩多少、每一笔花在哪里。",
};

// 2026-10-05 撤掉「常用服务商」预设 chips（用户定案：这一轨只留接口地址 / API Key /
// 模型名三项，不列服务商名单）。BYOK 只认 OpenAI 兼容端点（client.ts 只拼
// `/chat/completions`），照服务商自己的文档填这三项即可。

/**
 * 孤儿行的显示材料：完成记录在（换机同步拉回 / 素材还没重导 / 换字幕没认回），
 * 本地没有切片行。句面用用户当时**亲手写的字**顶替 —— 仿写优先（2026-10-09
 * 用户拍板的机制），没写仿写退抄写（抄写是逐字打的原句，最接近原貌），
 * 都没有就渲染占位说明。重导素材后切片 cid 对上，这些行自动换回真切片。
 */
interface OrphanInfo {
  /** 原切片 cid（= progress 行的 sliceCid；笔记按它取，不依赖切片行） */
  cid: string;
  /** 句序：progress 行上行时内嵌的 provenance（云端有、换机也在） */
  index: number;
  /** 顶替句面：仿写句 → 抄写 → 空串（渲染占位） */
  text: string;
  /** 仿写的中文意思（AI 判定留档）；只在顶替句面是仿写时有值 —— 抄写没有这东西 */
  translation: string;
}

/**
 * progress 行上行时内嵌的出处（snake_case，见 services/sync/snapshot.ts 的
 * provenance()）。只列历史页用得到的字段。
 */
interface SyncProvenance {
  record_cid?: string;
  record_title?: string;
  episode_number?: number;
  slice_index?: number;
}

/** 历史页的一行：学完的一个句子（现行切片 + 完成时刻 + 这句的笔记，没写是空串）。 */
interface SentenceRow {
  /** 本地现行切片；孤儿行为 null（句面用 OrphanInfo 顶替，见上） */
  slice: StudySentence | null;
  completedAt: string;
  /** 用户在学习页亲手写的笔记；空串 = 没写过（或清空了） */
  note: string;
  orphan?: OrphanInfo;
}

/**
 * 本机一行 AI 用量（自定义模型每次调用写一行）。
 * 只有这五个字段：`ai_usage` 表里**没有**服务商地址 / Key，也就无从"上云"——
 * 这张表本来就在同步剔除名单里（services/sync/snapshot.ts 的 LOCAL_ONLY_STORES）。
 */
interface ByokUsageRow {
  id?: number;
  ts: string;
  scene: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
}

/**
 * 历史页按集分的一组。视频在不在进组时一次定死 ——
 * 行渲染只读这个标志，不再碰文件系统。
 */
interface SentenceGroup {
  recordCid: string;
  label: string;
  /** 实测视频文件还在（AssetRow.available 是上次核对时的旧账，不做数） */
  videoOk: boolean;
  rows: SentenceRow[];
  /** 组内最近一次完成的时刻，组排序用 */
  lastAt: string;
}


/** 列表/历史通用的记录标签：视频名 · 第 N 季第 N 集 / E N（非剧集类只有名字）。 */
function recordLabelOf(record: {
  title: string;
  titleJa: string;
  season: number | null;
  number: string;
}): string {
  const head = record.title || record.titleJa || "未命名";
  const label =
    record.number.trim() === ""
      ? ""
      : `第${record.season != null ? ` ${record.season} 季` : ""}第 ${record.number} 集`;
  return [head, label.trim()].filter(Boolean).join(" · ");
}

function localDayOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function humanDay(day: string): string {
  const today = new Date();
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (day === iso(today)) return "今天";
  if (day === iso(new Date(today.getTime() - 86400000))) return "昨天";
  const [, m, d] = day.split("-");
  return `${Number(m)} 月 ${Number(d)} 日`;
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 时间线日期圆点上的短字：今 / 昨 / 9月27日 → 「27」 */
function dayLabel(day: string): string {
  const today = new Date();
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (day === iso(today)) return "今";
  if (day === iso(new Date(today.getTime() - 86400000))) return "昨";
  const [, , d] = day.split("-");
  return d;
}

/**
 * 个人中心：版式照 `temp/demo/yl-unified/me.html` —— 标题行右上角四个分区药丸，
 * 下面是正文滚动区。
 * 内容 = 资料（人 + 小结 + 学习）+ 设置（自定义模型 / 内置模型 / 消费记录）+ 词库。
 *
 * ⚠️ 不再有付费墙（2026-10-02）：学习 / 词库读的是本机学习记录，余额为 0 也照常能看。
 * 登录 / 注册在网页完成：插件侧的入口是学习页身份头的「连接账号」，
 * 点了直接开网页连接页（/plugin/connect），这里不再有登录表单。
 */
export class PersonalCenterView extends ItemView {
  private progressRows: ProgressRow[] = [];
  private counts: Map<string, number> = new Map();
  private vocab: VocabEntry[] | null = null;
  /** 词库排序键与方向，切页签间保持 */
  private vocabSort: "recent" | "seen" = "recent";
  /** 排序方向：desc = 最近的 / 最多的在前（默认），asc 反过来。同一颗钮点第二次即对调 */
  private vocabDir: "asc" | "desc" = "desc";
  /** 词库搜索词，切页签间保持（见 views/vocabSection.ts） */
  private vocabQuery = "";
  /**
   * 零延迟悬停牌：全页**共用一枚**、挂在 body 上的固定定位小黑牌（懒建）。
   *
   * 为什么不用原生 `title`：系统提示框天生慢一秒，2026-10-09 用户点名弃用
   * （见 styles.css 的 .yl-pc-hm-tip）。现在两处用它 —— 热力图格子的日期读数、
   * 供应商下拉的接口地址；两处不会同时出现，共用一枚就够。
   */
  private hoverTip: HTMLDivElement | null = null;
  /** 供应商下拉开着时"点外面 / 按 Esc 收起"的清理函数；视图关掉时兜底调一次 */
  private closeProviderMenu: (() => void) | null = null;
  private wallet: WalletPayload | null = null;
  /** 本机 AI 用量（IndexedDB `ai_usage`，倒序）。**自定义模型专用，一次也不上行** */
  private byokUsage: ByokUsageRow[] | null = null;
  /**
   * 消费记录区块（账户页底部）：一个 3 个月窗口 + 窗口内滚动加载。
   * 重画 / 关页前必须 `destroy()` —— 它挂着 document 上的"点外面收起"监听
   * 和一个滚动观察器（见 views/spendSection.ts 文件头坑 2）。
   */
  private spend: SpendSection | null = null;
  /**
   * 历史区块（历史页签）：一个 3 个月窗口 + 窗口内滚动加载。
   * 重画 / 关页前必须 `destroy()` —— 同消费记录（document 监听 + 滚动观察器）。
   */
  private historySec: HistorySection | null = null;
  /**
   * 词库区块（词库页签）：五十音 / 搜索筛选 + 滚动加载。
   * 重画 / 关页前必须 `destroy()`（滚动观察器不随 DOM 消失自动断开）。
   */
  private vocabSec: VocabSection | null = null;
  /** 历史当前选中的窗口档（切页签间保持，见 views/historySection.ts） */
  private sentenceWindowMonth: string | null = null;
  /** 当前窗口内每集的句数（组头「学完 N 句」按档内数显示），loadHistoryPage 每趟刷新 */
  private historyCounts = new Map<string, number>();
  private loadedTabs = new Set<TabKey>();
  private panes: Partial<Record<TabKey, HTMLElement>> = {};
  /** 正文滚动容器（.yl-v3-body）；切分区时复位滚动位置用 */
  private scrollEl: HTMLElement | null = null;
  private activeTab: TabKey = "profile";
  /**
   * 标题行左槽（.yl-pc-head）。两种内容二选一（2026-10-17 用户定）：
   *   - 「我的」→ 身份块（头像 + 昵称 + 等级 + 副行），由 renderProfile 画；
   *   - 其余 → 本页签的名字 + 一行灰色说明，由 renderHeadTitle 画。
   * 两种内容高度都落在同一个 56px 行里，切页签不跳。
   */
  private headEl: HTMLElement | null = null;
  /**
   * 页头说明行行尾的计数位（目前只有「词库」用：「共 N 词」）。
   *
   * 2026-10-17 用户拍板：页内那颗「词库」标题撤掉 —— 页头已经写着「词库」，
   * 再来一颗就是重复；计数不能跟着一起丢，于是挪进页头说明行（跟着页签重生）。
   * `vocabSection` 通过 `countEl` 往这个节点里写，写多少显示多少。
   */
  private headCntEl: HTMLElement | null = null;
  /** 「存储」页：自带盘点与筛选状态，跨次切换可复用 */
  private dataPane: DataPane | null = null;
  /** 「历史」页：学完的句子按集分组；懒加载，本次打开期间复用 */
  private sentenceGroups: SentenceGroup[] | null = null;
  /**
   * 历史排序（V4 时间线版，2026-10-09 用户拍板）：time = 学习时间（默认降序，
   * 最近学的在轴顶）；index = 句子顺序（默认升序，跟字幕对齐顺剧情）。
   * 组本身固定「最近学习的集在前」—— 历史页的本能是“最近学到哪了”。
   */
  private sentenceSort: "time" | "index" = "time";
  private sentenceDir: "asc" | "desc" = "desc";
  /** 余额刷新防重入（renderWallet 每次画完都会发起一次） */
  private refreshingBalance = false;

  private ensureDataPane(): DataPane {
    this.dataPane ??= new DataPane(this.plugin);
    return this.dataPane;
  }

  constructor(leaf: WorkspaceLeaf, private readonly plugin: YoungLookPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_PERSONAL;
  }

  /**
   * 页签带品牌前缀（2026-10-14 用户定）；页头（页签下面那行）由 render 里的
   * setViewTitle 另行写成「个人中心」。
   */
  getDisplayText(): string {
    return "洋流 · 个人中心";
  }

  getIcon(): string {
    return "user";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {
    // 下拉还开着就关页 = 挂在 document 上的"点外面"监听会留在那儿
    this.closeProviderMenu?.();
    // 消费记录 / 历史 / 词库三块都挂着滚动观察器（历史还有 document 监听）
    this.spend?.destroy();
    this.spend = null;
    this.historySec?.destroy();
    this.historySec = null;
    this.vocabSec?.destroy();
    this.vocabSec = null;
    this.contentEl.empty();
  }

  // ── 零延迟悬停牌 ─────────────────────────────────────────────────────

  private ensureHoverTip(): HTMLDivElement {
    if (!this.hoverTip) {
      this.hoverTip = document.body.createDiv({ cls: "yl-pc-hm-tip" });
      this.hoverTip.hide();
      this.register(() => this.hoverTip?.remove());
    }
    return this.hoverTip;
  }

  /** 把牌子摆到 el 附近：优先挂上方，顶到窗口沿就改挂下方，左右贴边往里收。 */
  private showHoverTip(el: HTMLElement, text: string): void {
    if (!text) return;
    const tip = this.ensureHoverTip();
    tip.setText(text);
    tip.show();
    const rect = el.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    const left = Math.min(
      Math.max(rect.left + rect.width / 2, half + 8),
      window.innerWidth - half - 8,
    );
    const roomAbove = rect.top > tip.offsetHeight + 12;
    tip.style.left = `${left}px`;
    tip.style.top = roomAbove ? `${rect.top - 6}px` : `${rect.bottom + 6}px`;
    tip.style.transform = roomAbove ? "translate(-50%, -100%)" : "translate(-50%, 0)";
  }

  private hideHoverTip(): void {
    this.hoverTip?.hide();
  }

  // ── 状态 ─────────────────────────────────────────────────────────────

  private isLoggedIn(): boolean {
    const s = this.plugin.settings;
    return Boolean(s.authToken.trim() || s.refreshToken.trim());
  }

  // ── 骨架 ─────────────────────────────────────────────────────────────

  private build(): void {
    const root = this.contentEl;
    // ⚠️ refreshOpenViews / undoAssociation 走 render() → build() 重建整页，
    //    **不经过 onClose** —— 三块带滚动观察器 / document 监听的 section
    //    必须在这里一并摘掉，否则旧监听悬空、旧 IO 还盯着已死的 DOM。
    this.spend?.destroy();
    this.spend = null;
    this.historySec?.destroy();
    this.historySec = null;
    this.vocabSec?.destroy();
    this.vocabSec = null;
    root.empty();
    root.removeClass("yl-pc");
    root.addClass("yl-v3");
    this.panes = {};

    // 内容包裹层：两侧留白在这一层（同学习页 .yl-study-wrap）
    const wrap = root.createDiv({ cls: "yl-v3-wrap" });

    // 标题行：左边是本页的身份（「我的」= 身份块，其余 = 页签名 + 说明），右边是药丸导航。
    // ⚠️ 这一行高度固定 56px（styles.css 的 .yl-card-header）：五个页签互切，
    //    标题行不跳、正文起点也不动。对齐方式是**顶对齐** —— 身份块（52 头像 +
    //    两行字 = 56）与药丸上沿齐平，块自然往下探出，见 .yl-v3 .yl-card-header。
    const header = wrap.createDiv({ cls: "yl-card-header" });
    this.headEl = header.createDiv({ cls: "yl-pc-head" });
    const nav = header.createDiv({ cls: "yl-card-nav" });
    for (const tab of TAB_DEFS) {
      const btn = createButton(nav, { text: tab.label, onClick: () => this.setTab(tab.key) });
      btn.dataset.tab = tab.key;
      if (tab.key === this.activeTab) btn.addClass("is-active");
    }
    // 唯一出口：关掉这一页、回到来路（**不是**退出登录，退出在学习页里）。
    // 它是动作不是目的地 —— 细分隔线切出页签组，别让它排成第五颗页签；
    // 纯文字不加箭头，出口钮这条线全站统一（学习页同款：分隔线 + 「退出」）。
    // 刻意不叫「退出」：页底有「退出登录」，页顶再放一个「退出」会撞词。
    nav.createDiv({ cls: "yl-card-nav-sep" });
    createButton(nav, {
      text: "返回",
      onClick: () => void this.plugin.closePersonalCenter(),
    });

    // 正文滚动区：pane 是它的直接子节点，滚动条归它（setTab 复位滚动读它）
    this.scrollEl = wrap.createDiv({ cls: "yl-v3-body" });
    for (const tab of TAB_DEFS) {
      const pane = this.scrollEl.createDiv({ cls: "yl-v3-pane" });
      pane.dataset.v3Pane = tab.key;
      if (tab.key === this.activeTab) pane.addClass("on");
      this.panes[tab.key] = pane;
    }
  }

  /**
   * 画出个人中心当前这一页。
   *
   * ⚠️ **不能只 `build()`**：`build()` 只搭骨架（标题 + 页签导航 + 一排空 pane），
   * 真正的内容由 `renderTab()` 画。只 build、不 renderTab 的下场是——打开个人中心
   * 看到一整片空白，得自己点一下某个页签才有东西。
   *
   * 未登录也照常渲染（2026-10-02 拍板：不遮不挡）—— 登录/注册在网页完成，
   * 插件侧入口是学习页和悬浮卡的「连接账号」（连接弹窗收一次性连接码）。
   *
   * 名字与签名跟 `StudyView.render()` 对齐：`activateLeaf()` 在聚焦一个已经开着的
   * 页面时会走 `if ("render" in view) view.render()`；没有这个方法，它就只能把
   * 一个空白页重新亮一遍，用户再点一次也不会出现内容。
   */
  async render(): Promise<void> {
    // openPersonalCenter 指定了落点页签（AI 门控弹窗「去配置」→ 账户页）：
    // 落一次就清，别让下一次从头像进来还停在这一页
    const initialTab = this.plugin.personalInitialTab;
    this.plugin.personalInitialTab = null;
    if (initialTab) this.activeTab = initialTab;
    // 历史的分组是按打开时刻的进度算的：学新句子都发生在学习页，重新打开
    // 个人中心意味着进度可能变了 —— 丢掉缓存，切到历史时重新整理。
    this.sentenceGroups = null;
    // ⚠️ 先取学习进度再搭骨架：学习页身份头要算等级（Lv. 标签），取晚了那一格就是空的
    await this.loadCore();
    // 学习页的「我的词库 / 我的笔记」要读整库，也先备好再搭骨架（词库页共用这份结果）
    await this.loadV3Stats();
    this.build();
    await this.renderTab(this.activeTab);
    // 页头只写页面名，页签才是「洋流 · 个人中心」（见 ui/viewTitle.ts）
    setViewTitle(this.leaf, this.containerEl, "洋流 · 个人中心", "个人中心");
  }

  /**
   * 非「我的」页签的标题行左槽：本页签的名字 + 一行灰色说明。
   *
   * 2026-10-17 用户定：标题就是页签的名字（「词库」顶替原来的「个人中心」）——
   * 翻到哪一页，页头写的就是哪一页，不必再先看页签高亮、再看标题。
   * 「我的」不走这里：它的左槽是身份块（renderProfile 画），页头不再重复写
   * 「个人中心」四个字（身份头本身就是答案）。
   */
  private renderHeadTitle(): void {
    const head = this.headEl;
    if (!head) return;
    head.empty();
    this.headCntEl = null;
    const tab = TAB_DEFS.find((t) => t.key === this.activeTab);
    head.createDiv({ cls: "yl-pc-head-title", text: tab?.label ?? "" });
    const sub = TAB_SUBS[this.activeTab];
    if (sub) {
      const subEl = head.createDiv({ cls: "yl-pc-head-sub" });
      subEl.createSpan({ cls: "yl-pc-head-subtext", text: sub });
      // 词库的「共 N 词」：页内标题撤了（重复），计数挪到说明行行尾。
      // 空着时 CSS 让它整颗消失（:empty），不会悬一颗分隔点在那儿。
      if (this.activeTab === "vocab") {
        this.headCntEl = subEl.createSpan({ cls: "yl-pc-head-cnt" });
      }
    }
  }

  private setTab(key: TabKey): void {
    this.activeTab = key;
    // 标题先换（同步）：正文要等 await，慢半拍时页头已经是新名字了。
    // 「我的」的清空在这里做，身份块由 renderProfile 紧接着填上。
    if (key === "profile") this.headEl?.empty();
    else this.renderHeadTitle();
    this.contentEl.querySelectorAll("[data-tab]").forEach((el) => {
      el.classList.toggle("is-active", (el as HTMLElement).dataset.tab === key);
    });
    this.contentEl.querySelectorAll("[data-v3-pane]").forEach((el) => {
      el.classList.toggle("on", (el as HTMLElement).dataset.v3Pane === key);
    });
    // 滚动条在 .yl-v3-body 上，pane 本身不滚 —— 复位要复位它
    if (this.scrollEl) this.scrollEl.scrollTop = 0;
    void this.renderTab(key);
  }

  /** 每次切到某个 tab 都重渲染（余额/登录态变了要跟着变），数据懒加载。 */
  private async renderTab(key: TabKey): Promise<void> {
    // 未登录也照渲染：学习页显示「—」、账户页显示本机余额、词库读本地记录，
    // 是什么就显示什么（2026-10-02 用户拍板：不遮不挡、不加登录引导位）
    if (key === "profile") this.renderProfile();
    else if (key === "wallet") { this.renderHeadTitle(); this.renderWallet(); }
    else if (key === "vocab") { this.renderHeadTitle(); await this.renderVocab(); }
    else if (key === "sentences") { this.renderHeadTitle(); await this.renderSentences(); }
    else if (key === "data") { this.renderHeadTitle(); await this.renderData(); }
  }

  /**
   * 「存储」页：本机各类数据量 + 哪些会上传到云端。只算用户自己产生的数据 ——
   * 插件自带的词典不计入；示例那一集是用户点下载才进来的，占着本机的盘，照常
   * 计入（口径都在 dataInventory 里做）。
   *
   * 单独一个 `DataPane` 而不是在这里写一长串方法：这一页要读真实文件（stat 素材、
   * 组一遍同步 payload），有自己的加载态与筛选状态，混进本文件
   * 会让这一个视图涨到两千行。
   */
  private async renderData(): Promise<void> {
    const pane = this.panes.data;
    if (!pane) return;
    await this.ensureDataPane().render(pane);
  }

  private async loadCore(): Promise<void> {
    this.progressRows = (await this.plugin.db.getAll<ProgressRow>(STORE.progress)).filter(
      (row) => !row.deletedAt,
    );
    this.counts = dayCounts(this.progressRows);
  }

  /**
   * 学习页那四个小结里，凡是要读整库的数字都在这里一次算完（词库页共用结果）。
   *
   * 循环与老版 `loadVocab()` 完全同源 —— 逐集取切片、挑出"已完成的句子"、抽词入库。
   * 不做 vault 文件扫描：词库是**学出来的**，本地库比文件系统更准。
   *
   * ⚠️ **总词汇量不认"本机有没有素材"**（2026-10-14 用户拍板）：本机没导入的素材里
   * 学过的句子（孤儿句）**照样计入** —— AI 解析随同步回来了（本地句子行，或同步暂存的
   * 孤儿补丁），出处用 progress 行内嵌的 provenance。少了这一步，词库会随"这台机器导
   * 没导素材"忽大忽小；那是统计口径的错，不是用户数据变了。同理，总句子数与等级只按
   * 进度行算，本来就与素材无关，三者因此始终自洽。
   */
  private async loadV3Stats(): Promise<void> {
    // 同一句的进度行可能不止一条（重学），完成时刻取最早那次；仿写跟着这条走
    const done = new Map<string, SliceLearnInfo>();
    const doneRow = new Map<string, ProgressRow>();
    for (const row of this.progressRows) {
      if (!row.completedAt) continue;
      const prev = done.get(row.sliceCid);
      if (!prev || row.completedAt < prev.at) {
        done.set(row.sliceCid, { at: row.completedAt, imitation: (row.imitationText ?? "").trim() });
        doneRow.set(row.sliceCid, row);
      }
    }
    const into = new Map<string, VocabEntry>();
    // ⚠️ 遍历**全部**记录（含软删的）：移除一集只软删记录行，台词行还全在，
    // 学过的词不该因为"首页那一条被移除了"就从词库消失
    const records = await this.plugin.db.getAll<RecordRow>(STORE.records);
    const localSliceCids = new Set<string>();
    for (const record of records) {
      const slices = await loadStudySentences(this.plugin.db, record.cid);
      for (const s of slices) localSliceCids.add(s.cid);
      collectVocabFromSlices(slices, done, recordLabelOf(record), into);
    }
    await this.collectOrphanVocab(done, doneRow, localSliceCids, into);
    // 默认最近学习时间倒序（词库页可以切按学习次数，见 renderVocab）
    this.vocab = [...into.values()].sort(
      (a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || a.surface.localeCompare(b.surface, "ja"),
    );
  }

  /**
   * 孤儿句（本机没有切片行的完成句）的词并进词表 —— 让总词汇量与"本机导没导素材"无关。
   *
   * 解析结果两个来源，先本地后云端暂存：
   *  ① `sentences` 行 —— 移除一集只软删**记录行**，句子行还留着，解析照读；
   *  ② 同步暂存的孤儿补丁 —— 换机拉回时 `analysis` 集合下来的解析（snapshot.ts）。
   * 出处标签与历史页孤儿行同一套写法：本机还有那条记录就用它的名字，没有就用
   * progress 行内嵌的 provenance（云端带回来的作品名 / 集号）。
   */
  private async collectOrphanVocab(
    done: ReadonlyMap<string, SliceLearnInfo>,
    doneRow: ReadonlyMap<string, ProgressRow>,
    localSliceCids: ReadonlySet<string>,
    into: Map<string, VocabEntry>,
  ): Promise<void> {
    const orphanCids = [...done.keys()].filter((cid) => !localSliceCids.has(cid));
    if (orphanCids.length === 0) return;
    // 孤儿补丁一趟取回：meta 键以 orphanPatch: 开头，按前缀做一次范围查询，
    // 不逐句 get（换机拉回来的孤儿可能成百上千）
    const patches = await this.plugin.db.getAll<{ key: string; value: OrphanPatch }>(
      STORE.meta,
      IDBKeyRange.bound(ORPHAN_PATCH_PREFIX, `${ORPHAN_PATCH_PREFIX}\uFFFF`),
    );
    const patchByCid = new Map(
      patches.map((row) => [row.key.slice(ORPHAN_PATCH_PREFIX.length), row.value] as const),
    );
    const records = await this.plugin.db.getAll<RecordRow>(STORE.records);
    const liveByCid = new Map(records.filter((r) => !r.deletedAt).map((r) => [r.cid, r] as const));
    const analyses = new Map<string, SentenceAnalysis>();
    const labels = new Map<string, string>();
    for (const sliceCid of orphanCids) {
      const row = doneRow.get(sliceCid);
      if (!row) continue;
      const local = await this.plugin.db.get<SentenceDbRow>(STORE.sentences, sliceCid);
      const analysis =
        local?.analysis ??
        (patchByCid.get(sliceCid)?.analysis as unknown as SentenceAnalysis | undefined) ??
        null;
      if (!analysis?.tokens?.length) continue;
      const prov = (row as unknown as { provenance?: SyncProvenance }).provenance;
      const record = prov?.record_cid ? liveByCid.get(prov.record_cid) : undefined;
      const number = typeof prov?.episode_number === "number" ? prov.episode_number : 0;
      analyses.set(sliceCid, analysis);
      labels.set(
        sliceCid,
        record
          ? recordLabelOf(record)
          : `${(prov?.record_title || "已学过的句子").trim()}${number ? ` E${number}` : ""}`,
      );
    }
    collectVocabFromAnalyses(analyses, done, (cid) => labels.get(cid) ?? "已学过的句子", into);
  }

  // ── 资料（我的主页，V3 版式）─────────────────────────────────────────
  //
  // 版式照 temp/demo/new_space/v3-two-track.html：单栏长滚动
  //   身份头 → 你的学习 → 渐变分享条 → 底部说明 → 页底动作。
  // 2026-10-04 参照 temp/demo/space/v1-顶部按钮重排.html 重排（用户拍板）：
  //   「编辑资料」收进昵称行、编辑面板在身份头正下方就地展开、退出登录单独放页底、
  //   标题行里「返回」与页签用细分隔线切开。
  // 2026-10-17 参照 temp/demo/space/v2-页头随页签.html（用户拍板）：
  //   **身份头整个搬出正文、搬进标题行左槽**（顶替「个人中心」四个字，与右侧药丸
  //   同一水平线居中）；**整块可点** —— 已登录开编辑面板、未登录走连接流程，
  //   昵称行那颗小药丸随之取消（它不再是唯一入口，只是块内的一行暗示）。
  //   正文第一屏因此从「你的学习」开始；身份头在标题行里天然常驻，sticky 已不需要。

  private renderProfile(): void {
    const pane = this.panes.profile;
    const head = this.headEl;
    if (!pane || !head) return;
    const profile = this.plugin.settings.accountProfile;
    pane.empty();
    head.empty();
    const stack = pane.createDiv({ cls: "yl-pc-stack" });

    const exp = this.progressRows.filter((row) => row.completedAt).length;
    const level = levelFromExp(exp);
    const streak = streakOf(this.counts);
    // activeDays 原本只给身份头副行用；副行改成只报 UID 后这里已无人读 → 删掉。
    //「你的学习」节自己另算了一份同名变量（buildLearnSection），那边照旧。

    const loggedIn = this.isLoggedIn();

    // ① 身份块：占标题行左槽（原「个人中心」的位置）。
    //    2026-10-17 按 temp/demo/login_card/v3-compact.html 的 **N1 光环版** 落地（用户拍板）：
    //      · 无底色 —— 静息 / 悬停都不填色块；悬停只让头像亮起 1px 青蓝环 + 5px 柔光。
    //        （上一版悬停填 `--yl-acc-tint`，那是 `yl-btn` 的按钮写法，一填底卡片就没了。）
    //      · 紧凑 —— 昵称 17→15、副行 12.5→11.5；头像保持 52（用户后来又要求放大一档），
    //        块高仍是 56（上下内距收到 1px）。
    //      · 「连接账号 / 编辑资料」回到昵称行内（紧跟等级徽标），不再占卡片右缘一列。
    //    整块 role=button —— 键盘 Enter / 空格同效。
    const me = head.createDiv({ cls: `yl-v3-me${loggedIn ? "" : " is-out"}` });
    me.setAttr("role", "button");
    me.setAttr("tabindex", "0");
    me.setAttr("aria-label", loggedIn ? "编辑资料" : "连接账号");
    const avatar = me.createDiv({ cls: "yl-v3-avatar" });
    if (loggedIn) {
      avatar.createSpan({ text: (profile?.nickname || "洋").slice(0, 1) });
    } else {
      // 未登录不放昵称首字：一个灰"洋"读起来像"人已经在那儿了"，人形剪影才是空位
      const ghost = avatar.createSpan({ cls: "yl-v3-avatar-ph" });
      setIcon(ghost, "user");
    }
    const avatarUrl = this.plugin.accountAvatarUrl();
    if (avatarUrl) {
      const img = avatar.createEl("img", { attr: { src: avatarUrl, alt: "" } });
      img.addEventListener("error", () => img.remove());
    }
    const meMain = me.createDiv({ cls: "yl-v3-id" });
    const nameRow = meMain.createDiv({ cls: "yl-v3-name" });
    nameRow.createSpan({ cls: "yl-v3-nick", text: profile?.nickname || "未登录" });
    nameRow.createSpan({ cls: "yl-v3-lvl", text: `Lv.${level.level} ${level.name}` });
    // 动作：一块**不是按钮**的暗示 —— 无底无边，前缀一根 11px 细线把它和徽标分开
    // （否则「Lv.1 港口 连接账号」会连读成一句）。悬停整块时字变青、箭头推 2px。
    // 右箭头 = 去网页连接（换页）；下箭头 = 就地展开面板（同页），展开后 CSS 转 180°。
    const act = nameRow.createSpan({ cls: "yl-v3-act" });
    const actText = act.createSpan({ text: loggedIn ? "编辑资料" : "连接账号" });
    const actIcon = act.createSpan({
      cls: `yl-v3-chev yl-v3-chev--${loggedIn ? "down" : "right"}`,
    });
    setIcon(actIcon, loggedIn ? "chevron-down" : "chevron-right");
    // 副行：灰色一行只报身份归属 —— 登录后给 UID（用户报障 / 对账要念的号，
    // 不必再切设置页去找）。学习节奏不在这里说，下面「你的学习」的卡片已经写着，
    // 同一件事说两遍只会互相打架。
    // ⚠️ 2026-10-17 用户点出：昵称已经写着「未登录」，副行再以「未登录 · 」开头是重复，
    //    只留后半句（"登录后可用云同步与内置模型"，一字未改）。
    // uid 为空 = 账号快照还没拉到（节流窗口 60s 内），先留空不显示，
    // 免得出现"UID: "这种半截。
    const uid = (profile?.uid || "").trim();
    meMain.createDiv({
      cls: "yl-v3-sub",
      text: !loggedIn ? "登录后可用云同步与内置模型" : uid ? `UID: ${uid}` : "",
    });

    // 编辑面板：身份块点开后就地展开（2026-10-04。原来追加在页面最底部，
    // 点了按钮视觉上毫无反馈）。未登录的「连接账号」不走这块面板
    // （2026-10-05 改成弹窗，见下）。
    //
    // 2026-10-15：三行（头像 / 昵称 / 邮箱）的编辑状态由 `ProfileEditCard` 统一托管 ——
    // 以前它们各自带着自己的保存键、改完任一项都会整页重绘（看着像"改完卡片自己跑了"），
    // 现在卡片右下角只有一对「取消 / 保存」，而关闭这张卡只有三个入口。
    const editWrap = stack.createDiv({ cls: "yl-v3-editwrap" });
    const editCard = editWrap.createDiv({ cls: "yl-v3-editclip" }).createDiv({ cls: "yl-pc-card" });
    let card: ProfileEditCard | null = null;
    let editOpen = false;
    /** 收 / 放折叠壳 + 跟着换提示的字与箭头朝向（三件事必须一起做，缺一就是形状对不上）。
     *  箭头本身不换图标，只给块挂 `is-open`，由 CSS 把它转 180°。 */
    const setCardOpen = (open: boolean): void => {
      editOpen = open;
      editWrap.toggleClass("on", open);
      me.toggleClass("is-open", open);
      actText.setText(open ? "收起" : "编辑资料");
      me.setAttr("aria-label", open ? "收起编辑面板" : "编辑资料");
    };
    /** 关掉这张卡：丢草稿 → 收起。`rerender` = 保存成功后要整页重绘带出新状态。 */
    const closeCard = (rerender: boolean): void => {
      if (card) {
        card.dispose();
        card = null;
      } else {
        editCard.empty();
      }
      setCardOpen(false);
      if (rerender) this.renderProfile();
    };

    const onMe = (): void => {
      if (!this.isLoggedIn()) {
        // 两边同时开（用户拍板）：网页（登录 / 注册 + 授权码）开新标签页，
        // 授权码弹窗在这边候着 —— 网页登录完复制码回来粘上就行，不靠深链跳转。
        this.plugin.openConnectPage();
        new ConnectCodeModal(this.app, this.plugin, {
          onDone: () => this.renderProfile(),
        }).open();
        return;
      }
      if (editOpen) {
        // 展开状态下提示已经变成「收起」—— 它就是三个关闭入口之一，
        // 语义等同于「取消」（丢草稿）。
        closeCard(false);
        return;
      }
      // 每次展开都是一张新卡：草稿不跨开关保留（保留的话上一次没保存的改动
      // 会阴魂不散地出现在几天后的某次编辑里）。
      editCard.empty();
      card = new ProfileEditCard(editCard, {
        plugin: this.plugin,
        heroAvatar: avatar,
        close: (rerender: boolean) => closeCard(rerender),
      });
      card.render();
      setCardOpen(true);
    };
    me.addEventListener("click", onMe);
    me.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      // 空格默认会滚一屏，这里必须拦住
      ev.preventDefault();
      onMe();
    });

    // ② 四个小结：2026-10-04 用户叉掉不要了 —— 核心指标改由「你的学习」节的
    //    四张渐变徽章卡承担（buildLearnSection）。


    // ③ 「你的学习」：原「学习」页签的内容整体并入（2026-10-02 用户拍板：
    //    六宫格不要，学习内容放资料页，页签随之少一个）
    stack.createDiv({ cls: "yl-v3-sec", text: "你的学习" });
    this.buildLearnSection(stack);

    // ④ 渐变分享条
    const share = stack.createDiv({ cls: "yl-v3-share" });
    const shareText = share.createDiv({ cls: "yl-v3-share-text" });
    shareText.createDiv({ cls: "yl-v3-share-t", text: "生成一张学习卡片" });
    shareText.createDiv({
      cls: "yl-v3-share-d",
      text: `把「连续 ${streak.current} 天 · ${exp} 句」做成图，发到群里或朋友圈。`,
    });
    share.createSpan({ cls: "yl-pc-grow" });
    const gen = createButton(share, { text: "生成" });
    // 卡片数据全在链接里（不上传），所以这里没有网络请求、登录与否都能生成
    gen.addEventListener("click", () => {
      new ShareCardModal(
        this.app,
        this.plugin,
        shareCardPayloadFrom(this.plugin, {
          streak: streak.current,
          level: level.level,
          levelName: level.name,
        }),
      ).open();
    });

    // ⑤ 底部说明
    const foot = stack.createDiv({ cls: "yl-v3-foot" });
    foot.createDiv({ text: "不登录也能用大部分本地功能；登录则可以支持云同步和内置模型。" });
    foot.createDiv({ text: "你的视频和字幕文件始终在本地。" });

    // ⑥ 退出登录 + 问题反馈：页底单独一行（原来混在编辑表单里 —— 账号级动作
    //    不和资料字段装一起）。两颗都是**登录才有的动作**，所以一起出现、一起消失。
    if (this.isLoggedIn()) {
      const logoutRow = stack.createDiv({ cls: "yl-v3-logout-row" });
      // 「问题反馈」在左、「退出登录」在右 —— 反馈是"我还想继续用、只是想说点什么"，
      // 退出是"不玩了"，顺序照这个轻重排，别把退出口放在顺手的第一个位置。
      const feedback = createButton(logoutRow, { shape: "text", text: "问题反馈" });
      feedback.addEventListener("click", () => this.openFeedback());
      const logout = createButton(logoutRow, { shape: "text", text: "退出登录" });
      logout.addEventListener("click", () => void this.plugin.logoutAccount());
    }
  }

  /**
   * 开反馈弹窗。
   *
   * 提交这一步要**现拿令牌**（`ensureAccessToken`）而不是直接用 settings 里那个：
   * access token 会过期，拿着过期的去撞 401，用户写完的一大段就没了 ——
   * 换令牌是 `main.ts` 的事，这里只负责拿不到时给人话。
   */
  private openFeedback(): void {
    const version = this.plugin.manifest.version;
    new FeedbackModal(this.app, {
      clientVersion: version,
      onSubmit: async (payload) => {
        const token = await this.plugin.ensureAccessToken();
        if (!token) throw new Error("登录状态失效了，重新连接账号后再提交。");
        await submitFeedback(this.plugin.settings, token, {
          kind: payload.kind,
          content: payload.content,
          files: payload.files,
          clientVersion: version,
        });
      },
    }).open();
  }

  /**
   * 「你的学习」：四张核心指标卡 + 热力图（2026-10-04 用户拍板 v2 渐变徽章版，
   * 设计稿 temp/demo/space_cards/v2.html）。顺序固定：连续学习 → 累计学习
   * → 等级 → 总词汇量；旧的「等级 + 连续」两张并排卡由这四张顶替。
   *
   * 数据全是 loadCore / loadV3Stats 备好的本机读数，没有新的加载路径。
   */
  private buildLearnSection(stack: HTMLElement): void {
    const exp = this.progressRows.filter((row) => row.completedAt).length;
    const level = levelFromExp(exp);
    const streak = streakOf(this.counts);
    const activeDays = [...this.counts.values()].filter((n) => n > 0).length;
    const vocabTotal = this.vocab?.length;

    const grid = stack.createDiv({ cls: "yl-pc-grid4" });

    // ① 连续学习：火焰三态 —— 红色=连续中 / 蓝色结冰=断 1~2 天宽限 / 灰色=默认或已断
    const streakCard = grid.createDiv({ cls: "yl-pc-stat" });
    const flameTile = streakCard.createDiv({
      cls: `yl-pc-tile ${
        streak.state === "active" ? "t-fire" : streak.state === "grace" ? "t-ice" : "t-ash"
      }`,
    });
    flameTile.innerHTML = ICON_FLAME;
    if (streak.state === "grace") {
      flameTile.createDiv({ cls: "yl-pc-flake" }).innerHTML = ICON_FLAKE;
    }
    streakCard.createDiv({ cls: "yl-pc-stat-label", text: "连续学习" });
    const streakNum = streakCard.createDiv({ cls: "yl-pc-stat-num yl-pc-num" });
    streakNum.createSpan({ text: String(streak.current) });
    streakNum.createSpan({ cls: "yl-pc-stat-unit", text: "天" });
    streakCard.createDiv({
      cls: "yl-pc-stat-cap",
      text:
        streak.state === "active"
          ? `中断 ${STREAK_GRACE} 天内补学仍可接上`
          : streak.state === "grace"
            ? `宽限还剩 ${streak.graceLeft} 天 · 学一句就接上`
            : exp > 0
              ? `中断超过 ${STREAK_GRACE} 天，从今天重计`
              : "学完一句，点亮火焰",
    });

    // ② 累计学习：有学习记录的天数（与热力图同口径），2026-10-15 由「总句子数」改名换数并移到「连续学习」右侧
    const daysCard = grid.createDiv({ cls: "yl-pc-stat" });
    daysCard.createDiv({ cls: "yl-pc-tile t-sent" }).innerHTML = ICON_TOTAL;
    daysCard.createDiv({ cls: "yl-pc-stat-label", text: "累计学习" });
    const daysNum = daysCard.createDiv({ cls: "yl-pc-stat-num yl-pc-num" });
    daysNum.createSpan({ text: activeDays.toLocaleString() });
    daysNum.createSpan({ cls: "yl-pc-stat-unit", text: "天" });
    daysCard.createDiv({ cls: "yl-pc-stat-cap", text: "累计天数在涨，学习进步不止" });

    // ③ 等级：徽章外套一圈升级进度环（progress 0~1 → 圆弧）
    const lvCard = grid.createDiv({ cls: "yl-pc-stat" });
    const RING_R = 37;
    const ringC = 2 * Math.PI * RING_R;
    const lvWrap = lvCard.createDiv({ cls: "yl-pc-ring" });
    lvWrap.innerHTML =
      `<svg viewBox="0 0 80 80" aria-hidden="true">` +
      `<circle class="yl-pc-ring-bg" cx="40" cy="40" r="${RING_R}"></circle>` +
      `<circle class="yl-pc-ring-fg" cx="40" cy="40" r="${RING_R}" ` +
      `stroke-dasharray="${ringC.toFixed(2)}" ` +
      `stroke-dashoffset="${(ringC * (1 - level.progress)).toFixed(2)}"></circle></svg>`;
    const lvTile = lvWrap.createDiv({ cls: "yl-pc-tile t-acc" });
    lvTile.innerHTML = LEVEL_ICONS[level.level - 1] ?? LEVEL_ICONS[0];
    lvCard.createDiv({ cls: "yl-pc-stat-label", text: "等级" });
    const lvNum = lvCard.createDiv({ cls: "yl-pc-stat-num yl-pc-num" });
    lvNum.createSpan({ text: `Lv.${level.level}` });
    lvNum.createSpan({ cls: "yl-pc-stat-unit", text: level.name });
    lvCard.createDiv({
      cls: "yl-pc-stat-cap",
      text: level.nextName ? `距「${level.nextName}」还差 ${level.toNext} 句` : "已到最高等级「新大陆」",
    });

    // ④ 总词汇量：学过的句子里出现过的所有单词（词库整库去重总数）
    const vocabCard = grid.createDiv({ cls: "yl-pc-stat" });
    vocabCard.createDiv({ cls: "yl-pc-tile t-voc" }).innerHTML = ICON_VOCAB;
    vocabCard.createDiv({ cls: "yl-pc-stat-label", text: "总词汇量" });
    const vocabNum = vocabCard.createDiv({ cls: "yl-pc-stat-num yl-pc-num" });
    vocabNum.createSpan({ text: vocabTotal === undefined ? "—" : vocabTotal.toLocaleString() });
    vocabNum.createSpan({ cls: "yl-pc-stat-unit", text: "词" });
    vocabCard.createDiv({ cls: "yl-pc-stat-cap", text: "学过句中的所有单词" });

    this.buildHeatmap(stack, activeDays, exp);
  }

  // ── 设置（原「钱包」页签）：双轨（自定义模型 / 内置模型）+ 消费记录 ─────
  //
  // 2026-10-02 改版：以前这一页是"收银台"—— 一张余额大卡 + 一颗主色「充值」大按钮，
  // 现在换成**用版面讲产品模式**：自定义模型与内置模型两轨并列，默认落在自带 Key 那轨，
  // 余额和充值缩成 B 轨里的一行字。交易不再是主角，人是。

  private renderWallet(): void {
    const pane = this.panes.wallet;
    if (!pane) return;
    // 重画前先收掉可能还开着的供应商下拉 —— 下面 pane.empty() 会把菜单 DOM 拿掉，
    // 但挂在 document 上的"点外面"监听不会跟着消失，留着就是每重画一次漏一对。
    // （余额刷新到账后会走 renderWallet 重画，那时下拉可能正开着。）
    this.closeProviderMenu?.();
    this.closeProviderMenu = null;
    const settings = this.plugin.settings;
    pane.empty();
    const stack = pane.createDiv({ cls: "yl-pc-stack" });

    // ── 页首说明（2026-10-10 用户拍板）────────────────────────────────
    // 原来页签下那行灰小字说不清"两条轨什么关系"，小白看不懂。换成正文顶部
    // 的**黑字**说明块：先讲二选一，再按"你是谁"给两条路。别写实现术语。
    const guide = stack.createDiv({ cls: "yl-pc-guide" });
    guide.createDiv({
      cls: "yl-pc-guide-main",
      text: "自定义模型和内置模型二选一：配置其中任意一个，本地学习的 AI 功能就能正常使用。用内置模型还附带云同步 —— 学习记录能在多台设备间同步，换机也能恢复。",
    });
    const guideUl = guide.createEl("ul", { cls: "yl-pc-guide-list" });
    for (const line of [
      "自己有大模型的 API Key → 配置到「自定义模型」，请求直连你的服务商，费用由服务商结算。",
      "自己没有大模型的 API Key，或者不明白什么是 API Key → 直接给「内置模型」充值，更简单省事。",
    ]) {
      guideUl.createEl("li", { text: line });
    }

    // stack.createDiv({ cls: "yl-pc-sec", text: "你是怎么用洋流的" });
    const tracks = stack.createDiv({ cls: "yl-pc-grid2" });

    // 用户**显式选**的轨道（2026-10-14 用户拍板）：双卡永远可自由切换 ——
    // 不看余额、不看自定义模型参数填没填完；配没配好、余额够不够，都是
    // **实际调用时**由 resolveAiGate 出各自的报错（need-key / need-balance…）。
    // 所以这里认 settings.aiMode（用户的选择），不认 resolveAiRoute（生效解析：
    // 选了 byok 但没保存过配置时它是 off）。角标「你正在用」跟选择走。
    const picked = settings.aiMode;
    const byokUi = byokUiState(settings);

    /**
     * 方案一（2026-10-12 用户挑定）：双卡等权，**点整卡选中**。
     * 正在用的卡带「你正在用」角标，另一张角标「点这里切换」。
     * 卡内的表单/按钮点击不算选卡（否则点输入框就把轨道切了）。
     */
    const pickTrack = (side: "byok" | "hosted") => (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, button, a, .yl-pc-select, .yl-pc-form")) return;
      if (picked === side) return;
      settings.aiMode = side;
      void this.plugin.saveSettings().then(() => this.renderWallet());
    };

    // A 轨：自定义模型 —— 用自己的 Key，数据不出本机。
    // 2026-10-14 改口径：整卡可点选 = 切到这条轨，**不再要求已保存配置** ——
    // 参数没填完也允许先选上，实际调用时由 gate 报「自定义模型还没配好」。
    // 表单本身仍是 2026-10-10 的「保存/编辑」机制：草稿（settings.byok）
    // 随时可填，**生效的永远是已保存快照**（byokSaved），点「保存」先测
    // 连接，测通才落快照并把轨道切到 byok。
    const byok = tracks.createDiv({
      cls: `yl-pc-track is-clickable${picked === "byok" ? " is-pick" : ""}`,
    });
    byok.addEventListener("click", pickTrack("byok"));
    const byokTop = byok.createDiv({ cls: "yl-pc-track-top" });
    byokTop.createSpan({ cls: "yl-pc-track-radio" });
    setIcon(byokTop.createDiv({ cls: "yl-pc-track-ic" }), "key");
    byokTop.createSpan({ cls: "yl-pc-track-name", text: "自定义模型" });
    byokTop.createSpan({
      cls: "yl-pc-track-flag",
      text: picked === "byok" ? "你正在用" : "点这里切换",
    });
    byok.createDiv({
      cls: "yl-pc-track-copy",
      text: "填一个自己的 Key，全部功能都能用。请求直接发给你选的服务商，我们看不到、也不中转。",
    });
    const bullets = byok.createEl("ul", { cls: "yl-pc-bullets" });
    for (const line of [
      "不限哪一家：任何 OpenAI 兼容接口都能填",
      "调用费用由你的服务商结算，不从这里扣余额",
    ]) {
      const li = bullets.createEl("li");
      setIcon(li.createSpan(), "check");
      li.createSpan({ text: line });
    }
    const byokForm = byok.createDiv({ cls: "yl-pc-form" });
    // 锁定态要把这几个输入框一起锁死（baseUrl 那颗在供应商下拉里，经 deps.makeField 建出）
    const byokInputs: HTMLInputElement[] = [];
    // 表单回显的**生效值**：草稿优先，草稿为空则回落到已保存快照 ——
    // 修复「框是空的、Key 其实还在生效」的自相矛盾（2026-10-12 用户拍板）：
    // 有内容就必须显示出来（password 掩码成圆点 + 眼睛看明文），空 = 真的没存。
    const effByokValue = (key: "baseUrl" | "apiKey" | "model"): string =>
      settings.byok[key].trim() || settings.byokSaved?.[key]?.trim() || "";
    const makeField = (
      label: string,
      key: "baseUrl" | "apiKey" | "model",
      placeholder: string,
      type = "text",
      opts: { secret?: boolean } = {},
    ): { field: HTMLElement; input: HTMLInputElement } => {
      const field = byokForm.createDiv({ cls: "yl-pc-field" });
      field.createDiv({ cls: "yl-pc-faint yl-pc-xs", text: label });
      // type=password 自带掩码：**真值一直在 value 里**，不是摆「••••••••」字面量 ——
      // 那个旧写法会在 change 后被当成真 Key 存下来。眼睛钮只切换 type 显示原文。
      const holder: HTMLElement = opts.secret
        ? field.createDiv({ cls: "yl-pc-keywrap" })
        : field;
      const input = holder.createEl("input", {
        cls: "yl-pc-input",
        attr: { type, placeholder, value: effByokValue(key) },
      });
      byokInputs.push(input);
      if (opts.secret) {
        const eye = holder.createEl("button", {
          cls: "yl-pc-eye",
          attr: { type: "button", "aria-label": "显示或隐藏 API Key" },
        });
        const paintEye = (): void => {
          setIcon(eye, input.type === "password" ? "eye" : "eye-off");
        };
        paintEye();
        // 锁定态只锁输入框，眼睛保持可点：存了 Key 就该随时能看到
        eye.addEventListener("click", () => {
          input.type = input.type === "password" ? "text" : "password";
          paintEye();
        });
      }
      // 锁定态下输入框 disabled，change 不会 fire；编辑态照旧只写**草稿**，
      // 不碰 byokSaved 快照 —— 改动要过「保存」才生效（见下方保存按钮）。
      input.addEventListener("change", async () => {
        // 清空 gesture：快照里还有值时框不许摆成空 —— 「空」必须真的代表没存
        const savedVal = settings.byokSaved?.[key] ?? "";
        if (!input.value.trim() && savedVal) input.value = savedVal;
        settings.byok[key] = input.value.trim();
        await this.plugin.saveSettings();
      });
      return { field, input };
    };

    // ── 供应商下拉（2026-10-09 用户拍板）─────────────────────────────────
    // 「接口地址」不再让人对着官网文档抄：**选一家 = 地址填好**。版面上只出品牌名，
    // 真实地址挂在**零延迟悬停牌**上（原生 title 的系统提示框慢一秒，2026-10-09 用户
    // 点名弃用）。「自定义」是逃生舱 —— 选它才露出输入框，自建代理 / 中转站走这条。
    //
    // 整套（含"点外面收起"那对 document 监听的清理）在 views/providerSelect.ts 里 ——
    // 那边能在 jsdom 里整块真跑单测；这里只负责接上设置、悬停牌与懒建的模型名输入框。
    const providerSelect = buildProviderSelect(byokForm, {
      makeField: (label, placeholder) => makeField(label, "baseUrl", placeholder),
      getBaseUrl: () => effByokValue("baseUrl"),
      onPick: (baseUrl) => {
        // 「自定义」只是"我要手填"，**不清空**已有地址
        if (baseUrl !== null) settings.byok.baseUrl = baseUrl;
        void this.plugin.saveSettings();
      },
      modelInput: () => modelField.input,
      showTip: (el, text) => this.showHoverTip(el, text),
      hideTip: () => this.hideHoverTip(),
      // 清理函数交给视图保管：重画 / 关页时兜底调一次（见 renderWallet 开头与 onClose）
      keepCloser: (close) => {
        this.closeProviderMenu = close;
      },
    });
    makeField("API Key", "apiKey", "sk-…", "password", { secret: true });
    const modelField = makeField("模型名", "model", modelPlaceholder(settings.byok.baseUrl));
    providerSelect.sync(settings.byok.baseUrl);

    // ── 保存 / 编辑 + 测试连接（2026-10-10 拍板）─────────────────────────
    // 用户填好后原来没有任何"保存"动作，总以为没地方存。现在：
    //   · 编辑态：主钮「保存」—— 先测连接，**测通才**落快照 + 切到 byok 轨 +
    //     进锁定态；没测通就报错停在编辑态，想保存也保存不了。
    //   · 锁定态：三输入框 + 供应商下拉 + 测试连接全部只读，主钮变「编辑」，
    //     点一下解锁（快照不动，旧配置继续生效）。
    const testRow = byokForm.createDiv({ cls: "yl-pc-testrow" });
    const saveBtn = createButton(testRow, { text: byokUi.locked ? "编辑" : "保存" });
    const testBtn = createButton(testRow, { text: "测试连接" });
    testRow.createSpan({
      cls: "yl-pc-faint yl-pc-xs",
      text: byokUi.locked ? "配置已锁定，点「编辑」才能修改" : "保存前会先测一次连接，测通才生效",
    });
    saveBtn.addEventListener("click", async () => {
      if (byokUi.locked) {
        settings.byokLocked = false;
        await this.plugin.saveSettings();
        this.renderWallet();
        return;
      }
      // 生效值 = 草稿，缺了回落快照（与输入框回显同一口径，见 effByokValue）
      const draft = {
        baseUrl: effByokValue("baseUrl").replace(/\/+$/u, ""),
        apiKey: effByokValue("apiKey"),
        model: effByokValue("model"),
      };
      if (!draft.baseUrl || !draft.apiKey || !draft.model) {
        new Notice("接口地址、API Key、模型名要先填全，再点保存。");
        return;
      }
      saveBtn.disabled = true;
      saveBtn.setText("保存中…");
      try {
        await chat(draft, [{ role: "user", content: "ping" }], "test", 15_000);
        // ⚠️ 草稿与快照必须是**两个对象**：共用一个引用的话，之后改草稿
        // （settings.byok[key] = …）会把快照一起改掉，「已保存」就名存实亡。
        settings.byok = { ...draft };
        settings.byokSaved = { ...draft };
        settings.byokLocked = true;
        settings.aiMode = "byok";
        await this.plugin.saveSettings();
        new Notice("已保存，自定义模型已生效。");
        this.renderWallet();
      } catch (error) {
        new Notice(
          error instanceof Error
            ? error.message
            : "连接没通，检查接口地址与 Key；没测通之前不能保存。",
        );
        saveBtn.disabled = false;
        saveBtn.setText("保存");
      }
    });
    testBtn.addEventListener("click", async () => {
      testBtn.disabled = true;
      testBtn.setText("测试中…");
      try {
        // 与保存同一口径：草稿缺了回落快照，留空也能测「已保存的 Key」
        const eff = {
          baseUrl: effByokValue("baseUrl").replace(/\/+$/u, ""),
          apiKey: effByokValue("apiKey"),
          model: effByokValue("model"),
        };
        if (!eff.baseUrl || !eff.apiKey || !eff.model) {
          throw new Error("接口地址、API Key、模型名要先填全。");
        }
        await chat(eff, [{ role: "user", content: "ping" }], "test", 15_000);
        new Notice(`连接成功，${eff.model} 有响应。`);
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "连接没通，检查接口地址与 Key。");
      } finally {
        testBtn.disabled = false;
        testBtn.setText("测试连接");
      }
    });
    // 锁定态落地：输入框、供应商下拉触发器、测试连接一起只读
    if (byokUi.locked) {
      for (const input of byokInputs) input.disabled = true;
      providerSelect.trigger.disabled = true;
      testBtn.disabled = true;
    }
    // B 轨：内置模型 —— 省事的另一条，余额只在这一行里。整卡可点选（方案一）。
    const hosted = tracks.createDiv({
      cls: `yl-pc-track is-clickable${picked === "hosted" ? " is-pick" : ""}`,
    });
    hosted.addEventListener("click", pickTrack("hosted"));
    const hostedTop = hosted.createDiv({ cls: "yl-pc-track-top" });
    hostedTop.createSpan({ cls: "yl-pc-track-radio" });
    setIcon(hostedTop.createDiv({ cls: "yl-pc-track-ic is-dim" }), "cloud");
    hostedTop.createSpan({ cls: "yl-pc-track-name", text: "内置模型" });
    hostedTop.createSpan({
      cls: "yl-pc-track-flag",
      text: picked === "hosted" ? "你正在用" : "点这里切换",
    });
    hosted.createDiv({
      cls: "yl-pc-track-copy",
      text: "无需配置模型，选这条就能用，按用量扣余额。",
    });
    const perks = hosted.createEl("ul", { cls: "yl-pc-bullets" });
    for (const line of [
      "额外支持核心学习记录云同步、发音评估，获得更加准确的注音",
      "按使用量计费，充值并保有余额即永久享受云同步",
      "赞助本项目，以便维持服务器开销和运营成本",
      "前 1000 名付费用户，将在 GitHub 项目感谢榜永久留名",
    ]) {
      const li = perks.createEl("li");
      setIcon(li.createSpan(), "check");
      li.createSpan({ text: line });
    }
    const kv = hosted.createDiv({ cls: "yl-pc-track-kv" });
    kv.createSpan({ text: "余额" });
    // 余额卡固定两位（2026-10-09 拍板，与网页账户页同一个口径）
    kv.createEl("b", { cls: "yl-pc-num", text: yuan(settings.aiBalanceMillis, { fixed: 2 }) });
    kv.createSpan({ cls: "yl-pc-grow" });
    const recharge = createButton(kv, { text: "充值" });
    recharge.addEventListener("click", () => {
      // 充值（连带登录 / 注册）全在网页完成：余额记在账号下，连上账号后插件就能用。
      // 插件侧要账号时走「连接账号」弹窗（学习页 / 悬浮卡 / 插件设置）。
      window.open(`${this.plugin.webBase()}/pricing`, "_blank");
    });

    // ── 消费记录（账户页底部）─────────────────────────────────────────
    // 一次只看**一个 3 个月窗口**，往下滚只在这个窗口里继续加载；往更早看是
    // 换一档窗口，不是一路滚下去（views/spendSection.ts）。
    //
    // ⚠️ 两条通路别混：
    //   · 自定义模型 → 明细**只在本机**（IndexedDB `ai_usage`），一次也不上行；
    //   · 内置模型  → 明细**从服务端拉**（`billing.WalletTransaction`）。
    this.spend?.destroy();
    this.spend = null;
    const records = stack.createDiv({ cls: "yl-pc-card" });
    if (picked === "off") {
      const recHead = records.createDiv({ cls: "yl-pc-h3" });
      recHead.createSpan({ text: "消费记录" });
      recHead.createSpan({ cls: "yl-pc-cnt", text: "AI 还没开启" });
      records.createDiv({ cls: "yl-pc-loading", text: "到上面两条轨里选一条就能用。" });
    } else {
      const common = {
        // 滚动条在 .yl-v3-body 上（pane 自己不滚），哨兵要挂在它里面观察
        scrollRoot: this.scrollEl,
        dayKey: localDayOf,
        dayText: humanDay,
        dayMark: (day: string) => dayLabel(day).slice(0, 2),
      };
      // ⚠️ 两条轨的 `source` 各是各的类型（本机行 / 服务端流水行），
      //    合成一个三元表达式会让泛型推断成 union 而报错 —— 分两支各建各的。
      this.spend =
        picked === "byok"
          ? buildSpendSection(records, { ...common, source: this.byokSpendSource() })
          : buildSpendSection(records, { ...common, source: this.hostedSpendSource() });
    }

    // 余额的本地缓存可能过期（网页端充了值、插件这边不知道）：进这一页顺手拉一次，
    // 拉到了就更新缓存并重画。走哪条轨由用户选择决定（2026-10-12 拍板），余额只
    // 影响内置模型本身能不能用。失败不打扰，显示旧值。
    void this.refreshBalance();
  }

  /** 拉一次最新余额更新缓存（顺带把消费明细也备好）；防重入，变了才重画。 */
  private async refreshBalance(): Promise<void> {
    if (this.refreshingBalance || !this.isLoggedIn()) return;
    this.refreshingBalance = true;
    try {
      // 只要余额：不带 month、limit 取最小 —— 明细由下面消费记录那块自己按档拉
      const wallet = await fetchWallet(this.plugin.settings, { limit: 1 });
      this.wallet = wallet;
      const millis = wallet.balance_millis;
      if (millis !== this.plugin.settings.aiBalanceMillis) {
        this.plugin.settings.aiBalanceMillis = millis;
        await this.plugin.saveSettings();
        if (this.activeTab === "wallet") this.renderWallet();
        // 余额刚变了 = 网页端充值到账了。开着的学习页 AI 按钮要立刻解锁，别让
        // 用户再点一次还弹"余额不够"。refreshOpenViews 会重建本视图（自己正在
        // render 中途），延后一拍等这轮渲染走完。
        window.setTimeout(() => void this.plugin.refreshOpenViews(), 0);
      }
    } catch {
      // 余额拿不到就算了：本地缓存是什么就显示什么
    } finally {
      this.refreshingBalance = false;
    }
  }

  // ── 消费记录的两条通路 ───────────────────────────────────────────────
  //
  // ⚠️ 这两条**永远不要合成一条**：
  //   · 自定义模型（BYOK）的明细**只在本机** —— 翻 IndexedDB，一行都不上行；
  //   · 内置模型的明细**在服务端** —— 翻 `/api/v1/billing/wallet/`。
  // 两边共用同一个壳子（范围下拉 + 窗口内滚动，见 views/spendSection.ts），
  // 但数据来源各走各的。混了就等于把「自定义模型的数据不出本机」这条承诺破掉。

  /** 自定义模型：读本机 `ai_usage`。 */
  private byokSpendSource(): SpendSource<ByokUsageRow> {
    return {
      note: "自定义模型 · 只记在本机",
      emptyText: "这一段时间没有调用记录 —— 自定义模型的用量只留在这台电脑上。",
      timeOf: (row) => row.ts,
      sumOf: (row) => row.prompt_tokens + row.completion_tokens,
      sumText: (sum) => `${sum} token`,
      renderRow: (parent, row) => {
        const record = parent.createDiv({ cls: "yl-pc-tx" });
        const sc = record.createDiv({ cls: "yl-pc-sc" });
        sc.createDiv({ text: sceneText(row.scene, row.scene) });
        sc.createDiv({
          cls: "yl-pc-faint yl-pc-xs",
          text: `${timeLabel(row.ts)} · ${row.model} · 入 ${row.prompt_tokens} / 出 ${row.completion_tokens}`,
        });
        record.createDiv({
          cls: "yl-pc-amt num",
          text: `${row.prompt_tokens + row.completion_tokens} token`,
        });
      },
      loadPage: (month, cursor) => this.loadByokPage(month, cursor),
    };
  }

  /** 内置模型：向服务端要一页（3 个月窗口 + id 游标）。 */
  private hostedSpendSource(): SpendSource<WalletTransactionRow> {
    return {
      note: "内置模型 · 记金额",
      emptyText: "这一段时间没有消费记录。",
      timeOf: (row) => row.created_at,
      sumOf: (row) => row.delta_millis,
      // 金额一律定长三位（10-09 账户页拍板）：一列里位数不齐根本对不上账
      sumText: (sum) => signedYuan(sum, { fixed: 3 }),
      // 净额为正的那几天（充值 / 退款）点亮 —— 一水儿的消费额里它才找得着
      sumTone: (sum) => sum > 0,
      renderRow: (parent, tx) => {
        const row = parent.createDiv({ cls: "yl-pc-tx" });
        const sc = row.createDiv({ cls: "yl-pc-sc" });
        // 名称与「要不要补小字」共用 billingApi 里那一份规则（网页端同一份）
        sc.createDiv({ text: txnName(tx) });
        const sub = txnSubNote(tx);
        if (sub) sc.createDiv({ cls: "yl-pc-faint yl-pc-xs", text: sub });
        const amount = row.createDiv({
          cls: `yl-pc-amt num ${tx.delta_millis > 0 ? "plus" : ""}`,
        });
        amount.setText(signedYuan(tx.delta_millis, { fixed: 3 }));
        row.createDiv({
          cls: "yl-pc-bal num",
          text: `余 ${yuan(tx.balance_after_millis, { fixed: 3 })}`,
        });
      },
      loadPage: (month, cursor) => this.loadHostedPage(month, cursor),
    };
  }

  /** 本机分页：先按窗口过滤，再按"已加载条数"切页（没有服务端可问，自己算）。 */
  private async loadByokPage(
    month: string | null,
    cursor: string | null,
  ): Promise<SpendPage<ByokUsageRow>> {
    const usage = await this.ensureByokUsage();
    const { start, end } = windowRangeOf(month);
    const inWindow = usage.filter((row) => {
      const t = new Date(row.ts);
      return t >= start && t < end;
    });
    const offset = cursor ? Number(cursor) || 0 : 0;
    const rows = inWindow.slice(offset, offset + SPEND_PAGE_SIZE);
    const next = offset + rows.length < inWindow.length ? String(offset + rows.length) : null;
    // 全量是倒序的：最后一条就是最早一笔 —— 下拉靠它决定列到哪一档
    return { rows, cursor: next, oldest: usage.length ? usage[usage.length - 1].ts : null };
  }

  /** 服务端分页：窗口 = `month`，游标 = 上一页最后一条的 id。 */
  private async loadHostedPage(
    month: string | null,
    cursor: string | null,
  ): Promise<SpendPage<WalletTransactionRow>> {
    const wallet = await fetchWallet(this.plugin.settings, {
      month,
      before_id: cursor ? Number(cursor) : null,
      limit: SPEND_PAGE_SIZE,
    });
    // 服务端已按 id 倒序回，这里再按时间排一次 —— 跟本机那条轨的顺序口径一致
    const rows = [...wallet.transactions].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
    const last = rows[rows.length - 1];
    return {
      rows,
      // has_more 却一页空 = 别再翻了，否则会一直空转
      cursor: wallet.has_more && last ? String(last.id) : null,
      oldest: wallet.oldest_created_at ?? null,
    };
  }

  /** 本机 AI 用量全量（倒序）；读一次缓存住，换档不再翻库。 */
  private async ensureByokUsage(): Promise<ByokUsageRow[]> {
    if (!this.byokUsage) {
      this.byokUsage = (
        await this.plugin.db.getAll<ByokUsageRow>(STORE.aiUsage)
      ).sort((a, b) => b.ts.localeCompare(a.ts));
    }
    return this.byokUsage;
  }

  // ── 学习 / 词库公共：直接铺开，没有付费墙 ─────────────────────────────
  //
  // ⚠️ 这里原来是 renderWithLock：余额为 0 就把整片内容 blur 掉，压一层
  // 「请充值后使用」的浮层。2026-10-02 用户拍板撤掉 —— 学习 / 词库读的全是
  // 本机已有记录，跟余额一点关系没有，"本地功能免费用"不能只写在文案里。
  // 现在只剩一个包装，留着是为了别处不再各自 createDiv 一遍。

  private renderPane(pane: HTMLElement, buildContent: (inner: HTMLElement) => void): void {
    pane.empty();
    const inner = pane.createDiv({ cls: "yl-pc-pane-inner" });
    buildContent(inner);
  }

  // ── 学习：等级 / 连续 / 热力图 ────────────────────────────────────────
  //
  // 原「学习」页签的内容，2026-10-02 起并入资料页「你的学习」节
  // （buildLearnSection）。余额不在这里重复出现；四个数字 tiles 已删 ——
  // 累计/词库/连续与资料页 hero 的小结重复。

  /** 近一年热力图：每天一格，颜色越深学得越多。全年 364 格横向铺开。 */
  private buildHeatmap(parent: HTMLElement, activeDays: number, exp: number): void {
    const heat = heatmapSeries(this.counts, 364);
    // 与上面四张指标卡同一质感：白卡 + 同款圆角投影（wash 晕染 2026-10-05 退场）
    const card = parent.createDiv({ cls: "yl-pc-card yl-pc-card-lift" });
    const head = card.createDiv({ cls: "yl-pc-h3" });
    head.createSpan({ text: "学习热力图" });
    head.createSpan({ cls: "yl-pc-cnt", text: `近一年 ${activeDays} 天有学习 · ${exp} 句` });
    const wrap = card.createDiv({ cls: "yl-pc-hm-wrap" });
    const hm = wrap.createDiv({ cls: "yl-pc-hm" });
    const max = Math.max(1, ...heat.map((x) => x.count));
    for (const d of heat) {
      const cell = hm.createDiv();
      if (d.count > 0) {
        const ratio = d.count / max;
        cell.addClass(ratio <= 0.25 ? "l1" : ratio <= 0.6 ? "l2" : "l3");
      }
      // 读数放 dataset，悬停时由下面共用的小黑牌展示。⚠️ 原生 title 弹的是
      // 系统提示框，天生慢一秒 —— 用户点名要"瞬间出"（2026-10-09），弃用。
      const date = `${Number(d.day.slice(5, 7))}月${Number(d.day.slice(8, 10))}日`;
      cell.dataset.tip = d.count > 0 ? `${date} · ${d.count} 句` : `${date} · 没学`;
    }
    // 悬停读数牌：零延迟的公用小黑牌（this.showHoverTip，挂在 body 上做固定定位）
    // —— 不做成格子内的 CSS 浮层，因为 .yl-pc-hm-wrap 是滚动容器
    // （overflow-x: auto），露头的绝对定位浮层会被整圈裁掉。
    const tip = this.ensureHoverTip();
    const moveTip = (cell: HTMLElement) => {
      this.showHoverTip(cell, cell.dataset.tip ?? "");
    };
    hm.addEventListener("mouseover", (ev) => {
      const target = ev.target;
      // 格子没有子元素，悬停目标就是格子本身
      if (target instanceof HTMLElement && target.parentElement === hm) moveTip(target);
    });
    hm.addEventListener("mouseleave", () => tip.hide());
    // 横向滚动格子时牌子跟不上（fixed 定位不随容器滚），直接收掉
    wrap.addEventListener("scroll", () => tip.hide(), { passive: true });
    // 月份刻度：与热力图同一套列宽的一行 —— 哪一列里含有某个月的 1 号，
    // 就在哪一列下面标那个月（GitHub 同款）。格子按周一分列，一列 = 一周。
    const months = wrap.createDiv({ cls: "yl-pc-months" });
    for (let col = 0; col * 7 < heat.length; col += 1) {
      const slot = months.createDiv({ cls: "yl-pc-month" });
      for (let d = col * 7; d < Math.min(col * 7 + 7, heat.length); d += 1) {
        const day = heat[d].day;
        if (day.slice(8) === "01") {
          slot.setText(`${Number(day.slice(5, 7))}月`);
          break;
        }
      }
    }
    const legend = card.createDiv({ cls: "yl-pc-legend" });
    legend.createSpan({ text: "少" });
    for (const cls of ["l1", "l2", "l3"]) legend.createDiv({ cls: `yl-pc-legend-dot ${cls}` });
    legend.createSpan({ text: "多" });
    legend.createSpan({ cls: "yl-pc-legend-note", text: "每天一格 · 颜色越深学得越多" });

  }

  // ── 词库 ─────────────────────────────────────────────────────────────
  //
  // 2026-10-04 改版（用户拍板）：不再分熟练档 —— 每个词就是一条账
  // （单词 / 读音 / 罗马音 / 释义 / 例句 / 学习次数 / 最近学习时间），
  // 两个排序（最近学习 / 学习次数）。
  // 2026-10-09（用户拍板）：排序钮加表头同款双三角指示符；「导出 CSV」
  // 把整本词库（按当前排序）导出 —— 恒为整本，不受筛选影响。
  // 2026-10-10（用户拍板）：翻页（20 条/页页码条）退场，改成**筛选 + 滚动
  // 加载（30 条/批）**。
  // 2026-10-10 二次拍板：五十音首字胶囊行整行退场，工具行收成一排 ——
  // 「最近学习 / 学习次数 / 搜索框 / 搜索钮 …… 导出 CSV」，且**按下搜索才筛**。
  // 主体在 views/vocabSection.ts。

  private renderVocab(): void {
    const pane = this.panes.vocab;
    if (!pane) return;
    this.vocabSec?.destroy();
    this.vocabSec = null;
    this.renderPane(pane, (inner) => {
      if (!this.vocab) {
        void this.loadVocab();
        inner.createDiv({ cls: "yl-pc-loading", text: "正在从本地学习记录里整理词库…" });
        return;
      }
      const vocab = this.vocab;
      const stack = inner.createDiv({ cls: "yl-pc-stack" });

      // 2026-10-17 用户拍板：页内那颗「词库」标题撤掉 —— 页头写的就是「词库」，
      // 再来一颗纯属重复；计数改挂页头说明行行尾（headCntEl，见 renderHeadTitle）。
      if (vocab.length === 0) {
        stack.createDiv({
          cls: "yl-pc-loading",
          text: "学完一句，句子里的词会自动进词库。",
        });
        return;
      }

      const countEl = this.headCntEl ?? document.createElement("span");

      this.vocabSec = buildVocabSection(stack, {
        scrollRoot: this.scrollEl,
        countEl,
        total: vocab.length,
        all: () => this.vocab ?? [],
        compare: (a, b) => this.compareVocab(a, b),
        renderRow: (parent, entry) => this.vocabRowEl(parent, entry),
        initialQuery: this.vocabQuery,
        onSearch: (query) => {
          this.vocabQuery = query;
        },
        fillToolbarLeading: (row) => this.fillVocabSorts(row),
        fillToolbarTrailing: (row) => this.fillVocabExport(row),
      });
    });
  }

  /** 词库排序比较器（主键 + 方向由 vocabSort/vocabDir 定，同值次序稳定不随方向翻）。 */
  private compareVocab(a: VocabEntry, b: VocabEntry): number {
    const dirMul = this.vocabDir === "asc" ? 1 : -1;
    const primary =
      this.vocabSort === "recent"
        ? dirMul * a.lastSeenAt.localeCompare(b.lastSeenAt)
        : dirMul * (a.seen - b.seen);
    if (primary !== 0) return primary;
    const bySeen = b.seen - a.seen;
    if (bySeen !== 0) return bySeen;
    return a.surface.localeCompare(b.surface, "ja");
  }

  /** 整本词库按当前排序铺平 —— 导出 CSV 专用（恒为整本，不受筛选影响）。 */
  private sortedVocab(): VocabEntry[] {
    return [...(this.vocab ?? [])].sort((a, b) => this.compareVocab(a, b));
  }

  /** 词库工具行左段：排序双钮（搜索框 / 搜索钮由 vocabSection 建在中间，导出在右段）。 */
  private fillVocabSorts(row: HTMLElement): void {
    const sortDefs: [typeof this.vocabSort, string][] = [
      ["recent", "最近学习"],
      ["seen", "学习次数"],
    ];
    const chips: { key: "recent" | "seen"; btn: HTMLButtonElement }[] = [];
    const paint = (): void => {
      for (const { key, btn } of chips) {
        btn.removeClass("is-active", "is-asc", "is-desc");
        if (this.vocabSort === key) {
          btn.addClass("is-active", this.vocabDir === "asc" ? "is-asc" : "is-desc");
        }
      }
    };
    for (const [key, label] of sortDefs) {
      const chip = createButton(row, { text: label, cls: "yl-vb-sort" });
      // 表头排序指示符同款：上下两枚小三角叠在一起。默认都淡显（「默认」形态）；
      // 当前键按方向点亮一枚（升序 / 降序形态），样式见 styles.css .yl-sort-caret。
      chip.insertAdjacentHTML(
        "beforeend",
        '<svg class="yl-sort-caret" viewBox="0 0 8 12" aria-hidden="true">' +
          '<path class="up" d="M4 1.2 L7 5.2 H1 Z"></path>' +
          '<path class="down" d="M4 10.8 L1 6.8 H7 Z"></path></svg>',
      );
      chips.push({ key, btn: chip });
      chip.addEventListener("click", () => {
        if (this.vocabSort !== key) {
          this.vocabSort = key;
          this.vocabDir = "desc";
        } else {
          this.vocabDir = this.vocabDir === "desc" ? "asc" : "desc";
        }
        // ⚠️ 只就地重筛（vocabSection.refilter），**不重画整块** —— 工具行
        //    重建会把搜索框的焦点和用户已经打进去的字一起打丢。
        paint();
        void this.vocabSec?.refilter();
      });
    }
    paint();
  }

  /** 词库工具行右段：导出钮（摆最右，margin-left:auto，见 styles.css）。 */
  private fillVocabExport(row: HTMLElement): void {
    // 导出的是**整本词库**（按当前排序），不受搜索筛选影响。
    // ⚠️ 图标**不能走 createButton 的 icon 参数**：setIcon 会先清空按钮内容，
    //    文字被整个吞掉（2026-10-09 实撞：导出钮只剩一枚图标）。改成先 setIcon
    //    再补文字 span —— 图标在前、文字在后。
    const exportBtn = createButton(row, {
      cls: "yl-vb-export",
      ariaLabel: "把词库导出成 CSV 文件（含未筛选的词）",
      onClick: () => void this.exportVocabCsv(this.sortedVocab()),
    });
    setIcon(exportBtn, "download");
    exportBtn.createSpan({ text: "导出 CSV" });
  }

  /** 词库一行（单词+读音 | 释义+例句 | 次数+最近学习），旧 renderVocab 循环体原样搬来。 */
  private vocabRowEl(parent: HTMLElement, entry: VocabEntry): void {
    const row = parent.createDiv({ cls: "yl-vb-row" });
    const w = row.createDiv({ cls: "yl-vb-word" });
    w.createDiv({ cls: "yl-vb-surface", text: entry.surface });
    // 读音：假名在前（查词的习惯），罗马音跟在后面；两个都没有才给 —
    w.createDiv({
      cls: "yl-vb-reading",
      text: [entry.reading, entry.romaji].filter(Boolean).join(" · ") || "—",
    });
    const main = row.createDiv({ cls: "yl-vb-main" });
    main.createDiv({ cls: "yl-vb-meaning", text: entry.meaning || "（还没有释义）" });
    if (entry.example) {
      main.createDiv({ cls: "yl-vb-example", text: `仿写：${entry.example}` });
    }
    const side = row.createDiv({ cls: "yl-vb-side" });
    side.createDiv({ cls: "yl-vb-seen", text: `${entry.seen} 次` });
    side.createDiv({ cls: "yl-vb-last", text: humanDay(localDayOf(entry.lastSeenAt)) });
  }

  private async loadVocab(): Promise<void> {
    // 与 loadV3Stats 同源：那一趟已经连词库一起算好了，这里只兜底
    // （正常路径下 render() 早把 this.vocab 备好了，走不到这儿）。
    if (this.vocab) return;
    await this.loadV3Stats();
  }

  /**
   * 把词库导出成 CSV。**先弹系统保存框让用户挑位置**（2026-10-09 用户拍板：
   * 直接落到 vault 根目录用户找不到文件在哪），再写到选中的路径。
   * · 开头带 UTF-8 BOM：Excel / WPS 双击打开才不会把日文读成乱码；
   * · 含逗号 / 引号 / 换行的字段按 RFC 4180 加引号转义（日文释义里很可能有逗号）；
   * · 行顺序 = 页面上当前的排序；导出的永远是整本，不是当前翻到的这一页。
   */
  private async exportVocabCsv(entries: VocabEntry[]): Promise<void> {
    if (entries.length === 0) {
      new Notice("词库还是空的，没有可导出的词。");
      return;
    }
    const esc = (v: string): string =>
      /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const header = ["单词", "读音", "罗马音", "释义", "学习次数", "最近学习", "例句（仿写）"];
    const lines = [header.map(esc).join(",")];
    for (const e of entries) {
      lines.push(
        [
          e.surface,
          e.reading,
          e.romaji,
          e.meaning,
          String(e.seen),
          localDayOf(e.lastSeenAt),
          e.example,
        ]
          .map(esc)
          .join(","),
      );
    }
    const content = "\uFEFF" + lines.join("\r\n");
    const defaultName = `词库-${localDayOf(new Date().toISOString())}.csv`;

    const saved = await saveTextViaSystemDialog(defaultName, content);
    if (saved === null) return; // 用户取消了保存框，不算出错
    if (saved === undefined) {
      // 这个环境拿不到系统保存框：导出就此结束 —— 不往笔记库里塞文件
      // （2026-10-10 用户拍板：导出一律由用户自己选位置，插件不往库里写东西）
      new Notice("这个环境弹不出保存窗口，导出没做成。");
      return;
    }
    new Notice(`已导出 ${entries.length} 个词到 ${saved}`);
  }

  // ── 历史（初名句库）──────────────────────────────────────────────────
  //
  // 学完（三步做完）的每一句一条账，按集分组，组固定「最近学习的集在前」。
  // 2026-10-09 V4 时间线版（用户挑版）：组内左侧一条轴，节点先标「哪天学的」，
  // 句子行挂在节点下；排序钮两颗（句子顺序 / 学习时间）+ 导出 CSV，
  // 样式与交互照词库页签（.yl-vb-sort / .yl-vb-export）。
  // 2026-10-10（用户拍板）：加「3 个月一档」范围下拉（按完成时间，默认最近
  // 3 个月），档内滚动加载 30 条/批 —— 与消费记录同一套口径，主体在
  // views/historySection.ts；组头「学完 N 句」随之变为**档内**句数。
  // 「打开」→ 新开学习页 tab 落到那一句（视频不在则跳不了，藏钮）。
  // 用户在学习页亲手写的笔记（原「便签」概念退场）不用点按钮，
  // 用白纸容器（.yl-sl-paper）直接跟在句下展示。

  /**
   * 整理历史：进度行的完成时刻对上现行切片，按集分组。
   *
   * ⚠️ **历史是用户的数据资产，不认"素材在不在"**（2026-10-14 用户拍板，
   * 见 docs/rules/principle.md）：分组遍历的是**全部**记录（含软删的），
   * 因为移除一集只软删记录行、台词行（`lines`）一条没删 —— 那一集学过的句子
   * 照常以**真原句**出现，不因为首页那一条被移除就从历史里消失。
   *
   * 切片是内容派生 cid：同一份字幕重导 cid 不变，进度照常对得上；字幕真换了
   * 内容，旧完成记录对不上现行切片，那一句就不出现（那一集重学即可，不值得
   * 为它留一条跳不过去的死账）—— 这是对**本机有切片行**的句子。
   * 换机拉回来的完成记录（孤儿，本机连台词行都没有）同样要保住：
   * 见 mergeOrphanRows。
   */
  private async loadSentences(): Promise<void> {
    if (this.sentenceGroups) return;
    // 同一句的进度行可能不止一条（重学），完成时刻取最早那次（行也留着，
    // 孤儿行要从它身上读仿写/抄写与 provenance）
    const doneAt = new Map<string, string>();
    const doneRow = new Map<string, ProgressRow>();
    for (const row of this.progressRows) {
      if (!row.completedAt) continue;
      const prev = doneAt.get(row.sliceCid);
      if (!prev || row.completedAt < prev) {
        doneAt.set(row.sliceCid, row.completedAt);
        doneRow.set(row.sliceCid, row);
      }
    }
    const groups: SentenceGroup[] = [];
    const groupByEpisode = new Map<string, SentenceGroup>();
    // 笔记一趟整库取回（一句一行、键 = sliceCid；空 text 是删除墓碑）：
    // 历史页几十行逐句 get 太碎，一次 getAll 建好映射
    const noteTexts = await this.loadNoteTexts();
    // ⚠️ 遍历**全部**记录（含软删的）：见 loadSentences 头注释的口径
    const records = await this.plugin.db.getAll<RecordRow>(STORE.records);
    const placed = new Set<string>();
    for (const record of records) {
      const rows: SentenceRow[] = [];
      for (const slice of await loadStudySentences(this.plugin.db, record.cid)) {
        const at = doneAt.get(slice.cid);
        if (!at) continue;
        rows.push({
          slice,
          completedAt: at,
          note: noteTexts.get(slice.cid.slice(2)) ?? "",
        });
        placed.add(slice.cid);
      }
      if (rows.length === 0) continue;
      // 视频在不在拿现行文件实测：AssetRow.available 是上次核对时的旧账，
      // 外接盘拔了它还说是 —— 灰不灰得以文件说话
      const video = await this.plugin.db.get<AssetRow>(
        STORE.assets,
        assetShaCid(record.videoSha256),
      );
      const group: SentenceGroup = {
        recordCid: record.cid,
        label: recordLabelOf(record),
        videoOk: video ? await fileExists(video.localPath) : false,
        rows,
        lastAt: rows.reduce((max, r) => (r.completedAt > max ? r.completedAt : max), rows[0].completedAt),
      };
      groups.push(group);
      groupByEpisode.set(group.recordCid, group);
    }
    await this.mergeOrphanRows(doneAt, doneRow, noteTexts, records, placed, groups, groupByEpisode);
    groups.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    for (const group of groups) group.rows.sort((a, b) => this.rowIndexOf(a) - this.rowIndexOf(b));
    this.sentenceGroups = groups;
  }

  private async mergeOrphanRows(
    doneAt: Map<string, string>,
    doneRow: Map<string, ProgressRow>,
    noteTexts: Map<string, string>,
    records: RecordRow[],
    placed: ReadonlySet<string>,
    groups: SentenceGroup[],
    groupByRecord: Map<string, SentenceGroup>,
  ): Promise<void> {
    const recordByCid = new Map(records.map((r) => [r.cid, r] as const));

    for (const [sliceCid, at] of doneAt) {
      const row = doneRow.get(sliceCid);
      if (!row) continue;
      // 本机已经有真切片行的句子不再造孤儿行 —— 否则换机后重导素材，
      // 同一句会既出现在真组里、又多出一条灰色的顶替行
      if (placed.has(sliceCid)) continue;
      const prov = (row as unknown as { provenance?: SyncProvenance }).provenance;
      if (!prov || typeof prov.record_cid !== "string") continue;

      const orphan: OrphanInfo = {
        cid: sliceCid,
        index: typeof prov.slice_index === "number" ? prov.slice_index : 0,
        // 仿写优先（用户拍板）；没写过退抄写 —— 抄写是逐字打的原句
        text: row.imitationText || row.copyText || "",
        translation:
          row.imitationText && row.imitationFeedback?.translation
            ? row.imitationFeedback.translation
            : "",
      };
      const srow: SentenceRow = {
        slice: null,
        completedAt: at,
        note: noteTexts.get(sliceCid.slice(2)) ?? "",
        orphan,
      };

      // 这条记录本机还有（哪怕是软删的）：并进它的组（组还没开就现开一个 ——
      // 行全是孤儿，跳不了）。标签一律优先用本机记录名，云端 provenance 只兜底
      const record = recordByCid.get(prov.record_cid);
      let group = record ? groupByRecord.get(record.cid) : undefined;
      if (!group) {
        const number = typeof prov.episode_number === "number" ? prov.episode_number : 0;
        const label = record
          ? recordLabelOf(record)
          : `${(prov.record_title || "已学过的句子").trim()}${number ? ` E${number}` : ""}`;
        group = {
          recordCid: record ? record.cid : `orphan:${prov.record_cid}`,
          label,
          videoOk: false,
          rows: [],
          lastAt: at,
        };
        groups.push(group);
        if (record) groupByRecord.set(record.cid, group);
      }
      group.rows.push(srow);
      if (at > group.lastAt) group.lastAt = at;
    }
  }

  /** 行排序键：真切片用句序；孤儿行用 provenance 里的句序，混在一组里也能排进去。 */
  private rowIndexOf(row: SentenceRow): number {
    return row.slice ? row.slice.index : (row.orphan?.index ?? 0);
  }

  /** 我的笔记一趟取回（键 = 三句 hash，走统一缓存；登录拉服务端、未登录读本机）。 */
  private async loadNoteTexts(): Promise<Map<string, string>> {
    try {
      return await loadMyNotes(this.plugin.settings, this.plugin.db);
    } catch (error) {
      log.warn("读取笔记失败", error);
      return peekMyNotes() ?? new Map();
    }
  }

  /**
   * 笔记在学习页随时可改（收起即保存），而分组是缓存的 —— 历史页每次进来
   * 都重拉一遍笔记，别让纸上显示旧字。一趟 getAll，很便宜。
   */
  private async refreshSentenceNotes(): Promise<void> {
    const groups = this.sentenceGroups;
    if (!groups) return;
    const noteTexts = await this.loadNoteTexts();
    for (const g of groups) {
      for (const r of g.rows) {
        // 笔记键 = 三句 hash（切片 cid 去前缀）；孤儿行从 OrphanInfo 拿
        const cid = r.slice ? r.slice.cid : r.orphan?.cid;
        r.note = cid ? (noteTexts.get(cid.slice(2)) ?? "") : "";
      }
    }
  }

  private async renderSentences(): Promise<void> {
    const pane = this.panes.sentences;
    if (!pane) return;
    this.historySec?.destroy();
    this.historySec = null;
    if (!this.sentenceGroups) {
      pane.empty();
      pane.createDiv({ cls: "yl-pc-loading", text: "正在整理学完的句子…" });
      await this.loadSentences();
    } else {
      await this.refreshSentenceNotes();
    }
    pane.empty();
    const stack = pane.createDiv({ cls: "yl-pc-stack" });

    // 页内那颗「历史」标题 2026-10-17 撤掉（用户拍板）：页头写的就是「历史」，
    // 页内再写一遍是重复。列表直接接在页头下面。
    const groups = this.sentenceGroups ?? [];
    if (groups.length === 0) {
      const card = stack.createDiv({ cls: "yl-pc-card" });
      card.createDiv({
        cls: "yl-pc-loading",
        text: "还没有学完的句子。学完一句（三步做完）就会自动记到这里。",
      });
      return;
    }

    // 工具行：范围下拉（historySection 自己 prepend 进最左）+ 排序钮 + 导出
    // （样式与交互照词库页签：双三角指示符三种形态，导出摆最右）。
    // 切排序就地重筛 —— 分组是缓存的，重筛很便宜。
    const sorts = stack.createDiv({ cls: "yl-pc-filters" });
    const sortDefs: [typeof this.sentenceSort, string][] = [
      ["index", "句子顺序"],
      ["time", "学习时间"],
    ];
    const chips: { key: "index" | "time"; btn: HTMLButtonElement }[] = [];
    const paint = (): void => {
      for (const { key, btn } of chips) {
        btn.removeClass("is-active", "is-asc", "is-desc");
        if (this.sentenceSort === key) {
          btn.addClass("is-active", this.sentenceDir === "asc" ? "is-asc" : "is-desc");
        }
      }
    };
    for (const [key, label] of sortDefs) {
      const chip = createButton(sorts, { text: label, cls: "yl-vb-sort" });
      chip.insertAdjacentHTML(
        "beforeend",
        '<svg class="yl-sort-caret" viewBox="0 0 8 12" aria-hidden="true">' +
          '<path class="up" d="M4 1.2 L7 5.2 H1 Z"></path>' +
          '<path class="down" d="M4 10.8 L1 6.8 H7 Z"></path></svg>',
      );
      chips.push({ key, btn: chip });
      chip.addEventListener("click", () => {
        if (this.sentenceSort !== key) {
          this.sentenceSort = key;
          // 各回各的默认方向：句子顺序天然从小到大，学习时间默认最近在前
          this.sentenceDir = key === "index" ? "asc" : "desc";
        } else {
          this.sentenceDir = this.sentenceDir === "desc" ? "asc" : "desc";
        }
        paint();
        void this.historySec?.refilter();
      });
    }
    paint();
    // ⚠️ 图标不能走 createButton 的 icon 参数（setIcon 先清空内容，文字被吞，
    // 2026-10-09 词库导出钮实撞过）—— 先 setIcon 再补文字 span。
    const exportBtn = createButton(sorts, {
      cls: "yl-vb-export",
      ariaLabel: "把学习历史导出成 CSV 文件",
      onClick: () => void this.exportHistoryCsv(),
    });
    setIcon(exportBtn, "download");
    exportBtn.createSpan({ text: "导出 CSV" });

    this.historySec = buildHistorySection(stack, {
      source: this.historySource(),
      filterRow: sorts,
      scrollRoot: this.scrollEl,
      initialMonth: this.sentenceWindowMonth,
      onMonthChange: (month) => {
        this.sentenceWindowMonth = month;
      },
    });
  }

  /** 历史的数据来源：展平缓存分组 → 窗口过滤 → offset 切片（本机数据，无服务端）。 */
  private historySource(): HistorySource<SentenceGroup, SentenceRow> {
    return {
      emptyText: "这一档没有学完的句子。",
      loadPage: (month, cursor) => this.loadHistoryPage(month, cursor),
      groupInfo: (group) => ({
        key: group.recordCid,
        label: group.label,
        // 组头的「学完 N 句」是**档内**的数（窗口过滤按行算，一集跨两档各算各的）
        count: this.historyCounts.get(group.recordCid) ?? group.rows.length,
      }),
      renderGroupHead: (parent, group, info) => {
        parent.createSpan({ text: group.label });
        parent.createSpan({ cls: "yl-pc-cnt", text: `学完 ${info.count} 句` });
      },
      renderGroupTail: (card, group) => {
        if (group.rows.some((r) => r.orphan)) {
          card.createDiv({
            cls: "yl-sl-hint",
            text: "灰色句子的原句不在这台机器上，先用你当时写的仿写/抄写顶着；重新导入对应素材后自动换回原句。",
          });
        } else if (!group.videoOk) {
          card.createDiv({
            cls: "yl-sl-hint",
            text: "视频文件不在了，句子还留着，只是跳不回学习页；笔记照常能看。",
          });
        }
      },
      renderRow: (parent, item) => parent.appendChild(this.sentenceRowEl(item.group, item.row)),
    };
  }

  /**
   * 历史分页：把缓存的分组展平成行（组内按当前排序），按 `completedAt` 落进
   * 3 个月窗口（半开区间 `[start, end)`），再按 offset 切一页。
   * ⚠️ offset 游标只在打开期间数据不变时安全 —— sentenceGroups 是打开期缓存
   *（loadSentences 只算一次），笔记刷新只改行内容不改次序，成立。
   */
  private loadHistoryPage(
    month: string | null,
    cursor: string | null,
  ): Promise<HistoryPage<SentenceGroup, SentenceRow>> {
    const groups = this.sentenceGroups ?? [];
    const items: { group: SentenceGroup; row: SentenceRow }[] = [];
    let oldest: string | null = null;
    for (const group of groups) {
      for (const row of this.sortedGroupRows(group)) {
        items.push({ group, row });
        if (!oldest || row.completedAt < oldest) oldest = row.completedAt;
      }
    }
    const { start, end } = windowRangeOf(month);
    const inWindow = items.filter(({ row }) => {
      const t = new Date(row.completedAt);
      return t >= start && t < end;
    });
    // 组头「学完 N 句」= 档内数：过滤完顺手按组聚合（renderGroupHead 读它）
    this.historyCounts = new Map();
    for (const { group } of inWindow) {
      this.historyCounts.set(
        group.recordCid,
        (this.historyCounts.get(group.recordCid) ?? 0) + 1,
      );
    }
    const offset = cursor ? Number(cursor) || 0 : 0;
    const rows = inWindow.slice(offset, offset + HISTORY_PAGE_SIZE);
    const next = offset + rows.length < inWindow.length ? String(offset + rows.length) : null;
    return Promise.resolve({ items: rows, cursor: next, oldest });
  }

  /** 组内行按当前排序钮的状态排（复制一份排，不动缓存里的原始次序）。 */
  private sortedGroupRows(group: SentenceGroup): SentenceRow[] {
    const dirMul = this.sentenceDir === "asc" ? 1 : -1;
    return [...group.rows].sort((a, b) => {
      const primary =
        this.sentenceSort === "index"
          ? dirMul * (this.rowIndexOf(a) - this.rowIndexOf(b))
          : dirMul * a.completedAt.localeCompare(b.completedAt);
      if (primary !== 0) return primary;
      // 主键同值时用另一把尺子兜底，次序稳定可预期（不随方向来回翻）
      return this.sentenceSort === "index"
        ? a.completedAt.localeCompare(b.completedAt)
        : this.rowIndexOf(a) - this.rowIndexOf(b);
    });
  }

  /**
   * 把学习历史导出成 CSV（2026-10-09 用户拍板：参考词库）。
   * · 行顺序 = 组固定「最近学习的集在前」+ 组内当前排序钮的状态，整表铺平；
   * · 开头带 UTF-8 BOM（Excel/WPS 双击打开日文不乱码）+ RFC 4180 转义，同词库导出；
   * · 孤儿行照导：日语列是仿写/抄写顶替句（原句不在本机就实话实说）。
   */
  private async exportHistoryCsv(): Promise<void> {
    const groups = this.sentenceGroups;
    if (!groups || groups.length === 0) {
      new Notice("还没有学完的句子，没有可导出的历史。");
      return;
    }
    const esc = (v: string): string =>
      /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const header = ["作品 / 集", "句号", "日语", "中文", "完成日期", "笔记"];
    const lines = [header.map(esc).join(",")];
    let count = 0;
    for (const group of groups) {
      for (const row of this.sortedGroupRows(group)) {
        const orphan = row.orphan;
        const ja = orphan
          ? orphan.text || "（原句不在本机，重新导入对应素材后自动恢复）"
          : row.slice
            ? effectiveJa(row.slice)
            : "";
        const zh = orphan ? orphan.translation : row.slice ? effectiveZh(row.slice) : "";
        lines.push(
          [
            group.label,
            String(orphan ? orphan.index : (row.slice?.index ?? 0)),
            ja,
            zh,
            localDayOf(row.completedAt),
            row.note,
          ]
            .map(esc)
            .join(","),
        );
        count += 1;
      }
    }
    const content = "\uFEFF" + lines.join("\r\n");
    const defaultName = `学习历史-${localDayOf(new Date().toISOString())}.csv`;

    const saved = await saveTextViaSystemDialog(defaultName, content);
    if (saved === null) return; // 用户取消了保存框，不算出错
    if (saved === undefined) {
      // 同词库导出：拿不到保存框就到此为止，不往笔记库里写
      new Notice("这个环境弹不出保存窗口，导出没做成。");
      return;
    }
    new Notice(`已导出 ${count} 句到 ${saved}`);
  }

  /**
   * 时间线上的一个节点（V4）：轴上先标「哪天学的」（关联恢复的留痕跟在日期后），
   * 下面一行句子 —— 句号 │ 日语句子 ┊ 中文句子 …… 打开钮；用户的笔记用白纸
   * 容器跟在句下（2026-10-09 起「便签」概念退场，样式对齐学习页的笔记纸）。
   * 视频不在 → 置灰、藏「打开」钮；孤儿行（原句不在本机）→ 置灰、无钮，
   * 句面用仿写/抄写顶替，没写过给占位。
   * ⚠️ 行本身不带点击（2026-10-04 用户：两个按钮之外点了不该有反应，避免误解）。
   */
  private sentenceRowEl(group: SentenceGroup, row: SentenceRow): HTMLElement {
    const orphan = row.orphan;
    const el = document.createElement("div");
    // 灰不灰两层：视频不在（整组置灰）或这行本身就是孤儿（单行置灰）
    el.className = `yl-sl-item${group.videoOk && !orphan ? "" : " is-missing"}`;
    const day = el.createDiv({ cls: "yl-sl-tlday" });
    day.createSpan({ text: humanDay(localDayOf(row.completedAt)) });
    const line = el.createDiv({ cls: "yl-sl-line" });
    line.createDiv({ cls: "yl-sl-no", text: String(orphan ? orphan.index : (row.slice?.index ?? 0)) });
    if (orphan) {
      // 原句不在本机：用户当时亲手写的字顶替（仿写 → 抄写），都没有给占位说明
      line.createDiv({
        cls: "yl-sl-ja",
        text: orphan.text || "（原句不在本机，重新导入对应素材后自动恢复）",
      });
      if (orphan.translation) {
        line.createDiv({ cls: "yl-sl-vline" });
        line.createDiv({ cls: "yl-sl-zh", text: orphan.translation });
      }
    } else if (row.slice) {
      line.createDiv({ cls: "yl-sl-ja", text: effectiveJa(row.slice) });
      line.createDiv({ cls: "yl-sl-vline" });
      line.createDiv({ cls: "yl-sl-zh", text: effectiveZh(row.slice) });
    }
    const side = line.createDiv({ cls: "yl-sl-side" });
    const slice = row.slice;
    if (group.videoOk && slice) {
      createButton(side, {
        shape: "text",
        text: "打开",
        onClick: () => void this.plugin.jumpToSentence(group.recordCid, slice.index),
      });
    }
    // 笔记：用户亲手写的字，不用点任何按钮直接跟在句下（白纸容器，左缘对齐日语句子）
    if (row.note) el.createDiv({ cls: "yl-sl-paper", text: row.note });
    return el;
  }

}

/** Electron 保存框够用的那一角（经 window.require("electron").remote 拿，见下）。 */
interface RemoteSaveDialog {
  showSaveDialog: (options: {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
    properties?: string[];
  }) => Promise<{ canceled?: boolean; filePath?: string }>;
}

/**
 * 弹**系统保存框**让用户挑导出位置，把文本写到选中的路径。
 *
 * Obsidian 是 Electron 环境，渲染进程里弹原生对话框只有一条路：
 * `window.require("electron").remote.dialog`（Obsidian 为插件初始化过 @electron/remote，
 * 与 ImportModal 里 `webUtils.getPathForFile` 同一条 require 通道）。
 *
 * 返回值三态，调用方据此分岔：
 *  - 字符串      → 用户选了位置，已写盘，返回绝对路径；
 *  - null        → 用户取消了选择框（**不算出错**，静默返回）；
 *  - undefined   → 这个环境拿不到系统保存框（理论上不会发生）→ 告诉用户导出没做成。
 *
 * ⚠️ 拿不到保存框时**不往笔记库里写**：导出一律由用户自己选位置（2026-10-10 用户
 *    拍板），插件不往库里塞任何文件。
 */
async function saveTextViaSystemDialog(
  defaultName: string,
  content: string,
): Promise<string | null | undefined> {
  try {
    const req = (window as unknown as { require?: (name: string) => unknown }).require;
    const electron = req?.("electron") as
      | { remote?: { dialog?: RemoteSaveDialog } }
      | undefined;
    const dialog = electron?.remote?.dialog;
    if (!dialog?.showSaveDialog) return undefined;
    const result = await dialog.showSaveDialog({
      title: "导出词库",
      defaultPath: defaultName,
      filters: [{ name: "CSV", extensions: ["csv"] }],
      properties: ["createDirectory", "showOverwriteConfirmation", "dontAddToRecent"],
    });
    if (result.canceled || !result.filePath) return null;
    let path = result.filePath;
    if (!/\.csv$/i.test(path)) path += ".csv";
    const fs = req?.("fs") as
      | { writeFileSync?: (path: string, data: string, encoding: string) => void }
      | undefined;
    if (!fs?.writeFileSync) return undefined;
    fs.writeFileSync(path, content, "utf-8");
    return path;
  } catch {
    return undefined;
  }
}
