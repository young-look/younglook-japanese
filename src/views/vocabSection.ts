/**
 * 词库区块 —— 个人中心「词库」页签的主体（2026-10-10 起）。
 *
 * ══ 它定的是什么规矩 ════════════════════════════════════════════════
 * 词库是**词条状态列表**（每个词一条账），不是事件流水 —— 所以**没有**
 * 时间窗口筛选（用户拍板 2026-10-10）。筛的只剩一样：**搜索词**
 * （匹配 词面 / 读音 / 罗马音 / 释义，大小写不敏感），而且**按下搜索才筛**
 * —— 边打字边筛会让人一个字断一次（2026-10-10 用户拍板：五十音胶囊行退场，
 * 工具行改成一排 —— 排序钮 + 搜索框 + 搜索钮 …… 导出钮）。
 * 筛完按当前排序铺平，滚动分页加载（每批 30 条，替代旧版 20 条页码翻页）。
 *
 * ══ 工具行横跨两个主人 ═════════════════════════════════════════════
 * 排序钮（左）与导出钮（右）**由调用方塞进来**（排序状态、导出都在视图手里），
 * 搜索框与搜索钮（中）**由本区块自建**（筛选状态在这儿）。两个回调各管一段，
 * 顺序即所见：fillToolbarLeading → 搜索框 → 搜索钮 → fillToolbarTrailing。
 *
 * ══ 与消费记录（spendSection.ts）的差异 ═════════════════════════════
 * 没有范围下拉（无窗口），没有 document 级监听（输入框与搜索钮的监听都挂在
 * 自己元素上，pane 重画时随 DOM 一起消失）—— 但滚动触发器仍要 destroy
 * （IntersectionObserver 不随 DOM 消失自动断开）。
 *
 * ══ 容易踩的坑 ═════════════════════════════════════════════════════
 * 重筛**绝不整块重画**：只清列表容器（就地 refilter），重建输入框会把焦点
 * 和用户已经打进去的字一起打丢（2026-10-10 前是 debounce 边打边筛，现在是
 * 按搜索钮才筛 —— 但"不重建输入框"这条没变）。
 */

import { createButton } from "../ui/button";
import type { VocabEntry } from "../services/vocabLibrary";
import { createNearBottomTrigger } from "./nearBottom";

export interface VocabSectionDeps {
  /** 滚动容器（IntersectionObserver 的 root），插件里是 `.yl-v3-body` */
  scrollRoot: HTMLElement | null;
  /** 头部「共 N 词」的计数 span：筛选变化时由壳子更新文案 */
  countEl: HTMLElement;
  /** 整本词数（未筛选）—— 计数文案的「共 N 词」用它 */
  total: number;
  /** 全量词（未筛选未排序）；壳子每次 refilter 现取，数据方可在打开期间换缓存 */
  all: () => VocabEntry[];
  /** 排序比较器（视图状态管排序，壳子只管筛与分页） */
  compare(a: VocabEntry, b: VocabEntry): number;
  /** 画一行词条（parent 是 .yl-vb-list 容器） */
  renderRow(parent: HTMLElement, entry: VocabEntry): void;
  /**
   * 工具行**左段**（搜索框之前）建好后回调 —— 调用方把排序钮塞进来。
   * ⚠️ 回调里的按钮**不得重建这一行**（焦点会丢），要换状态就地改类名。
   */
  fillToolbarLeading?(row: HTMLElement): void;
  /**
   * 工具行**尾段**（搜索钮之后）建好后回调 —— 调用方把导出钮塞进来
   * （摆最右交给 CSS 的 margin-left:auto）。
   */
  fillToolbarTrailing?(row: HTMLElement): void;
  /** 初始搜索词（视图恢复用） */
  initialQuery?: string;
  /** 按下搜索（且词真的变了）时回传 —— 视图存着，切页签回来时恢复 */
  onSearch?(query: string): void;
  /** 一页多少条（默认 30；测试注入用） */
  pageSize?: number;
}

export interface VocabSection {
  readonly el: HTMLElement;
  readonly searchInput: HTMLInputElement;
  /** 按当前输入框内容提交一次搜索（搜索钮 / 回车 / 清空框走的是同一件事） */
  search(): Promise<void>;
  /** 已加载的行数（测试用） */
  loaded(): number;
  /** 当前筛选命中的总词数（测试用） */
  filteredCount(): number;
  /** 再加载一页（等价于滚到底；测试里直接调它） */
  loadMore(): Promise<void>;
  /** 筛选/排序变了：就地清空重拉（游标归零） */
  refilter(): Promise<void>;
  /** 断开滚动观察 */
  destroy(): void;
}

const DEFAULT_PAGE_SIZE = 30;

