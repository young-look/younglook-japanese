import { Notice, type App } from "obsidian";
import { kanaToRomaji } from "../services/jaTokenize";
import { normalizeTextFix } from "../services/study";
import type { StudySentence } from "../types/entities";
import { DialogModal } from "../ui/dialog";
import { createButton } from "../ui/button";

/**
 * 纠错弹窗（2026-10-03 用户定；设计稿 `temp/demo/correction-v1.html`）。
 *
 * ══ 它解决什么 ══════════════════════════════════════════════════════
 * 之前「纠」是在原句卡片里就地展开一块面板：只改注音、改完要点卡片上那个小×。
 * 两件事不对：
 *  1. **只能改注音**。字幕本身有错（人名、同音字、机器翻译）时没有出口。
 *  2. **面板挤在卡片里**，句子一长就把下面的练习步骤顶走。
 *
 * 2026-10-05 用户定：字幕都有错的可能，**纯假名句也要能纠**（入口不再按
 * 「有没有带汉字的词」收放）；弹窗里那排 0.25×~1.5× 变速 + 循环 + 时钟撤掉，
 * 换成跟原句卡一样的两颗：喇叭（1×）+「慢」（0.5×），够了。
 *
 * ══ 三处能改的东西，边界不一样 ══════════════════════════════════════
 * · **注音** —— 改过的词进 `readingFixes`，校验 surface 跟当前分词一致。
 *   🔥 全站读音优先级第一档（用户手改 > AI 解析 > 本机词典），AI 重新解析也不许盖回去。
 * · **中文** —— 改进 `textFixes.zh`。零风险：中文不参与任何派生计算。
 * · **日文** —— 改进 `textFixes.ja`，**`slice.ja` 本身不动**。
 *   🔥🔥 日文参与身份派生（`sliceCid` 三句 hash），真去改那个字段会让这句的
 *   cid 对不上已有进度 / 录音 / 单词卡，全成孤儿。覆盖层是方案 A
 *   （用户 2026-10-03 定的）：身份永远锚在原片字幕上，用户的版本叠加显示。
 *
 * ══ 弹窗壳 ═══════════════════════════════════════════════════════════
 * 宽度/圆角/标题行/底栏**全走 `DialogModal.buildShell`**，这个文件一行都不自己写
 * —— 那是全站弹窗的唯一壳（`ui/dialog.ts`，用户 10-02 拍板统一 v2）。
 *
 * ⚠️ 标题左侧那颗图标必须是宿主 lucide 里**真实存在**的名字，否则 `setIcon`
 * **静默不渲染**（不报错、只是没图）。`notebook-pen` 已核过在可用清单里。
 * ⚠️ 构造器里**只存依赖、绝不建 DOM** —— `buildShell` 要先 `contentEl.empty()`，
 * 在它之前塞进去的节点会被清掉。
 * ⚠️ 说明块**不复用 `.yl-note`**：那是移除确认框的「学习记录不会被删除」，
 * 语义是"最怕误伤的东西"。这里要的是"跟字段一家的补充说明"，另起 `.yl-corr-help`。
 */

/** 注音只收假名（平/片假名、长音ー、中点・）：注音本来就是假名，填别的多半是手滑 */
const KANA_ONLY_RE = /^[\u3040-\u30ff・]+$/u;

export interface CorrectionAnnot {
  /** 分词序号 —— `readingFixes` 的键 */
  index: number;
  surface: string;
  reading: string;
}

export interface CorrectionOptions {
  slice: StudySentence;
  /** 当前句**可注音**的词（只有带汉字的那些），由 StudyView 分词后给 */
  annots: CorrectionAnnot[];
  /** 句中纯假名的词，只用来在面板上说清「为什么它们没列出来」 */
  lockedWords: string[];
  /** 这句实际显示的日文 / 中文（已套用 textFixes） */
  ja: string;
  zh: string;
  /** 副标题：作品 · 集 · 第 N 句 */
  subtitle: string;
  /**
   * 喇叭 / 慢：借**宿主**的播放器从头重播这句（1× / 0.5×，与原句卡上那一对
   * 同一套逻辑 —— 只有一个音频源，弹窗不另起播放器）。
   */
  onReplay(rate: 1 | 0.5): void;
  /** 关窗收尾：把播放器还给宿主 —— 停下、倍速回 1×，别留一句 0.5× 的在响 */
  onTeardown(): void;
  onSave: (fixes: {
    textFixes: StudySentence["textFixes"];
    readingFixes: StudySentence["readingFixes"];
  }) => void | Promise<void>;
}

