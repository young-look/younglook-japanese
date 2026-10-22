import { Notice, type App } from "obsidian";
import { DialogModal } from "../ui/dialog";
import { createButton } from "../ui/button";
import {
  FEEDBACK_KINDS,
  FEEDBACK_MAX_IMAGES,
  FEEDBACK_MAX_IMAGE_BYTES,
  FEEDBACK_MAX_LEN,
  type FeedbackKind,
} from "../services/feedbackApi";

/**
 * 问题反馈弹窗 —— 个人中心「我的」页底部那颗「问题反馈」打开的窗。
 *
 * ══ 它收什么 ══════════════════════════════════════════════════════════
 * 三样：分类（三选一，必选）、一句话以上的正文、可选截图（最多 3 张）。
 * 提交后落服务端的反馈队列表，运营在 ops「用户反馈」页按时间倒序看到它。
 *
 * ══ 为什么分类是必选 ══════════════════════════════════════════════════
 * 「播放按钮点了没反应」和「能不能加个夜间模式」是两种东西，走的是两条路
 * （一个进排期、一个进需求池）。让用户提交时顺手选一下，比运营事后自己
 * 从正文里猜快得多 —— 这一步省不掉，所以没选就不让提交。
 *
 * ══ 截图怎么进来 ══════════════════════════════════════════════════════
 * 两条路都开：**点「添加截图」选文件**，或者直接 **Ctrl/⌘+V 粘贴剪贴板里的图**。
 * 后者是反馈场景的本能动作（刚截完图就在剪贴板里），只给一个选文件按钮
 * 会逼用户先去存盘 —— 多一步就少一半截图。
 *
 * ⚠️ 预览用的是 `URL.createObjectURL`，**关窗时必须逐个 revoke** ——
 *    不回收的话这几个 blob 会一直挂在内存里直到插件重载。
 *
 * 弹窗壳走 `DialogModal.buildShell`，本文件一行都不自己写壳。
 */
export interface FeedbackSubmit {
  kind: FeedbackKind;
  content: string;
  files: File[];
}

export interface FeedbackModalOptions {
  /** 插件版本号，随反馈一起上行（运营排查「哪个版本开始的」用） */
  clientVersion: string;
  /** 真正发请求的那一步（拿令牌 + 调接口）。抛错就留在窗里，让用户能改完重发 */
  onSubmit: (payload: FeedbackSubmit) => Promise<void>;
}

export class FeedbackModal extends DialogModal {
  private kind: FeedbackKind | null = null;
  private kindBtns: HTMLButtonElement[] = [];
  private readonly shots: { file: File; url: string }[] = [];

  private input: HTMLTextAreaElement | null = null;
  private shotWrap: HTMLElement | null = null;
  private addBtn: HTMLButtonElement | null = null;
  private counter: HTMLElement | null = null;
  private footEl: HTMLElement | null = null;
  private submitting = false;
  /** 粘贴监听的句柄 —— 关窗要摘掉（`modalEl` 会被复用，不摘会挂第二份） */
  private onPaste: ((ev: ClipboardEvent) => void) | null = null;

  constructor(
    app: App,
    private readonly opts: FeedbackModalOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    const { body, foot } = this.buildShell({
      icon: "notebook-pen",
      title: "问题反馈",
      subtitle: "说一下遇到了什么，带上截图更好定位",
      // 宽档 560：三颗分类钮 + 截图缩略图一排，窄档 470 会挤成两行
      width: "wide",
      cls: "yl-fb",
    });

    this.buildKinds(body);
    this.buildInput(body);
    this.buildShots(body);
    this.renderFoot(foot);
    this.bindPaste();
  }

  protected onBeforeClose(): void {
    for (const shot of this.shots) URL.revokeObjectURL(shot.url);
    this.shots.length = 0;
    if (this.onPaste) {
      this.modalEl.removeEventListener("paste", this.onPaste);
      this.onPaste = null;
    }
  }

  // ── 分类：三选一 ────────────────────────────────────────────────────

  private buildKinds(body: HTMLElement): void {
    const field = body.createDiv({ cls: "yl-fb-field" });
    field.createDiv({ cls: "yl-fb-label", text: "这是哪一类" });
    const row = field.createDiv({ cls: "yl-fb-kinds" });
    this.kindBtns = FEEDBACK_KINDS.map((kind) => {
      const btn = createButton(row, { cls: "yl-fb-kind", text: kind.label });
      btn.setAttribute("title", kind.hint);
      btn.addEventListener("click", () => {
        this.kind = kind.key;
        // 选中态只留一颗：三颗里亮两颗会让人以为可以多选
        for (const other of this.kindBtns) other.toggleClass("is-on", other === btn);
        this.refreshFoot();
      });
      return btn;
    });
  }

  // ── 正文 ────────────────────────────────────────────────────────────

  private buildInput(body: HTMLElement): void {
    const field = body.createDiv({ cls: "yl-fb-field" });
    const lab = field.createDiv({ cls: "yl-fb-label" });
    lab.createSpan({ text: "说说具体情况" });
    this.counter = lab.createSpan({ cls: "yl-fb-count", text: `0 / ${FEEDBACK_MAX_LEN}` });

    this.input = field.createEl("textarea", {
      cls: "yl-fb-text",
      attr: {
        rows: "5",
        maxlength: String(FEEDBACK_MAX_LEN),
        placeholder: "点了什么、看到了什么、本来期待什么 —— 写得越具体越好定位。",
      },
    });
    this.input.addEventListener("input", () => {
      const len = (this.input?.value ?? "").length;
      this.counter?.setText(`${len} / ${FEEDBACK_MAX_LEN}`);
      this.refreshFoot();
    });
    // 焦点直接落在正文里：打开就是为了打字，别让人再点一下
    this.input.focus();
  }