export function buildVocabSection(
  parent: HTMLElement,
  deps: VocabSectionDeps,
): VocabSection {
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;

  // ── 状态（先于 DOM 声明：搜索钮的监听挂在后面接，避开 TDZ）────────────
  let query = deps.initialQuery ?? "";
  let offset = 0;
  let loading = false;
  /** 重筛自增：在飞的那页回来对不上号就丢（快速连按搜索不串页） */
  let loadSeq = 0;
  let rendered = 0;
  /** 当前筛选 + 排序好的全量快照；分页就是在它上面切 offset */
  let filtered: VocabEntry[] = [];
  let dead = false;

  // ── 骨架：工具行（排序钮 | 搜索框 | 搜索钮 | 导出钮）→ 列表 → 哨兵 → 状态行
  //    五十音胶囊行 2026-10-10 退场（用户拍板）。
  const toolbarRow = parent.createDiv({ cls: "yl-pc-filters" });
  deps.fillToolbarLeading?.(toolbarRow);
  const searchInput = toolbarRow.createEl("input", {
    cls: "yl-vb-search",
    type: "search",
    attr: { placeholder: "搜词面 / 读音 / 释义" },
  });
  // 恢复上次的搜索词：框里和筛出来的列表必须一致 —— 否则切回本页签会看到
  // 「框是空的、列表却是筛过的」，而"按下搜索才筛"让用户没有别的线索可循。
  searchInput.value = query;
  const searchBtn = createButton(toolbarRow, { text: "搜索", cls: "yl-vb-search-btn" });
  deps.fillToolbarTrailing?.(toolbarRow);

  const el = parent.createDiv({ cls: "yl-vb-sec" });
  const list = el.createDiv({ cls: "yl-pc-card yl-vb-list" });
  const sentinel = el.createDiv({ cls: "yl-pc-pagesentinel" });
  const status = el.createDiv({ cls: "yl-pc-loading" });
  status.hide();

  const matchQuery = (entry: VocabEntry): boolean => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      entry.surface.toLowerCase().includes(q) ||
      entry.reading.toLowerCase().includes(q) ||
      entry.romaji.toLowerCase().includes(q) ||
      entry.meaning.toLowerCase().includes(q)
    );
  };

  const recompute = (): void => {
    filtered = deps.all().filter(matchQuery).sort(deps.compare);
  };

  const paintCount = (): void => {
    deps.countEl.setText(
      filtered.length === deps.total
        ? `共 ${deps.total} 词`
        : `共 ${deps.total} 词 · 符合 ${filtered.length} 词`,
    );
  };

  // ── 加载 ────────────────────────────────────────────────────────────
  const loadPage = async (): Promise<void> => {
    if (loading || dead) return;
    loading = true;
    const seq = loadSeq;
    try {
      const rows = filtered.slice(offset, offset + pageSize);
      if (rows.length > 0) list.show();
      for (const entry of rows) {
        deps.renderRow(list, entry);
        rendered += 1;
      }
      offset += rows.length;
      if (dead || seq !== loadSeq) return;
      if (rendered === 0) {
        // 筛空了：白卡一并藏掉，别留一个空盒子
        list.hide();
        status.setText("没有符合条件的词。");
        status.show();
      } else if (offset < filtered.length) {
        status.setText("继续下滑加载更多");
        status.show();
      } else {
        // 翻完了：一并清字 —— 隐藏元素的字还挂在 textContent 里，会污染断言与读屏
        status.setText("");
        status.hide();
      }
    } finally {
      loading = false;
    }
  };

  const refilter = async (): Promise<void> => {
    loadSeq += 1;
    loading = false;
    offset = 0;
    rendered = 0;
    list.empty();
    recompute();
    paintCount();
    await loadPage();
  };

  // ── 搜索：**按下才筛**（2026-10-10 用户拍板）────────────────────────
  // 三条入口都走这里：搜索钮、输入框里回车、`type=search` 的原生「×」清空
  // （清空只发 search 事件，不发 input）。词没变就空转，不白重排一遍。
  const submitSearch = async (): Promise<void> => {
    const next = searchInput.value;
    if (next === query) return;
    query = next;
    deps.onSearch?.(query);
    await refilter();
  };
  searchBtn.addEventListener("click", () => void submitSearch());
  searchInput.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    void submitSearch();
  });
  searchInput.addEventListener("search", () => void submitSearch());

  // ── 滚到底自动加载（共用触发器，见 views/nearBottom.ts）──────────────
  const trigger = createNearBottomTrigger({
    sentinel,
    scrollRoot: deps.scrollRoot,
    ready: () => !loading && !dead && offset < filtered.length,
    fire: () => void loadPage(),
  });

  // 构造时先把第一页铺上（loadPage 内部无 await，同步完成）：
  // 后续续拉交给滚动触发器，首页不挂 IO 自动续拉是刻意的。
  void refilter();

  return {
    el,
    searchInput,
    search: submitSearch,
    loaded: () => rendered,
    filteredCount: () => filtered.length,
    // ⚠️ 与哨兵触发走同一道闸门：翻完了就别再发了
    loadMore: async () => {
      if (!loading && !dead && offset < filtered.length) await loadPage();
    },
    refilter,
    destroy: () => {
      dead = true;
      trigger.destroy();
    },
  };
}
