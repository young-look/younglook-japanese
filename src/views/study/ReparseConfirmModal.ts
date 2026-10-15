/**
 * 「重新解析」确认窗 —— 学习页上**唯一一次点击前问一句**的窗。
 *
 * 为什么单独开一颗窗（2026-10-08 用户拍板）：这一句已经解析过了，再点一次
 * 不是"看上次的结果"（那条路走本机缓存、一分钱不花，见 StudyView 的 showCached），
 * 而是**重新发一次请求** —— 内置模型按实际用量从余额扣费。用户点了才知道扣费
 * 不可接受，所以在花钱之前拦一下，由人点头才发。
 *
 * ══ 2026-10-15：从"一句话确认"升级成**两块可选**（用户拍板） ══════════════
 *
 * 原先这条路写死「只重算左侧解读，词表不重算」，于是想救词表的用户被指向「纠」
 * 按钮 —— 可「纠」是**手改**、不是重新解析，产品给的路是错的。现在这一窗同时
 * 承担两件事：**问**（花钱前点头）与**选**（这次要重算哪一块）。
 *
 * 三条设计口径：
 *   · **默认 = 缺哪块勾哪块**；两块都不缺就都勾（用户点它的前提通常就是"不满意
 *     眼前这两块"）。「缺」由上层判定（解读正文为空 / 有内容词还没释义），
 *     本构件不猜内容，只认传进来的 `missing`。
 *   · **悬停某一行 → 背景里对应的那块亮起来**（`onHighlight`，实现在上层：
 *     弹窗带遮罩，那两块得被抬到遮罩之上才看得见）。标签后还跟着位置词
 *     （左下 / 右上）兜底 —— 那块被滚出视野时，高亮也就无从谈起。
 *   · **一块都不勾 = 确认钮置灰**：点了什么都不发生最像"坏了"，而它其实只是
 *     "没选东西"。
 *
 * 壳走 `ui/dialog.ts` 的统一壳（居中竖版 V1，跟「需要先配置模型」同一档）：
 * 全站弹窗长相只有这一处定义，别在这儿另写一套宽度/圆角。
 *
 * ⚠️ 文案按**实际生效的轨道**分叉（`resolveAiRoute`）：双轨自由选（2026-10-12）
 * 之后轨道就是用户自己选的 —— 选内置说"扣余额"，选自定义说"不扣余额"，各说各的实话。
 */
import { type App } from "obsidian";

import { DialogModal } from "../../ui/dialog";

/** 会被重算的两块。键名与界面上的两个分区一一对应。 */
export type ReparseBlock = "explain" | "words";

/** 一块（整句解读 / 逐词释义）现在的状态 —— 决定默认勾选与行内那行小字。 */
export interface ReparseBlockState {
  /**
   * 这一块现在**缺**吗（缺 → 默认勾上）。口径由上层定：
   * 解读 = 没有正文；逐词释义 = 一个释义都没有，或有内容词还没释义。
   */
  missing: boolean;
  /** 行内说明（"已有内容" / "有 2 个词还没释义" / "还没有内容"） */
  note: string;
}

export interface ReparseSelection {
  explain: boolean;
  words: boolean;
}

export interface ReparseConfirmOpts {
  /** 实际生效的轨道：决定正文说的是"扣余额"还是"花自己的额度" */
  aiMode: "off" | "byok" | "hosted";
  explain: ReparseBlockState;
  words: ReparseBlockState;
  /**
   * 鼠标停在某一行上 / 移开（null）：让背景里对应的那块亮起来。
   * 实现在上层 —— 只有它知道那两块在哪儿（`StudyView.highlightReparseTarget`）。
   */
  onHighlight(block: ReparseBlock | null): void;
  /** 点「重新解析」→ 真的发请求（关窗后才回调），带上这次勾了什么 */
  onConfirm(selection: ReparseSelection): void;
}

/** 两行的静态部分：名字 + 位置词（位置是给"高亮看不见"时兜底的）。 */
const ROWS: { key: ReparseBlock; label: string; where: string }[] = [
  { key: "explain", label: "整句解读", where: "左下" },
  { key: "words", label: "逐词释义", where: "右上" },
];