export class CorrectionModal extends DialogModal {
  private jaInput: HTMLTextAreaElement | null = null;
  private zhInput: HTMLTextAreaElement | null = null;

  private readonly annotRows: {
    index: number;
    surface: string;
    reading: string;
    fixed: boolean;
    input: HTMLInputElement;
  }[] = [];

  constructor(
    app: App,
    private readonly opts: CorrectionOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    const { body, foot } = this.buildShell({
      icon: "notebook-pen",
      title: "纠错",
      subtitle: this.opts.subtitle,
      // 宽档 560：窄档 470 装不下「词面 + 输入框 + 罗马音」这一行
      width: "wide",
    });

    this.buildReplay(body);
    this.buildLive(body);
    this.buildFields(body);
    this.renderFoot(foot);
  }

  protected onBeforeClose(): void {
    this.opts.onTeardown();
  }
  // ── 喇叭 / 慢（与原句卡同一对，只这一种放法）──────────────────────────────

  private buildReplay(body: HTMLElement): void {
    const row = body.createDiv({ cls: "yl-corr-replay" });
    createButton(row, {
      shape: "hero",
      icon: "volume-2",
      ariaLabel: "再听一遍",
      title: "再听一遍",
      onClick: () => this.opts.onReplay(1),
    });
    createButton(row, {
      shape: "hero",
      text: "慢",
      ariaLabel: "0.5 倍速再听一遍",
      title: "0.5 倍速再听一遍",
      onClick: () => this.opts.onReplay(0.5),
    });
  }

  // ── 原句预览（静态，不随播放高亮）────────────────────────────────────────

  private buildLive(body: HTMLElement): void {
    const box = body.createDiv({ cls: "yl-corr-live" });
    const ja = box.createDiv({ cls: "yl-corr-ja" });
    ja.setAttr("lang", "ja");
    // ⚠️ 整句都要铺出来，ruby 只挂在带汉字的词上（纯假名的读音就是它自己）。
    // 旧版只铺 annots，句子里的假名段整段丢失 —— 画面上只剩「傷つけ分かつ」。
    const jaText = this.opts.ja;
    let cursor = 0;
    for (const annot of this.opts.annots) {
      const found = jaText.indexOf(annot.surface, cursor);
      if (found < 0) continue; // 词面拼不回句子（分词口径变了）→ 跳过，让它落进纯文本
      if (found > cursor) ja.createSpan({ text: jaText.slice(cursor, found) });
      const ruby = ja.createEl("ruby", { cls: "yl-corr-kw" });
      ruby.createSpan({ text: annot.surface });
      ruby.createEl("rt", { text: annot.reading });
      cursor = found + annot.surface.length;
    }
    if (cursor < jaText.length) ja.createSpan({ text: jaText.slice(cursor) });
    if (this.opts.zh) box.createDiv({ cls: "yl-corr-zh", text: this.opts.zh });
  }

  // ── 三个字段（说明都收在问号点里） ──────────────────────────────────────────

  private buildFields(body: HTMLElement): void {
    const fJa = this.buildField(body, {
      title: "日文字幕",
      hints: [
        { text: "改完会一直生效：以后重新导入这部片子，用的还是你改过的版本。" },
        { text: "整句改了的话，下面每个词的注音都要重新对一遍。", warn: true },
      ],
    });
    this.jaInput = fJa.content.createEl("textarea", { cls: "yl-corr-input is-ja" });
    this.jaInput.value = this.opts.ja;

    const fZh = this.buildField(body, {
      title: "中文字幕",
      tip: "没有译文也可以补一句",
      hints: [{ text: "只改显示，不参与任何计算 —— 随便改，不影响别的。" }],
    });
    this.zhInput = fZh.content.createEl("textarea", { cls: "yl-corr-input" });
    this.zhInput.value = this.opts.zh;

    const fRd = this.buildField(body, {
      title: "注音",
      tip: "只列带汉字的词",
      hints: [
        { text: "纯假名的词读音就是字面，不用改 —— 所以没列出来。" },
        { text: "清空一个词 = 恢复它原来的注音。" },
        { text: "这里改的注音只影响显示，不会写回字幕文件。", warn: true },
      ],
    });
    const list = fRd.content.createDiv({ cls: "yl-corr-rows" });
    for (const annot of this.opts.annots) list.appendChild(this.buildRow(annot));
    if (this.opts.lockedWords.length) {
      fRd.content.createDiv({
        cls: "yl-corr-locked",
        text: `「${this.opts.lockedWords.join("」「")}」是纯假名，没列出来。`,
      });
    }
  }

