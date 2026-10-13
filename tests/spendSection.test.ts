// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { installObsidianDomHelpers } from "./obsidianDom";
import {
  buildSpendSection,
  spendWindows,
  windowRangeOf,
  type SpendPage,
  type SpendSource,
} from "../src/views/spendSection";

/**
 * 账户页底部「消费记录」的行为契约（2026-10-10 拍板）。
 *
 * 守的是那句用户话：**明细不能单纯无限滚动 —— 先有一个范围，滚动只发生在这个范围内，
 * 范围最大 3 个月**。四个反面：
 *   · 没给"最早一笔"时下拉里不该凭空长出历史档位；
 *   · 换档后旧档的行必须清空（混在一起就是账对不上）；
 *   · 翻页游标必须待在当前档里（跨档翻页 = 一路滚到天地尽头，正是要禁止的）；
 *   · `destroy()` 之后不能再往 DOM 里追加任何东西。
 */

installObsidianDomHelpers();

interface Row {
  id: number;
  at: string;
  amount: number;
}

/** 内存里的假数据源：按游标切页，行为照服务端那套（倒序、id 游标） */
function sourceOf(all: Row[], perPage = 2) {
  const calls: { month: string | null; cursor: string | null }[] = [];
  const source: SpendSource<Row> = {
    note: "测试轨",
    emptyText: "这一段时间没有记录",
    timeOf: (r) => r.at,
    sumOf: (r) => r.amount,
    sumText: (sum) => `${sum}`,
    renderRow: (parent, r) => {
      parent.createDiv({ cls: "row", text: `#${r.id}` });
    },
    loadPage: async (month, cursor): Promise<SpendPage<Row>> => {
      calls.push({ month, cursor });
      const offset = cursor ? Number(cursor) : 0;
      const rows = all.slice(offset, offset + perPage);
      const next = offset + rows.length < all.length ? String(offset + rows.length) : null;
      return { rows, cursor: next, oldest: all.length ? all[all.length - 1].at : null };
    },
  };
  return { source, calls };
}

const NOW = new Date("2026-10-10T12:00:00");

function mount(all: Row[], perPage = 2) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const { source, calls } = sourceOf(all, perPage);
  const section = buildSpendSection(root, {
    source,
    dayKey: (iso) => iso.slice(0, 10),
    dayText: (key) => key,
    dayMark: (key) => key.slice(8),
    now: () => NOW,
  });
  return { root, section, calls };
}

