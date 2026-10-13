/**
 * 学习历史区块 —— 个人中心「历史」页签的主体（2026-10-10 起）。
 *
 * ══ 它定的是什么规矩（与消费记录 spendSection.ts 同一口径）════════════
 * 历史**不是一路往下滚到天地尽头**：先选一个**范围**（一档 = 3 个自然月，
 * 按「完成时间 completedAt」算），滚动只发生在这个范围里。默认范围 =
 * 「最近 3 个月」；想看更早的，在下拉里换一档历史窗口。
 *
 * 档位与窗口边界直接复用 spendSection 的 `spendWindows` / `windowRangeOf`
 * （只读复用，spendSection 一行不改）—— 两处是同一套"3 个月一档"的算法，
 * 没必要养两份。
 *
 * ══ 分组与分页怎么共存 ══════════════════════════════════════════════
 * 窗口过滤发生在**行级**，集（组）只是聚合容器：
 *  · 一集的句子横跨两档时，两档各显示各自的行 —— 组头在两档里各出现一次，
 *    「学完 N 句」是**档内**的数（不是这一集总共几句）；
 *  · 组头跨页不重复：`lastGroupKey` 记住当前画到哪个组，同组续页只追加行；
 *  · 组尾提示（孤儿 / 视频不在）在该组档内行数画满时补上。
 *
 * ══ 两条容易踩的坑（与 spendSection 相同，见其文件头）════════════════
 *  1. 换窗口要作废在飞的那一页（loadSeq 自增，回来对不上号就丢）；
 *  2. 下拉的"点外面 / Esc 收起"挂在 document 上，重画 / 关页前必须
 *     destroy()（keepCloser 把清理函数交调用方保管）。
 */

import { setIcon } from "obsidian";
import { createNearBottomTrigger } from "./nearBottom";
import { spendWindows, type SpendWindow } from "./spendSection";

/** 组头要展示的信息（由数据方算好，壳子不关心组长什么样）。 */
export interface HistoryGroupInfo {
  /** 组键：同键的行画进同一张卡 */
  key: string;
  label: string;
  /** 档内行数 —— 组头的「学完 N 句」用它 */
  count: number;
}

/** 一条历史 = 一行 + 它所属的组。 */
export interface HistoryItem<G, R> {
  group: G;
  row: R;
}

export interface HistoryPage<G, R> {
  items: HistoryItem<G, R>[];
  /** 下一页游标（offset）；null = 这一档到底了 */
  cursor: string | null;
  /** 最早一条的时间（iso）：下拉靠它列到哪一档为止 */
  oldest: string | null;
}

/**
 * 历史的数据来源。壳子只认这个接口 —— 数据方负责窗口过滤与切片
 * （参照 PersonalCenterView.loadHistoryPage：展平 → windowRangeOf 过滤 → offset 切片）。
 */
export interface HistorySource<G, R> {
  loadPage(month: string | null, cursor: string | null): Promise<HistoryPage<G, R>>;
  groupInfo(group: G): HistoryGroupInfo;
  /** 画组头（壳子已建好 .yl-pc-h3 容器；label / 计数 / 组内动作钮都在这里画） */
  renderGroupHead(parent: HTMLElement, group: G, info: HistoryGroupInfo): void;
  /** 画组尾提示（该组档内行数画满时调一次；没有提示就不画） */
  renderGroupTail(parent: HTMLElement, group: G): void;
  /** 画一行本体（parent 是该组的 .yl-sl-list 容器） */
  renderRow(parent: HTMLElement, item: HistoryItem<G, R>): void;
  /** 这一档一条都没有时的文案 */
  emptyText: string;
}

export interface HistorySectionDeps<G, R> {
  source: HistorySource<G, R>;
  /**
   * 范围下拉插进这一行的**最左**（调用方的筛选工具行 —— 排序钮、导出钮在它右边）。
   * 下拉元素由壳子创建后 `prepend` 进去。
   */
  filterRow: HTMLElement;
  /** 滚动容器（IntersectionObserver 的 root），插件里是 `.yl-v3-body` */
  scrollRoot?: HTMLElement | null;
  /** 「点外面 / Esc 收起」的清理函数交出去保管（见文件头坑 2） */
  keepCloser?(close: (() => void) | null): void;
  /** 初始选中的档（视图状态恢复用）；缺省 = 最近 3 个月 */
  initialMonth?: string | null;
  /** 换档时回传（视图存着，切页签回来恢复） */
  onMonthChange?(month: string | null): void;
  /** 现在几点（测试注入用） */
  now?: () => Date;
}

