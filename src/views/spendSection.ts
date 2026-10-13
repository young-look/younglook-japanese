/**
 * 消费记录区块 —— 插件「个人中心 → 账户」页的最下面一块（网页端账户页是同一套口径，
 * 见 web/src/pages/AccountPage.vue）。
 *
 * ══ 它定的是什么规矩 ══════════════════════════════════════════════════
 * 消费明细**不是一路往下滚到天地尽头**：先选一个**范围**，滚动只发生在这个范围里。
 * 一个范围恒等于 **3 个自然月**（服务端 `MONTHS_PER_WINDOW = 3` 钉死，这里跟着钉）。
 * 默认范围 = 「最近 3 个月」；想看更早的，在下拉里换一档历史窗口。
 *
 * 为什么这么定：明细是"查账"，不是"刷时间线"。人想的是"我上个月花了多少"，
 * 而不是"继续往下翻"。一路无限滚动的结果是——滚到几百条之前早就忘了自己在看哪一段，
 * 而服务端还得为每一页做一次全表扫描。
 *
 * ══ 两条数据通路（别混）══════════════════════════════════════════════
 *  · **内置模型** —— 明细在服务端（`billing.WalletTransaction`），这里一页一页去拉；
 *  · **自定义模型** —— 明细**只在本机**（IndexedDB `ai_usage`），一次也不上行，
 *    滚动翻的是本机数据。
 * 两条路由调用方给不同的 `source` 决定，本文件不碰任何一侧的数据来源。
 *
 * ══ 两条容易踩的坑 ════════════════════════════════════════════════════
 *  1. **换窗口要作废在飞的那一页**：切档时旧请求可能还在路上，回来就会把旧窗口的
 *     行追加到新窗口下面。所以每次切档 `loadSeq` 自增，回来时对不上号就丢弃。
 *  2. **下拉的"点外面 / Esc 收起"挂在 document 上**，菜单 DOM 被重画时那些监听
 *     **不会跟着消失** —— `close()` 必须由调用方在重画 / 关页前主动调一次
 *     （通过 `keepCloser` 把清理函数交出去保管，与 providerSelect.ts 同款）。
 */

import { setIcon } from "obsidian";

/** 一个可选范围 = 一档 3 个自然月。 */
export interface SpendWindow {
  /** 起始月 YYYY-MM；**null = 最近 3 个自然月**（服务端按北京时间自己算） */
  month: string | null;
  /** 下拉里显示的字 */
  label: string;
}

/** 一页明细（倒序：最近的在前）。 */
export interface SpendPage<T> {
  rows: T[];
  /** 下一页游标；null = 这一档到底了 */
  cursor: string | null;
  /** 本机 / 云端最早一笔的时间（iso）：下拉列到它所在的那一档为止 */
  oldest: string | null;
}

/**
 * 一条明细轨的数据来源。**壳子只认这个接口** —— 内置模型给"拉服务端"的实现，
 * 自定义模型给"读本机"的实现，两边共用同一套范围与滚动。
 */
export interface SpendSource<T> {
  /** 标题右边的小字：交代这份明细是哪条轨、记在哪 */
  note: string;
  /** 拉一页。`month = null` = 最近 3 个月；`cursor = null` = 这一档的第一页 */
  loadPage(month: string | null, cursor: string | null): Promise<SpendPage<T>>;
  /** 这一行的时间（iso）：按天分组用 */
  timeOf(row: T): string;
  /** 这一行计入「当天小计」的数值（内置模型 = 厘，自定义模型 = token） */
  sumOf(row: T): number;
  /** 当天小计的文案 */
  sumText(sum: number): string;
  /** 当天小计要不要点成强调色（净额为正 —— 充值 / 退款那几天）。不给就不加 */
  sumTone?(sum: number): boolean;
  /** 画一行本体（日期头与小计由壳子负责） */
  renderRow(parent: HTMLElement, row: T): void;
  /** 这一档一条都没有时的文案 */
  emptyText: string;
}

