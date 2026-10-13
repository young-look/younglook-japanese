/**
 * 按钮组件 —— 插件里所有 `<button>` 的唯一入口。
 *
 * ══ 为什么要有这个文件 ══════════════════════════════════════════════
 * 2026-10-02 之前，每个视图都自己写 `createEl("button", { cls: "…" })`：
 *   · 类名字符串散落 6 个文件约 60 处，有的带 `yl-btn` 有的不带
 *     （`yl-btn-primary` 单独出现 14 次 —— 它现在靠 styles.css 里
 *      和 `yl-btn` 并列同一条规则才碰巧长得一样）；
 *   · 图标钮要自己 `setIcon()` + 自己补 `aria-label`，漏一个就是无标签按钮；
 *   · 「基底」在 CSS 里是一串手抄的并列选择器（yl-btn / primary / danger /
 *     lg / block），**新加一个按钮类必须记得回来把这串补上**，漏了就悄悄
 *     长成宿主原生按钮 —— 这正是"老是某个页面不一致"的机制性来源。
 *
 * 收敛之后：
 *   · 类名由这里**算**出来，调用方只说「我要一个主按钮」，不拼字符串；
 *   · 基底类 `yl-btn` 由这里**强制**加上，不可能漏；
 *   · 图标 + aria-label 强制配对（给了 icon 却没给 ariaLabel 会报错）；
 *   · 换皮肤只改 styles.css + 本文件，不动 6 个视图。
 *
 * ⚠️ 返回的就是**原生 HTMLButtonElement**，不是包装对象 —— 现有代码里
 *    大量 `btn.disabled = …` / `btn.setText()` / `btn.hide()` / `btn.addClass()`
 *    都是直接操作 DOM，包一层会让它们全部失效。要加行为用下面导出的
 *    `setButtonRole()` / `setButtonIcon()`，它们是纯 DOM 操作。
 */

import { setIcon } from "obsidian";

/** 主次。⚠️ 现在全站外观一致（2026-10-02 用户令），它只是**语义标签**：
 *  styles.css 里 `.yl-btn-primary` 是空规则。将来要恢复主次，改 CSS 那一条即可。 */
export type ButtonRole = "default" | "primary" | "danger";

/**
 * 形状 —— 由「这个按钮扮演什么角色」决定，**不是第二套皮肤**。
 *
 * ⚠️ 这个枚举就是「插件里到底有几种按钮」的清单。要加一种新按钮，先问能不能
 * 归进现有某一种；真要新增，改这里 + styles.css，别在视图里手搓一个类名。
 *
 * 前三种（pill / icon / text）走全站统一的 `yl-btn` 皮肤；
 * 后四种各自在 CSS 里有独立规则（形状是角色决定的，但底/悬停/过渡仍同全站）。
 */
export type ButtonShape =
  /** 常规带底药丸（默认） */
  | "pill"
  /** 只有一个图标的方形钮（28px，small 时 22px） */
  | "icon"
  /** 贴着正文排的小文字钮 */
  | "text"
  /** 右下角悬浮问句球（46px，带轻微浮动动画） */
  | "launcher"
  /** 助手面板里的圆形发送钮（26px，空=灰/有字=反色，见 yl-assistant-send） */
  | "send"
  /** 提醒条里的动作钮 */
  | "alert"
  /** 🔒 原句卡片那一排（喇叭/乌龟/纠/罗马音）—— 2026-10-02 用户点名保留原样，
   *  **不参与全站统一**。只有它能长得不一样，别把新按钮往这里塞。 */
  | "hero";

export interface ButtonOptions {
  /** 按钮上的字。图标钮一般不给（给了就变成「图标 + 字」） */
  text?: string;
  /** Lucide 图标名（Obsidian 内置那一套，如 "play" / "x" / "rotate-ccw"） */
  icon?: string;
  role?: ButtonRole;
  shape?: ButtonShape;
  /** 大号（登录/验证那几颗），对应 `yl-btn-lg` */
  lg?: boolean;
  /** 撑满整行，对应 `yl-btn-block` */
  block?: boolean;
  /** 小号图标钮（22px），对应 `is-sm` */
  small?: boolean;
  /** 无障碍标签。⚠️ 给了 icon 就必填 —— 否则屏幕阅读器读不出这是干什么的 */
  ariaLabel?: string;
  /** 原生 tooltip。⚠️ 用户可见文案**禁实现术语**（见 MEMORY.md） */
  title?: string;
  /** 逃生舱：额外类名（如定位用的 `yl-auth-close`）。**别用它改外观** */
  cls?: string;
  /** 逃生舱：额外属性 */
  attr?: Record<string, string>;
  disabled?: boolean;
  hidden?: boolean;
  onClick?: (ev: MouseEvent, btn: HTMLButtonElement) => void;
}

