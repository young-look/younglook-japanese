// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { installObsidianDomHelpers } from "./obsidianDom";
import { buildVocabSection, type VocabSection } from "../src/views/vocabSection";
import type { VocabEntry } from "../src/services/vocabLibrary";

/**
 * 词库页签「按下搜索才筛 + 滚动加载」的行为契约（2026-10-10 拍板：五十音首字
 * 胶囊行整行退场，工具行收成一排「排序 / 搜索框 / 搜索钮 …… 导出」；词库是
 * 词条不是流水，**没有时间窗口**）。
 *
 * 守的是：① 输入框里打字**不筛**，按搜索钮（或回车）才筛；② 重筛游标归零、
 * 就地清列表（绝不重建输入框）；③ 工具行三段的先后；④ 到头后 loadMore 空转；
 * ⑤ destroy 之后不再加载。
 */

installObsidianDomHelpers();

let seq = 0;
function entry(over: Partial<VocabEntry> = {}): VocabEntry {
  seq += 1;
  return {
    surface: over.surface ?? `词${seq}`,
    reading: over.reading ?? "",
    romaji: over.romaji ?? "",
    meaning: over.meaning ?? "",
    source: "测试 S01E01",
    seen: over.seen ?? 1,
    lastSeenAt: over.lastSeenAt ?? "2026-09-10T10:00:00",
    example: over.example ?? "",
    exampleAt: over.exampleAt ?? "",
  };
}

const NOW_ROWS = (): VocabEntry[] => [
  entry({ surface: "あめ", reading: "あめ", meaning: "雨" }),
  entry({ surface: "かさ", reading: "かさ", meaning: "伞" }),
  entry({ surface: "食べる", reading: "たべる", meaning: "吃" }),
  entry({ surface: "Video", reading: "", romaji: "video", meaning: "视频" }),
];

const PER_PAGE = 2;

interface MountOpts {
  fillToolbarLeading?(row: HTMLElement): void;
  fillToolbarTrailing?(row: HTMLElement): void;
  initialQuery?: string;
}

function mount(rows: VocabEntry[], opts: MountOpts = {}) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const countEl = root.createSpan({ text: "" });
  const section = buildVocabSection(root, {
    scrollRoot: null,
    countEl,
    total: rows.length,
    all: () => rows,
    compare: (a, b) => b.seen - a.seen,
    renderRow: (parent, e) => {
      parent.createDiv({ cls: "vrow", text: e.surface });
    },
    pageSize: PER_PAGE,
    initialQuery: opts.initialQuery,
    fillToolbarLeading: opts.fillToolbarLeading,
    fillToolbarTrailing: opts.fillToolbarTrailing,
  });
  return { root, section, countEl };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 往框里写字 —— 只发 input，**不**提交（模拟"还在打字"） */
const typeOnly = (section: VocabSection, text: string): void => {
  section.searchInput.value = text;
  section.searchInput.dispatchEvent(new Event("input"));
};

/** 写字 + 点搜索钮（真实入口；等价于用户按了那颗钮） */
const submit = async (section: VocabSection, text: string): Promise<void> => {
  section.searchInput.value = text;
  searchBtn(section).click();
  await flush();
};

const searchBtn = (section: VocabSection): HTMLButtonElement => {
  const row = section.el.parentElement?.querySelector(".yl-pc-filters") as HTMLElement;
  return Array.from(row.querySelectorAll("button")).find(
    (b) => b.textContent === "搜索",
  ) as HTMLButtonElement;
};

afterEach(() => {
  document.body.empty();
});