  /**
   * 一个字段 = 标题行（+ 可选提示 + 问号点）+ 说明区 + 内容槽。
   *
   * 说明默认收起，点问号就地展开在**它自己这个字段下面** —— 不占额外整块，
   * 弹窗因此能一屏装下（用户 10-29 定的口径）。
   */
  private buildField(
    body: HTMLElement,
    spec: { title: string; tip?: string; hints: { text: string; warn?: boolean }[] },
  ): { content: HTMLElement } {
    const field = body.createDiv({ cls: "yl-corr-field" });
    const lab = field.createDiv({ cls: "yl-corr-label" });
    lab.createDiv({ text: spec.title, cls: "yl-corr-label-title" });
    if (spec.tip) lab.createDiv({ text: spec.tip, cls: "yl-corr-label-tip" });

    const q = lab.createEl("button", {
      cls: "yl-corr-q",
      text: "?",
      attr: { "aria-label": `${spec.title}：这有什么要注意的`, "aria-expanded": "false" },
    });
    const panel = field.createDiv({ cls: "yl-corr-help" });
    for (const hint of spec.hints) {
      panel.createDiv({ text: hint.text, cls: hint.warn ? "is-warn" : "" });
    }
    q.addEventListener("click", () => {
      // ⚠️ Obsidian 的 `toggleClass(classes, value)` **要两个参数**，而且**返回 void**
      // —— 别拿返回值当"现在开没开"，那样 aria-expanded 永远写 false。
      const on = !panel.hasClass("on");
      panel.toggleClass("on", on);
      q.setAttr("aria-expanded", String(on));
    });

    return { content: field.createDiv({ cls: "yl-corr-field-body" }) };
  }

  /** 一个词一行：词面 + 假名输入框 + 罗马音（跟着重算）。 */
  private buildRow(annot: CorrectionAnnot): HTMLElement {
    const fixed = Boolean(this.opts.slice.readingFixes?.[String(annot.index)]);
    const row = this.contentEl.createDiv({ cls: "yl-corr-row" });
    row.setAttr("data-index", String(annot.index));
    row.createDiv({ cls: `yl-corr-row-dot${fixed ? "" : " is-off"}` });

    const wd = row.createDiv({ cls: "yl-corr-row-word" });
    wd.createDiv({ text: annot.surface });
    wd.createDiv({ text: kanaToRomaji(annot.reading), cls: "yl-corr-row-ro" });

    const input = row.createEl("input", {
      cls: "yl-corr-input",
      attr: { type: "text", value: annot.reading, spellcheck: "false" },
    });
    const romaji = row.createSpan({ cls: "yl-corr-row-ro2", text: kanaToRomaji(annot.reading) });
    input.addEventListener("input", () => {
      romaji.setText(kanaToRomaji(input.value.trim()));
    });
    if (fixed) row.createDiv({ cls: "yl-corr-row-fixed", text: "你改过" });

    this.annotRows.push({ ...annot, fixed, input });
    return row;
  }

  // ── 底栏 + 保存 ───────────────────────────────────────────────────────────

  private renderFoot(foot: HTMLElement): void {
    this.fillFoot(
      foot,
      { text: "保存", role: "primary", onClick: () => void this.save() },
      { cancel: { text: "取消", onClick: () => this.close() }, note: "改完先慢放听一遍再保存" },
    );
  }

  /**
   * 校验 + 落库。
   *
   * ⚠️ 注音非假名**就地报错并 return**，不静默丢弃：手滑打进去的「たなかx」
   * 如果被悄悄扔掉，用户会以为改好了。
   */
  private async save(): Promise<void> {
    const slice = this.opts.slice;
    const fixes: NonNullable<StudySentence["readingFixes"]> = { ...(slice.readingFixes ?? {}) };

    for (const row of this.annotRows) {
      const value = row.input.value.trim();
      const key = String(row.index);
      if (!value) {
        // 空 = 撤销这个词的纠错（回默认注音）
        if (row.fixed) delete fixes[key];
        continue;
      }
      if (!KANA_ONLY_RE.test(value)) {
        new Notice(`「${row.surface}」的注音只能填假名`);
        row.input.focus();
        return;
      }
      if (value === row.reading) continue;
      fixes[key] = { surface: row.surface, reading: value };
    }

    await this.opts.onSave({
      textFixes: normalizeTextFix(this.jaInput?.value ?? "", this.zhInput?.value ?? ""),
      readingFixes: Object.keys(fixes).length ? fixes : undefined,
    });
    this.close();
  }
}

