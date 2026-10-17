/**
 * 解析区（学习卡片左栏下半部分）。
 *
 * **一张卡片**：顶上一行是「AI 解析」按钮 + 状态/费用提示；点「AI 解析」后，
 * 卡片内部冒出一根灰色分界线，线下是这一句的「解读」—— **真流式**：模型每
 * 吐一段就多显示一段（分节骨架随内容出现），不再等整份回来再"打字机"重放。
 * 解读分两段、各带小标题（核心单词 / 核心语法），
 * 只有模型给了内容的那几段才出。默认什么都*不*出 —— 分界线与解读都要等生成：
 *
 *  ┌ [AI 解析]  点「AI 解析」会生成… ─────────┐
 *  │ ──────────────────────────────────────  │  ← 灰色分界线（第一段文字到了才出）
 *  │ 核心单词                                 │
 *  │ 挑最值得学的几个讲透…                     │  ← 边生成边追加
 *  │ 核心语法                                 │
 *  │ …                                       │
 *  └────────────────────────────────────────┘
 *
 * 🔥 为什么不用打字机（2026-10-08 用户拍板）：打字机是**假节奏** —— 内容早已
 * 拿到，只是慢慢放给用户看。真流式之后，"等"这件事本身被消掉了；再叠一层
 * 打字机只会让人多等一次。**本机缓存/服务端缓存命中的那份直接铺开**，一个字
 * 都不补（用户要的就是"点开就有"）。
 *
 * 🔥 解析是**两次请求**（2026-10-07 用户拍板）：这一张卡显示的是**第一块**
 * （解读）；**第二块**（逐词释义）不在这儿渲染 —— 它们随解析结果落进
 * `StudySentence.analysis.tokens[].def/.aiReading/.origin`，改由**句子卡片上的词
 * 点击弹卡**展示：词表落地时句子卡变青蓝、词加虚线变可点。
 * 2026-10-08 起两块**并行发出**（解读流式 + 词表同时在路上），词表更早到。
 *
 * 为什么不默认跑：要花 token（内置模型扣余额、BYOK 花用户自己的额度），
 * 什么时候花由用户说了算 —— 开卡、翻页都不该偷偷产生费用。
 *
 * 🔥 口径（2026-09-26 用户拍板）：**解析 = 大模型产物，点了才存在**。
 * 本机分词（kuromoji）的读音/词性/罗马音**不许在点击前出现** —— 用户明确否掉
 * "免费识字层默认展示"。分词只干两件内部的事：定「送哪些词进 AI」（explainTargets）
 * 和给朗读/抄写供数据。
 */
import {
  EMPTY_EXPLANATION_SECTIONS,
  EXPLANATION_SECTIONS,
  type ExplanationSections,
  type SentenceAnalysis,
  type StudySentence,
  type Token,
} from "../../types/entities";
import { explainTargets } from "../../services/jaTokenize";
import { hasSections, type SentenceExplanation, type StreamFields } from "../../services/ai/client";
import type { AiGate } from "../../services/ai/gate";
import { renderHintWithRecharge } from "./hintText";
import { createButton } from "../../ui/button";

