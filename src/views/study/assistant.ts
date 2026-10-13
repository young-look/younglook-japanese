/**
 * 右下角的「海獭小助手」——对着当前这一句追问 AI。
 *
 * 为什么要有它：一次性讲解（分词 + 释义 + 语法）和仿写判定经常不够用，
 * 用户还得自己组织语言去别处问。**这里把原句、已经讲过的解析、仿写判定结果
 * 一起塞进上下文**，用户只需要问"为什么这里用と不用に"。
 *
 * 2026-10-07 用户定稿的界面（demo v1，temp/demo/assistant）：
 *  · 入口是**海獭**（logo 图，明暗两版跟主题切），面板开着也不消失 ——
 *    它同时是开关（点它 = 开/关面板），关 = 点海獭 / 点面板外；
 *  · 面板是**干净的对话流**：没有标题栏、没有原句区、没有范围说明 ——
 *    原句由助手开场白带出来（「『原句』，对于这句话你还有什么疑问吗？」），
 *    面板宽 374 × 高 408（2026-10-09 加头像后 +10% 宽 / +20% 高；60vh 兜底）；
 *  · **微信式对话行**（2026-10-09）：每条消息 = 头像 + 气泡成行（AI = 海獭头像
 *    在左，用户 = 账号头像在右，没头像用昵称首字占位），相邻消息隔 5 分钟以上
 *    才插一条居中时间条；回车直接发送，Shift+回车换行（IME 选字中不触发）；
 *  · 输入框默认**一行字高**，高度只跟内容走：内容超过一行宽度才长高
 *    （两行封顶），再输入就在框内滚动（2026-10-08 拍板，去掉了点击长高动画），
 *    发送是并排的**圆箭头钮**：空 = 灰不可点，有字 = 反色可点；placeholder
 *    是「提出你的问题」；
 *  · AI 回答按**极简 markdown** 显示（加粗/行内代码/列表/分段，
 *    `ui/miniMarkdown.ts`）；面板顶部有一根纯白顶栏（一条线 + 空条），
 *    对话滚起来也不贴顶。
 *  · AI 回答是**真流式**（2026-10-09）：边生成边渲染进气泡 —— 显示节奏就是
 *    生成节奏，没有打字机那种假节奏；没答完就断的部分留着，只如实说明。
 *
 * 几条刻意的取舍（都还作数）：
 *  1. **只聊这一句**：提示词里写死了范围，跑题时模型自己会把他拉回来；
 *  2. 对话按句子缓存在内存里，**并落进进度行**（`ProgressRow.imitationChat`）——
 *     翻走了再翻回来还在，插件重载后也还在。换句就是换话题：助手只聊当前
 *     这一句，不把上一句的问答串进来（开场白也跟着换）；
 *  3. 扣费/余额**不再显示**（2026-10-09 用户拍板，数据仍随回答落库）；
 *  4. 没开 AI / 缺 Key 时点开给的是能照做的下一步，不是一个死掉的面板；
 *     而**未登录**（内置模型）时点它直接弹登录提醒 —— 开一个用不了的面板只会让人多绕一圈。
 *
 * 两个入口：右下角的海獭（用户自己问），以及仿写卡片上的「AI 提示」
 * （`prompt()`：展开面板并**代为发出**一句引导语，见 `IMITATION_HINT_QUESTION`）。
 */

import { setIcon } from "obsidian";
import { AiUnavailableError, askAboutSentenceStream, isNoBalanceError } from "../../services/ai/client";
import type { AiGate } from "../../services/ai/gate";
import type { PluginSettings } from "../../settings/types";
import type { ChatTurn, SliceRow } from "../../types/entities";
import { log } from "../../core/logger";
import { onClickOutside } from "../../core/onClickOutside";
import { renderHintWithRecharge } from "./hintText";
import { createButton } from "../../ui/button";
import { renderMiniMarkdown } from "../../ui/miniMarkdown";
import otterBlack from "../../assets/otter-black.png";
import otterWhite from "../../assets/otter-white.png";

const MAX_QUESTION = 300;
const MAX_HISTORY = 6;
/** 居中时间条的间隔门槛（微信式）：相邻消息隔了 5 分钟以上才显示一条时间 */
const TIME_GAP_MS = 5 * 60 * 1000;