export class ReparseConfirmModal extends DialogModal {
  private readonly selected: ReparseSelection;
  private summaryEl: HTMLElement | null = null;
  private primaryBtn: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly opts: ReparseConfirmOpts,
  ) {
    super(app);
    // 默认 = 缺哪块勾哪块；两块都不缺 → 都勾（点这按钮通常就是"两块都不满意"）
    const missing = { explain: opts.explain.missing, words: opts.words.missing };
    this.selected = missing.explain || missing.words
      ? { explain: missing.explain, words: missing.words }
      : { explain: true, words: true };
  }

  onOpen(): void {
    const { body, foot } = this.buildShell({
      // refresh-cw 在宿主 lucide 里真实存在（核过 obsidian.asar）—— 别换成
      // "coins"/"wallet" 这类看着更贴题的：它们不在，setIcon 会静默不出图。
      icon: "refresh-cw",
      title: "重新解析这一句吗？",
      variant: "center",
    });

    const rows = body.createDiv({ cls: "yl-reparse-rows" });
    for (const row of ROWS) {
      this.buildRow(rows, row.key, row.label, row.where);
    }

    // 勾了什么 —— 两块 = 两次请求，扣费也是两次，得说在明面上
    this.summaryEl = body.createDiv({ cls: "yl-reparse-summary" });
    body.createEl("p", {
      text: this.opts.aiMode === "hosted"
        ? "用内置模型生成，按实际用量从余额扣费。"
        : "用你自己的 Key 生成，不扣余额。",
      cls: "yl-lead",
    });

    const { primaryBtn } = this.fillFoot(
      foot,
      {
        text: "重新解析",
        role: "primary",
        onClick: () => {
          this.close();
          this.opts.onConfirm({ ...this.selected });
        },
      },
      {
        // 「再想想」不传 onClick = 关窗，什么都不发生（底栏默认行为，见 fillFoot）。
        // 想要"降级成只读缓存"之类的副作用，先问清楚再往这儿加。
        cancel: { text: "再想想" },
      },
    );
    this.primaryBtn = primaryBtn;
    this.sync();
  }

  onClose(): void {
    // 关窗（确认 / 再想想 / ESC / 点遮罩）都要把高亮撤掉 —— 漏了它，
    // 那张卡会一直亮着，看着像"还在解析"
    this.opts.onHighlight(null);
    super.onClose();
  }

  private buildRow(parent: HTMLElement, key: ReparseBlock, label: string, where: string): void {
    const state = key === "explain" ? this.opts.explain : this.opts.words;
    const row = parent.createDiv({
      cls: `yl-reparse-opt${state.missing ? " is-missing" : ""}`,
    });
    const box = row.createEl("input", { attr: { type: "checkbox" } });
    box.checked = this.selected[key];

    const text = row.createDiv({ cls: "yl-reparse-opt-text" });
    const title = text.createDiv({ cls: "yl-reparse-opt-title" });
    title.createSpan({ text: label });
    title.createSpan({ text: where, cls: "yl-reparse-opt-where" });
    text.createDiv({ text: state.note, cls: "yl-reparse-opt-note" });

    const sync = (): void => {
      this.selected[key] = box.checked;
      this.sync();
    };
    box.addEventListener("change", sync);
    // 整行可点（不只那个小方框）：点击目标大一点，鼠标不必对准十几像素
    row.addEventListener("click", (ev) => {
      if (ev.target === box) return; // 点方框本身走 change 那条，别翻两次
      box.checked = !box.checked;
      sync();
    });
    row.addEventListener("mouseenter", () => this.opts.onHighlight(key));
    row.addEventListener("mouseleave", () => this.opts.onHighlight(null));
  }

  /** 勾选变了就更新"要重算什么"与确认钮的可用性 —— 状态只在这一处收口。 */
  private sync(): void {
    const none = !this.selected.explain && !this.selected.words;
    if (this.primaryBtn) {
      // 只置 disabled：置灰的样子由 `button.yl-btn:disabled` 那套统一样式给，
      // 不在这儿另加类名（全站按钮的禁用长相只有一处定义）。
      this.primaryBtn.disabled = none;
    }
    if (!this.summaryEl) return;
    const picked = ROWS.filter((row) => this.selected[row.key]).map((row) => row.label);
    this.summaryEl.setText(
      none
        ? "两块都没勾 —— 先选要重新生成的内容。"
        : `将要重新生成：${picked.join(" + ")}`,
    );
    this.summaryEl.toggleClass("yl-warn-text", none);
  }
}
