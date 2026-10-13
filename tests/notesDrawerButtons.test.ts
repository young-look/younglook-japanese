// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { installObsidianDomHelpers } from "./obsidianDom";

// 必须先装 DOM 扩展再开抽屉（搭壳时才碰 DOM，import 顺序无忧）
installObsidianDomHelpers();

import type { App } from "obsidian";
import { STORE, VaultDb } from "../src/storage/db";
import type { MyNoteRow } from "../src/types/entities";
import type { PluginSettings } from "../src/settings/types";
import { invalidateNoteCache, loadMyNotes } from "../src/services/notes/mine";
import { openNotesDrawer, type NotesDrawerDeps } from "../src/views/notesDrawer";

/**
 * 笔记抽屉 · 编辑态两颗钮的契约（2026-10-09 晚 用户拍板），钉两件事：
 *
 *   ① 「保存」**不要求有改动** —— 没改也要能一键从编辑态回到锁态。原先按
 *      `text === baseline` 禁用保存，只想退出编辑的用户会被困在编辑态里；
 *   ② 「取消」放弃这次所有编辑，回到存稿（有存稿 → 回锁态；没存稿 → 清空留在编辑态）。
 *
 * 为什么值得一组 DOM 用例：这两条改坏了症状完全静默（按钮点不动 / 改动没丢），
 * 纯函数钉不住 —— 只有真把抽屉搭起来、真点那颗钮才看得出来。
 */

const HASH = "abc";
const CID = `S:${HASH}`;
/** 未登录 = 纯本地，全程不走网络（共享笔记区只显示提示，不会发请求） */
const settings = { refreshToken: "" } as PluginSettings;

let db: VaultDb | null = null;

afterEach(async () => {
  await db?.close();
  db = null;
  invalidateNoteCache();
});

/** 造一个「预置了存稿」的抽屉（缓存也拉过 → 开抽屉即锁态），返回挂载点。 */
async function openWithSaved(text: string): Promise<HTMLElement> {
  const vault = await VaultDb.open(`nd-${Math.random().toString(36).slice(2)}`);
  db = vault;
  const row: MyNoteRow = { hash: HASH, text, updatedAt: new Date().toISOString() };
  await vault.put(STORE.myNotes, row);
  invalidateNoteCache();
  await loadMyNotes(settings, vault); // 填缓存 → 开抽屉时同步拿到 baseline

  const parent = document.createElement("div");
  openNotesDrawer({
    parent,
    app: {} as App,
    settings,
    db: vault,
    sliceCid: CID,
    zh: "中文",
    sentenceEl: () => null,
    onReplay: () => undefined,
    draft: "",
    onClose: () => undefined,
    onMineChanged: () => undefined,
  } satisfies NotesDrawerDeps);
  return parent;
}

/** 造一个「没有任何存稿」的抽屉（打开即编辑态空框）。 */
async function openFresh(): Promise<HTMLElement> {
  const vault = await VaultDb.open(`nd-${Math.random().toString(36).slice(2)}`);
  db = vault;
  invalidateNoteCache();
  const parent = document.createElement("div");
  openNotesDrawer({
    parent,
    app: {} as App,
    settings,
    db: vault,
    sliceCid: CID,
    zh: "中文",
    sentenceEl: () => null,
    onReplay: () => undefined,
    draft: "",
    onClose: () => undefined,
    onMineChanged: () => undefined,
  } satisfies NotesDrawerDeps);
  return parent;
}

/** 按文字找按钮（抽屉里同名按钮只有一个） */
function btn(parent: HTMLElement, label: string): HTMLButtonElement {
  const hit = Array.from(parent.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === label,
  );
  if (!hit) throw new Error(`没找到按钮：${label}`);
  return hit as HTMLButtonElement;
}

const area = (parent: HTMLElement): HTMLTextAreaElement =>
  parent.querySelector<HTMLTextAreaElement>("textarea.yl-nd-input")!;
const locked = (parent: HTMLElement): HTMLElement =>
  parent.querySelector<HTMLElement>(".yl-nd-locked")!;

/** 打一行字（走 input 事件，跟真人打字同一路径） */
function type(parent: HTMLElement, text: string): void {
  const el = area(parent);
  el.value = text;
  el.dispatchEvent(new Event("input"));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("笔记抽屉 · 编辑态退出", () => {
  it("打开有存稿 → 锁态；点「编辑」进编辑态，没改动时「保存」仍可用", async () => {
    const parent = await openWithSaved("原稿");

    expect(area(parent).style.display).toBe("none"); // 锁态：输入框收着
    expect(locked(parent).textContent).toBe("原稿");

    btn(parent, "编辑").click();
    expect(area(parent).style.display).not.toBe("none");
    // 🔥 核心：没改动也不再禁用保存（原先就是这里把用户困住的）
    expect(btn(parent, "保存").disabled).toBe(false);
  });

  it("没改动点「保存」→ 直接回锁态", async () => {
    const parent = await openWithSaved("原稿");
    btn(parent, "编辑").click();

    btn(parent, "保存").click();
    await flush();

    expect(area(parent).style.display).toBe("none");
    expect(locked(parent).textContent).toBe("原稿");
  });

  it("改了字点「保存」→ 存下来，锁态显示新内容", async () => {
    const parent = await openWithSaved("原稿");
    btn(parent, "编辑").click();
    type(parent, "改过的说法");

    btn(parent, "保存").click();
    await flush();

    expect(locked(parent).textContent).toBe("改过的说法");
    const rows = await db!.getAll<MyNoteRow>(STORE.myNotes);
    expect(rows.find((r) => r.hash === HASH)?.text).toBe("改过的说法");
  });

  it("点「取消」→ 放弃这次编辑、回到存稿", async () => {
    const parent = await openWithSaved("原稿");
    btn(parent, "编辑").click();
    type(parent, "改了一半不要了");

    btn(parent, "取消").click();

    expect(area(parent).value).toBe("原稿"); // 输入框还原
    expect(area(parent).style.display).toBe("none"); // 有存稿 → 回锁态
    expect(locked(parent).textContent).toBe("原稿");
    // 没落库
    const rows = await db!.getAll<MyNoteRow>(STORE.myNotes);
    expect(rows.find((r) => r.hash === HASH)?.text).toBe("原稿");
  });

  it("新笔记空框：「保存」禁用；打了字就可用；「取消」清空后留在编辑态", async () => {
    const parent = await openFresh();

    expect(area(parent).style.display).not.toBe("none"); // 空框 → 编辑态
    expect(btn(parent, "保存").disabled).toBe(true); // 没内容可存

    type(parent, "打了个草稿又不要了");
    expect(btn(parent, "保存").disabled).toBe(false);

    btn(parent, "取消").click();
    expect(area(parent).value).toBe("");
    expect(area(parent).style.display).not.toBe("none"); // 没存稿 → 留在编辑态
  });
});