/**
 * 「AI 提示」自动发出去的那句话。
 *
 * 仿写卡片上点「AI 提示」= 打开这个面板并把下面这句当作用户的问题发出去 ——
 * 用户不用自己组织语言，AI 直接按"拆结构 + 给思路"的方式引导他写。
 * ⚠️ 措辞里写死了"别直接给答案"：给了答案这一步就废了。
 */
export const IMITATION_HINT_QUESTION =
  "我想自己仿写这一句，先别直接给我答案：带我把原句的句式结构拆开讲一下，再给我一个可以照着套的思路提示。";

/** 时间条的文案：今天只给 HH:MM，跨了天就带上日期（M月D日 HH:MM） */
function formatTurnTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const hm =
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export interface AssistantContext {
  /** 已经讲过的解析；没解析过就是 undefined（助手照样能答，只是少点上下文） */
  analysis?: { translation?: string; words?: Array<{ surface: string; meaning: string }>; explanation?: string } | null;
  imitation?: { text?: string; correct?: boolean; reason?: string } | null;
}

export interface AssistantHandle {
  root: HTMLElement;
  /**
   * 换到这一句。
   * @param stored 库里存着的问答记录（`ProgressRow.imitationChat`）——
   *               这次会话内存里没有时用它还原：插件重载后翻回来，之前问过的还在。
   */
  load(slice: SliceRow, stored?: ChatTurn[]): void;
  /** 解析/仿写做完时把结果喂进来，追问时才会带上 */
  setContext(context: AssistantContext): void;
  /** 登录状态变了（刚连接上 / 刚退出）后重算发送键的锁定态 */
  refreshGate(): void;
  /**
   * 展开面板并**自动把一句话发出去**（仿写卡片的「AI 提示」用它）。
   *
   * 与点瓶子图标进来说明：走同一条 `ask` 通道、同一套门控 ——
   * 门控不放行时照旧只弹「配置模型」小窗（开一个用不了的面板没意义）。
   */
  prompt(question: string): void;
  dispose(): void;
}

