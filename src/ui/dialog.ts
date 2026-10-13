/**
 * 弹窗壳 —— 插件里所有 `Modal` 的唯一基类。
 *
 * ══ 为什么要有这个文件 ══════════════════════════════════════════════
 * 2026-10-02 之前，四个弹窗各写各的壳（`ImportModal` / `EditModal` /
 * `RemoveModal` / `ModelSetupModal`）：
 *   · `RemoveModal` **一个类都没加**，整个走宿主默认 `.modal`
 *     —— 560px 宽、24px 圆角、左对齐、按钮右对齐；
 *   · `ModelSetupModal` 自己加 `.yl-setup` 压到 400px / 14px 圆角 /
 *     居中 / 图标徽章 / 按钮居中；
 *   · 另外两个在 `contentEl` 上各挂一个 `yl-import` / `yl-edit`，
 *     宽度同样是宿主默认 560px。
 * ⇒ 同一个产品里两种弹窗长相（用户拿实机截图指出「弹窗风格不一致」）。
 *
 * 收敛之后（用户 2026-10-02 拍板：**全部采用 v2**）：
 *   · 宽度 / 圆角 / 内距 / 标题行 / 底栏对齐**只在这里写一次**；
 *   · 子类只说「标题是什么、正文放什么、底栏有哪些钮」，不碰壳；
 *   · 换壳只改这个文件 + styles.css 的 `.yl-dialog` 那一段，不动四个视图。
 *
 * ══ v2 长什么样（用户在 5 版候选里选的）═══════════════════════════
 *   470px · 圆角 14px · 左对齐 · 标题行左边一颗 28px 青蓝圆角小图标 ·
 *   正文 13px/1.75 · 底栏一条细线 + 按钮**居中**（主操作在右）。
 *   短提示不寡淡、长内容不打架 —— 这是选它而不是居中徽章/头部条的原因。
 *
 * 🔥 宽度/圆角/内距**必须挂 `modalEl`（盒子本体）**，不能只挂 `contentEl`：
 *    宿主 `.modal` 自带 `width: var(--dialog-width)` = 560px，而 `contentEl`
 *    是盒子里的内容层。只在它上面写 `max-width:380px`，盒子照旧 560px 宽、
 *    内容缩在左半边、右侧空一大块 —— 10-02 用户看到的就是这个「又宽又歪」。
 *
 * 🔥🔥 搭壳的方法**必须叫 `buildShell`，不能叫 `open`** —— `Modal` 已经有
 *    一个公开的 `open()`（打开弹窗，外部靠它启动）。基类里再定义一个 `open()`
 *    会**静默覆盖**它：`new RemoveModal(...).open()` 会去调搭壳而不是打开弹窗，
 *    表现是「点了没反应」；而 TS 只报 "Expected 1 arguments, but got 0"。
 *    这不是假想 —— 第一版就真写成了 `open`，靠 tsc 报错才拦住。
 *
 * @example
 * private render(): void {
 *   const { body, foot } = this.buildShell({
 *     icon: "trash-2", title: "移除这一集", subtitle: "娱乐人偶 · 第 1 季 第 8 集",
 *   });
 *   body.createEl("p", { text: "移除后…", cls: "yl-lead" });
 *   this.renderFoot(foot);
 * }
 */

import { Modal, setIcon, type App, type Scope } from "obsidian";
import { createButton, type ButtonOptions } from "./button";

/**
 * 宽度档。⚠️ 就是「插件里有几种弹窗宽度」的清单，要加一档先问能不能归进现有某档。
 *
 * · `narrow`（默认 470）= 一句话问询、确认框：内容撑不满也不会显空；
 * · `wide`（560）= 并排两张卡 + 名字栏（导入 / 编辑）—— 双卡挤在 470 里
 *   每张只剩 ~210px，卡里的图标和「＋ 再加一份」那行会折行（实测，别改回 470）。
 */
export type DialogWidth = "narrow" | "wide";

