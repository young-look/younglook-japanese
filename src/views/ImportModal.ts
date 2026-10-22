import { Notice, type App } from "obsidian";
import type YoungLookPlugin from "../main";
import { importSubtitle, type ImportProgress } from "../services/importer";
import { resolveMediaDir } from "../services/mediaStore";
import { guessFromFilename } from "../services/guess";
import { lookupEpisodeTitle, lookupSubject } from "../services/bangumi";
import { fileSize, readTextFile } from "../storage/files";
import {
  containsLanguages,
  detectFormat,
  parseRawLines,
  type RawLine,
} from "../services/subtitle/parse";
import { VIEW_TYPE_STUDY } from "./StudyView";
import { createButton } from "../ui/button";
import { setMarkup } from "../ui/safeHtml";
import { DialogModal } from "../ui/dialog";

/**
 * 导入对话框。用户手上的活儿只剩两件：**选一个视频、配上字幕**，
 * 然后「确定」。其余一律不问他。
 *
 * 版面就是一个方框里并排两张卡：左＝视频，右＝字幕。选好就从虚线变实心、
 * 右上角打勾，一眼看出进度。卡里没有输入框，所以可以随时重画，
 * 不会打断正在打字的用户（输入框都单独维护，不整个重建）。
 *
 * 字幕**默认一份、最多两份**（日语、中文各一份；一份中日双语合并版也算数）。
 * 语种不问用户 —— 读文件内容自己判（看假名占比，见 languagesOf）。
 * 判完发现缺哪门语言，就在卡片下面浮一条提醒，把「再加一份」的入口
 * 直接放在提醒里。缺日文是硬拦截（没有日文台词就没法出句子），
 * 缺中文只提醒不拦（少一份对照，照样能学）。
 *
 * 必填的是**视频名称**和**作品类型**（2026-10-11 用户拍板新增）：没有名字笔记就
 * 没名字；作品类型决定下面还要填什么 ——
 *   · 剧集类：季度 / 集号都是必填（带 `*`，默认第 1 季第 1 集），另有选填的
 *     年份与集标题；
 *   · 非剧集类（单集、剧场版）：只剩一个选填的年份。
 * 年份两种类型都能填（选填），用来区分同名作品。识别不出视频信息时，
 * 让用户起个名、再选一下类型就够了。
 *
 * ⚠️ 「作品类型」不落成一个新字段：剧集类＝有季度/集号，非剧集类＝两者都空，
 * 正是既有的数据形态（`EpisodeRow`），所以服务端与同步层一点都不用动。
 *
 *  ⚠️ 视频会被**复制**一份到素材库（设置里的「素材库目录」，默认在 vault 外），
 *  以后按素材库里的那份播放 —— 用户整理自己的文件夹不会再把这一集弄坏。
 *  他原来那份留着不动，我们不删、不挪。
 * 路径都必须是**绝对路径**：资源管理器里右键视频或字幕文件时会自动带出路径，
 * 也可以点卡片从系统对话框里选、或直接把文件拖到卡上。
 * 插件不下载、不检索视频本体，只负责把字幕切成句子切片、和视频对上号。
 */

/** 名字栏之外的几个字段（作品类型决定哪些出现、哪些必填）。 */
type MetaKey = "year" | "season" | "number" | "episodeTitle";
const META_KEYS: readonly MetaKey[] = ["year", "season", "number", "episodeTitle"];

/**
 * 作品类型（必选）。只影响**这一屏显示什么**，不落一个新字段：
 * 「剧集类」＝有季度/集号，「非剧集类」＝两者都空 —— 正是既有的数据形态，
 * 服务端与同步层一点都不用动。
 *
 * ⚠️ 导出给「编辑这一集」用（`EditModal`）—— 两处必须同一套口径与同一串文案，
 * 各写一份必然漂移。
 */
export type WorkKind = "series" | "single";
export const KIND_OPTIONS: ReadonlyArray<{ value: WorkKind; label: string }> = [
  { value: "series", label: "剧集类" },
  { value: "single", label: "非剧集类" },
];

/** 一份已选的字幕。语种是读出来的，不是用户选的。 */
interface SubEntry {
  path: string;
  state: "reading" | "ready" | "bad";
  ja: boolean;
  zh: boolean;
  /** state === "bad" 时给人看的原因 */
  error: string;
}