export interface AnalysisHandle {
  root: HTMLElement;
  /** 换句：清空上一句的解读，回到"未解析"状态 */
  load(slice: StudySentence): void;
  /** 分词结果（本地）：**只留底账不渲染** —— 解析区点之前必须是空的 */
  showTokens(tokens: Token[], unavailableReason?: string): void;
  /**
   * 流式开始：清空、进入"正在生成"态。与 `pushFields` 配对 ——
   * 分节骨架与正文由后续每一片增量自己长出来。
   */
  beginStream(): void;
  /** 流式增量：把当前抽到的字段铺上屏（内容会随每一片增长） */
  pushFields(fields: StreamFields): void;
  /** 流式走到一半断了：**留着已经显示的部分**，只说这一句失败 */
  streamFailed(message: string): void;
  /** 整份解读（流式走完的最终结果 / 非流式兜底回来）：直接铺开，不补打字机 */
  showExplanation(explanation: SentenceExplanation | null, errorMessage: string): void;
  /** 第二块（逐词释义）到齐：改提示语 —— 这时句子卡上的词才能点 */
  wordsReady(): void;
  /**
   * 「只重算逐词释义」走完（2026-10-15）：说清**这次刷的是哪一块**。
   *
   * 不能沿用 `wordsReady` 那句"已生成这一句的解读" —— 这一次解读根本没重算，
   * 左右两块得各说各的实话（与 `explanationRefreshed` 对称）。
   */
  wordsRefreshed(): void;
  /** 第二块没拿到（重试过一次还是失败）：如实说，解读留着不动 */
  wordsFailed(message: string): void;
  /**
   * 「重新解析」走完（**只重算了左边这一块**）：说清"这次只刷新了解读"。
   *
   * 不能沿用 `wordsReady` 那句"点右上方卡片里的词可以看释义" —— 这次根本没请求
   * 词表，句子卡上那份是**上一次**留下的；按钮的承诺必须与刚刚发生的事对得上。
   *
   * @param hasWords 句子卡上现在有没有可点的词（决定"词照旧可以点"还是"还点不开"）
   */
  explanationRefreshed(hasWords: boolean): void;
  /**
   * 本机存着这一句的解析：直接铺开，**不再发请求**（也就不再花钱）。
   * 与 `showExplanation` 的区别只是内容来源 —— 渲染路径完全同一条。
   *
   * 🔥 2026-10-15（用户拍板）：库里可能是**半份** —— 解读那块单独存下来了、
   * 词表那次失败（见 `AnalysisHandle.showCached` 的调用点与 `persistExplanationOnly`）。
   * 半份**照样铺**：用户花过钱的解读不能因为另一块没到就不给看。
   *
   * @param wordsReady 词表那块也在不在（= 记录里的 `done`）。决定提示语是
   *   "点词可以看释义"还是"词还点不开、点「重新解析」只补这一块" ——
   *   **不许撒谎**：说能点而点不动，比少说一句糟得多。
   */
  showCached(analysis: SentenceAnalysis, wordsReady: boolean): void;
  /** 分词器不可用（词典缺失等）：先记下，点了 AI 解析才提示 */
  showUnavailable(message: string): void;
  /**
   * 解析中：这张卡边缘转起那道弧（2026-10-15）。
   *
   * **只拨开关，不管起止时机** —— 由上层在"这一句真的在解析"的整段里拨上、
   * 在每条出口拨下（与句子卡压灰/转圈共用同一份判定，见 `StudyView.setParsingActive`）。
   * 放这儿而不是 `beginStream` 里自动开：`beginStream` 只管**第一块**的开始，
   * 而这次解析成不成立由上层看门控 —— 自动开会在"点了但被门控拦下"时白转一圈。
   *
   * 🔥 2026-10-17 用户拍板：**这一块自己结束就自己停**（`beginStream` 与它配对）。
   * 解读是两块里先落地的那块，弧不该等逐词释义 —— 左下方解读都铺满了还转圈，
   * 用户只会当成卡死。句子卡那份由 `StudyView` 单独管，与这里无关。
   */
  setParsing(on: boolean): void;
  /**
   * 「重新解析」选择窗里悬停某一行时，把**整块解析区**点亮（2026-10-15）。
   *
   * 为什么需要它：弹窗带遮罩，背景是压暗的；不把那块抬到遮罩之上，"悬停高亮"
   * 根本看不见（实现在 `StudyView.highlightReparseTarget` + styles.css 的
   * `.yl-spotlight`）。只拨类名，不碰布局。
   */
  setSpotlight(on: boolean): void;
  /** 登录状态变了（刚连接上 / 刚退出）后重算锁定态，不重建 DOM */
  refreshGate(): void;
  /**
   * 等价于点一次「AI 解析」按钮 —— 给**外部的引导**用。
   *
   * 学习页上这一句还没解析过时，点「纠」会先弹一颗"要不要先试 AI 解析"的提醒窗
   * （见 `CorrectionSuggestModal`）；那颗窗的确认按钮就拨到这里。必须走按钮这条
   * **同一条链路**（门控核实 / 词表判定 / 忙态 / 文案收尾），别在外面另开小灶。
   */
  runExplain(): void;
}