export interface DialogOptions {
  /**
   * 标题行左侧那颗 28px 图标（Lucide 名，必须在 Obsidian 自带那一套里真实存在，
   * 否则 `setIcon` **静默不渲染**：不报错，只是没图）。
   *
   * 已确认可用：trash-2 / sliders-horizontal / notebook-pen / upload / file-video。
   * ⚠️ `pencil` / `film` / `clapperboard` / `sparkles` **不在**（查 obsidian.asar 核过）。
   * 不想要图标就传 null / 省略。
   */
  icon?: string | null;
  /** 大标题 */
  title: string;
  /** 标题下面那行小字（对象名、补充说明）。留空就不建这个节点。 */
  subtitle?: string;
  /** 宽度档，默认 `narrow` */
  width?: DialogWidth;
  /**
   * 版式档，默认 `"row"`（2026-10-02 拍板的 v2 左对齐壳）。
   *
   * `"center"` = 居中竖版（2026-10-04 用户在 temp/demo/dialog 三版里选了 V1）：
   * 384px 窄盒、徽章居中放大到 46px、标题/正文/按钮全部居中，
   * 底栏不要细线 —— 主按钮升级成**实心青蓝**撑满整行（这是全站唯一的
   * 实心按钮皮，特权就限在 `variant: "center"` 的弹窗里），「取消」降为灰字。
   * 只给一句话问询用 —— 带复选框/表单的弹窗（移除/导入/编辑）不适用。
   */
  variant?: "row" | "center";
  /**
   * 逃生舱：额外类名挂 **contentEl**（只给内容层用，别拿来改盒子外观 ——
   * 宽度 / 圆角 / 内距一律在盒子上）。
   */
  cls?: string;
  /**
   * 「锁定」档（默认 false）：**必选弹窗，关不掉**。
   *
   * 给「不做选择就无法继续使用」的场合用（换账号归属，见 `LocalSpaceModal`）。
   * 打开后 Esc / 点背景 / 点右上 ✕ 都关不了 —— 只有子类调 `closeLocked()`
   * （用户真做了选择）才放行。主防线是 `close()` 里的守卫：三条关闭途径最终
   * 都汇到 `close()`，一处拦住即全覆盖；右上那颗 ✕ 由 `yl-dialog-locked`
   * 在 CSS 里藏掉。
   */
  locked?: boolean;
}

/** `open()` 的返回值：正文插槽 + 底栏，各弹窗自己往里放东西。 */
export interface DialogShell {
  /** 正文容器（`.yl-dialog-body`）。标题行和底栏不在里面。 */
  body: HTMLElement;
  /** 底栏容器（`.yl-dialog-foot`）。已带一条上边细线，按钮**居中**。 */
  foot: HTMLElement;
  /** 盒子本体，需要量尺寸时用（多数情况不需要）。 */
  modalEl: HTMLElement;
}

/**
 * 底栏的一颗钮。`role` 只是语义标签（全站按钮外观一致，主次靠位置）。
 */
export interface DialogAction {
  text: string;
  role?: ButtonOptions["role"];
  disabled?: boolean;
  /**
   * 点了做什么。**不给 = 关窗**（见 `fillFoot`）—— 「取消」这一类本来就只有
   * 这一件事，调用方不该为了关窗写一行样板、更不能忘了写（2026-10-08 踩过：
   * 底栏注释写着"默认关窗"而实现没接，于是有一颗钮点了毫无反应）。
   * ⚠️ 只在需要**额外**副作用时才传（先关窗再做别的），别传一个只调 `close()` 的。
   */
  onClick?: (ev: MouseEvent, btn: HTMLButtonElement) => void;
}

export interface DialogFootOptions {
  /** 左边那颗，默认文案「取消」、点了关窗。传 null 就只要一颗钮。 */
  cancel?: DialogAction | null;
  /**
   * 底栏上方那行状态字（「还差：名字」「勾选项也会一起执行」）。
   * 留空 = 整行不占位。
   */
  note?: string;
  /**
   * 状态字是不是「可以往下走了」那档（青蓝）。
   * ⚠️ 这是**状态**不是主次 —— 全站按钮主次不靠颜色，靠位置。
   */
  noteOk?: boolean;
}

export abstract class DialogModal extends Modal {
  /** 这次开的是哪一档宽度 —— `onClose` 要照它摘类名。 */
  private appliedWidth: DialogWidth = "narrow";
  /** 「锁定」档：true 时 `close()` 会被守卫拦下（见 `closeLocked`）。 */
  private locked = false;
  /** 已经吞过 Esc 的那个 scope —— 同一个 scope 只注册一次，避免重复挂键位。 */
  private escTrapped: Scope | null = null;

  constructor(app: App) {
    super(app);
  }

  /**
   * 搭壳并返回插槽。**每个弹窗的 `onOpen` 第一件事就是调它。**
   *
   * 清理（摘类名、清空内容）由基类的 `onClose` 统一做，子类只管实现
   * `onBeforeClose()` 放自己的收尾 —— 覆盖 `onClose` 忘了调 `super` 是
   * 那种不报错的静默 bug（盒子残留 560px 宽、上一次的类名带进这一次）。
   */
  protected buildShell(opts: DialogOptions): DialogShell {
    const { contentEl, modalEl } = this;

    // 🔥 盒子级样式（宽度/圆角/内距）必须挂在 modalEl 上，不是 contentEl。
    //    contentEl 是盒子里的**内容层**，挂它只会让内容缩在一角、盒子照旧 560px。
    modalEl.addClass("yl-dialog");
    this.appliedWidth = opts.width ?? "narrow";
    modalEl.toggleClass("yl-dialog-wide", this.appliedWidth === "wide");
    modalEl.toggleClass("yl-dialog-center", opts.variant === "center");

    // 「锁定」档：关不掉的必选弹窗（换账号归属）。类名藏掉右上 ✕，Esc 在
    // 作用域里拦一道，真正的兜底在 `close()` 守卫 —— 见 `closeLocked`。
    this.locked = opts.locked === true;
    modalEl.toggleClass("yl-dialog-locked", this.locked);
    if (this.locked && this.scope !== this.escTrapped) {
      this.scope.register([], "Escape", (evt) => {
        evt.preventDefault();
        return false;
      });
      this.escTrapped = this.scope;
    }

    contentEl.empty();
    contentEl.addClass("yl-dialog-inner");
    if (opts.cls) contentEl.addClass(opts.cls);

    // 标题行：[28px 图标] 标题 / 副标题
    const head = contentEl.createDiv({ cls: "yl-dialog-head" });
    if (opts.icon) {
      // ⚠️ 图标名必须在宿主 lucide 里真实存在，否则静默不渲染。
      setIcon(head.createDiv({ cls: "yl-dialog-mark" }), opts.icon);
    }
    const text = head.createDiv({ cls: "yl-dialog-head-text" });
    text.createDiv({ text: opts.title, cls: "yl-dialog-title" });
    if (opts.subtitle) text.createDiv({ text: opts.subtitle, cls: "yl-dialog-sub" });

    return {
      body: contentEl.createDiv({ cls: "yl-dialog-body" }),
      foot: contentEl.createDiv({ cls: "yl-dialog-foot" }),
      modalEl,
    };
  }