interface Coverage {
  ja: boolean;
  zh: boolean;
  /** 还有文件在读 —— 读之前不下任何结论 */
  reading: boolean;
  /** 读不出来的那几份，附一句人话 */
  bad: string[];
}

export class ImportModal extends DialogModal {
  // ── 用户给的三个信息 ──
  private title = "";
  private videoPath = "";
  private videoSize: number | null = null;
  private subs: SubEntry[] = [];

  // ── 名字栏之外的几个字段 ──
  /** 作品类型（必选）。null = 还没选 —— 底栏会一直催 */
  private workKind: WorkKind | null = null;
  private year = "";
  private season = "";
  private number = "";
  private episodeTitle = "";
  private metaInputs: Partial<Record<MetaKey, HTMLInputElement>> = {};
  /** 用户手改过的字段被钉住，识别结果不再覆盖它。 */
  private pinned: Record<MetaKey, boolean> = {
    year: false,
    season: false,
    number: false,
    episodeTitle: false,
  };
  private titlePinned = false;
  private guessedTitle = "";
  private detectRun = 0;
  private busy = false;
  /**
   * 导入进行到哪个慢阶段（importer 的 onProgress 报上来），footer 提示用它。
   * 几 GB 的视频算哈希/拷素材库要 10~30 秒 —— 不挂状态用户会以为卡死了。
   */
  private phase: string | null = null;

