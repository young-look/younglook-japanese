/**
 * 个人中心「存储」页的画法。
 *
 * 版式照 `temp/demo/data.html`（2026-10-02 用户拍板：大类条默认合拢，点开才看明细）。
 *
 * 🔥 **三个大类，每一类的去向只有一个**（2026-10-10 用户拍板）：学习档案（云端同步）、
 *    本地设置、视频 / 字幕与录音（后两个只在本机）。去向由大类条右侧那颗图标说 ——
 *    软盘 = 只在本机，云 = 跟着账号走，**现在没在同步就在云上划一道斜线**；
 *    行里不再重复一遍标签。页面上也不再摆"云端会有多大"：云端是本机的一份副本，
 *    不是额外占用，那个数只会让人以为数据被搬走了一份。
 *
 * 数据一律来自 `services/dataInventory`（只读盘点），本文件不碰库、不做统计，
 * 只负责把结果摆出来。
 *
 * ⚠️ 这一个类管的就是"这一页"，状态（哪张条开着、筛到第几类）留在实例上：
 *    重新搜索时只重画列表那一段 —— 整页重画会让正在打字的搜索框丢焦点。
 */

import { Notice, setIcon } from "obsidian";

import cloudIcon from "../assets/cloud.svg";
import diskIcon from "../assets/disk.svg";
import noCloudIcon from "../assets/no-cloud.svg";
import type YoungLookPlugin from "../main";
import type {
  ArchiveRow,
  CloudSyncState,
  DataTrait,
  Inventory,
  MediaFileRow,
  MediaGroupRow,
} from "../services/dataInventory";
import { collectInventory } from "../services/dataInventory";
import { openFolderInShell, revealInShell } from "../services/revealPath";
import { createButton } from "../ui/button";
import { DeleteWorkMediaModal } from "./DeleteWorkMediaModal";

/** 素材筛选（「视频与字幕」展开后那排）。 */
type MediaFilter = "all" | "video" | "subtitle" | "attention";

/** 一个作品组最多先画多少行文件；再多就收成一句"还有 N 个"。 */
const FILE_ROWS_PER_GROUP = 30;

/** 「自己去那台机器上看」之外唯一能给的东西：把路径复制到剪贴板。 */
async function copyPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    new Notice("这个环境打不开文件管理器，路径已复制到剪贴板。", 6000);
  } catch {
    new Notice(`这个环境打不开文件管理器，在这儿：${path}`, 8000);
  }
}

export class DataPane {
  private inventory: Inventory | null = null;
  private busy = false;
  private parentEl: HTMLElement | null = null;
  private filter: MediaFilter = "all";
  private keyword = "";
  /** 素材列表容器：搜索 / 筛选只重画它，不整页重画（重画会丢焦点） */
  private mediaListEl: HTMLElement | null = null;
  /** 素材筛选那排按钮（切换选中态用） */
  private filterBtns: HTMLButtonElement[] = [];
  private readonly openCats = new Set<string>();
  private readonly openGroups = new Set<string>();
  /**
   * 上次盘点的是哪一份本机数据。换过空间（账号不同）就必须重新盘 ——
   * 否则页面还挂着上一个账号的库盘出来的数字。见 render()。
   */
  private loadedSpaceId: string | null = null;

  constructor(private readonly plugin: YoungLookPlugin) {}

  // ── 入口 ──────────────────────────────────────────────────────────────

  /** 切到「存储」页时画一遍。盘点结果留在实例上，来回切页不会反复读盘。 */
  async render(parent: HTMLElement): Promise<void> {
    this.parentEl = parent;
    // 换过本机数据了：上一次的盘点结果作废，重新读一遍
    if (this.loadedSpaceId !== this.plugin.settings.activeSpaceId) this.inventory = null;
    if (!this.inventory && !this.busy) await this.load();
    this.draw();
  }

  /** 丢掉缓存再来一遍：「重新核对」、清理完素材之后走这里。 */
  async refresh(): Promise<void> {
    this.inventory = null;
    await this.load();
    this.draw();
  }

