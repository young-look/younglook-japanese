// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { installObsidianDomHelpers } from "./obsidianDom";
import { buildHistorySection, type HistoryPage, type HistorySource } from "../src/views/historySection";
import { windowRangeOf } from "../src/views/spendSection";

/**
 * 历史页签「3 个月档 + 档内滚动」的行为契约（2026-10-10 拍板，与消费记录同一口径）。
 *
 * 守的是：过滤按**行级**完成时间算（半开区间）；组只是聚合容器 —— 一集跨两档
 * 各显示各的行、组头「学完 N 句」是**档内**数；组头跨页绝不重复；换档作废
 * 在飞的那页；destroy 之后不再追加。
 */

installObsidianDomHelpers();

interface Row {
  id: number;
  at: string;
}
interface Grp {
  key: string;
  label: string;
  rows: Row[];
  hasTail?: boolean;
}

const NOW = new Date("2026-10-10T12:00:00");
const PER_PAGE = 2;

/** 内存数据源：展平 → windowRangeOf 过滤 → offset 切片（照视图里 loadHistoryPage 的口径）。 */
function sourceOf(groups: Grp[]) {
  const calls: { month: string | null; cursor: string | null }[] = [];
  /** 每趟 loadPage 后按组记档内数 —— 组头「学完 N 句」读它（照 historyCounts） */
  let counts = new Map<string, number>();
  /** 手动放行的闸门：loadPage 先挂起，测试里 release(n) 放行第 n 个调用 */
  const gates: (() => void)[] = [];
  const source: HistorySource<Grp, Row> = {
    emptyText: "这一档没有学完的句子。",
    loadPage: async (month, cursor): Promise<HistoryPage<Grp, Row>> => {
      calls.push({ month, cursor });
      await new Promise<void>((res) => gates.push(res));
      const items: { group: Grp; row: Row }[] = [];
      let oldest: string | null = null;
      for (const g of groups) {
        for (const row of g.rows) {
          items.push({ group: g, row });
          if (!oldest || row.at < oldest) oldest = row.at;
        }
      }
      const { start, end } = windowRangeOf(month, NOW);
      const inWindow = items.filter(({ row }) => {
        const t = new Date(row.at);
        return t >= start && t < end;
      });
      counts = new Map();
      for (const { group } of inWindow) {
        counts.set(group.key, (counts.get(group.key) ?? 0) + 1);
      }
      const offset = cursor ? Number(cursor) || 0 : 0;
      const rows = inWindow.slice(offset, offset + PER_PAGE);
      const next = offset + rows.length < inWindow.length ? String(offset + rows.length) : null;
      return { items: rows, cursor: next, oldest };
    },
    groupInfo: (g) => ({
      key: g.key,
      label: g.label,
      count: counts.get(g.key) ?? 0,
    }),
    renderGroupHead: (parent, _g, info) => {
      parent.createSpan({ text: info.label });
      parent.createSpan({ cls: "cnt", text: `学完 ${info.count} 句` });
    },
    renderGroupTail: (card, g) => {
      if (g.hasTail) card.createDiv({ cls: "tail", text: "tail" });
    },
    renderRow: (parent, item) => {
      parent.createDiv({ cls: "hrow", text: `#${item.row.id}` });
    },
  };
  const release = (n = 1): void => {
    for (let i = 0; i < n; i++) gates.shift()?.();
  };
  return { source, calls, release };
}

function mount(groups: Grp[]) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const filterRow = root.createDiv({ cls: "filters" });
  const { source, calls, release } = sourceOf(groups);
  const section = buildHistorySection(root, {
    source,
    filterRow,
    now: () => NOW,
  });
  return { root, section, calls, release };
}

/** 让挂起的 loadPage 落地（放行 + 微任务排空） */
const flush = async (release: () => void): Promise<void> => {
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  document.body.empty();
});

// 三组：A 三句（9 月，默认档内）、B 两句（6 月，历史档）、C 一句（8-01 档首当天）
const groups = (): Grp[] => [
  { key: "a", label: "番剧A S01E01", rows: [
    { id: 1, at: "2026-09-01T10:00:00" },
    { id: 2, at: "2026-09-02T10:00:00" },
    { id: 3, at: "2026-09-03T10:00:00" },
  ], hasTail: true },
  { key: "b", label: "番剧B S01E01", rows: [
    { id: 4, at: "2026-06-01T10:00:00" },
    { id: 5, at: "2026-06-02T10:00:00" },
  ], hasTail: true },
  { key: "c", label: "番剧C S01E01", rows: [
    { id: 6, at: "2026-08-01T00:00:00" },
  ] },
];