export function buildAnalysis(opts: {
  onExplain(words: string[]): Promise<void>;
  /** AI 现在能不能点（含登录状态）。每次渲染/重算锁定态时用，别缓存 */
  getGate(): AiGate;
  /**
   * 点击时的门控核实：本地缓存说不行不能直接判死 —— 余额真值在服务端，
   * 充值在网页端完成，插件这边只有主动去问才知道。实现在上层（StudyView）。
   */
  checkGate(): Promise<AiGate>;
  /** 门控不放行 → 居中弹「配置模型」小窗（不再就地跳登录）。确认后进个人中心账户页 */
  onNeedSetup(): void;
  /** 提示语里的「充值」被点时打开充值页 —— 跳转只发生在这一下，不自动跳 */
  onRecharge(): void;
  /**
   * 这一句已经解析过、用户又点了「重新解析」：弹确认窗，**点了确认才真的发请求**。
   *
   * 为什么必须问一句：再点一次不是"看上次的结果"（那条路走本机缓存、不花钱），
   * 而是重新发一次请求 —— 内置模型按实际用量扣余额。花钱前让人点头是不可退的一步。
   * 实现在上层（StudyView），因为它要按**实际生效的轨道**（resolveAiRoute）说
   * 清楚"扣余额"还是"花自己的 Key"；本构件只负责"问"，不碰钱的门控。
   */
  onReparseConfirm(): void;
  /** 花谁的钱 —— 按钮下面那句话要说清楚，别让用户点了才知道扣费 */
  aiMode: "off" | "byok" | "hosted";
}): AnalysisHandle {
  const root = createDiv("yl-analysis");

  // ── 唯一的卡片：动作行在上，结果（分界线 + 解读）在下 ──────────────────
  const card = root.createDiv({ cls: "yl-analysis-block" });

  // 🔥 解析中顺着卡片边缘转的那道弧（2026-10-15 用户拍板：彗星单弧 + 匀速）。
  // 纯装饰：**这里不放计时器、不管节奏**，转不转只认卡片上的 `.yl-parsing`，
  // 关/开都由 `setParsing` 一处拨（上层 StudyView 与句子卡那道弧一起拨，见
  // `setParsingActive`）。元素本身是空的 —— 弧是 CSS 的 conic-gradient。
  card.createSpan({ cls: "yl-ring", attr: { "aria-hidden": "true" } }).createEl("i");

  const toolbar = card.createDiv({ cls: "yl-analysis-toolbar" });

  // 花谁的钱要在按钮上写清楚 —— 解析是唯一会花钱的动作，点了才知道扣费不可接受。
  // 只问两条真轨道：costHint 只在门控放行时被调（见 applyGate），而放行就不可能
  // 是 off —— 那个分支永远不可达，别再给它写文案。
  function costHint(): string {
    return opts.aiMode === "hosted"
      ? "用内置模型生成，按实际用量从余额扣费"
      : "用你自己的 Key 生成，不扣余额";
  }

  const aiButton = createButton(toolbar, { text: "AI 解析" });
  const hintEl = toolbar.createDiv({ cls: "yl-muted-sm yl-analysis-hint" });

  /** 整句中文 —— 只在字幕自带的 zh 为空时才显示 AI 翻译（否则跟读那边已经有了，
   *  同一句话印两遍反而让人找不着重点；但完全没有中文时它就是唯一的中文）。
   *  它是"整句翻译"不是"解读"，所以摆在分界线**上方**，也不走打字机。 */
  const translationEl = card.createDiv({ cls: "yl-analysis-translation" });
  translationEl.hide();

  /** 灰色分界线：解读回来才有，把"按钮"与"解读"分开 */
  const dividerEl = card.createDiv({ cls: "yl-analysis-divider" });
  dividerEl.hide();

  /** 解读落点：分节铺好，打字机逐节写进去 */
  const explanationEl = card.createDiv({ cls: "yl-analysis-explanation" });

  let currentWords: string[] = [];
  let busy = false;
  /** 这一句已经解析过了（按钮变成"重新解析"） */
  let explained = false;
  /** 字幕自带了中文 —— 那就不必再印一遍 AI 翻译 */
  let hasSubtitleZh = false;
  /** 本机分词底账：不渲染，只供 AI 解析时定词表 */
  let tokensCache: Token[] = [];
  /** 分词器不可用的原因：点了 AI 解析才提示（点之前解析区保持空白） */
  let pendingUnavailable = "";

  // ── 流式：分节骨架按需长出来，正文随每一片增量改写 ─────────────────────
  // 没有计时器、没有队列 —— 显示节奏就是生成节奏。这是"真流式"的全部意思。
  let streaming = false;
  /** 流式中已经长出来的分节正文（key → body 元素），避免每片都重建 DOM */
  const streamBodies = new Map<string, HTMLElement>();

  function sectionBlock(title: string): HTMLElement {
    const block = explanationEl.createDiv({ cls: "yl-analysis-section" });
    block.createDiv({ cls: "yl-analysis-section-title", text: title });
    return block.createDiv({ cls: "yl-analysis-section-body" });
  }

  function beginStream(): void {
    streaming = true;
    streamBodies.clear();
    explanationEl.empty();
    translationEl.empty();
    translationEl.hide();
    dividerEl.hide();
    hintEl.removeClass("yl-warn-text");
    hintEl.setText("正在生成解读…");
  }

  function pushFields(fields: StreamFields): void {
    if (!streaming) return;
    // 整句翻译：字幕自带中文时不出（跟读那边已经有了，同一句话印两遍反而没重点）
    if (!hasSubtitleZh && fields.translation) {
      translationEl.setText(`整句：${fields.translation}`);
      translationEl.show();
    }
    let any = false;
    for (const [key, title] of EXPLANATION_SECTIONS) {
      const text = (fields.sections[key] ?? "").trim();
      if (!text) continue;
      let body = streamBodies.get(key);
      if (!body) {
        body = sectionBlock(title);
        streamBodies.set(key, body);
      }
      body.setText(text);
      any = true;
    }
    // 第一段文字到了才出分界线：分界线底下必须有东西，否则就是一根孤零零的线
    if (any) dividerEl.show();
  }

  /** 锁定态：只加 `.yl-locked`（灰、锁图标、cursor:help），**不设 `disabled`**。
   * 用户要求「不可点」和「点击触发登录提醒」并存，而 disabled 的按钮不派发 click ——
   * 两者在 HTML 里互斥，所以视觉上锁住、点击仍然进得来。
   */
  function applyGate(): void {
    const gate = opts.getGate();
    aiButton.toggleClass("yl-locked", !gate.ok);
    aiButton.setAttr("title", gate.ok ? costHint() : gate.message);
  }

  /**
   * 按钮文案的**唯一**出处：跟着"这一句解析过没有"走。
   *
   * 🔥 别把 `aiButton.setText(...)` 散到各处（2026-10-08 踩过）：文案原来只在
   * 点击链路的 `finally` 里改，于是**走缓存铺开**那条路（翻回来 / 刚解析完）虽然
   * 内部已经 `explained = true`、点击也确实会弹确认窗，按钮却还写着「AI 解析」——
   * 用户看到的和按钮真正会做的事对不上，只能靠点一下才知道。状态一变就在这里同步。
   */
  function syncAiButtonLabel(): void {
    aiButton.setText(explained ? "重新解析" : "AI 解析");
  }

  /**
   * 「AI 解析」按钮的**唯一执行口**。
   *
   * 点击按钮、以及学习页「点纠时的提醒窗」引导用户先试一次 —— 两条路都走这里。
   * 各写一份必然有一处先腐坏：门控核实、词表判定、忙态与按钮文案的收尾，一样都不能少。
   */
  async function runAnalysis(): Promise<void> {
    if (busy) return;
    // 这一句是不是"重新解析"要在点下的这一刻定下来 —— 后面等门控核实、等用户在
    // 确认窗上点头，期间按钮文案与状态都不再变，判定依据不该被中途的渲染改掉
    const reparse = explained;
    // 整个点击（含向服务器核实余额、确认窗、两次解析请求）都算忙：确认窗那一会儿
    // 也算 —— 不然连点第二下会再弹一颗一模一样的窗，用户对着两颗窗做同一件事
    busy = true;
    aiButton.disabled = true;
    try {
      // 缓存拦人的先核实一次真余额（见 opts.checkGate）；确实不行才弹配置窗
      const gate = await opts.checkGate();
      if (!gate.ok) {
        // 统一弹「配置模型」小窗：缺什么、该去哪，由弹窗按门控原因说清，这里不再指路
        opts.onNeedSetup();
        return;
      }
      // 没分出词就不发请求：词表是"每个词都要讲"的依据，空着让 AI 瞎猜既费钱又不全
      if (tokensCache.length === 0) {
        hintEl.addClass("yl-warn-text");
        renderHintWithRecharge(hintEl, pendingUnavailable || "这一句没能分出词来，没法按词解析。", opts.onRecharge);
        return;
      }
      // 🔥 重新解析要花钱，先弹确认窗（2026-10-08 用户拍板）：门控放行只说"钱够"，
      // "再花一次"仍得由人点头。顺序不能颠倒 —— 先确认再让上层弹窗，才谈得上拒绝；
      // 而"没分出词"这类不花钱的失败必须排在它前面，别让人白点一次确认。
      // 这里**只弹窗、不发请求**：真正的解析由确认窗那颗钮拨回来（走完整的
      // StudyView.confirmReparse → 重新解析）。按钮的忙态/文案交给下面 finally 收，
      // 用户点了「再想想」就回到"重新解析"待命。
      if (reparse) {
        aiButton.setText("解析中…");
        opts.onReparseConfirm();
        return;
      }
      aiButton.setText("解析中…");
      await opts.onExplain(currentWords);
    } finally {
      busy = false;
      aiButton.disabled = false;
      syncAiButtonLabel();
      applyGate();
    }
  }

  aiButton.addEventListener("click", () => void runAnalysis());
  applyGate();

  function idleHint(): void {
    hintEl.removeClass("yl-warn-text");
    const gate = opts.getGate();
    if (!gate.ok) {
      // 未登录时这句话就是"怎么才能用"的答案，别另写一套
      hintEl.setText(gate.message);
      return;
    }
    const tail = opts.aiMode === "hosted"
      ? "按用量从余额扣费"
      : "用你自己的 Key，不扣余额";
    hintEl.setText(
      `点「AI 解析」会生成这一句的解读（核心单词、核心语法）；${tail}。解读出来后会接着准备逐词释义，那时点句子里的词可以看释义。`,
    );
  }

  /**
   * 铺开一份解读：整句翻译（字幕没有中文才出）+ 分界线 + 分节正文。
   * **一次到位，没有打字机** —— 内容已经在手上了，慢慢放出来只是让用户多等。
   *
   * 三条路走的都是这里：流式走完的那份、非流式兜底回来的那份、本机缓存读出来
   * 的那份 —— 各写一遍的话必然有一处先腐坏（表现是"从缓存读出来的少了一样
   * 东西"，而且不报错、不抛异常，只是界面悄悄变空）。
   */
  function applyExplanation(explanation: SentenceExplanation): void {
    streaming = false;
    explained = true;
    // 解析过这一句了：按钮变「重新解析」—— 它现在点了会**再花一次钱**，文案必须
    // 跟得上（走缓存的这条路以前漏了这一下，见 syncAiButtonLabel 的注释）
    syncAiButtonLabel();
    // 字幕没有中文时才补上 AI 翻译（有就不重复印）
    if (!hasSubtitleZh && explanation.translation) {
      translationEl.setText(`整句：${explanation.translation}`);
      translationEl.show();
    }
    hintEl.removeClass("yl-warn-text");
    explanationEl.empty();
    if (hasSections(explanation.sections)) {
      // ⚠️ 这里只说"解读好了"：第二块（逐词释义）还在路上，等它到了才改成
      // "点词可以看释义" —— 早说一步，用户点词会点不动，那是更糟的观感
      hintEl.setText("解读已生成，正在准备逐词释义…");
      dividerEl.show();
      for (const [key, title] of EXPLANATION_SECTIONS) {
        const text = (explanation.sections[key] ?? "").trim();
        if (!text) continue;
        sectionBlock(title).setText(text);
      }
    } else {
      // 解析成功了但这段空着：如实说，别让分界线孤零零挂着
      hintEl.setText("AI 这次没给出解读，可以再点一次。");
      dividerEl.hide();
    }
  }

  return {
    root,
    load(slice) {
      streaming = false;
      streamBodies.clear();
      currentWords = [];
      tokensCache = [];
      pendingUnavailable = "";
      explained = false;
      hasSubtitleZh = Boolean((slice.zh ?? "").trim());
      translationEl.empty();
      translationEl.hide();
      dividerEl.hide();
      // 🔥 点之前解析区就是空的：不放"分析中"占位（分词只是内部底账）
      explanationEl.empty();
      syncAiButtonLabel();
      aiButton.disabled = false;
      applyGate();
      idleHint();
    },
    showTokens(tokens, unavailableReason) {
      // 只记底账，不渲染任何东西 —— 展示权在 AI 解析手里
      tokensCache = tokens;
      if (unavailableReason) pendingUnavailable = unavailableReason;
      currentWords = explainTargets(tokens);
    },
    beginStream() {
      beginStream();
    },
    pushFields(fields) {
      pushFields(fields);
    },
    streamFailed(message) {
      // 已经显示出来的那部分**留着**：那是模型的真实产出，抹掉等于让用户白等
      streaming = false;
      hintEl.addClass("yl-warn-text");
      if (message) renderHintWithRecharge(hintEl, message, opts.onRecharge);
      else hintEl.setText("这次没生成完，可以再点一次。");
    },
    showExplanation(explanation, errorMessage) {
      streaming = false;
      if (errorMessage) {
        // 余额不够（402）也会落到这里：提示语里的「充值」要可点，不许自动跳网页
        hintEl.addClass("yl-warn-text");
        renderHintWithRecharge(hintEl, errorMessage, opts.onRecharge);
        return;
      }
      if (!explanation) {
        hintEl.setText("AI 这次没给回可用的结果，可以再点一次。");
        hintEl.addClass("yl-warn-text");
        return;
      }
      applyExplanation(explanation);
    },
    wordsReady() {
      if (!explained) return;
      hintEl.removeClass("yl-warn-text");
      hintEl.setText("已生成这一句的解读，点右上方卡片内句子里的词可以看释义。");
    },
    wordsRefreshed() {
      if (!explained) return;
      hintEl.removeClass("yl-warn-text");
      hintEl.setText("逐词释义已更新；点右上方卡片内句子里的词可以看新的释义。");
    },
    wordsFailed(message) {
      hintEl.addClass("yl-warn-text");
      if (message) {
        // 重试过一次还是失败：如实说，并给一条"再点一次"的路
        renderHintWithRecharge(hintEl, message, opts.onRecharge);
        return;
      }
      // 没余额那条路自己会弹窗讲清楚，这里只留一句状态
      hintEl.setText("逐词释义这次没拿到，可以再点一次重新解析。");
    },
    explanationRefreshed(hasWords) {
      hintEl.removeClass("yl-warn-text");
      // 两句都不撒谎：句子卡这次没被碰过，所以只能说"没有重新生成"，
      // 不能说"正在准备"（那会让用户一直等一个不会来的东西）
      hintEl.setText(
        hasWords
          ? "解读已更新；句子卡上的逐词释义这次没有重新生成，里面的词照旧可以点。"
          : "解读已更新；这一句的逐词释义还没有，句子卡上的词暂时点不开。",
      );
    },
    showCached(analysis, wordsReady) {
      applyExplanation({
        translation: analysis.translation ?? "",
        sections: analysis.explanation ?? EMPTY_EXPLANATION_SECTIONS,
      });
      // applyExplanation 那句"正在准备逐词释义…"是**流式刚写完**那条路的话 ——
      // 从库里铺开时没有任何东西在路上，必须在这里改掉（半份记录尤其：它那句
      // "正在准备"会一直挂着，用户等到天荒地老）。
      if (!explained) return;
      hintEl.removeClass("yl-warn-text");
      hintEl.setText(
        wordsReady
          ? "已生成这一句的解读，点右上方卡片内句子里的词可以看释义。"
          : "上次只生成了解读，逐词释义没拿到（词暂时点不开）—— 点「重新解析」可以只补这一块。",
      );
    },
    showUnavailable(message) {
      // 点之前不提示（解析区保持空白）；消息先存着，点 AI 解析时会在按钮下冒出来
      pendingUnavailable = message;
    },
    setParsing(on) {
      card.toggleClass("yl-parsing", on);
    },
    setSpotlight(on) {
      root.toggleClass("yl-spotlight", on);
    },
    refreshGate() {
      applyGate();
      // 已经解析出内容、或正显示错误时不动提示，只更新按钮锁定态
      if (!explained && !hintEl.hasClass("yl-warn-text")) idleHint();
    },
    runExplain() {
      // 走按钮那条唯一链路：门控、词表、忙态、文案收尾全在里面
      void runAnalysis();
    },
  };
}