  private async load(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
    this.inventory = await collectInventory({
      db: this.plugin.db,
      settings: this.plugin.settings,
      pluginId: this.plugin.manifest.id,
    });
    } catch (error) {
      console.warn("[young-look] 盘点本机数据失败", error);
      this.inventory = null;
    } finally {
      // 只有真盘出来了才记账；失败时留着 null，下次进来会重试
      if (this.inventory) this.loadedSpaceId = this.plugin.settings.activeSpaceId;
      this.busy = false;
    }
  }

  // ── 整页 ──────────────────────────────────────────────────────────────

  private draw(): void {
    const parent = this.parentEl;
    if (!parent) return;
    parent.empty();
    const stack = parent.createDiv({ cls: "yl-pc-stack" });

    const inventory = this.inventory;
    if (!inventory) {
      const card = stack.createDiv({ cls: "yl-pc-card" });
      card.createDiv({ cls: "yl-pc-h3", text: "这台机器上的数据" });
      card.createDiv({
        cls: "yl-pc-loading",
        text: this.busy ? "正在盘点这台机器上的数据…" : "这次没能盘点出来，数据都还好好的，只是没读出来。",
      });
      if (!this.busy) {
        const actions = card.createDiv({ cls: "yl-dt-actions" });
        createButton(actions, { text: "再试一次", onClick: () => void this.refresh() });
      }
      return;
    }

    this.buildHero(stack, inventory);
    // 顺序：学习档案 → 本地设置 → 视频、字幕与录音（2026-10-10 用户拍板）
    this.buildArchive(stack, inventory);
    this.buildLocalSettings(stack, inventory);
    this.buildMedia(stack, inventory);
  }

  /** ① 合计：左边本机怎么分的，右边只说云同步处在哪个状态。 */
  private buildHero(stack: HTMLElement, inv: Inventory): void {
    const card = stack.createDiv({ cls: "yl-pc-card yl-pc-wash" });
    const head = card.createDiv({ cls: "yl-pc-h3" });
    iconEl(head, "hard-drive");
    head.createSpan({ text: "这台机器上的数据" });
    head.createSpan({ cls: "yl-pc-cnt", text: `${clockTime(inv.generatedAt)}核对过` });

    const hero = card.createDiv({ cls: "yl-dt-hero" });
    const left = hero.createDiv();
    // 大数字 = **本插件在这台机器上占了多少**（2026-10-10 用户拍板，取代"本机空闲空间"）：
    // 用户看这一格想知道的是"这东西占了我多少地方"，机器余量跟插件没关系。
    // 分母跟着用同一个数 ⇒ 条就是"三个大类各占多少"的分解，与下面那三行图例一一对上
    // （占得再少的段也留一道可见的细线，见 barPercent）。
    const denom = inv.localBytes;
    const num = left.createDiv({ cls: "yl-dt-hero-num" });
    num.createEl("b", { text: humanSize(denom) });
    num.createSpan({ text: "本插件占用" });

    // 三段就是下面那三个大类 —— 图例与卡片一一对应，不用再猜"档案与插件"是什么
    const parts: [string, number][] = [
      ["k-media", inv.media.bytes],
      ["k-local", inv.localSettings.bytes],
      ["k-archive", inv.archive.bytes],
    ];
    const bar = left.createDiv({ cls: "yl-dt-bar" });
    for (const [cls, bytes] of parts) {
      const seg = bar.createDiv({ cls });
      seg.style.width = `${barPercent(bytes, denom)}%`;
    }
    const key = left.createDiv({ cls: "yl-dt-bar-key" });
    keyRow(key, "var(--yl-acc-mid)", `视频、字幕与录音 ${humanSize(inv.media.bytes)}`);
    keyRow(key, "var(--yl-acc-soft)", `本地设置 ${humanSize(inv.localSettings.bytes)}`);
    keyRow(key, "var(--yl-acc-line)", `学习档案 ${humanSize(inv.archive.bytes)}`);

    const side = hero.createDiv({ cls: "yl-dt-cloud-side" });
    this.buildCloudMark(side, inv);

    // 云同步被余额挡住 → 卡**外面**补一条整宽提醒带（放进卡里会跟云端那一格抢位置）
    if (inv.cloud.paused) this.buildPausedBand(stack);
  }

  /**
   * 右侧那朵云 —— **只说状态，不说大小**（2026-10-10 用户拍板）。
   *
   * ⚠️ 以前在这里摆「同步之后云端会有 383 KB」和一个比例尺：那个数用户看着没用
   *    （云端是本机的一份副本，不是额外占用），还让人误以为数据被搬走了一份。
   *    现在只留一朵云 + 两行字：同步中是完整的一朵，没在同步就划一道斜线。
   *
   * **未登录时整块可点** → 跳网页连接页（2026-10-10 用户拍板）：「这台机器上的数据」
   * 还只在本机，最该做的事就是登录，把入口直接放在这朵云上。
   * 🔥 落点必须是 `openConnectPage()`（= `/plugin/connect`），**不是 `/login`**
   *    （2026-10-10 用户纠正）：网页那边 `/plugin/connect` 就是干这件事的 ——
   *    登录 / 注册、生成一次性码、深链跳回 Obsidian 一条龙；`/login` 只是它内部
   *    未登录时的一个中转，直接过去会丢掉「连完插件」这一步的上下文。
   *    这里也**不许自己拼地址**：全插件要登录的入口只有 `openConnectPage()` 一个出口。
   * ⚠️ 只给一个手型光标，**不加任何悬停底色**（用户明确要求）；登录了就不点，
   *    那条路是「同步已暂停」的提醒带（`buildPausedBand`）管的。
   */
  private buildCloudMark(side: HTMLElement, inv: Inventory): void {
    const { state } = inv.cloud;
    const synced = state === "synced";
    const row = side.createDiv({ cls: "yl-dt-cloud" });
    customIconEl(row, synced ? "cloud" : "no-cloud", "yl-dt-cloud-ic");
    const body = row.createDiv({ cls: "yl-dt-cloud-body" });
    body.createDiv({ cls: "yl-dt-cloud-t", text: cloudTitle(state) });
    body.createDiv({ cls: "yl-dt-cloud-d", text: cloudDesc(inv) });

    if (state === "local") {
      const open = () => this.plugin.openConnectPage();
      row.addClass("is-link");
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
      row.addEventListener("click", open);
      row.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          open();
        }
      });
    }
  }

  /**
   * 「云同步已暂停」提醒带（2026-10-10 用户拍板：卡外整宽 + 警示黄）。
   *
   * 两处口径必须成对：状态栏那颗灯（main.ts updateStatusBar）与这里说的是同一件事，
   * 一边改了另一边要跟着改。
   *
   * 为什么是**警示黄**不是错误红：这不是故障 —— 学习功能一切照旧，数据都在本机，
   * 只是云端那一份停在原地等充值。红的语义是"出错了"，用在这里会让人以为数据坏了。
   *
   * ⚠️ 只在 `inv.cloud.paused` 时画。本机数据跟账号**永久绑定**（2026-10-10 拍板），
   *    不存在"这份数据其实属于别人"的状态，所以不再有归属互斥条件。
   */
  private buildPausedBand(stack: HTMLElement): void {
    const band = stack.createDiv({ cls: "yl-dt-band" });
    iconEl(band, "pause-circle", "yl-dt-band-ic");
    const body = band.createDiv({ cls: "yl-dt-band-body" });
    body.createDiv({ cls: "yl-dt-band-t", text: "云同步已暂停 · 余额用尽" });
    body.createDiv({
      cls: "yl-dt-band-d",
      text: "学习数据都留在本机，不影响任何功能；充值后自动把这段时间的变化补传上去。",
    });
    // 落点与设置页那颗「去充值」同一处（网页充值页；不能拿 serverUrl 拼，见 webBase）
    createButton(band, {
      text: "去充值",
      onClick: () => window.open(`${this.plugin.webBase()}/pricing`, "_blank"),
    });
  }

  // ── ① 学习档案 ────────────────────────────────────────────────────────
  //
  // 这一类只剩"跟着账号走"的东西：句子进度、词库、仿写、对话、笔记，还有
  // 记着上次学到哪一页的偏好（2026-10-10 用户拍板：页面记忆属于学习记录）。

  private buildArchive(stack: HTMLElement, inv: Inventory): void {
    this.buildCategory(stack, {
      id: "archive",
      icon: "database",
      name: "学习档案",
      desc: "你学过、写过的一切，跟着你的账号走 —— 换台机器登录回来就能接着学",
      trait: "cloud",
      bytes: inv.archive.bytes,
      count: `${inv.archive.rows.length} 类`,
      build: (body) => {
        this.rowsTable(body, inv.archive.rows);
        body.createDiv({
          cls: "yl-dt-sub",
          text: "这一类的每一条都跟着你的账号走 —— 本机一份、账号里一份，登录后自动回来。这一份清单与你登不登录、有没有充值无关。",
        });
      },
    });
  }

  // ── ② 本地设置 ────────────────────────────────────────────────────────
  //
  // 「文件在本机的位置」也归在这儿（2026-10-10 用户拍板）：那是这台机器专属的信息，
  // 换台机器根本用不上，跟着账号走没有意义。

  private buildLocalSettings(stack: HTMLElement, inv: Inventory): void {
    this.buildCategory(stack, {
      id: "local",
      icon: "sliders-horizontal",
      name: "本地设置",
      desc: "登录状态、自备模型的用量、每个文件放在这台机器的哪儿；只留本机，不跟着账号走",
      trait: "local",
      bytes: inv.localSettings.bytes,
      count: `${inv.localSettings.rows.length} 类`,
      build: (body) => {
        this.rowsTable(body, inv.localSettings.rows);
        body.createDiv({
          cls: "yl-dt-sub",
          text: "这一类永远不出这台机器 —— 换机器时它们不跟着走，也不需要。",
        });
      },
    });
  }

  // ── ③ 视频、字幕与录音 ────────────────────────────────────────────────
  //
  // 台词原文是字幕拆出来的、跟读录音是照着字幕念的 —— 两个都是字幕的衍生品，
  // 跟素材本身归在一类（2026-10-10 用户拍板）。

  private buildMedia(stack: HTMLElement, inv: Inventory): void {
    this.buildCategory(stack, {
      id: "media",
      icon: "file-video",
      name: "视频、字幕与录音",
      desc: "你导入的视频和字幕收在素材库里（放在 Obsidian 库外面），台词原文和跟读录音是字幕的衍生品也归在这儿；整类都不上云（自带的演示素材不算在内）",
      trait: "local",
      bytes: inv.media.bytes,
      count: `${inv.media.count} 个文件`,
      build: (body) => {
        this.rowsTable(body, inv.media.rows);
        this.buildMediaBody(body, inv);
      },
    });
  }

  private buildMediaBody(body: HTMLElement, inv: Inventory): void {
    const tools = body.createDiv({ cls: "yl-dt-tools" });
    const search = tools.createEl("input", {
      cls: "yl-dt-search",
      attr: { type: "search", placeholder: "搜文件名或路径" },
    });
    search.value = this.keyword;
    search.addEventListener("input", () => {
      this.keyword = search.value.trim();
      this.drawMediaList();
    });

    const filterDefs: [MediaFilter, string][] = [
      ["all", "全部"],
      ["video", "视频"],
      ["subtitle", "字幕"],
      ["attention", "需要留意"],
    ];
    this.filterBtns = [];
    for (const [key, label] of filterDefs) {
      const btn = createButton(tools, {
        text: label,
        cls: "yl-dt-sm",
        onClick: () => {
          this.filter = key;
          this.drawMediaList();
        },
      });
      btn.dataset.filter = key;
      btn.classList.toggle("is-active", this.filter === key);
      this.filterBtns.push(btn);
    }
    tools.createDiv({ cls: "yl-pc-grow", attr: { "aria-hidden": "true" } });
    createButton(tools, {
      text: "重新核对",
      cls: "yl-dt-sm",
      icon: "refresh-cw",
      onClick: () => void this.refresh(),
    });

    this.mediaListEl = body.createDiv({ cls: "yl-dt-groups" });
    this.drawMediaList();
  }

  /** 只重画列表这一段（含 group 展开态），搜索框/input 保持原样不丢焦点。 */
  private drawMediaList(): void {
    const inv = this.inventory;
    const host = this.mediaListEl;
    if (!inv || !host) return;
    for (const btn of this.filterBtns) {
      btn.classList.toggle("is-active", btn.dataset.filter === this.filter);
    }
    host.empty();

    const kw = this.keyword.toLowerCase();
    let shownFiles = 0;
    let shownGroups = 0;

    for (const group of inv.media.groups) {
      const files = group.files.filter((file) => this.matchMedia(file, kw));
      if (files.length === 0) continue;
      shownGroups += 1;
      shownFiles += files.length;

      const section = host.createDiv({ cls: "yl-dt-group" });
      // 搜索时强制展开：合着的话用户看不见自己搜到的那一个
      const isOpen = this.openGroups.has(group.workCid) || kw.length > 0;
      section.classList.toggle("is-open", isOpen);

      const ghead = section.createDiv({ cls: "yl-dt-ghead" });
      iconEl(ghead, "chevron-right", "yl-dt-chev2");
      ghead.createSpan({ cls: "yl-dt-gname", text: group.title });
      ghead.createSpan({
        cls: "yl-dt-gmeta",
        text: `${group.episodes} 集 · ${group.files.length} 个文件 · ${humanSize(group.bytes)}`,
      });
      ghead.createDiv({ cls: "yl-pc-grow" });
      if (group.attention > 0) {
        ghead.createSpan({
          cls: "yl-dt-state is-outside",
          text: `${group.attention} 个需要留意`,
        });
      }
      createButton(ghead, {
        text: "打开文件夹",
        cls: "yl-dt-sm",
        icon: "folder-open",
        // 拿一集的路径往上退一层 —— 作品目录才是这一堆文件的家
        onClick: () => this.reveal(dirOf(group.files[0]?.localPath ?? inv.mediaDir), true),
      });
      // 只有收进素材库的副本才删得掉（库外是用户自己的文件，删不了也不该删）
      if (group.inLibraryCount > 0) {
        createButton(ghead, {
          text: "删除",
          cls: "yl-dt-sm",
          icon: "trash-2",
          onClick: () => this.openDeleteWork(group),
        });
      }
      ghead.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement | null)?.closest("button")) return;
        const next = !section.classList.contains("is-open");
        section.classList.toggle("is-open", next);
        if (next) this.openGroups.add(group.workCid);
        else this.openGroups.delete(group.workCid);
      });

      const list = section.createDiv({ cls: "yl-dt-files" });
      for (const file of files.slice(0, FILE_ROWS_PER_GROUP)) list.appendChild(this.mediaRow(file));
      if (files.length > FILE_ROWS_PER_GROUP) {
        const hiddenCount = files.length - FILE_ROWS_PER_GROUP;
        list.createDiv({
          cls: "yl-dt-xs",
          text: `往下还有 ${hiddenCount} 个文件 · ${humanSize(
            files.slice(FILE_ROWS_PER_GROUP).reduce((sum, f) => sum + f.bytes, 0),
          )}`,
        });
      }
    }

    if (shownGroups === 0) {
      host.createDiv({
        cls: "yl-pc-loading",
        text: this.filter === "attention" && !kw
          ? "没有需要留意的文件 —— 素材都在库里、也都还在。"
          : "没有对上这个文件。换个词试试。",
      });
      return;
    }
    host.createDiv({
      cls: "yl-dt-xs",
      text: `列出 ${shownFiles} 个文件${shownFiles < inv.media.count ? `（共 ${inv.media.count} 个）` : ""} · 素材库在 ${inv.mediaDir}`,
    });
  }

  /** 删掉一个作品在素材库里的全部副本（弹窗先把后果讲清楚）。 */
  private openDeleteWork(group: MediaGroupRow): void {
    new DeleteWorkMediaModal(
      this.plugin.app,
      this.plugin,
      {
        workCid: group.workCid,
        title: group.title,
        episodeCount: group.episodes,
        fileCount: group.inLibraryCount,
        bytes: group.inLibraryBytes,
        outsideCount: group.files.length - group.inLibraryCount,
      },
      { onDone: () => void this.refresh() },
    ).open();
  }

  private matchMedia(file: MediaFileRow, keyword: string): boolean {
    const byKind =
      this.filter === "all" ||
      (this.filter === "attention" ? !file.exists || !file.insideMedia : fileKind(file) === this.filter);
    if (!byKind) return false;
    if (!keyword) return true;
    return `${file.filename} ${file.localPath}`.toLowerCase().includes(keyword);
  }

  private mediaRow(file: MediaFileRow): HTMLElement {
    const needsCare = !file.exists || !file.insideMedia;
    const row = makeDiv(`yl-dt-file${needsCare ? " is-missing" : ""}`);
    iconEl(row, fileKind(file) === "subtitle" ? "file-text" : "file-video", "ic");

    row.createDiv({ cls: "yl-dt-fname", text: file.filename });
    row.createDiv({ cls: "yl-dt-fsize", text: humanSize(file.bytes) });

    const meta = row.createDiv({ cls: "yl-dt-fmeta" });
    if (!file.exists) meta.createSpan({ cls: "yl-dt-state is-missing", text: "找不到这个文件" });
    else if (!file.insideMedia) meta.createSpan({ cls: "yl-dt-state is-outside", text: "留在原来的位置" });
    else {
      const bits: string[] = [];
      if (file.durationSeconds) bits.push(durationText(file.durationSeconds));
      if (file.language) bits.push(languageText(file.language));
      meta.setText(bits.join(" · ") || "—");
    }

    row.createDiv({ cls: "yl-dt-fpath", text: file.localPath, attr: { title: file.localPath } });
    createButton(row, {
      text: "显示",
      cls: "yl-dt-sm act",
      onClick: () => this.reveal(file.localPath, !file.exists),
    });
    return row;
  }

  /** 明细表：数据 / 条目 / 大小 三列 —— 去向由大类条那颗图标说了，行里不再重复。 */
  private rowsTable(parent: HTMLElement, rows: ArchiveRow[]): void {
    const head = parent.createDiv({ cls: "yl-dt-thead" });
    for (const label of ["数据", "条目", "大小"]) head.createSpan({ text: label });
    for (const row of rows) this.archiveStyleRow(parent, row);
  }

  private archiveStyleRow(
    parent: HTMLElement,
    input: {
      label: string;
      hint: string;
      count: number | null;
      bytes: number;
      unit?: string;
    },
  ): void {
    const row = parent.createDiv({ cls: "yl-dt-tr" });
    const name = row.createDiv({ cls: "n" });
    name.appendText(input.label);
    name.createEl("small", { text: input.hint });
    row.createDiv({ cls: "c", text: input.count === null ? "—" : `${input.count} ${input.unit ?? "条"}` });
    row.createDiv({ cls: "s", text: input.bytes > 0 ? humanSize(input.bytes) : "—" });
  }

  // ── 通用的壳：一张合拢的大类条 ────────────────────────────────────────

  private buildCategory(
    stack: HTMLElement,
    opts: {
      id: string;
      icon: string;
      name: string;
      desc: string;
      /** 这一类的去向 —— 决定右侧那颗图标（软盘 / 云） */
      trait: DataTrait;
      bytes: number;
      count: string;
      build: (body: HTMLElement) => void;
    },
  ): void {
    const section = stack.createDiv({ cls: "yl-pc-card yl-dt-cat" });
    const isOpen = this.openCats.has(opts.id);
    section.classList.toggle("is-open", isOpen);

    const head = section.createDiv({ cls: "yl-dt-chead" });
    iconEl(head, opts.icon, "ic");
    const name = head.createDiv({ cls: "n" });
    name.appendText(opts.name);
    name.createEl("small", { text: opts.desc });
    // 窄面板才出现的一行汇总（右侧那格收起来时用）——
    // 去向那两个字必须跟过来，否则窄面板里就完全看不出这类跟不跟账号走
    name.createSpan({
      cls: "yl-dt-csum",
      text: `${opts.count} · ${humanSize(opts.bytes)} · ${traitLabel(opts.trait)}`,
    });

    // 右侧这一格 = 大小 + 去向（2026-10-10 用户拍板）：**先说大小，再一颗图标，
    // 图标下面一行小字写「本地 / 云端」**。软盘 = 只在本机，云 = 跟着账号走，
    // 云上划一道斜线 = 现在没在同步 —— 图标说的是眼下的状态，小字说的是这一类的性质。
    const mark = head.createDiv({ cls: "yl-dt-cmark" });
    mark.createEl("b", { text: humanSize(opts.bytes) });
    const markUnit = mark.createDiv({ cls: "yl-dt-cmark-unit" });
    customIconEl(markUnit, markIconOf(opts.trait, this.inventory?.cloud.state), "yl-dt-cmark-ic");
    markUnit.createSpan({ cls: "yl-dt-cmark-lb", text: traitLabel(opts.trait) });

    iconEl(head, "chevron-right", "yl-dt-chev");

    const body = section.createDiv({ cls: "yl-dt-cbody" });
    opts.build(body);

    head.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement | null;
      // 条上的按钮/输入框归它们自己，不算"点开了这一条"
      if (target?.closest("button") || target?.closest("input")) return;
      const next = !section.classList.contains("is-open");
      section.classList.toggle("is-open", next);
      if (next) this.openCats.add(opts.id);
      else this.openCats.delete(opts.id);
    });
  }

  // ── 杂项 ──────────────────────────────────────────────────────────────

  private reveal(path: string, folderOnly = false): void {
    if (!path) return;
    const ok = folderOnly ? openFolderInShell(path) : revealInShell(path);
    if (!ok) void copyPath(path);
  }
}