export interface SpendSectionDeps<T> {
  source: SpendSource<T>;
  /** 标题（默认「消费记录」） */
  title?: string;
  /**
   * 滚动容器（IntersectionObserver 的 root）。插件里是 `.yl-v3-body` ——
   * 滚动条在它身上，不在 pane 上；不给就退回窗口视口。
   */
  scrollRoot?: HTMLElement | null;
  /** 「点外面 / Esc 收起」的清理函数交出去保管（见文件头坑 2） */
  keepCloser?(close: (() => void) | null): void;
  /** "YYYY-MM-DD" 本机日键 */
  dayKey(iso: string): string;
  /** 日期头的文案：「今天 / 昨天 / 9 月 27 日」 */
  dayText(key: string): string;
  /** 日期圆点里的短字：「今 / 昨 / 27」 */
  dayMark(key: string): string;
  /** 现在几点（测试注入用） */
  now?: () => Date;
}

export interface SpendSection {
  readonly el: HTMLElement;
  /** 范围下拉的触发器（测试用） */
  readonly rangeBtn: HTMLButtonElement;
  /** 范围下拉的菜单（测试用） */
  readonly rangeMenu: HTMLElement;
  /** 当前选中的档 */
  window(): SpendWindow;
  /** 已加载的行数（测试用） */
  loaded(): number;
  /** 再加载一页（等价于滚到底；测试里直接调它） */
  loadMore(): Promise<void>;
  /** 摘掉 document 监听与滚动观察 */
  destroy(): void;
}

const MONTHS_PER_WINDOW = 3;
/** 安全阀：最早一笔算错了也不至于把下拉撑成几百项 */
const MAX_WINDOWS = 40;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 年月的加减（delta 可为负）。JS 取模对负数是负的，这里必须绕开。 */
function shiftMonth(year: number, month: number, delta: number): { y: number; m: number } {
  const total = year * 12 + (month - 1) + delta;
  return { y: Math.floor(total / 12), m: (((total % 12) + 12) % 12) + 1 };
}

/**
 * 可选范围清单：**3 个月一档**，从「最近 3 个月」起往前推，
 * 一直推到最早那一笔所在的档 —— 再往前不可能有数据，不列。
 *
 * `oldest` 为空（还没拉到过数据）时只列「最近 3 个月」一档。
 */
export function spendWindows(oldest: string | null, now = new Date()): SpendWindow[] {
  const out: SpendWindow[] = [{ month: null, label: "最近 3 个月" }];
  const oldestKey = oldest ? `${new Date(oldest).getFullYear()}-${pad2(new Date(oldest).getMonth() + 1)}` : null;
  if (!oldestKey || Number.isNaN(new Date(oldest as string).getTime())) return out;

  // 第 0 档「最近 3 个月」的起始月 = 当月往前推两个月；历史档再每次往前推 3 个月
  const base = shiftMonth(now.getFullYear(), now.getMonth() + 1, -(MONTHS_PER_WINDOW - 1));
  for (let k = 1; k <= MAX_WINDOWS; k++) {
    const start = shiftMonth(base.y, base.m, -MONTHS_PER_WINDOW * k);
    const end = shiftMonth(start.y, start.m, MONTHS_PER_WINDOW - 1);
    const key = `${start.y}-${pad2(start.m)}`;
    out.push({
      month: key,
      label:
        start.y === end.y
          ? `${key} ~ ${pad2(end.m)}`
          : `${key} ~ ${end.y}-${pad2(end.m)}`,
    });
    // "YYYY-MM" 的字典序就是时间序：这一档已经含住最早一笔，后面不必再列
    if (key <= oldestKey) break;
  }
  return out;
}

/**
 * 一档窗口的**日期边界**（半开区间 `[start, end)`）：起始月 1 号 00:00 → 满 3 个自然月。
 *
 * 服务端那一侧自己会按北京时间算，这里算的是**本机口径** —— 只给"读本机数据"的
 * 那条轨（自定义模型）用：它没服务端可问，得自己知道这个窗口是哪一天到哪一天。
 */