describe("词库 · 按下搜索才筛", () => {
  it("打字**不**筛；按下搜索钮才筛", async () => {
    const { section } = mount(NOW_ROWS());
    await flush();
    expect(section.filteredCount()).toBe(4);
    typeOnly(section, "かさ");
    await flush();
    // 框里已经有字了，但列表还没动
    expect(section.filteredCount()).toBe(4);
    searchBtn(section).click();
    await flush();
    expect(section.filteredCount()).toBe(1);
  });

  it("回车等价于按搜索钮", async () => {
    const { section } = mount(NOW_ROWS());
    await flush();
    section.searchInput.value = "雨";
    section.searchInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await flush();
    expect(section.filteredCount()).toBe(1);
  });

  it("搜词面 / 释义 / 罗马音都命中，大小写不敏感", async () => {
    const { root, section } = mount(NOW_ROWS());
    await flush();
    await submit(section, "かさ");
    expect(section.filteredCount()).toBe(1);
    await submit(section, "雨"); // あめ 的释义
    expect(section.filteredCount()).toBe(1);
    expect(root.querySelectorAll(".vrow")[0].textContent).toBe("あめ");
    await submit(section, "VIDEO"); // 罗马音，大小写不敏感
    expect(section.filteredCount()).toBe(1);
    expect(root.querySelectorAll(".vrow")[0].textContent).toBe("Video");
  });

  it("清空搜索框再提交 ⇒ 回到全部", async () => {
    const { section } = mount(NOW_ROWS());
    await flush();
    await submit(section, "かさ");
    expect(section.filteredCount()).toBe(1);
    await submit(section, "");
    expect(section.filteredCount()).toBe(4);
  });

  it("切页签回来：上次的搜索词既在筛选、也回到框里（框与列表不打架）", async () => {
    const { section } = mount(NOW_ROWS(), { initialQuery: "かさ" });
    await flush();
    expect(section.searchInput.value).toBe("かさ");
    expect(section.filteredCount()).toBe(1);
  });

  it("筛空了 ⇒ 说「没有符合条件的词」，不说词库是空的", async () => {
    const { root, section } = mount(NOW_ROWS());
    await flush();
    await submit(section, "ん");
    expect(root.textContent).toContain("没有符合条件的词。");
  });

  it("筛出子集时计数变「共 N 词 · 符合 M 词」", async () => {
    const { countEl, section } = mount(NOW_ROWS());
    await flush();
    await submit(section, "かさ");
    expect(countEl.textContent).toContain("符合 1 词");
  });
});

describe("词库 · 工具行", () => {
  it("顺序：左段（排序）→ 搜索框 → 搜索钮 → 尾段（导出）", async () => {
    const { root } = mount(NOW_ROWS(), {
      fillToolbarLeading: (row) => row.createSpan({ cls: "mark-l", text: "排序" }),
      fillToolbarTrailing: (row) => row.createSpan({ cls: "mark-r", text: "导出" }),
    });
    await flush();
    const row = root.querySelector(".yl-pc-filters") as HTMLElement;
    expect(row.children.length).toBe(4);
    expect(row.children[0].className).toContain("mark-l");
    expect(row.children[1].tagName).toBe("INPUT");
    expect(row.children[1].className).toContain("yl-vb-search");
    expect(row.children[2].tagName).toBe("BUTTON");
    expect(row.children[2].textContent).toBe("搜索");
    expect(row.children[3].className).toContain("mark-r");
  });

  it("五十音胶囊行已退场：工具行里只有一颗「搜索」钮", async () => {
    const { root } = mount(NOW_ROWS());
    await flush();
    const labels = Array.from(root.querySelectorAll(".yl-pc-filters button")).map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(["搜索"]);
  });
});

describe("词库 · 滚动加载", () => {
  it("先拉一页（一页 2 条），滚到底再续拉，到头后空转", async () => {
    const { root, section } = mount(NOW_ROWS());
    await flush();
    expect(section.loaded()).toBe(2);
    expect(root.querySelectorAll(".vrow").length).toBe(2);
    await section.loadMore();
    expect(section.loaded()).toBe(4);
    // 到头了：再滚也不再发
    await section.loadMore();
    expect(section.loaded()).toBe(4);
    // 状态行收掉（词库翻完不挂一句"看完了"的尾巴）
    expect(root.textContent).not.toContain("继续下滑");
  });
});

describe("词库 · 状态与销毁", () => {
  it("搜索变化游标归零：翻过两页再筛，从头只出筛后第一页", async () => {
    const { section } = mount(NOW_ROWS());
    await flush();
    await section.loadMore();
    expect(section.loaded()).toBe(4);
    await submit(section, "かさ");
    expect(section.loaded()).toBe(1);
    await section.loadMore();
    // 筛后只有 1 个，翻页空转
    expect(section.loaded()).toBe(1);
  });

  it("destroy 之后不再加载", async () => {
    const { section } = mount(NOW_ROWS());
    await flush();
    section.destroy();
    await section.loadMore();
    expect(section.loaded()).toBe(2);
  });
});