// ── 卡片条以内的小工具（都是纯函数，跟整页状态没关系） ─────────────────────

/** 放一颗图标。`setIcon` 静默不渲染不存在的图标 —— 名字必须在宿主 lucide 里真实存在。 */
function iconEl(parent: HTMLElement, name: string, extra = ""): HTMLElement {
  const el = parent.createDiv({ cls: extra ? `yl-dt-ic ${extra}` : "yl-dt-ic" });
  setIcon(el, name);
  return el;
}

/** 图例里的一行：[色块] 文字 */
function keyRow(parent: HTMLElement, color: string, text: string): void {
  const item = parent.createSpan();
  const swatch = item.createEl("i");
  swatch.style.background = color;
  item.appendText(text);
}

/** 造一个带类名的 div（独立于某个宿主节点时用：素材行、去向标签这些）。 */
function makeDiv(cls: string): HTMLElement {  const el = document.createElement("div");
  el.className = cls;
  return el;
}

function fileKind(file: MediaFileRow): "video" | "subtitle" {
  return file.kind === "subtitle" ? "subtitle" : "video";
}

/**
 * 存储页那三枚去向图标（2026-10-10 换成用户提供的 SVG 素材，见 `src/assets/*.svg`）。
 *
 * 为什么不用宿主 lucide：宿主 3662 个图标名里**没有软盘（save）也没有裸云（cloud）**，
 * 只有带修饰的 cloud-check / cloud-off 那些 —— 要的正是"软盘"和"一朵云"这两个形状。
 * 素材已随仓库走（`src/assets/`），经 esbuild 的 text loader 取源码现插进 DOM，
 * 这样 `fill="currentColor"` 才能跟着宿主主题的明暗走。
 */