  // ── 截图 ────────────────────────────────────────────────────────────

  private buildShots(body: HTMLElement): void {
    const field = body.createDiv({ cls: "yl-fb-field" });
    const lab = field.createDiv({ cls: "yl-fb-label" });
    lab.createSpan({ text: "截图" });
    lab.createSpan({
      cls: "yl-fb-tip",
      text: `可选 · 最多 ${FEEDBACK_MAX_IMAGES} 张 · 单张 5MB 内`,
    });

    this.shotWrap = field.createDiv({ cls: "yl-fb-shots" });
    this.shotWrap.toggleClass("is-empty", true);
    this.shotWrap.createDiv({ cls: "yl-fb-shot-empty", text: "可以直接 Ctrl / ⌘ + V 粘贴截图" });

    const row = field.createDiv({ cls: "yl-fb-shot-row" });
    this.addBtn = createButton(row, { text: "添加截图" });
    const file = row.createEl("input", {
      attr: { type: "file", accept: "image/*", multiple: "true" },
    });
    file.hide();
    this.addBtn.addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const picked = Array.from(file.files ?? []);
      // 清空 value：连着选同一张图第二次也要能触发 change
      file.value = "";
      for (const f of picked) this.addShot(f);
    });
  }

  /** 粘贴：剪贴板里的图片直接进窗（刚截完图的人不用先存盘） */
  private bindPaste(): void {
    this.onPaste = (ev: ClipboardEvent) => {
      const items = Array.from(ev.clipboardData?.files ?? []);
      const images = items.filter((f) => f.type.startsWith("image/"));
      if (!images.length) return;
      ev.preventDefault();
      for (const f of images) this.addShot(f);
    };
    this.modalEl.addEventListener("paste", this.onPaste);
  }

  private addShot(file: File): void {
    if (this.shots.length >= FEEDBACK_MAX_IMAGES) {
      new Notice(`最多 ${FEEDBACK_MAX_IMAGES} 张截图`);
      return;
    }
    if (file.size > FEEDBACK_MAX_IMAGE_BYTES) {
      new Notice("单张截图不能超过 5 兆");
      return;
    }
    this.shots.push({ file, url: URL.createObjectURL(file) });
    this.renderShots();
  }

  private renderShots(): void {
    const wrap = this.shotWrap;
    if (!wrap) return;
    wrap.empty();
    wrap.toggleClass("is-empty", this.shots.length === 0);
    if (!this.shots.length) {
      wrap.createDiv({ cls: "yl-fb-shot-empty", text: "可以直接 Ctrl / ⌘ + V 粘贴截图" });
      return;
    }
    this.shots.forEach((shot, index) => {
      const cell = wrap.createDiv({ cls: "yl-fb-shot" });
      cell.createEl("img", { attr: { src: shot.url, alt: "" } });
      createButton(cell, {
        shape: "icon",
        small: true,
        icon: "x",
        cls: "yl-fb-shot-del",
        ariaLabel: "移除这张截图",
        onClick: () => {
          URL.revokeObjectURL(shot.url);
          this.shots.splice(index, 1);
          this.renderShots();
        },
      });
    });
    // 满了就把「添加截图」暗掉：再点只会弹一句"最多 3 张"，不如直接说不能加
    if (this.addBtn) this.addBtn.disabled = this.shots.length >= FEEDBACK_MAX_IMAGES;
  }

  // ── 底栏 ────────────────────────────────────────────────────────────

  private renderFoot(foot: HTMLElement): void {
    this.footEl = foot;
    this.fillFoot(
      foot,
      {
        text: "提交",
        role: "primary",
        disabled: !this.canSubmit(),
        onClick: () => void this.submit(),
      },
      { cancel: { text: "取消" }, note: this.footNote() },
    );
  }

  /** 底栏会被反复重画（选了分类 / 打了字 / 提交中），状态字每次都要跟着变 */
  private refreshFoot(): void {
    if (this.footEl) this.renderFoot(this.footEl);
  }

  private canSubmit(): boolean {
    return this.kind !== null && (this.input?.value ?? "").trim().length > 0 && !this.submitting;
  }

  private footNote(): string {
    if (!this.kind) return "先选一个分类";
    if (!(this.input?.value ?? "").trim()) return "写一句再提交";
    return "";
  }

  private async submit(): Promise<void> {
    if (!this.kind) {
      new Notice("先选一个分类");
      return;
    }
    const content = (this.input?.value ?? "").trim();
    if (!content) {
      new Notice("写一句再提交");
      this.input?.focus();
      return;
    }
    this.submitting = true;
    this.refreshFoot();
    try {
      await this.opts.onSubmit({
        kind: this.kind,
        content,
        files: this.shots.map((s) => s.file),
      });
      new Notice("反馈已提交，谢谢");
      this.close();
    } catch (error) {
      // 留在窗里：写完的东西不能因为网络抖一下就没了
      new Notice(error instanceof Error ? error.message : "没提交成功，稍后再试。");
      this.submitting = false;
      this.refreshFoot();
    }
  }
}
