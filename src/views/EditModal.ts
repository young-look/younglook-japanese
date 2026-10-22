import { Notice, type App } from "obsidian";
import { normalizeEpisodeNumber } from "../core/ids";
import { log } from "../core/logger";
import { episodeLabel } from "../markdown/templates";
import { findEditClash, saveRecordEdit } from "../services/episodeEdit";
import type { RecordListItem } from "../services/study";
import type YoungLookPlugin from "../main";
import { DialogModal } from "../ui/dialog";
import { KIND_OPTIONS, type WorkKind } from "./ImportModal";

/**
 * 「编辑素材信息」对话框：改导入时配置的那组固有属性 —— 视频名称、作品类型、
 * 年份、集号、季度、集标题。视频/字幕文件不在这里换（那是重新导入的事）。
 *
 * 与导入框同一套口径（2026-10-11 用户拍板）：作品类型必选（剧集类 / 非剧集类），
 * 剧集类才有季度 / 集号（都必填）与集标题；年份两种类型都能填（选填）。
 * 版式也同一套（名字栏 + 作品类型分段钮 + meta 行）与同一套交互纪律：
 *  · 名字栏只建一次，打字时**只重画底栏** —— 重建会抢走输入框的焦点；
 *  · 切换作品类型只重铺下面那组 meta 行，不碰名字栏；
 *  · 校验（撞名要查库，是异步的）结果只更新底栏那行状态，不打断打字。
 *
 * 视频名称是**每条记录自己的**展示字段（2026-10-14 身份模型重构后不再整部作品
 * 共用）。保存走 services/episodeEdit 的 `saveRecordEdit` —— 改的全是展示字段，
 * recordCid 不重派生，进度/笔记零影响。
 */
export class EditModal extends DialogModal {
  private title = "";
  /** 作品类型：由这一集现在有没有集号反推（剧集类 = 有集号） */
  private workKind: WorkKind;
  private year = "";
  private season = "";
  private number = "";
  private episodeTitle = "";
  private busy = false;

  /** 撞名检查的在途标记：只认最后一次输入的结果，旧回包作废 */
  private checkRun = 0;
  /** 撞上的对方作品名；null = 没撞（或还没查完） */
  private clashWith: string | null = null;
  /** 名字/数字字段没填对时的人话；空 = 没问题 */
  private invalid = "";