describe("历史 · 范围分档", () => {
  it("默认落在「最近 3 个月」，先拿一页（2 条）", async () => {
    const { section, calls, release } = mount(groups());
    await flush(release);
    expect(section.window().month).toBeNull();
    expect(section.loaded()).toBe(2);
    expect(calls).toEqual([{ month: null, cursor: null }]);
    // 最早一条（6 月）已知 → 下拉补出历史档
    const labels = Array.from(section.rangeMenu.querySelectorAll("button")).map(
      (b) => b.textContent,
    );
    expect(labels[0]).toBe("最近 3 个月");
    expect(labels).toContain("2026-05 ~ 07");
  });

  it("窗口边界是半开区间：8-01 档首当天在档内，11-01 满档当天不在", async () => {
    const rows: Grp[] = [
      { key: "a", label: "A", rows: [{ id: 1, at: "2026-08-01T00:00:00" }] },
      { key: "b", label: "B", rows: [{ id: 2, at: "2026-11-01T00:00:00" }] },
    ];
    const { section, release } = mount(rows);
    await flush(release);
    // 默认档 [2026-08-01, 2026-11-01)：只有 8-01 那句
    expect(section.loaded()).toBe(1);
    expect(section.window().month).toBeNull();
  });

  it("换档 ⇒ 旧档 DOM 一条不留，游标从头开始", async () => {
    const { section, calls, release, root } = mount(groups());
    await flush(release);
    // 切到 6 月所在的历史档
    const item = Array.from(section.rangeMenu.querySelectorAll("button")).find(
      (b) => b.textContent === "2026-05 ~ 07",
    ) as HTMLElement;
    item.click();
    await flush(release);
    expect(section.window().month).toBe("2026-05");
    expect(section.loaded()).toBe(2);
    expect(root.querySelectorAll(".hrow").length).toBe(2);
    expect(calls[calls.length - 1]).toEqual({ month: "2026-05", cursor: null });
  });
});

describe("历史 · 组与分页", () => {
  it("组头跨页只出现一次，组尾提示在档内行画满时补上", async () => {
    const one: Grp[] = [
      { key: "a", label: "A", rows: [
        { id: 1, at: "2026-09-01T10:00:00" },
        { id: 2, at: "2026-09-02T10:00:00" },
        { id: 3, at: "2026-09-03T10:00:00" },
      ], hasTail: true },
    ];
    const { section, release, root } = mount(one);
    await flush(release);
    expect(root.querySelectorAll(".yl-pc-h3").length).toBe(1);
    const more = section.loadMore();
    await flush(release);
    await more;
    expect(section.loaded()).toBe(3);
    // 3 行全画完仍只有一张组卡、一个组头，组尾提示已补
    expect(root.querySelectorAll(".yl-pc-card").length).toBe(1);
    expect(root.querySelectorAll(".yl-pc-h3").length).toBe(1);
    expect(root.querySelectorAll(".tail").length).toBe(1);
  });

  it("组头「学完 N 句」是档内数：A 组默认档 3 句、6 月档 0 句不出现", async () => {
    const { section, release, root } = mount(groups());
    await flush(release);
    // 默认档第 1 页：A 组先出现，组头是档内数 3（不是这一集总共几句之外的口径）
    expect(root.textContent).toContain("学完 3 句");
    // 翻完默认档（A3 + C6）：B 组（6 月）整组不出现
    const more1 = section.loadMore();
    await flush(release);
    await more1;
    const more2 = section.loadMore();
    await flush(release);
    await more2;
    expect(section.loaded()).toBe(4);
    expect(root.querySelectorAll(".yl-pc-card").length).toBe(2);
    expect(root.textContent).not.toContain("番剧B");
    expect(root.textContent).toContain("这一档看完了");
  });

  it("这一档一条都没有 ⇒ 说档，不说你没学过", async () => {
    const { release, root } = mount([
      { key: "b", label: "番剧B", rows: [{ id: 4, at: "2026-06-01T10:00:00" }] },
    ]);
    await flush(release);
    expect(root.textContent).toContain("这一档没有学完的句子。");
  });
});

describe("历史 · 在飞请求与销毁", () => {
  it("快速连切档：旧档迟到的那页回来不许落进新档", async () => {
    const { section, release, root } = mount(groups());
    await flush(release);
    // 切到历史档（这趟挂起）→ 再切回「最近 3 个月」（也挂起）
    const hist = Array.from(section.rangeMenu.querySelectorAll("button")).find(
      (b) => b.textContent === "2026-05 ~ 07",
    ) as HTMLElement;
    hist.click();
    const latest = Array.from(section.rangeMenu.querySelectorAll("button")).find(
      (b) => b.textContent === "最近 3 个月",
    ) as HTMLElement;
    latest.click();
    // 先放行**旧档**（第 2 次调用）那页 —— seq 对不上，必须整个丢弃
    release(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(section.loaded()).toBe(0); // 还没放行最新那趟
    release(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 落地的是「最近 3 个月」的行（#1/#2），不是历史档的 6 月行（#4/#5）
    expect(section.window().month).toBeNull();
    expect(section.loaded()).toBe(2);
    const rowTexts = Array.from(root.querySelectorAll(".hrow")).map((r) => r.textContent);
    expect(rowTexts).toEqual(["#1", "#2"]);
  });

  it("destroy 之后不再往里追加任何东西", async () => {
    const { section, release } = mount(groups());
    await flush(release);
    section.destroy();
    await section.loadMore();
    expect(section.loaded()).toBe(2);
  });

  it("没有 IntersectionObserver 的环境退回滚动监听，滚一下就续拉", async () => {
    const { section, release } = mount(groups());
    await flush(release);
    expect(section.loaded()).toBe(2);
    window.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(section.loaded()).toBeGreaterThan(2);
  });
});