export interface HistorySection {
  readonly el: HTMLElement;
  readonly rangeBtn: HTMLButtonElement;
  readonly rangeMenu: HTMLElement;
  /** 当前选中的档 */
  window(): SpendWindow;
  /** 已加载的行数（测试用） */
  loaded(): number;
  /** 再加载一页（等价于滚到底；测试里直接调它） */
  loadMore(): Promise<void>;
  /** 数据没变但**排序/口径**变了：就地清空重拉（游标归零），不换窗口 */
  refilter(): Promise<void>;
  /** 摘掉 document 监听与滚动观察 */
  destroy(): void;
}

export function buildHistorySection<G, R>(
  parent: HTMLElement,
  deps: HistorySectionDeps<G, R>,
): HistorySection {
  const now = (): Date => (deps.now ? deps.now() : new Date());
  const src = deps.source;

  // ── 骨架 ────────────────────────────────────────────────────────────
  // 本体（列表 + 哨兵 + 状态行）追加在 parent 里；下拉插进调用方的工具行。
  const el = parent.createDiv({ cls: "yl-pc-history" });
  const wrap = deps.filterRow.createDiv({ cls: "yl-pc-select yl-pc-spend-range" });
  deps.filterRow.prepend(wrap);
  const rangeBtn = wrap.createEl("button", {
    cls: "yl-pc-select-btn",
    attr: { type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" },
  });
  const nameEl = rangeBtn.createSpan({ cls: "yl-pc-select-name" });
  setIcon(rangeBtn.createSpan({ cls: "yl-pc-select-chev" }), "chevron-down");
  const rangeMenu = wrap.createDiv({
    cls: "yl-pc-select-menu is-hidden",
    attr: { role: "listbox" },
  });

  // ⚠️ 这里原来有一行灰字「一次最多看 3 个月，想看更早的换个范围。」——
  // 2026-10-10 用户拍板撤掉（历史页不要这行小字）。消费记录页（spendSection）
  // 那一句仍然保留，别顺手一起删。
  const list = el.createDiv({ cls: "yl-pc-hist-list" });
  const sentinel = el.createDiv({ cls: "yl-pc-pagesentinel" });
  const status = el.createDiv({ cls: "yl-pc-loading" });
  status.hide();

  // ── 状态 ────────────────────────────────────────────────────────────
  let windows: SpendWindow[] = spendWindows(null, now());
  let month: string | null = deps.initialMonth ?? null;
  let cursor: string | null = null;
  let hasMore = false;
  let loading = false;
  /** 换档 / 重筛自增：在飞的那页回来时对不上号就丢掉（见文件头坑 1） */
  let loadSeq = 0;
  let rendered = 0;
  /** 当前画到哪个组：同组续页组头绝不重复，跨页保持 */
  let lastGroupKey: string | null = null;
  let currentCard: HTMLElement | null = null;
  let currentRowList: HTMLElement | null = null;
  let currentGroup: G | null = null;
  let groupRendered = 0;
  let groupCount = 0;
  let dead = false;

  const current = (): SpendWindow => windows.find((w) => w.month === month) ?? windows[0];

  const paintMenu = (): void => {
    rangeMenu.empty();
    for (const w of windows) {
      const item = rangeMenu.createEl("button", {
        cls: `yl-pc-select-item${w.month === month ? " is-active" : ""}`,
        text: w.label,
        attr: { type: "button", role: "option" },
      });
      item.addEventListener("click", () => {
        close();
        if (w.month !== month) void switchTo(w.month);
      });
    }
  };

  const paintTrigger = (): void => {
    const w = current();
    nameEl.setText(w.label);
    rangeBtn.setAttribute("aria-label", `历史范围：${w.label}`);
  };

  // ── 下拉开关（照 spendSection 同款）─────────────────────────────────
  const close = (): void => {
    rangeMenu.addClass("is-hidden");
    rangeBtn.removeClass("is-open");
    rangeBtn.setAttribute("aria-expanded", "false");
    deps.keepCloser?.(null);
  };

  const open = (): void => {
    rangeMenu.removeClass("is-hidden");
    rangeBtn.addClass("is-open");
    rangeBtn.setAttribute("aria-expanded", "true");
    const onDown = (ev: MouseEvent): void => {
      const target = ev.target;
      if (target instanceof Node && wrap.contains(target)) return;
      close();
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape") return;
      close();
      rangeBtn.focus();
    };
    // capture 阶段：菜单里的钮自己也会 click，冒泡阶段拦会晚一步
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    deps.keepCloser?.(() => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    });
  };

  rangeBtn.addEventListener("click", () => {
    if (rangeMenu.hasClass("is-hidden")) open();
    else close();
  });

  // ── 行渲染（按集分组）───────────────────────────────────────────────
  /** 当前组的档内行数画满 → 补组尾提示，这一组收工。 */
  const sealGroup = (): void => {
    if (currentCard && currentGroup && groupRendered >= groupCount && groupCount > 0) {
      src.renderGroupTail(currentCard, currentGroup);
    }
  };

  const appendItem = (item: HistoryItem<G, R>): void => {
    const info = src.groupInfo(item.group);
    if (info.key !== lastGroupKey) {
      sealGroup(); // 上一组收尾（正常路径在画满时就已收过，这里是兜底）
      lastGroupKey = info.key;
      currentCard = list.createDiv({ cls: "yl-pc-card yl-sl-group" });
      const head = currentCard.createDiv({ cls: "yl-pc-h3" });
      src.renderGroupHead(head, item.group, info);
      currentRowList = currentCard.createDiv({ cls: "yl-sl-list" });
      currentGroup = item.group;
      groupRendered = 0;
      groupCount = info.count;
    }
    if (currentRowList) src.renderRow(currentRowList, item);
    groupRendered += 1;
    rendered += 1;
    if (groupRendered >= groupCount) {
      sealGroup();
      // 组画满了：后续不该再出现同组行（数据方保证按组分好块），真出现也只会
      // 因 lastGroupKey 已切换而新开卡 —— 在这里把卡清引用，防误画。
      currentGroup = null;
      currentCard = null;
      currentRowList = null;
    }
  };

  // ── 加载 ────────────────────────────────────────────────────────────
  const reset = (): void => {
    list.empty();
    rendered = 0;
    lastGroupKey = null;
    currentCard = null;
    currentRowList = null;
    currentGroup = null;
    groupRendered = 0;
    groupCount = 0;
    cursor = null;
    hasMore = false;
  };

  const loadPage = async (): Promise<void> => {
    if (loading || dead) return;
    loading = true;
    const seq = loadSeq;
    status.setText("正在加载…");
    status.show();
    try {
      const page = await src.loadPage(month, cursor);
      if (dead || seq !== loadSeq) return;
      cursor = page.cursor;
      hasMore = page.cursor !== null;
      // 最早一条已知 → 下拉补出历史档位（第一次进来只有「最近 3 个月」）
      const grew = page.oldest ? spendWindows(page.oldest, now()) : null;
      if (grew && grew.length !== windows.length) {
        windows = grew;
        paintMenu();
        paintTrigger();
      }
      for (const item of page.items) appendItem(item);
      if (rendered === 0) {
        status.setText(src.emptyText);
        status.show();
      } else if (hasMore) {
        status.setText("继续下滑加载更早的");
        status.show();
      } else {
        // 这一档翻完了 —— 与消费记录同一句
        status.setText("这一档看完了");
        status.show();
      }
    } catch (error) {
      if (dead || seq !== loadSeq) return;
      status.setText(error instanceof Error ? error.message : "历史暂时拿不到。");
      status.show();
    } finally {
      loading = false;
    }
  };

  const switchTo = async (next: string | null): Promise<void> => {
    month = next;
    loadSeq += 1; // 作废在飞的那页
    loading = false;
    reset();
    paintMenu();
    paintTrigger();
    deps.onMonthChange?.(month);
    await loadPage();
  };

  // ── 滚到底自动加载（共用触发器，见 views/nearBottom.ts）──────────────
  const trigger = createNearBottomTrigger({
    sentinel,
    scrollRoot: deps.scrollRoot ?? null,
    ready: () => hasMore && !loading && !dead,
    fire: () => void loadPage(),
  });

  paintMenu();
  paintTrigger();
  void loadPage();

  return {
    el,
    rangeBtn,
    rangeMenu,
    window: current,
    loaded: () => rendered,
    // ⚠️ 与哨兵触发走同一道闸门（hasMore / loading / dead）：这一档翻完了
    //    就别再发了，否则会一直空转。
    loadMore: async () => {
      if (!hasMore || loading || dead) return;
      await loadPage();
    },
    // 排序变化走这里：窗口不动，就地清空重拉（游标归零）
    refilter: async () => {
      loadSeq += 1;
      loading = false;
      reset();
      await loadPage();
    },
    destroy: () => {
      dead = true;
      close();
      trigger.destroy();
    },
  };
}