/** 让构造时发起的那一页（void loadPage()）跑完 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const rows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: n - i,
    at: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T10:00:00`,
    amount: -1,
  }));

afterEach(() => {
  document.body.empty();
});

describe("消费记录 · 范围分档", () => {
  it("没有最早一笔 ⇒ 只列「最近 3 个月」，不凭空长历史档位", () => {
    expect(spendWindows(null, NOW).map((w) => w.label)).toEqual(["最近 3 个月"]);
  });

  it("3 个月一档往前列，到最早一笔那一档为止", () => {
    // now = 2026-10 ⇒ 第 0 档起始月 2026-08；历史档每次往前推 3 个月
    const labels = spendWindows("2026-03-15T00:00:00", NOW).map((w) => w.label);
    expect(labels[0]).toBe("最近 3 个月");
    expect(labels).toContain("2026-05 ~ 07");
    // 2026-02 起那一档已含住 3 月 ⇒ 到此为止，再往前不列
    expect(labels[labels.length - 1]).toBe("2026-02 ~ 04");
    expect(labels.length).toBe(3);
  });

  it("跨年的那一档把两年都写出来", () => {
    const labels = spendWindows("2025-11-02T00:00:00", NOW).map((w) => w.label);
    expect(labels[labels.length - 1]).toBe("2025-11 ~ 2026-01");
  });

  it("档位的日期边界是半开区间 [起始月 1 号, 满 3 个月)", () => {
    const { start, end } = windowRangeOf("2026-05", NOW);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(4);
    expect(start.getDate()).toBe(1);
    expect(end.getMonth()).toBe(7);
    expect(end.getDate()).toBe(1);
  });

  it("不给 month = 最近 3 个自然月（含当月）", () => {
    const { start, end } = windowRangeOf(null, NOW);
    expect(start.getMonth()).toBe(7); // 2026-08
    expect(end.getMonth()).toBe(10); // 2026-11 ⇒ [08-01, 11-01) 正好三个月
  });
});

describe("消费记录 · 窗口内滚动", () => {
  it("默认落在「最近 3 个月」这一档，先拿一页", async () => {
    const { section, calls, root } = mount(rows(5));
    await flush();
    expect(section.window().month).toBeNull();
    expect(section.loaded()).toBe(2);
    expect(calls).toEqual([{ month: null, cursor: null }]);
    // 第一档永远排在最前，且是默认选中的那一档
    // ⚠️ 别用 `[...NodeList]` 展开：本项目的 tsconfig 没开 DOM.Iterable，展开过不了类型检查
    const labels = Array.from(section.rangeMenu.querySelectorAll("button")).map(
      (b) => b.textContent,
    );
    expect(labels[0]).toBe("最近 3 个月");
    expect(root.textContent).toContain("最近 3 个月");
  });

  it("往下滚只在**当前档内**接着翻，游标是上一页末尾，不换档", async () => {
    const { section, calls } = mount(rows(5));
    await flush();
    await section.loadMore();
    expect(section.loaded()).toBe(4);
    expect(calls[1]).toEqual({ month: null, cursor: "2" });
    await section.loadMore();
    expect(section.loaded()).toBe(5);
    // 翻完了：没有下一页了
    expect(calls.length).toBe(3);
    await section.loadMore();
    expect(calls.length).toBe(3);
  });

  it("换档 ⇒ 旧档的行一条不留，游标从头开始", async () => {
    const { section, calls, root } = mount(rows(6));
    await flush();
    await section.loadMore();
    expect(section.loaded()).toBe(4);

    // 下拉里出现历史档（这一页带回了"最早一笔"）
    const items = section.rangeMenu.querySelectorAll("button");
    expect(items.length).toBeGreaterThan(1);
    (items[1] as HTMLElement).click();
    await flush();
    expect(section.window().month).toBe("2026-05");
    expect(calls[calls.length - 1]).toEqual({ month: "2026-05", cursor: null });
    // 旧档那 4 行换成新档的第 1 页
    expect(section.loaded()).toBe(2);
    expect(root.querySelectorAll(".row").length).toBe(2);
  });

  it("destroy 之后不再往里追加任何东西", async () => {
    const { section, calls } = mount(rows(6));
    await flush();
    section.destroy();
    await section.loadMore();
    expect(calls.length).toBe(1);
    expect(section.loaded()).toBe(2);
  });

  it("这一档一条都没有 ⇒ 说的是「这一段时间」，不是「你没消费过」", async () => {
    const { root } = mount([]);
    await flush();
    expect(root.textContent).toContain("这一段时间没有记录");
  });
});

describe("消费记录 · 每天一笔小计", () => {
  const sumsOf = (root: HTMLElement): (string | null)[] =>
    Array.from(root.querySelectorAll(".yl-pc-tl-sum")).map((e) => e.textContent);

  it("**每个**日期组都要写上当天合计，不只是最后一天", async () => {
    // 三天、每天两笔。回归（2026-10-11 用户报）：只靠页末定稿时，
    // 只有最后一个日期组有合计，前面几天全是空的。
    const all: Row[] = [
      { id: 6, at: "2026-10-11T10:00:00", amount: -1 },
      { id: 5, at: "2026-10-11T09:00:00", amount: -2 },
      { id: 4, at: "2026-10-10T10:00:00", amount: -4 },
      { id: 3, at: "2026-10-10T09:00:00", amount: -8 },
      { id: 2, at: "2026-10-09T10:00:00", amount: -16 },
      { id: 1, at: "2026-10-09T09:00:00", amount: -32 },
    ];
    const { root } = mount(all, 60);
    await flush();
    expect(sumsOf(root)).toEqual(["-3", "-12", "-48"]);
  });

  it("同一天跨页 ⇒ 还是一笔合计，页间接着累加", async () => {
    const all: Row[] = [
      { id: 3, at: "2026-10-11T12:00:00", amount: -1 },
      { id: 2, at: "2026-10-11T11:00:00", amount: -2 },
      { id: 1, at: "2026-10-11T10:00:00", amount: -4 },
    ];
    const { section, root } = mount(all, 2);
    await flush();
    expect(sumsOf(root)).toEqual(["-3"]);
    await section.loadMore();
    // 没有多长出一个日期组，同一格的值并成整天的 7
    expect(sumsOf(root)).toEqual(["-7"]);
  });
});