  // ── 只重画这几块，别整个表单重建（会抢走名字栏的焦点）──
  private videoTileEl: HTMLElement | null = null;
  private subsTileEl: HTMLElement | null = null;
  private alertEl: HTMLElement | null = null;
  private metaEl: HTMLElement | null = null;
  private segEl: HTMLElement | null = null;
  private footEl: HTMLElement | null = null;
  private nameInputEl: HTMLInputElement | null = null;
  private guessTagEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly plugin: YoungLookPlugin,
    subtitlePath: string,
    preset?: {
      title?: string;
      number?: string;
      season?: number | null;
      year?: number | null;
      /** 右键视频文件进来时预填 */
      videoPath?: string;
    },
  ) {
    super(app);
    if (subtitlePath.trim()) this.subs.push(pendingEntry(subtitlePath.trim()));
    this.videoPath = preset?.videoPath ?? "";
    this.title = preset?.title ?? "";
    this.number = preset?.number ?? "";
    this.season = preset?.season != null ? String(preset.season) : "";
    this.year = preset?.year != null ? String(preset.year) : "";
  }

  onOpen(): void {
    this.render();
    void this.syncSubEntries();
    if (this.videoPath) void this.loadVideoInfo(this.videoPath);
    void this.detect();
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────

  private render(): void {
    const { body, foot } = this.buildShell({
      icon: "file-video",
      title: "导入这一集",
      subtitle: "选一个视频，配上字幕。",
      // 这一屏是并排两张卡 + 名字栏：挤在 470 里每张卡只剩 ~210px，
      // 卡里的图标和「＋ 再加一份」那行会折行。宽一档是实测出来的，别改回窄档。
      width: "wide",
    });

    const pair = body.createDiv({ cls: "yl-pair" });
    this.videoTileEl = pair.createDiv({ cls: "yl-tile" });
    this.subsTileEl = pair.createDiv({ cls: "yl-tile" });
    bindDropTarget(this.videoTileEl, () => this.pickVideo(), (path) => void this.setVideoPath(path));
    bindDropTarget(this.subsTileEl, () => this.pickSubtitle(), (path) => this.addSubtitle(path));

    this.alertEl = body.createDiv({ cls: "yl-alert-slot" });
    this.renderNameField(body);
    this.renderKindField(body);
    this.metaEl = body.createDiv({ cls: "yl-meta" });
    this.renderMetaFields();
    this.footEl = foot;

    this.refresh();
  }

  /** 重画两张卡、提醒条和底栏。名字栏不在这里，避免打字时被打断。 */
  private refresh(): void {
    this.renderVideoTile();
    this.renderSubsTile();
    this.renderAlert();
    this.renderFoot();
  }

  private renderVideoTile(): void {
    const el = this.videoTileEl;
    if (!el) return;
    el.empty();
    const path = this.videoPath.trim();

    if (!path) {
      el.removeClass("is-done");
      setMarkup(el.createDiv({ cls: "yl-tile-ico" }), ICON_VIDEO);
      el.createDiv({ text: "选择视频", cls: "yl-tile-title" });
      el.createDiv({ text: "点一下选，或拖进来", cls: "yl-tile-hint" });
      return;
    }

    el.addClass("is-done");
    setMarkup(el.createDiv({ cls: "yl-tile-check" }), ICON_CHECK);
    const head = el.createDiv({ cls: "yl-tile-head" });
    setMarkup(head.createSpan({ cls: "yl-tile-ico" }), ICON_VIDEO);
    head.createSpan({ text: basenameOf(path), cls: "yl-tile-title" });
    const hint = this.videoSize != null ? `${humanSize(this.videoSize)} · 点一下换一个` : "点一下换一个";
    el.createDiv({ text: hint, cls: "yl-tile-hint" });
  }

  private renderSubsTile(): void {
    const el = this.subsTileEl;
    if (!el) return;
    el.empty();

    if (this.subs.length === 0) {
      el.removeClass("is-done");
      setMarkup(el.createDiv({ cls: "yl-tile-ico" }), ICON_SUBS);
      el.createDiv({ text: "选择字幕", cls: "yl-tile-title" });
      el.createDiv({ text: "中日可分开给，最多两份", cls: "yl-tile-hint" });
      return;
    }

    el.addClass("is-done");
    el.createDiv({ cls: "yl-tile-count", text: `${this.subs.length} 份` });
    const head = el.createDiv({ cls: "yl-tile-head" });
    setMarkup(head.createSpan({ cls: "yl-tile-ico" }), ICON_SUBS);
    head.createSpan({ text: "字幕", cls: "yl-tile-title" });

    const list = el.createDiv({ cls: "yl-sub-list" });
    for (const entry of this.subs) {
      const item = list.createDiv({ cls: "yl-sub-item" });
      item.createSpan({ text: langLabelOf(entry), cls: "yl-sub-lang" });
      item.createSpan({ text: basenameOf(entry.path), cls: "yl-sub-name" });
      item
        .createSpan({ text: "×", cls: "yl-sub-rm", attr: { title: "移除这份" } })
        .addEventListener("click", (event) => {
          event.stopPropagation(); // 别把「移除」当成「再加一份」
          this.removeSubtitle(entry.path);
        });
    }
    if (this.subs.length < MAX_SUBTITLES) {
      list
        .createDiv({ text: "＋ 再加一份", cls: "yl-sub-add" })
        .addEventListener("click", (event) => {
          event.stopPropagation();
          this.pickSubtitle();
        });
    }
  }

  /**
   * 提醒条。一次只说一件事，按「文件读不出来 > 缺日文 > 缺中文」的顺序。
   * 缺日文拦得住导入，缺中文拦不住 —— 后者只想让人知道「少了一份对照」。
   */
  private renderAlert(): void {
    const slot = this.alertEl;
    if (!slot) return;
    slot.empty();
    if (this.subs.length === 0) return;

    const coverage = this.coverage();
    if (coverage.bad.length > 0) {
      this.renderAlertBox(slot, "warn", "这份字幕读不出来", coverage.bad[0], null);
      return;
    }
    if (coverage.reading) return;
    if (coverage.ja && coverage.zh) return;

    const room = this.subs.length < MAX_SUBTITLES;
    if (!coverage.ja) {
      this.renderAlertBox(
        slot,
        "warn",
        "没检测到日文字幕",
        room
          ? "这一集要按日文台词来学，中文字幕只是对照。再加一份日文字幕就能继续。"
          : "这一集要按日文台词来学，中文字幕只是对照。把其中一份换成日文字幕就能继续。",
        room ? { text: "加一份日文", onClick: () => this.pickSubtitle() } : null,
      );
      return;
    }
    this.renderAlertBox(
      slot,
      "warn",
      "没检测到中文字幕",
      room
        ? "没有中文就只能看日文原文。加一份中文字幕，就有中日对照了。"
        : "两份里都没有中文。想要对照的话，把其中一份换成中文字幕。",
      room ? { text: "加一份中文", onClick: () => this.pickSubtitle() } : null,
    );
  }

  private renderAlertBox(
    parent: HTMLElement,
    tone: "warn" | "danger",
    title: string,
    body: string,
    action: { text: string; onClick: () => void } | null,
  ): void {
    const box = parent.createDiv({ cls: `yl-alert is-${tone}` });
    setMarkup(
      box.createSpan({ cls: "yl-alert-ico" }),
      tone === "danger" ? ICON_WARN : ICON_INFO,
    );
    const text = box.createDiv({ cls: "yl-alert-text" });
    text.createEl("b", { text: title });
    text.createSpan({ text: body });
    if (action) {
      createButton(box, { shape: "alert", text: action.text, onClick: action.onClick });
    }
  }

  private renderNameField(parent: HTMLElement): void {
    const box = parent.createDiv({ cls: "yl-name" });
    const label = box.createDiv({ text: "视频名称", cls: "yl-name-label" });
    label.createSpan({ cls: "yl-req", text: "*" });
    const input = box.createEl("input", {
      type: "text",
      cls: "yl-name-input",
      attr: { placeholder: "例如：葬送的芙莉莲" },
    });
    input.value = this.title;
    input.addEventListener("input", () => {
      this.title = input.value;
      this.titlePinned = true;
      this.renderFoot(); // 「还差」要跟着变；别重画整个表单，用户还在打字
    });
    this.nameInputEl = input;

    // 只在识别结果确实等于当前名字时才亮徽标；没有徽标时这一行就空着
    const foot = box.createDiv({ cls: "yl-name-foot" });
    this.guessTagEl = foot.createSpan({ cls: "yl-tag" });
    this.updateGuessTag();
  }

  /**
   * 作品类型：两颗并列的按钮，必选。
   *
   * 之所以要用户明说，是因为「非剧集」以前只能靠「集号留空」隐式表达 ——
   * 那个约定藏在说明小字里，用户根本猜不到。点一下就重铺下面的字段。
   */
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

  /** 切换作品类型：更新选中态 + 重铺字段；剧集类给季度/集号补默认值。 */
  private setWorkKind(kind: WorkKind): void {
    if (this.workKind === kind) return;
    this.workKind = kind;
    // 剧集类：季度、集号默认第 1 季第 1 集；已经识别/填过的值不动
    if (kind === "series") {
      if (!this.season.trim()) this.season = "1";
      if (!this.number.trim()) this.number = "1";
    }
    this.syncKindButtons();
    this.renderMetaFields();
    this.renderFoot();
  }

  /** 只在识别结果确实等于当前名字时才亮这枚徽标 —— 徽标不能说假话。 */
  private updateGuessTag(): void {
    const el = this.guessTagEl;
    if (!el) return;
    const show = !!this.guessedTitle && this.guessedTitle === this.title.trim();
    el.setText(show ? "✓ 按文件名识别" : "");
    el.toggleClass("is-on", show);
  }

  /**
   * 名字栏之外的字段。哪些出现由作品类型决定：
   *   · 剧集类：季度* → 集号* → 年份 → 集标题；
   *   · 非剧集类：只有年份；还没选类型时也先摆一个年份。
   * 切换作品类型时整块重铺；输入框引用留着给识别回填。
   */
  private renderMetaFields(): void {
    const parent = this.metaEl;
    if (!parent) return;
    parent.empty();
    this.metaInputs = {};

    const isSeries = this.workKind === "series";
    if (isSeries) {
      this.metaSetting(parent, "season", "季度", "第几季，默认第 1 季", "1", true);
      this.metaSetting(parent, "number", "集号", "支持 1.5 这种特别篇", "1", true);
    }
    this.metaSetting(parent, "year", "年份", "同名作品才需要填；不填也行", "2023", false);
    if (isSeries) {
      this.metaSetting(parent, "episodeTitle", "集标题", "可留空", "", false);
    }
  }

  private metaSetting(
    parent: HTMLElement,
    key: MetaKey,
    name: string,
    desc: string,
    placeholder: string,
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
      attr: { placeholder },
    });
    input.value = this[key];
    input.addEventListener("input", () => {
      this[key] = input.value;
      this.pinned[key] = true;
      this.renderFoot(); // 季度/集号是必填，「还差」要跟着变
    });
    this.metaInputs[key] = input;
  }

  private renderFoot(): void {
    const el = this.footEl;
    if (!el) return;

    const coverage = this.coverage();
    const need: string[] = [];
    if (!this.videoPath.trim()) need.push("视频");
    if (this.subs.length === 0) need.push("字幕");
    else if (!coverage.reading && !coverage.ja) need.push("日文字幕");
    if (!this.title.trim()) need.push("名称");
    need.push(...this.missingMeta());

    let note = `还差：${need.join(" · ")}`;
    let noteOk = false;
    if (this.busy) note = this.phase ?? "正在导入…";
    else if (coverage.reading) note = "正在读字幕…";
    else if (coverage.bad.length > 0) note = "先处理读不出来的字幕";
    else if (need.length === 0) {
      note = "✓ 都齐了";
      noteOk = true;
    }

    this.fillFoot(
      el,
      {
        role: "primary",
        text: "确定",
        disabled: this.busy || !this.canImport(),
        onClick: () => void this.runImport(),
      },
      { note, noteOk },
    );
  }

  // ── 选文件 ──────────────────────────────────────────────────────────────

  private pickVideo(): void {
    pickFilePath(VIDEO_ACCEPT, (path) => void this.setVideoPath(path));
  }

  private pickSubtitle(): void {
    if (this.subs.length >= MAX_SUBTITLES) {
      new Notice("字幕最多两份：日文一份、中文一份。");
      return;
    }
    pickFilePath(SUBTITLE_ACCEPT, (path) => this.addSubtitle(path));
  }

  private async setVideoPath(raw: string): Promise<void> {
    const path = cleanPath(raw);
    if (!path) return;
    this.videoPath = path;
    this.videoSize = null;
    this.refresh();
    try {
      this.videoSize = await fileSize(path);
    } catch {
      new Notice("读不到这个视频文件，看看它还在不在原处。");
      this.videoPath = "";
    }
    this.refresh();
    void this.detect();
  }

  /** 只把体积补上（右键视频进来时用）；文件已经不在了就悄悄清掉，别吓人。 */
  private async loadVideoInfo(path: string): Promise<void> {
    try {
      this.videoSize = await fileSize(path);
    } catch {
      this.videoPath = "";
    }
    this.refresh();
  }

  private addSubtitle(raw: string): void {
    const path = cleanPath(raw);
    if (!path) return;
    if (this.subs.length >= MAX_SUBTITLES) {
      new Notice("字幕最多两份：日文一份、中文一份。");
      return;
    }
    if (this.subs.some((entry) => entry.path === path)) {
      new Notice("这份字幕已经加过了。");
      return;
    }
    this.subs.push(pendingEntry(path));
    this.refresh();
    void this.syncSubEntries();
  }

  private removeSubtitle(path: string): void {
    this.subs = this.subs.filter((entry) => entry.path !== path);
    this.refresh();
    void this.detect();
  }

  // ── 读字幕判语种 ────────────────────────────────────────────────────────

  private async syncSubEntries(): Promise<void> {
    const pending = this.subs.filter((entry) => entry.state === "reading");
    if (pending.length === 0) return;
    await Promise.all(pending.map((entry) => this.inspectEntry(entry)));
    this.refresh();
  }

  /**
   * 读一份字幕，判它含有哪几门语言。
   * 判不出来（读不到、格式不认、没有时间轴）就标记成 bad，让用户在卡上看见，
   * 而不是等导入时才被告知 —— 那时他已经点了「确定」。
   */
  private async inspectEntry(entry: SubEntry): Promise<void> {
    const format = detectFormat(entry.path);
    if (!format) {
      entry.state = "bad";
      entry.error = "格式还不支持，只认 .ass / .ssa / .srt / .vtt / .lrc。";
      return;
    }
    let lines: RawLine[];
    try {
      lines = parseRawLines(await readTextFile(entry.path), format);
    } catch {
      entry.state = "bad";
      entry.error = "读不到这份文件，路径可能已经变了。";
      return;
    }
    if (lines.length === 0) {
      entry.state = "bad";
      entry.error = "里面读不出带时间轴的台词，纯文本和卡拉OK特效都不行。";
      return;
    }
    const langs = languagesOf(lines);
    entry.state = "ready";
    entry.ja = langs.ja;
    entry.zh = langs.zh;
  }

  private coverage(): Coverage {
    return {
      ja: this.subs.some((entry) => entry.state === "ready" && entry.ja),
      zh: this.subs.some((entry) => entry.state === "ready" && entry.zh),
      reading: this.subs.some((entry) => entry.state === "reading"),
      bad: this.subs
        .filter((entry) => entry.state === "bad")
        .map((entry) => `${basenameOf(entry.path)}：${entry.error}`),
    };
  }

  // ── 自动识别（只填名字和收起的那几个字段）────────────────────────────────

  /**
   * 本地按文件名解析（零成本、离线可用），再免费查一把 Bangumi 补年份和集标题 ——
   * 都只写进**没被用户钉住**的字段，名字栏除外（用户改过就不动）。
   * 识别只是预填，导入的硬性字段还是视频、字幕、名字三个。
   */
  private async detect(): Promise<void> {
    const run = ++this.detectRun;
    const base = basenameOf(this.videoPath || this.subs[0]?.path || "");
    const guess = base ? guessFromFilename(base) : null;

    // 空结果也照写：文件换错了，上一份的识别残留必须清掉
    if (!this.titlePinned) this.title = guess?.workTitle ?? "";
    this.applyMeta("number", guess?.number ?? "");
    this.applyMeta("season", guess?.season != null ? String(guess.season) : "");
    this.applyMeta("year", guess?.year != null ? String(guess.year) : "");
    this.guessedTitle = guess?.workTitle ?? "";
    this.syncNameInput();
    this.refreshMetaInputs();
    this.updateGuessTag();
    this.renderFoot();

    const query = this.title.trim();
    if (!query) return;
    const subject = await lookupSubject(query);
    if (run !== this.detectRun) return; // 用户又换了文件：这包结果作废
    if (!subject) return;

    if (subject.year && !this.pinned.year) {
      this.year = String(subject.year);
      this.refreshMetaInputs();
    }
    const currentNumber = this.number.trim();
    if (!currentNumber) return;
    const episodeTitle = await lookupEpisodeTitle(subject.id, currentNumber);
    if (run !== this.detectRun) return;
    if (episodeTitle && !this.pinned.episodeTitle && !this.episodeTitle.trim()) {
      this.episodeTitle = episodeTitle;
      this.refreshMetaInputs();
    }
  }

  private applyMeta(key: MetaKey, value: string): void {
    if (this.pinned[key]) return;
    this[key] = value;
  }

  private syncNameInput(): void {
    if (this.nameInputEl && this.nameInputEl.value !== this.title) {
      this.nameInputEl.value = this.title;
    }
  }

  private refreshMetaInputs(): void {
    for (const key of META_KEYS) {
      const input = this.metaInputs[key];
      if (input && input.value !== this[key]) input.value = this[key];
    }
  }

  // ── 导入 ────────────────────────────────────────────────────────────────

  private canImport(): boolean {
    const coverage = this.coverage();
    return (
      !!this.videoPath.trim() &&
      !!this.title.trim() &&
      this.subs.length > 0 &&
      !coverage.reading &&
      coverage.bad.length === 0 &&
      coverage.ja &&
      this.missingMeta().length === 0
    );
  }

  /**
   * 名字栏之外还缺哪些 **必填** 字段的人话清单（渲染「还差」与放行导入共用一处，
   * 免得两处各写一份、改一处漏一处）。
   * 剧集类要季度与集号；非剧集类没有别的必填。
   */
  private missingMeta(): string[] {
    if (!this.workKind) return ["作品类型"];
    if (this.workKind !== "series") return [];
    const need: string[] = [];
    if (!this.season.trim()) need.push("季度");
    if (!this.number.trim()) need.push("集号");
    return need;
  }

  private async runImport(): Promise<void> {
    if (this.busy) return;
    const title = this.title.trim();
    const videoPath = this.videoPath.trim();
    const coverage = this.coverage();
    if (
      !title ||
      !videoPath ||
      coverage.reading ||
      coverage.bad.length > 0 ||
      !coverage.ja ||
      this.missingMeta().length > 0
    ) {
      new Notice("先按底下的提示把缺的补齐。");
      return;
    }

    // 作品类型决定落库的形态：非剧集类没有季度/集号、也没有集标题。
    const isSeries = this.workKind === "series";
    const episodeNumber = isSeries ? this.number.trim() : "";

    // 日文那份出句子，中文那份出翻译；一份中日合并版就自己管两头。
    const ready = this.subs.filter((entry) => entry.state === "ready");
    const jaEntry = ready.find((entry) => entry.ja)!;
    const zhEntry = jaEntry.zh ? undefined : ready.find((entry) => entry !== jaEntry && entry.zh);

    this.busy = true;
    this.phase = null;
    this.renderFoot();
    try {
      const outcome = await importSubtitle(this.plugin.db, {
        subtitlePath: jaEntry.path,
        translationPath: zhEntry?.path,
        videoPath,
        workTitle: title,
        year: this.year.trim() ? Number(this.year.trim()) : null,
        season: isSeries && this.season.trim() ? Number(this.season.trim()) : null,
        number: episodeNumber,
        episodeTitle: isSeries ? this.episodeTitle.trim() || undefined : undefined,
        mediaDir: resolveMediaDir(this.plugin.settings.mediaDir, this.plugin.settings.activeSpaceId),
        // 慢阶段挂状态：算哈希/拷素材库动辄 10~30 秒，干瞪眼像卡死（见 PHASE_TEXT）
        onProgress: (phase) => {
          this.phase = PHASE_TEXT[phase];
          this.renderFoot();
        },
      });

      if (!outcome.ok) {
        new Notice(`没能导入：${outcome.reason}${outcome.hint ? `（${outcome.hint}）` : ""}`, 8000);
        return;
      }

      const { result } = outcome;
      // 素材没能进库时不吓人：说清还能学、以及补救办法。成功那条才是主口径。
      const tail = result.mediaNote
        ? `\n${result.mediaNote}这一集先按你原来的位置播放；换个能写进去的素材库目录再导入一次就收进去了。`
        : "\n一句的三步练习做完，这一句的进度就记下了。";
      new Notice(`导入完成：${result.sliceCount} 句台词，视频已对上。${tail}`, 10000);
      await this.plugin.refreshOpenViews();
      this.close();

      // 进度/笔记全挂在句子哈希上（2026-10-14 身份模型重构）：同一个文件对
      // 重新导入，旧进度自动接上，不再有「跨设备接回」这一步。
      // 导完不让人自己找入口：直接进这一集的学习界面
      try {
        await this.plugin.activateLeaf(VIEW_TYPE_STUDY, true);
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_STUDY)[0];
        const view = leaf?.view as { openEpisode?: (recordCid: string) => Promise<void> };
        if (view?.openEpisode) await view.openEpisode(result.recordCid);
      } catch {
        // 跳不过去不碍事：选集页里也能点「开始学」
      }
    } finally {
      this.busy = false;
      this.phase = null;
      this.renderFoot();
    }
  }

  protected onBeforeClose(): void {
    this.detectRun++; // 在途的 Bangumi 回包作废
  }
}