export function buildAssistant(opts: {
  onSettings(): PluginSettings;
  /** 提示语里的「充值」被点时打开充值页 —— 跳转只发生在这一下，不自动跳 */
  onPricing(): void;
  /** AI 现在能不能问（含登录状态）。每次渲染/重算锁定态时用，别缓存 */
  getGate(): AiGate;
  /**
   * 点击时的门控核实：本地缓存说不行不能直接判死 —— 余额真值在服务端，
   * 充值在网页端完成，插件这边只有主动去问才知道。实现在上层（StudyView）。
   */
  checkGate(): Promise<AiGate>;
  /** 门控不放行 → 居中弹「配置模型」小窗（不再直接跳登录）。确认后进个人中心账户页 */
  onNeedSetup(): void;
  /** 真问起来才发现没余额（服务端 402）→ 统一弹「余额用完」窗（主钮去配置）；不再就地摆提示（2026-10-04 用户拍板） */
  onNoBalance?(): void;
  /** 一轮问答落地时回调 —— 调用方负责写进本地库（翻回来还在） */
  onTurn?(sliceCid: string, turn: ChatTurn): void;
  /**
   * 用户侧头像（微信式对话行，2026-10-09）：账号头像的完整地址；
   * 没设头像时 url 为空，用 initial（昵称首字）画圆形占位。
   */
  getUserAvatar(): { url: string | null; initial: string };
}): AssistantHandle {
  const root = document.createElement("div");
  root.className = "yl-assistant";

  // ── 入口：海獭（2026-10-07 用户定稿，替代漂流瓶）─────────────────────
  // 🔥 **面板开着海獭也不消失**：它同时是开关（点它 = 开/关面板），
  //    也是"这是谁在跟我说话"的身份锚点。明暗两版 logo 都塞进去，
  //    styles.css 按 .theme-dark 切显示（插件不重渲染也能跟主题走）。
  const launcher = createButton(root, {
    shape: "launcher",
    // 不挂 aria-label / title（2026-10-09 用户拍板）：Obsidian 会给带 aria-label
    // 的元素弹样式化 tooltip，悬浮球旁边冒「海獭小助手」黑条就是这个 —— 去掉即净。
  });
  launcher.innerHTML =
    `<img class="yl-assistant-otter" src="${otterBlack}" alt="">` +
    `<img class="yl-assistant-otter yl-otter-dark" src="${otterWhite}" alt="">`;
  const badge = launcher.createSpan({ cls: "yl-assistant-badge", text: "?" });
  badge.hide();

  // ── 面板：干净的对话流（2026-10-07 用户定稿）────────────────────────
  // 没有标题栏、没有原句区、没有范围说明 —— 原句由**助手开场白**带出来
  // （见 renderThread），收起 = 点海獭 / 点面板外。
  // 顶栏是唯一例外（2026-10-08 用户拍板）：一根纯白的空条 + 底下一道线，
  // 「本来是个标题栏，只是变成纯白」—— 对话在线下面滚，永远不贴顶。
  const panel = root.createDiv({ cls: "yl-assistant-panel" });
  panel.setAttribute("aria-label", "海獭小助手");
  panel.hide();

  panel.createDiv({ cls: "yl-assistant-topbar" });
  const threadEl = panel.createDiv({ cls: "yl-assistant-thread" });
  const hintEl = panel.createDiv({ cls: "yl-assistant-hint" });
  hintEl.hide();

  // 输入区：一行字高的小框 + 并排的圆箭头发送钮（参考 DeepSeek）——
  // 空 = 灰箭头不可点，有字 = 反色可点；高度只跟内容走：内容超过一行宽度
  // 才长高（两行封顶），再输入就在框内滚动（见 refreshGrow）。
  const composer = panel.createDiv({ cls: "yl-assistant-composer" });
  const field = composer.createDiv({ cls: "yl-assistant-field" });
  const input = field.createEl("textarea", {
    cls: "yl-assistant-input",
    attr: { rows: "1", placeholder: "提出你的问题" },
  });
  const sendButton = createButton(field, {
    shape: "send",
    ariaLabel: "发送",
    title: "发送",
  });
  sendButton.innerHTML = SEND_ARROW_SVG;

  let slice: SliceRow | null = null;
  let context: AssistantContext = {};
  let history: ChatTurn[] = [];
  let pending = false;
  /** 面板开没开。海獭是常驻开关（点它 = 开/关），不再用隐藏入口表达开合 */
  let isOpen = false;
  /** 点瓶子图标 / prompt() 正在向服务器核实门控：期间别重复触发 */
  let checkingGate = false;
  /** "点外面关面板"监听的摘除函数；null = 面板没开着（监听只在开着时挂，见 onClickOutside） */
  let stopOutside: (() => void) | null = null;
  /** 对话按句子缓存：翻走了再回来，刚才问的还在（比读库快，库是兜底） */
  const cache = new Map<string, ChatTurn[]>();

  function currentSettings(): PluginSettings {
    return opts.onSettings();
  }

  /** AI 侧头像：海獭 logo 圆（明暗两版都挂，CSS 按 .theme-dark 切显示，同 launcher） */
  function aiAvatarEl(): HTMLElement {
    const av = document.createElement("div");
    av.className = "yl-assistant-avatar";
    av.innerHTML =
      `<img class="yl-assistant-otter" src="${otterBlack}" alt="">` +
      `<img class="yl-assistant-otter yl-otter-dark" src="${otterWhite}" alt="">`;
    return av;
  }

  /** 用户侧头像：账号头像图；没图（或图挂了）就用昵称首字的圆形占位 */
  function userAvatarEl(): HTMLElement {
    const av = document.createElement("div");
    av.className = "yl-assistant-avatar yl-assistant-avatar-me";
    const fillInitial = (): void => {
      av.empty();
      av.createSpan({ cls: "yl-assistant-avatar-initial", text: opts.getUserAvatar().initial });
    };
    const url = opts.getUserAvatar().url;
    if (!url) {
      fillInitial();
      return av;
    }
    const img = av.createEl("img", { cls: "yl-assistant-avatar-img", attr: { src: url, alt: "" } });
    img.addEventListener("error", fillInitial);
    return av;
  }

  /** AI 行：海獭头像在左 + 气泡。开场白和流式占位气泡也走这里 */
  function aiRow(fill?: (bubble: HTMLElement) => void): { row: HTMLElement; bubble: HTMLElement } {
    const row = threadEl.createDiv({ cls: "yl-assistant-row" });
    row.appendChild(aiAvatarEl());
    const bubble = row.createDiv({ cls: "yl-assistant-bubble yl-assistant-ai" });
    fill?.(bubble);
    return { row, bubble };
  }

  /** 用户行：气泡在左 + 用户头像在右（微信式，头像永远贴外侧） */
  function meRow(fill?: (bubble: HTMLElement) => void): { row: HTMLElement; bubble: HTMLElement } {
    const row = threadEl.createDiv({ cls: "yl-assistant-row yl-assistant-row-me" });
    const bubble = row.createDiv({ cls: "yl-assistant-bubble yl-assistant-me" });
    fill?.(bubble);
    row.appendChild(userAvatarEl());
    return { row, bubble };
  }

  /** 时间条：首条消息前必显示；之后相邻消息间隔超过 5 分钟才再来一条（微信式） */
  function appendTimeBar(prevTsMs: number | null, ts: string): number | null {
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) return prevTsMs;
    if (prevTsMs === null || ms - prevTsMs >= TIME_GAP_MS) {
      threadEl.createDiv({ cls: "yl-assistant-time", text: formatTurnTime(ms) });
    }
    return ms;
  }

  function renderThread(): void {
    threadEl.empty();
    if (history.length === 0) {
      // 助手先开口（2026-10-07 用户定稿）：原句加粗引在问句里，替用户把第一句说了。
      // 换句就换开场白 —— renderThread 在 load() 里跑，读的是当前 slice。
      aiRow((bubble) => {
        if (slice) bubble.createSpan({ cls: "yl-assistant-greet-ja", text: `「${slice.ja}」` });
        bubble.createSpan({ text: "，对于这句话你还有什么疑问吗？" });
      });
      return;
    }
    // 微信式对话流（2026-10-09）：每条消息 = 头像 + 气泡成行，中间按间隔插时间条。
    let prevTs: number | null = null;
    for (const turn of history) {
      prevTs = appendTimeBar(prevTs, turn.ts);
      // AI 的回答走极简 markdown（模型爱回 **加粗** 和编号列表，2026-10-08）；
      // 用户消息保持纯文本 —— 他打什么就显示什么。
      if (turn.role === "user") {
        meRow((bubble) => bubble.setText(turn.content));
      } else {
        aiRow((bubble) => renderMiniMarkdown(bubble, turn.content));
      }
    }
    threadEl.scrollTop = threadEl.scrollHeight;
  }

  function open(): void {
    isOpen = true;
    panel.show();
    renderThread();
    // 不自动聚焦（2026-10-07 用户口径）：让用户先看到开场白，什么时候问由人决定。
    // 点其他位置就收，不必去找关闭钮（2026-09-28 用户定，全站弹层统一）。
    // 海獭本体不算"外面"（alsoInside）—— 它自己那一下归 toggle 收尾，
    // 否则"外面关 + 按钮又开"会闪一下。
    // ⚠️ 先摘再挂：面板开着时 prompt() 还会再走一次 open()，别叠出两份监听。
    stopOutside?.();
    stopOutside = onClickOutside(panel, close, [launcher]);
  }

  function close(): void {
    isOpen = false;
    panel.hide();
    stopOutside?.();
    stopOutside = null;
  }

  function showHint(message: string): void {
    // 含「充值」的提示（余额不够）把这两个字做成可点入口，点了才开充值页
    renderHintWithRecharge(hintEl, message, opts.onPricing);
    hintEl.show();
  }

  /** 发送键的锁定态：加类、不加 disabled（未登录时点它也要能进 ask() 弹提醒） */
  function applyGate(): void {
    sendButton.toggleClass("yl-locked", !opts.getGate().ok);
  }

  /**
   * 发送钮的两态（2026-10-07 用户定稿，参考 DeepSeek）：
   * 空 = 灰箭头不可点；有字 = 反色可点；发着 = 回灰。禁用只看内容与忙闲，
   * 门控不进 disabled —— 没登录时有字也能点，ask() 里弹提醒。
   */
  function refreshSend(): void {
    const has = input.value.trim().length > 0;
    sendButton.toggleClass("yl-ready", has && !pending);
    sendButton.toggleClass("yl-pending", pending);
    sendButton.disabled = !has || pending;
  }

  /**
   * 输入框的长高只跟内容走（2026-10-08 用户拍板）：点进去不变高、没有动画 ——
   * 内容没超过一行宽度就一直是一行；超过了长到两行封顶，再输入就在框内滚动。
   * 先压回一行再读 scrollHeight，删字后才能缩回来。
   */
  function refreshGrow(): void {
    input.style.height = "22px";
    input.style.height = `${Math.min(input.scrollHeight, 42)}px`;
  }

  /**
   * 记一轮问答到**指定的句子**，并交给调用方落库。
   *
   * 学生问的那句和 AI 答的那句**都要过这里** —— 只落一半的话，读回来
   * 就是一堆没有问题的回答，那还不如不存。落哪句由调用方显式给：
   * 回答在路上的几秒里当前句可能已经换人，落「当前句」就是串台。
   */
  function pushTurnTo(target: SliceRow, into: ChatTurn[], turn: Omit<ChatTurn, "ts">): void {
    const full: ChatTurn = { ...turn, ts: new Date().toISOString() };
    into.push(full);
    opts.onTurn?.(target.cid, full);
  }

  /** 正在路上的流式提问：换句 / 关面板时掐掉（剩下的 token 不再产生、不再花钱） */
  let askAbort: AbortController | null = null;

  /**
   * 发一轮（**真流式**，2026-10-09）：回答每吐一段就地渲染进气泡（极简
   * markdown 增量重铺，没有打字机假节奏 —— 显示节奏就是生成节奏）。
   * @param preset 由「AI 提示」这样的入口**代为发出的问题**；不传就读输入框。
   *               代为发出时不回填输入框（那行字是替用户说的，不是他敲的）。
   */
  async function ask(preset?: string): Promise<void> {
    if (pending || !slice) return;
    const target = slice;
    const question = (preset ?? input.value).trim().slice(0, MAX_QUESTION);
    if (!question) return;

    const gate = opts.getGate();
    if (!gate.ok) {
      showHint(gate.message);
      opts.onNeedSetup();
      return;
    }

    pending = true;
    refreshSend();
    hintEl.hide();
    // ⚠️ 回答在路上的这几秒里用户可能已经换句了：问答**必须落回发起时的那句**
    // （history/slice 都在换句时被换掉），渲染也只在这句还是当前句时才动 ——
    // 不做这道墙，答案会落进新句子的对话里，那是最难查的一类串台。
    const targetHistory = history;
    pushTurnTo(target, targetHistory, { role: "user", content: question });
    if (preset === undefined) input.value = "";
    refreshSend();
    refreshGrow();
    if (slice === target) renderThread();

    // 流式气泡：先摆"想想"占位（半透明），第一片正文到了就地开始长
    // ——占位也是一条 AI 行（海獭头像 + 气泡），跟正式回答同款结构
    const { bubble } = aiRow((b) => {
      b.addClass("yl-assistant-thinking");
      b.setText("让 AI 想想这一句…");
    });
    threadEl.scrollTop = threadEl.scrollHeight;
    let streamed = "";

    askAbort = new AbortController();
    try {
      const { answer, billing } = await askAboutSentenceStream(
        {
          ja: target.ja,
          zh: target.zh,
          analysis: context.analysis ?? undefined,
          imitation: context.imitation ?? undefined,
          question,
          history: targetHistory
            .slice(-MAX_HISTORY * 2)
            .map((turn) => ({ role: turn.role, content: turn.content })),
        },
        currentSettings(),
        (text) => {
          streamed = text;
          if (slice !== target) return; // 已经换句：照常收流（钱已花），界面不再动
          bubble.removeClass("yl-assistant-thinking");
          bubble.empty();
          renderMiniMarkdown(bubble, text);
          threadEl.scrollTop = threadEl.scrollHeight;
        },
        askAbort.signal,
      );
      pushTurnTo(target, targetHistory, {
        role: "assistant",
        content: answer || "AI 这次没答上来，换个问法试试。",
        billing,
      });
      cache.set(target.cid, targetHistory);
      if (slice === target) renderThread();
    } catch (error) {
      // 自己掐的（换句 / 关面板）：界面已经是新句子的了，什么都别再动
      if (askAbort?.signal.aborted || slice !== target) return;
      if (streamed) {
        // 已经吐出来一部分：留在对话里（那是模型的真实产出，抹掉等于白等），
        // 只如实说明没答完。不收账单（没走完不扣费是服务端的口径）。
        pushTurnTo(target, targetHistory, { role: "assistant", content: streamed });
        cache.set(target.cid, targetHistory);
        if (slice === target) renderThread();
        if (isNoBalanceError(error)) {
          opts.onNoBalance?.();
        } else {
          showHint(error instanceof AiUnavailableError ? error.message : "这次没答完，可以再问一次。");
        }
      } else {
        // 一个字都没到：撤掉刚才那条问题（与旧行为一致），按失败提示
        targetHistory.pop();
        if (slice === target) renderThread();
        if (isNoBalanceError(error)) {
          // 没余额不再就地摆提示（2026-10-04 用户拍板）：统一弹「余额用完」窗
          opts.onNoBalance?.();
        } else {
          const message = error instanceof AiUnavailableError ? error.message : "问失败了，稍后再试。";
          if (!(error instanceof AiUnavailableError)) log.warn("助手追问失败", error);
          showHint(message);
        }
      }
    } finally {
      askAbort = null;
      pending = false;
      refreshSend();
      applyGate();
    }
  }

  // 海獭常驻：点它 = 开 / 关面板。开的那条路仍要走门控核实（缓存拦人的
  // 先向服务器问一次真余额），关的那条路直接关，不问任何服务。
  launcher.addEventListener("click", () => {
    if (isOpen) {
      close();
      return;
    }
    if (checkingGate) return;
    checkingGate = true;
    void (async () => {
      const gate = await opts.checkGate();
      if (!gate.ok) {
        opts.onNeedSetup();
        return;
      }
      open();
    })().finally(() => {
      checkingGate = false;
      applyGate();
    });
  });
  sendButton.addEventListener("click", () => void ask());
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    // 回车发送（微信式，2026-10-09 用户拍板）；Shift+回车 = 换行（textarea 默认
    // 行为，放行不拦）。⚠️ IME 守卫必须有：日语输入法里回车是"确定假名"——
    // isComposing / keyCode 229 时绝不能发送，否则选字选到一半就飘出去了。
    // Ctrl/Cmd+回车照旧也能发送（旧习惯保留，且恰好不被上面的分支误伤）。
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void ask();
  });
  input.addEventListener("input", () => {
    refreshSend();
    refreshGrow();
  });
  applyGate();
  refreshSend();

  return {
    root,
    load(nextSlice: SliceRow, stored?: ChatTurn[]) {
      // 上一句的回答还在路上：掐掉（换句 = 换话题，旧的回答没处落了）
      askAbort?.abort();
      if (slice && slice.cid !== nextSlice.cid) cache.set(slice.cid, history);
      slice = nextSlice;
      context = {};
      // 内存里那份优先（这次会话刚问过、比读库新）；没有才回落到库里存的。
      // ⚠️ 复制一份再进内存：直接引用库对象的话，往后每次 push 都在改它。
      history = cache.get(nextSlice.cid) ?? (stored ? [...stored] : []);
      hintEl.hide();
      renderThread();
      // 一句都没问过时给个小提示，问过就不吵了
      badge.toggle(history.length === 0);
    },
    setContext(next) {
      context = { ...context, ...next };
    },
    refreshGate() {
      applyGate();
    },
    prompt(question) {
      if (checkingGate) return;
      checkingGate = true;
      void (async () => {
        // 与点瓶子图标同一套门控（缓存拦人的先向服务器核实一次）：不放行就只
        // 弹「配置模型」小窗，不开面板
        const gate = await opts.checkGate();
        if (!gate.ok) {
          opts.onNeedSetup();
          return;
        }
        open();
        await ask(question);
      })().finally(() => {
        checkingGate = false;
        applyGate();
      });
    },
    dispose() {
      askAbort?.abort();
      close();
      cache.clear();
    },
  };
}

/** 发送钮的向上箭头（参考 DeepSeek 的圆形发送钮）：纯内联 SVG，不引外部资源。 */
const SEND_ARROW_SVG =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">' +
  '<path d="M8 13V3.5M3.8 7.7 8 3.5l4.2 4.2" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';