export function windowRangeOf(month: string | null, now = new Date()): { start: Date; end: Date } {
  let y: number;
  let m: number;
  if (month) {
    const parts = month.split("-");
    y = Number(parts[0]);
    m = Number(parts[1]);
  } else {
    const base = shiftMonth(now.getFullYear(), now.getMonth() + 1, -(MONTHS_PER_WINDOW - 1));
    y = base.y;
    m = base.m;
  }
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    // month 只可能来自我们自己算的档位，走到这里说明算错了 —— 退回"最近 3 个月"
    return windowRangeOf(null, now);
  }
  const end = shiftMonth(y, m, MONTHS_PER_WINDOW);
  return {
    start: new Date(y, m - 1, 1, 0, 0, 0, 0),
    end: new Date(end.y, end.m - 1, 1, 0, 0, 0, 0),
  };
}

export function buildSpendSection<T>(
  parent: HTMLElement,
  deps: SpendSectionDeps<T>,
): SpendSection {
  const now = (): Date => deps.now ? deps.now() : new Date();
  const src = deps.source;

  // ── 骨架 ────────────────────────────────────────────────────────────
  const el = parent.createDiv({ cls: "yl-pc-spend" });
  const top = el.createDiv({ cls: "yl-pc-spend-top" });
  const head = top.createDiv({ cls: "yl-pc-h3" });
  head.createSpan({ text: deps.title ?? "消费记录" });
  head.createSpan({ cls: "yl-pc-cnt", text: src.note });

  // 范围下拉：复用供应商下拉那一套类（.yl-pc-select*），观感与账户页其余控件同源。
  // 没复用 providerSelect.ts 是因为它绑死了"供应商 → 接口地址字段"的联动，
  // 这里只需要"选一档 → 换窗口"。
  const wrap = top.createDiv({ cls: "yl-pc-select yl-pc-spend-range" });
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

  // 为什么不能一路往下滚，得当场说清（网页端账户页同一句，别各说各的）
  el.createDiv({
    cls: "yl-pc-spend-hint",
    text: "一次最多看 3 个月，想看更早的换个范围。",
  });

  const timeline = el.createDiv({ cls: "yl-pc-tl" });
  const sentinel = el.createDiv({ cls: "yl-pc-spend-sentinel" });
  const status = el.createDiv({ cls: "yl-pc-loading" });
  status.hide();

  // ── 状态 ────────────────────────────────────────────────────────────
  let windows: SpendWindow[] = spendWindows(null, now());
  let month: string | null = null;
  let cursor: string | null = null;
  let hasMore = false;
  let loading = false;
  /** 换档自增：在飞的那页回来时对不上号就丢掉（见文件头坑 1） */
  let loadSeq = 0;
  let rendered = 0;
  // 按天小计的增量游标：行是倒序的，遇到新的（更早的）天 = 上一天收工
  let lastDay: string | null = null;
  let daySum = 0;
  let daySumEl: HTMLElement | null = null;
  let dead = false;

  const current = (): SpendWindow =>
    windows.find((w) => w.month === month) ?? windows[0];

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
    rangeBtn.setAttribute("aria-label", `消费记录范围：${w.label}`);
  };

  // ── 下拉开关 ─────────────────────────────────────────────────────────
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

  // ── 行渲染 ──────────────────────────────────────────────────────────

  /** 定稿「当前这一天」的合计（同一天可能跨页：页末先写一次，下一页接着累加再写） */
  const sealDay = (): void => {
    if (!daySumEl) return;
    daySumEl.setText(src.sumText(daySum));
    daySumEl.toggleClass("plus", src.sumTone?.(daySum) ?? false);
  };

  const startDay = (key: string): void => {
    // ⚠️ 换日期头之前必须先把**上一天**的合计定稿 —— daySumEl 是单指针，
    //    下面一 reassign 就再也够不着它了。只靠页末那次 sealDay 的话，
    //    只有最后一个日期组有合计，前面几天全是空的（2026-10-11 踩过）。
    sealDay();
    lastDay = key;
    daySum = 0;
    const item = timeline.createDiv({ cls: "yl-pc-tl-item" });
    const rail = item.createDiv({ cls: "yl-pc-tl-rail" });
    rail.createDiv({ cls: "yl-pc-tl-no day", text: deps.dayMark(key) });
    const dayRow = item.createDiv({ cls: "yl-pc-tl-dayrow" });
    dayRow.createDiv({ cls: "yl-pc-tl-day", text: deps.dayText(key) });
    daySumEl = dayRow.createDiv({ cls: "yl-pc-tl-sum num" });
  };

  const appendRow = (row: T): void => {
    const key = deps.dayKey(src.timeOf(row));
    if (key !== lastDay) startDay(key);
    daySum += src.sumOf(row);
    const item = timeline.createDiv({ cls: "yl-pc-tl-item" });
    const rail = item.createDiv({ cls: "yl-pc-tl-rail" });
    rail.createDiv({ cls: "yl-pc-tl-no spend" });
    src.renderRow(item.createDiv({ cls: "yl-pc-tl-body" }), row);
    rendered += 1;
  };

  // ── 加载 ────────────────────────────────────────────────────────────
  const reset = (): void => {
    timeline.empty();
    rendered = 0;
    lastDay = null;
    daySum = 0;
    daySumEl = null;
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
      // 最早一笔已知 → 下拉补出历史档位（第一次进来只有「最近 3 个月」）
      const grew = page.oldest ? spendWindows(page.oldest, now()) : null;
      if (grew && grew.length !== windows.length) {
        windows = grew;
        paintMenu();
        paintTrigger();
      }
      for (const row of page.rows) appendRow(row);
      sealDay();
      if (rendered === 0) {
        status.setText(src.emptyText);
        status.show();
      } else if (hasMore) {
        status.setText("继续下滑加载更早的");
        status.show();
      } else {
        // 这一档翻完了 —— 与网页端账户页同一句
        status.setText("这一档看完了");
        status.show();
      }
    } catch (error) {
      if (dead || seq !== loadSeq) return;
      status.setText(error instanceof Error ? error.message : "消费明细暂时拿不到。");
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
    await loadPage();
  };

  // ── 滚到底自动加载 ──────────────────────────────────────────────────
  // 哨兵进视口就再拉一页。jsdom / 老环境没有 IntersectionObserver 时退回滚动监听。
  let observer: IntersectionObserver | null = null;
  let onScroll: (() => void) | null = null;

  const maybeMore = (): void => {
    if (!hasMore || loading || dead) return;
    void loadPage();
  };

  if (typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) maybeMore();
      },
      { root: deps.scrollRoot ?? null, rootMargin: "160px" },
    );
    observer.observe(sentinel);
  } else {
    onScroll = (): void => {
      const rect = sentinel.getBoundingClientRect();
      const bottom = deps.scrollRoot
        ? deps.scrollRoot.getBoundingClientRect().bottom
        : window.innerHeight;
      if (rect.top <= bottom + 160) maybeMore();
    };
    (deps.scrollRoot ?? window).addEventListener("scroll", onScroll, { passive: true });
  }

  paintMenu();
  paintTrigger();
  void loadPage();

  return {
    el,
    rangeBtn,
    rangeMenu,
    window: current,
    loaded: () => rendered,
    // ⚠️ 与哨兵触发走同一道闸门（hasMore / loading / dead）：这一档翻完了就
    //    别再发请求了，否则会一直空转到服务端去。
    loadMore: async () => {
      if (!hasMore || loading || dead) return;
      await loadPage();
    },
    destroy: () => {
      dead = true;
      close();
      observer?.disconnect();
      if (onScroll) (deps.scrollRoot ?? window).removeEventListener("scroll", onScroll);
    },
  };
}