// ── 常量与纯函数 ────────────────────────────────────────────────────────────

const SUBTITLE_ACCEPT = ".ass,.ssa,.srt,.vtt,.lrc";
const VIDEO_ACCEPT = "video/*,.mp4,.mkv,.m4v,.avi,.mov,.webm,.ts,.m2ts,.wmv,.flv";
/** 日文一份、中文一份 —— 再多也没有第三种语言要学。 */
const MAX_SUBTITLES = 2;

/** importer 的慢阶段 → footer 的人话（「save」拷几个 GB 的视频一样要等）。 */
const PHASE_TEXT: Record<ImportProgress, string> = {
  hash: "正在计算文件指纹…（几 GB 的视频要等一会儿）",
  save: "正在收进素材库…",
};

const ICON_VIDEO =
  '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="M10 9.5l4.5 2.5L10 14.5z" fill="currentColor" stroke="none"/></svg>';
const ICON_SUBS =
  '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5.5" width="19" height="13" rx="3"/><path d="M6 14.5h5M13.5 14.5h4.5M6 11h12"/></svg>';
const ICON_CHECK =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5.5 5.5L20 6.5"/></svg>';
const ICON_WARN =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l9 15.5H3z"/><path d="M12 9.5v4M12 16.2v.3"/></svg>';
const ICON_INFO =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.3"/></svg>';