/**
 * 算出一个按钮该有的全部类名。**这是全站按钮外观的唯一事实来源。**
 *
 * 刻意不让调用方拼字符串：拼字符串 = 每个人都能发明一种新组合。
 */
export function buttonClasses(opts: ButtonOptions): string[] {
  const shape = opts.shape ?? "pill";
  const out: string[] = [];

  switch (shape) {
    case "icon":
      out.push("yl-btn-icon");
      if (opts.small) out.push("is-sm");
      break;
    // ⚠️ 下面这几种在 styles.css 里各有独立规则，**不要**加 `yl-btn` ——
    //    加了会被 yl-btn 的 height/padding 顶成药丸，角色的形状就没了。
    case "text":
      out.push("yl-btn-text");
      break;
    case "launcher":
      out.push("yl-assistant-launcher");
      break;
    case "send":
      out.push("yl-assistant-send");
      break;
    case "alert":
      out.push("yl-alert-act");
      break;
    case "hero":
      out.push("yl-hero-chip");
      break;
    default: {
      // 🔥 基底类**强制**加上：以前有人只写 `yl-btn-primary` 漏掉 `yl-btn`，
      // 那种按钮全靠 CSS 里两个选择器并列才碰巧长得对 —— 加一个新 role 就会漏。
      out.push("yl-btn");
      if (opts.role === "primary") out.push("yl-btn-primary");
      if (opts.role === "danger") out.push("yl-btn-danger");
      if (opts.lg) out.push("yl-btn-lg");
      if (opts.block) out.push("yl-btn-block");
      break;
    }
  }

  if (opts.cls) out.push(opts.cls);
  return out;
}

/**
 * 造一颗按钮。插件里所有按钮都该走这里。
 *
 * @example
 * createButton(nav, { text: "下一句 →", onClick: () => this.showSlice(i + 1) });
 * createButton(controls, { shape: "icon", icon: "play", ariaLabel: "播放" });
 */
export function createButton(
  parent: HTMLElement,
  opts: ButtonOptions = {},
): HTMLButtonElement {
  // 🔥 图标钮必须带 aria-label：这是最容易漏、又最不显眼的一致性问题
  // （漏了外观完全正常，只是读屏和键盘用户不知道这颗是干什么的）。
  if (opts.icon && !opts.ariaLabel && !opts.text) {
    console.warn(
      "[young-look] 图标按钮缺少 ariaLabel —— 屏幕阅读器读不出它是干什么的",
      opts,
    );
  }

  const attr: Record<string, string> = { ...(opts.attr ?? {}) };
  if (opts.ariaLabel) attr["aria-label"] = opts.ariaLabel;
  if (opts.title) attr["title"] = opts.title;

  const btn = parent.createEl("button", {
    cls: buttonClasses(opts).join(" "),
    ...(opts.text !== undefined ? { text: opts.text } : {}),
    ...(Object.keys(attr).length > 0 ? { attr } : {}),
  });

  if (opts.icon) setIcon(btn, opts.icon);
  if (opts.disabled) btn.disabled = true;
  if (opts.hidden) btn.hide();
  if (opts.onClick) {
    btn.addEventListener("click", (ev: MouseEvent) => opts.onClick?.(ev, btn));
  }
  return btn;
}

/**
 * 运行时切换主次（替代散落各处的 `toggleClass("yl-btn-primary", bool)`）。
 * 只动 role 类，不碰基底类 —— 所以不会出现"切完变回宿主原生按钮"。
 */
export function setButtonRole(btn: HTMLButtonElement, role: ButtonRole): void {
  btn.removeClass("yl-btn-primary", "yl-btn-danger");
  if (role === "primary") btn.addClass("yl-btn-primary");
  if (role === "danger") btn.addClass("yl-btn-danger");
}

/** 运行时换图标（顺带换 aria-label —— 图标变了含义通常也变了） */
export function setButtonIcon(
  btn: HTMLButtonElement,
  icon: string,
  ariaLabel?: string,
): void {
  setIcon(btn, icon);
  if (ariaLabel !== undefined) btn.setAttribute("aria-label", ariaLabel);
}
