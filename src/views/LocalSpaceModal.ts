/**
 * 「这台机器上还有没认领的学习数据」—— 首次登录时的认领窗（2026-10-10 重做）。
 *
 * ══ 它取代了什么 ══════════════════════════════════════════════════════
 * 旧模型里本机库只有一份、认了主就换不掉，于是 A 登出 B 登录时必须问「这份数据
 * 跟谁走」（改用新账号 / 保留给原账号）—— 共用电脑上那就是"后登录的人一键把前
 * 一个人的数据抢走"。新模型把归属反过来推（见 `services/localSpace.ts`）：
 *   匿名空间**恒存在**且不属于任何账号；登录 = 进入"我在本机的空间"（没有就新建）。
 * 所以这张窗问的不再是"跟谁走"，而是"**匿名空间里那批数据要不要接过去**"。
 *
 * ══ 版式（2026-10-10 用户拍板）═════════════════════════════════════════
 *   中间**两张可点的卡**（单选）—— 点中的那张变青蓝，没点的是白底；
 *   底下两颗钮：「确定」+「放弃登录」。没选之前**「确定」是禁用的**。
 *   ⇒ 出路有两条：要么选一张卡，要么放弃这次登录 —— 不存在"做不出选择就卡死"。
 *
 * 为什么「放弃登录」必须留着（而不是像计划里那样砍掉）：**认领与不认领都是
 * 不可逆的**。选了「不认领」，这个账号在本机的空间就建出来了，以后再登录直接
 * 进它、永不再问 —— 那批匿名数据从此跟这个账号再没关系（只能一直当匿名数据用）。
 * 所以"我还没想好"必须能退出去，否则用户是在被逼着做一个不能再改的决定。
 *
 * ⚠️ 这是**必答题**（`locked: true`）：Esc / 点背景 / 点右上 ✕ 都关不掉，
 *    只能从上面那三条路里走一条（见 `ui/dialog.ts` 的 `locked` 档）。
 */

import { type App } from "obsidian";
import { accountLabel, type SpacePeer } from "../services/localSpace";
import { DialogModal } from "../ui/dialog";

/** 两条路 —— 值即选中态；`null` = 还没选（「确定」保持禁用）。 */
type ClaimChoice = "claim" | "keep";

export class LocalSpaceModal extends DialogModal {
  /** 用户点中的那条路。`onOpen` 每次重置 —— 实例可能被复用。 */
  private choice: ClaimChoice | null = null;
  /** 底栏那颗「确定」。没选中时禁用，选中后由 `select()` 解禁。 */
  private primaryBtn: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly options: {
      /** 刚登录进来的账号 —— 匿名数据要么归它，要么留在这儿 */
      account: SpacePeer;
      /** 认领：匿名空间原地变成这个账号的空间（另开一份新的空匿名空间） */
      onClaim: () => void;
      /** 不认领：匿名数据原样留在匿名空间，给它另开一份空的本机数据 */
      onSkip: () => void;
      /** 放弃这次登录：丢掉刚换到的登录态，回到未登录 + 匿名空间 */
      onAbort: () => void;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    const who = accountLabel(this.options.account.name, this.options.account.uid);
    const { body, foot } = this.buildShell({
      icon: "database",
      title: "这台机器上还有没认领的学习数据",
      subtitle: `你登录的是 ${who}`,
      // 必答题：不做选择关不掉（Esc / 背景 / ✕ 都被拦下），见文件头。
      locked: true,
    });
    this.choice = null;

    body.createEl("p", {
      cls: "yl-lead",
      text: "未登录时产生的记录留在匿名空间里，它不属于任何账号。这个账号要么把它接过去，要么让它留在这儿 —— 两条路都不会删掉任何东西。",
    });

    const list = body.createDiv({ cls: "yl-choice-list" });
    this.buildChoice(list, "claim", {
      name: `认领给 ${who}`,
      desc: "这些记录从此跟着这个账号，以后换台电脑登录也能看到。这个账号在本机不会再问第二次。",
    });
    this.buildChoice(list, "keep", {
      name: "留在匿名空间",
      desc: "记录留在「未登录」的那份数据里，退出登录还能看到；这个账号从一份空的学习数据开始，它自己云端已有的记录会同步回来。",
    });

    const { primaryBtn } = this.fillFoot(
      foot,
      {
        text: "确定",
        disabled: true, // 没选之前点不动（要退出就走「放弃登录」）
        onClick: () => this.confirm(),
      },
      {
        cancel: {
          text: "放弃登录",
          onClick: () => {
            this.closeLocked(); // 解锁再关：只有真做了选择才放行
            this.options.onAbort();
          },
        },
      },
    );
    this.primaryBtn = primaryBtn;
  }

  /**
   * 一张可点的卡（选项名 + 说明）。
   *
   * 🔥 用 `<button>` 而不是 `<div role="radio">`：键盘可达 / 焦点环 / 点按反馈
   *    全部白拿，不用自己补 `tabindex` 与 Enter 键处理。代价是外观得靠类名
   *    整条重写（宿主 `button:not(.clickable-icon)` 是 (0,1,1)，光写 `.yl-choice`
   *    压不住它，见 styles.css 里那几条的 `button.` 前缀）。
   */
  private buildChoice(
    parent: HTMLElement,
    value: ClaimChoice,
    input: { name: string; desc: string },
  ): void {
    const btn = parent.createEl("button", {
      cls: "yl-choice",
      attr: {
        type: "button",
        "data-choice": value,
        role: "radio",
        // 初始都没选 —— 默认不预选（最不易误操作）
        "aria-checked": "false",
      },
    });
    btn.createDiv({ cls: "yl-choice-t", text: input.name });
    btn.createDiv({ cls: "yl-choice-d", text: input.desc });
    btn.addEventListener("click", () => this.select(value));
  }

  /**
   * 单选：点哪张哪张变青蓝，另一张回到白底；同时给「确定」解禁。
   *
   * ⚠️ 两张卡的样式不靠 JS 算 —— `is-selected` 一个类名，配色全在 CSS 里
   *    （青蓝语言跟着全站状态色 `--yl-acc-*` 走，深浅色主题各自有值）。
   */
  private select(value: ClaimChoice): void {
    this.choice = value;
    for (const card of Array.from(this.contentEl.querySelectorAll<HTMLButtonElement>(".yl-choice"))) {
      const on = card.getAttribute("data-choice") === value;
      card.toggleClass("is-selected", on);
      card.setAttribute("aria-checked", on ? "true" : "false");
    }
    if (this.primaryBtn) this.primaryBtn.disabled = false;
  }

  /** 「确定」：只走选中的那一条。没选时按钮是禁用的，这里再兜一道。 */
  private confirm(): void {
    const choice = this.choice;
    if (!choice) return;
    this.closeLocked();
    if (choice === "claim") this.options.onClaim();
    else this.options.onSkip();
  }
}