function pendingEntry(path: string): SubEntry {
  return { path, state: "reading", ja: false, zh: false, error: "" };
}

/** 卡片右上角那枚角标：读出来的语种，读之前和读失败都不冒充。 */
function langLabelOf(entry: SubEntry): string {
  if (entry.state === "reading") return "…";
  if (entry.state === "bad") return "!";
  if (entry.ja && entry.zh) return "中日";
  return entry.ja ? "日" : "中";
}

/**
 * 一份字幕里含有哪几门语言 —— 看内容，不看文件名。
 *
 * 判定口径在解析端（`containsLanguages`）：一行双语合并版、一个文件两条样式轨、
 * 一个样式里的两轨，三种都要认成「中日都有」。以前这里只认第 1 种，
 * 字幕组双语 ASS（Dial_JP / Dial_CH 各一轨）被误判成纯日文，
 * 弹「没检测到中文字幕」的警告 —— 其实解析端能配对得很好，是这里的判定太窄。
 */
function languagesOf(lines: readonly RawLine[]): { ja: boolean; zh: boolean } {
  return containsLanguages(lines);
}

/**
 * 卡片当按钮用：点击/回车打开文件对话框，文件可以直接拖到卡上。
 * 拖进来算数的只有**文件** —— 拖一段文字进去当作路径，只会让人困惑。
 */