  /**
   * 子类的收尾钩子（作废在途请求之类）。**默认什么都不做**，
   * 想提前关闭弹窗就把活儿放这里，别去覆盖 `onClose`。
   */
  protected onBeforeClose(): void {
    /* 子类按需覆盖 */
  }

  onClose(): void {
    this.onBeforeClose();
    this.contentEl.empty();
    this.contentEl.removeClass("yl-dialog-inner");
    // 盒子类名摘干净：弹窗实例可能被留着复用，残留的宽度档会带到下一次打开。
    this.modalEl.removeClass("yl-dialog", "yl-dialog-wide", "yl-dialog-center", "yl-dialog-locked");
    this.locked = false;
  }

  /**
   * 🔥 「锁定」档的**主防线**：未解锁前拒绝一切关闭。
   *
   * Esc（宿主关窗键位）、点背景、点右上 ✕、以及任何程序性 `close()` 最终都
   * 汇到这个方法 —— 一处拦住即全覆盖，不必逐条堵途径。
   */
  close(): void {
    if (this.locked) return;
    super.close();
  }

  /**
   * 子类在**用户真做了选择**时调它关窗（见 `LocalSpaceModal`）。
   * 普通（未锁定）弹窗不受影响，照旧 `this.close()`。
   */
  protected closeLocked(): void {
    this.locked = false;
    this.close();
  }

  /**
   * 往底栏放两颗钮 —— 四个弹窗的底栏都是「取消 + 主操作」这个形状，
   * 共享一份写法，免得每处都手排 flex 和状态行。
   *
   * 主操作永远在**右边**（底栏居中排布，写入顺序即左右顺序）。
   * ⚠️ 底栏会被反复重画（校验状态一变就重画），所以每次都 `empty()` 重建 ——
   *    但这不影响正在打字的用户，因为输入框都在正文里，不在底栏。
   *
   * 🔥 取消钮**不传 `onClick` 就是关窗**（2026-10-08 修正）：默认那颗
   * `{ text: "取消" }` 原先只造了按钮、没人接 close，于是"点了毫无反应" ——
   * 注释写着默认关窗、实现没做，这种"文档对、代码错"的坑只能靠读实现发现。
   * 现在把默认行为落到实现里：调用方只在要**额外**副作用时才传 onClick。
   */
  protected fillFoot(
    foot: HTMLElement,
    primary: DialogAction,
    opts: DialogFootOptions = {},
  ): { primaryBtn: HTMLButtonElement } {
    foot.empty();

    // 状态行放在按钮**上面**一行：v2 的底栏是居中的一排钮，
    // 中间插一段会长会变的文字（"正在读字幕…"）会把整排顶歪。
    const note = opts.note ?? "";
    const noteEl = foot.createDiv({ text: note, cls: "yl-dialog-note" });
    // 空文案不占位（`:empty` 那条在 CSS 里）—— 状态行是"有话才出现"，不是常驻一条横。
    noteEl.toggleClass("is-on", note.length > 0);
    if (opts.noteOk) noteEl.addClass("is-ok");

    const cancel = opts.cancel === undefined ? { text: "取消" } : opts.cancel;
    if (cancel) {
      createButton(foot, {
        text: cancel.text,
        role: cancel.role,
        // 没给 onClick 就关窗（`DialogAction.onClick` 的注释是同一口径）
        onClick: cancel.onClick
          ? (ev, btn) => cancel.onClick?.(ev, btn)
          : () => this.close(),
      });
    }
    const primaryBtn = createButton(foot, {
      text: primary.text,
      role: primary.role,
      disabled: primary.disabled,
      onClick: (ev, btn) => primary.onClick?.(ev, btn),
    });
    return { primaryBtn };
  }
}