type StoreIcon = "disk" | "cloud" | "no-cloud";

const STORE_ICON_SVG: Record<StoreIcon, string> = {
  disk: diskIcon,
  cloud: cloudIcon,
  "no-cloud": noCloudIcon,
};

function customIconEl(parent: HTMLElement, name: StoreIcon, extra = ""): HTMLElement {
  const el = parent.createDiv({ cls: extra ? `yl-dt-ic ${extra}` : "yl-dt-ic" });
  el.innerHTML = STORE_ICON_SVG[name];
  // 素材里只留了 viewBox，宽高交给外层那格（`.yl-dt-ic` 定尺寸）——
  // 不写这一句，svg 会按素材自带的 800×800 撑破版面。
  const svg = el.firstElementChild;
  if (svg instanceof SVGElement) {
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
  }
  return el;
}

/** 大类条右侧摆哪颗：本地一律软盘；云端同步中一朵云，**没在同步就划一道斜线**。 */
function markIconOf(trait: DataTrait, state: CloudSyncState | undefined): StoreIcon {
  if (trait === "local") return "disk";
  return state === "synced" ? "cloud" : "no-cloud";
}

/** 大类条右侧那颗图标下面那行小字 —— 说的是这一类的去向。 */
function traitLabel(trait: DataTrait): string {
  return trait === "local" ? "本地" : "云端";
}