function bindDropTarget(el: HTMLElement, onClick: () => void, onPath: (path: string) => void): void {
  el.setAttr("role", "button");
  el.setAttr("tabindex", "0");
  el.addEventListener("click", onClick);
  el.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick();
    }
  });
  el.addEventListener("dragover", (event) => {
    event.preventDefault();
    el.addClass("is-drop");
  });
  el.addEventListener("dragleave", () => el.removeClass("is-drop"));
  el.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation(); // 别让 Obsidian 把外来的文件再打开一次
    el.removeClass("is-drop");
    const path = pathFromDrop(event);
    if (path) onPath(path);
    else new Notice("这个环境拿不到拖进来文件的路径，点一下卡片从对话框里选吧。");
  });
}

function pathFromDrop(event: DragEvent): string | null {
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    const path = absolutePathOf(file);
    if (path) return path;
  }
  // Obsidian 内部拖拽给的是 vault 里的相对路径，拿不到绝对路径就不用它
  const text = event.dataTransfer?.getData("text/plain") ?? "";
  return text.startsWith("/") ? text : null;
}

/**
 * 弹系统文件选择框，把选中文件的绝对路径交给回调。
 *
 * Obsidian 是 Electron 环境，但拿到绝对路径有两条通道、都不能赌：
 *  - Electron 长期在 File 对象上挂 `path`，但新版本把它删了；
 *  - 新版走 `electron.webUtils.getPathForFile`，要经 `window.require` 拿。
 * 两条都拿不到（理论上不会发生）就退回拖拽 —— 卡片本身是拖放目标。
 */
