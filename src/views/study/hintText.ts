/**
 * 提示语里的可点词 —— 全站唯一实现点。
 *
 * 口径（2026-10-02 用户拍板）：余额不够这类提示**不许自动跳网页**，跳转只能
 * 发生在用户点提示语里某几个字那一下。所以各处提示（AI 解析 / AI 核对 /
 * 助手 / 仿写卡片）统一走这里铺：文案里含关键词时把那几个字渲染成可点的"文字"，
 * 点了才触发；不含就当纯文本，各处不用自己分叉。
 *
 * 两种样式（2026-10-03 用户定）：
 *   · 实线下划线 = 「充值」这类**该点**的出口（不点就没法继续）；
 *   · 虚线下划线 = 「内置模型」这类**可以点**的入口（功能已经过了，只是告诉他
 *     还有一条更好的路）。虚线比实线弱一档，不抢正文。
 */

/** 提示语里被做成可点入口的那两个字 */
const RECHARGE_KEYWORD = "充值";

export interface HintLinkOptions {
  /** 句子里哪几个字做成可点 */
  keyword: string;
  onClick(): void;
  /** 虚线下划线（弱提示，"可以点"） */
  dashed?: boolean;
}

/**
 * 把 `message` 铺进 `container`，其中 `keyword` 那一段变成可点的文字。
 *
 * 没找到关键词就整句当纯文本 —— 调用方不用自己判断。
 */
export function renderHintLink(
  container: HTMLElement,
  message: string,
  opts: HintLinkOptions,
): void {
  container.empty();
  const index = message.indexOf(opts.keyword);
  if (index < 0) {
    container.setText(message);
    return;
  }
  container.createSpan({ text: message.slice(0, index) });
  // ⚠️ 这里**刻意不走 ui/button.ts**：它是提示句里的一个**词**，不是控件
  // （`yl-hint-link` 是 display:inline，字号行高都继承所在行）。套上按钮底
  // 会把一整句话撕成两截。它靠下划线提示"这是能点的文字"，不是按钮。
  const link = container.createEl("button", {
    cls: opts.dashed ? "yl-hint-link is-dashed" : "yl-hint-link",
    text: opts.keyword,
    attr: { type: "button" },
  });
  // 提示行本身不带点击行为，这里拦冒泡只是防手滑点到外层容器
  link.addEventListener("click", (event) => {
    event.stopPropagation();
    opts.onClick();
  });
  container.createSpan({ text: message.slice(index + opts.keyword.length) });
}

/** 点「充值」唯一该做的事：打开充值页 */
export function renderHintWithRecharge(
  container: HTMLElement,
  message: string,
  onRecharge: () => void,
): void {
  renderHintLink(container, message, { keyword: RECHARGE_KEYWORD, onClick: onRecharge });
}