  private footEl: HTMLElement | null = null;
  private metaEl: HTMLElement | null = null;
  private segEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly plugin: YoungLookPlugin,
    private readonly entry: RecordListItem,
    private readonly options: { onSaved?: () => void | Promise<void> } = {},
  ) {
    super(app);
    const record = entry.record;
    this.title = record.title || record.titleJa || "";
    this.year = record.year != null ? String(record.year) : "";
    this.season = record.season != null ? String(record.season) : "";
    this.number = record.number;
    this.episodeTitle = record.episodeTitle;
    this.workKind = record.number.trim() ? "series" : "single";
  }

  onOpen(): void {
    this.render();
    void this.checkClash();
  }

  protected onBeforeClose(): void {
    this.checkRun++; // 在途的撞名检查作废
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────

  /** 与移除确认框、列表行同一套拼法 */
  private targetText(): string {
    const record = this.entry.record;
    const label = episodeLabel(record.season, record.number);
    const head = [record.title || record.titleJa, label].filter(Boolean).join(" · ");
    return `${head}${record.episodeTitle ? ` ${record.episodeTitle}` : ""}`;
  }

  private render(): void {
    const { body, foot } = this.buildShell({
      icon: "notebook-pen",
      title: "编辑素材信息",
      subtitle: this.targetText(),
      // 这一屏有名字栏 + 作品类型分段钮 + 最多四行 meta —— 挤在 470 里每一行
      // 只剩 ~200px，说明小字会折成三行。宽一档是实测出来的，别改回窄档。
      width: "wide",
    });

    // 名字栏：与导入框同一套类名（.yl-name*），同一份样式
    const nameBox = body.createDiv({ cls: "yl-name" });
    const nameLabel = nameBox.createDiv({ text: "视频名称", cls: "yl-name-label" });
    nameLabel.createSpan({ cls: "yl-req", text: "*" });
    const nameInput = nameBox.createEl("input", {
      type: "text",
      cls: "yl-name-input",
      attr: { placeholder: "这部作品叫什么" },
    });
    nameInput.value = this.title;
    nameInput.addEventListener("input", () => {
      this.title = nameInput.value;
      void this.checkClash();
      this.renderFoot();
    });
    const nameFoot = nameBox.createDiv({ cls: "yl-name-foot" });
    nameFoot.createSpan({ cls: "yl-tag" });

    this.renderKindField(body);
    this.metaEl = body.createDiv({ cls: "yl-meta" });
    this.renderMetaFields();

    this.footEl = foot;
    this.renderFoot();
  }

  /** 作品类型：与导入框同一套分段钮（同样两颗、同样文案，见 ImportModal） */
  private renderKindField(parent: HTMLElement): void {
    const box = parent.createDiv({ cls: "yl-field" });
    const label = box.createDiv({ text: "作品类型", cls: "yl-field-label" });
    label.createSpan({ cls: "yl-req", text: "*" });
    const seg = box.createDiv({ cls: "yl-seg" });
    this.segEl = seg;
    for (const option of KIND_OPTIONS) {
      const btn = seg.createEl("button", {
        cls: "yl-seg-btn",
        text: option.label,
        attr: { type: "button", "data-kind": option.value },
      });
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        this.setWorkKind(option.value);
      });
    }
    this.syncKindButtons();
  }

  private syncKindButtons(): void {
    const seg = this.segEl;
    if (!seg) return;
    for (const btn of Array.from(seg.querySelectorAll<HTMLButtonElement>(".yl-seg-btn"))) {
      btn.toggleClass("is-selected", btn.dataset.kind === this.workKind);
    }
  }

  /** 切换作品类型：只重铺 meta 行 + 重查撞名，不重建名字栏（不丢焦点）。 */
  private setWorkKind(kind: WorkKind): void {
    if (this.workKind === kind) return;
    this.workKind = kind;
    // 剧集类：季度、集号默认第 1 季第 1 集；已有值不动
    if (kind === "series") {
      if (!this.season.trim()) this.season = "1";
      if (!this.number.trim()) this.number = "1";
    }
    this.syncKindButtons();
    this.renderMetaFields();
    void this.checkClash();
    this.renderFoot();
  }

  /** meta 行随作品类型增减；与导入框同一套类名与说明文案。 */
  private renderMetaFields(): void {
    const parent = this.metaEl;
    if (!parent) return;
    parent.empty();
    const isSeries = this.workKind === "series";
    if (isSeries) {
      this.field(parent, "season", "季度", "第几季，默认第 1 季", true);
      this.field(parent, "number", "集号", "支持 1.5 这种特别篇", true);
    }
    this.field(parent, "year", "年份", "同名作品才需要填；不填也行", false);
    if (isSeries) {
      this.field(parent, "episodeTitle", "集标题", "可留空", false);
    }
  }

  /** meta 行：与导入框同一套类名与说明文案 */
  private field(
    parent: HTMLElement,
    key: "year" | "number" | "season" | "episodeTitle",
    name: string,
    desc: string,
    required: boolean,
  ): void {
    const row = parent.createDiv({ cls: "yl-meta-row" });
    const info = row.createDiv({ cls: "yl-meta-info" });
    const nameEl = info.createDiv({ text: name, cls: "yl-meta-name" });
    if (required) nameEl.createSpan({ cls: "yl-req", text: "*" });
    if (desc) info.createDiv({ text: desc, cls: "yl-meta-desc" });
    const input = row.createEl("input", {
      type: "text",
      cls: "yl-meta-input",
      attr: { spellcheck: "false" },
    });
    input.value = this[key];
    input.addEventListener("input", () => {
      this[key] = input.value;
      void this.checkClash();
      this.renderFoot();
    });
  }

  private renderFoot(): void {
    const el = this.footEl;
    if (!el) return;

    let note = "✓ 可以保存";
    let noteOk = true;
    if (this.invalid) {
      note = this.invalid;
      noteOk = false;
    } else if (!this.title.trim()) {
      note = "还差：名称";
      noteOk = false;
    } else if (this.missingMeta().length > 0) {
      note = `还差：${this.missingMeta().join(" · ")}`;
      noteOk = false;
    } else if (this.clashWith) {
      note = `已经有同名的这一集了：撞上了《${this.clashWith}》`;
      noteOk = false;
    }

    this.fillFoot(
      el,
      {
        role: "primary",
        text: "保存",
        disabled: this.busy || !this.canSave(),
        onClick: () => void this.run(),
      },
      { cancel: { text: "取消", onClick: () => this.close() }, note, noteOk },
    );
  }

  /**
   * 名字栏之外还缺哪些 **必填** 字段的人话清单。
   * 剧集类要季度与集号；非剧集类没有别的必填。
   */
  private missingMeta(): string[] {
    if (this.workKind !== "series") return [];
    const need: string[] = [];
    if (!this.season.trim()) need.push("季度");
    if (!this.number.trim()) need.push("集号");
    return need;
  }

  /** 非剧集类没有季度/集号 —— 保存时一律落空，不看输入框里残留的值。 */
  private nextSeason(): number | null {
    return this.workKind === "series" ? parseOptionalInt(this.season) : null;
  }

  private nextNumber(): string {
    return this.workKind === "series" ? normalizeEpisodeNumber(this.number) : "";
  }

  private nextEpisodeTitle(): string {
    return this.workKind === "series" ? this.episodeTitle.trim() : "";
  }

  private canSave(): boolean {
    if (!this.title.trim()) return false;
    if (this.clashWith) return false;
    if (this.invalid) return false;
    if (this.missingMeta().length > 0) return false;
    return (
      this.title.trim() !== (this.entry.record.title || this.entry.record.titleJa || "") ||
      parseOptionalInt(this.year) !== this.entry.record.year ||
      this.nextSeason() !== this.entry.record.season ||
      this.nextNumber() !== this.entry.record.number ||
      this.nextEpisodeTitle() !== this.entry.record.episodeTitle
    );
  }

  // ── 校验与保存 ──────────────────────────────────────────────────────────

  /**
   * 底栏那行状态要的人话：年份（和剧集类的季度）写了就得是数字，别的随意。
   * （集号是自由文本 —— 1.5、特别篇都行，保存时统一归一化；非剧集类不校验。）
   */
  private validate(): void {
    this.invalid = "";
    const checks: Array<[string, string]> = [["年份", this.year]];
    if (this.workKind === "series") checks.push(["季度", this.season]);
    for (const [label, raw] of checks) {
      if (raw.trim() && !Number.isFinite(Number(raw.trim()))) {
        this.invalid = `${label}得是数字`;
        return;
      }
    }
  }

  /** 撞名要查库，是异步的：只认最后一次输入的结果。 */
  private async checkClash(): Promise<void> {
    this.validate();
    this.renderFoot();
    const run = ++this.checkRun;
    const title = this.title.trim();
    if (!title || this.invalid) {
      this.clashWith = null;
      return;
    }
    const clash = await findEditClash(
      this.plugin.db,
      { recordCid: this.entry.record.cid },
      {
        workTitle: title,
        season: this.nextSeason(),
        number: this.nextNumber(),
      },
    );
    if (run !== this.checkRun) return; // 用户又打了字：这包结果作废
    this.clashWith = clash;
    this.renderFoot();
  }

  private async run(): Promise<void> {
    if (this.busy || !this.canSave()) return;
    this.busy = true;
    try {
      const outcome = await saveRecordEdit(
        this.plugin.db,
        this.entry.record,
        {
          workTitle: this.title.trim(),
          year: parseOptionalInt(this.year),
          season: this.nextSeason(),
          number: this.nextNumber(),
          episodeTitle: this.nextEpisodeTitle(),
        },
      );
      if (!outcome.ok) {
        // 撞名在这里再拦一次：弹窗的检查是异步的，赶在回包前点保存完全可能。
        // 就地改口底栏状态，不关窗，用户改完接着存。
        this.clashWith = null;
        this.invalid = outcome.reason ?? "没能保存";
        this.renderFoot();
        this.busy = false;
        this.renderFoot();
        return;
      }
      this.close();
      await this.options.onSaved?.();
    } catch (error) {
      log.warn("编辑没能保存", error);
      new Notice("没能保存，稍后再试。");
      this.busy = false;
      this.renderFoot();
    }
  }
}

// ── 常量与纯函数 ────────────────────────────────────────────────────────────

/** 年份/季度输入 → 数字或 null。空串是 null；非数字上层已拦（validate），这里兜底也回 null。 */
function parseOptionalInt(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num) : null;
}