function pickFilePath(accept: string, onPick: (path: string) => void): void {
  const input = createEl("input", { type: "file", attr: { accept } });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    const path = absolutePathOf(file);
    if (path) {
      onPick(path);
    } else {
      new Notice("这个环境拿不到所选文件的路径，试试把文件直接拖到卡片上。");
    }
  });
  input.click();
}

function absolutePathOf(file: File): string | null {
  const direct = (file as unknown as { path?: string }).path;
  if (direct) return direct;
  try {
    const req = (window as unknown as { require?: (name: string) => unknown }).require;
    const electron = req?.("electron") as { webUtils?: { getPathForFile?: (f: File) => string } } | undefined;
    const path = electron?.webUtils?.getPathForFile?.(file);
    return path ?? null;
  } catch {
    return null;
  }
}

/**
 * 收拾用户给过来的路径。
 *
 * 渠道很杂：Finder 的「拷贝」、终端里 `pwd`、某些工具给的是 `file:///Users/...`
 * 形式，还有人手上带引号。这些都不该让导入失败 —— 能修的在这里修掉。
 */
function cleanPath(raw: string): string {
  let value = (raw ?? "").trim();
  for (const quote of ['"', "'"]) {
    if (value.length > 1 && value.startsWith(quote) && value.endsWith(quote)) {
      value = value.slice(1, -1).trim();
    }
  }
  if (value.startsWith("file://")) {
    value = value.slice("file://".length);
    try {
      value = decodeURIComponent(value);
    } catch {
      // 不是合法的百分号编码就按原样用 —— 别让「清理」本身把路径毁了
    }
  }
  return value.trim();
}

/** 取路径最后一段当文件名。 */
function basenameOf(path: string): string {
  const trimmed = (path ?? "").trim();
  if (!trimmed) return "";
  return trimmed.split(/[\\/]/u).pop() ?? trimmed;
}

/** 卡片上那句体积。只求一眼看出「是不是这个大文件」。 */
function humanSize(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${Math.round(bytes / (1 << 20))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}