/** 右侧那朵云的标题（跟着状态走）。 */
function cloudTitle(state: CloudSyncState): string {
  if (state === "synced") return "云同步中";
  if (state === "paused") return "同步已暂停";
  return "未同步 · 未登录";
}

/** 右侧那朵云下面那句说明 —— 一句话说清现在是什么情况。 */
function cloudDesc(inv: Inventory): string {
  const { cloud } = inv;
  if (cloud.state === "synced") {
    const at = cloud.lastSyncAt ? `最近同步 ${clockTime(cloud.lastSyncAt)}` : "还没同步过";
    return `${at} · 学习记录跟着你的账号走`;
  }
  if (cloud.state === "paused") return "数据都留在本机，不影响学习；充值后自动补传。";
  return "学习记录只存在这台机器上；登录后自动开始同步。";
}

/** 体积：超过 1GB 给一位小数，其余取整。看得懂就行，不是账单。 */
function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${Math.round(bytes / (1 << 20))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

/** 堆叠条里一段的宽度百分比。总量是 0 时一律 0（别除出 NaN 让整条塌掉）。 */
function barPercent(bytes: number, total: number): number {
  if (!total || bytes <= 0) return 0;
  const pct = (bytes / total) * 100;
  // 占得再少也要留出一道看得见的细线 —— 0.2% 和"没有"是两回事
  return Math.max(0.4, Math.min(100, pct));
}

function durationText(seconds: number): string {
  const total = Math.round(seconds);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

/** 素材行的语种：库里存的可能是 `ja` / `ja-zh` 之类，翻成人话。 */
function languageText(language: string): string {
  const value = language.trim();
  if (!value) return "";
  const parts = value.split(/[-_]/u).map((bit) => bit.trim().toLowerCase());
  const names: Record<string, string> = { ja: "日文", zh: "中文", en: "英文", ko: "韩文" };
  const mapped = parts.map((bit) => names[bit] ?? bit);
  if (mapped.length > 1) return `${mapped.join(" + ")}字幕`;
  return `${mapped[0]}字幕`;
}

/** 时间戳的人话：今天 HH:MM / 昨天 HH:MM / M 月 D 日 HH:MM。 */
function clockTime(ts: number): string {
  if (!ts) return "还没";
  const at = new Date(ts);
  const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const today = new Date();
  const iso = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (iso(at) === iso(today)) return `今天 ${hhmm}`;
  const yesterday = new Date(today.getTime() - 86400000);
  if (iso(at) === iso(yesterday)) return `昨天 ${hhmm}`;
  return `${at.getMonth() + 1} 月 ${at.getDate()} 日 ${hhmm}`;
}

/** 路径去掉最后一段。没得去就原样返回。 */
function dirOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}
