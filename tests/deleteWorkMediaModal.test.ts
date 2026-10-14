// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "./obsidianDom";

// 必须先装 DOM 扩展再 new 弹窗（搭壳时才碰 DOM，import 顺序无忧）
installObsidianDomHelpers();

import type YoungLookPlugin from "../src/main";
import { DeleteWorkMediaModal, type DeleteWorkTarget } from "../src/views/DeleteWorkMediaModal";
import { STORE, VaultDb } from "../src/storage/db";
import type { AssetRow, RecordRow } from "../src/types/entities";

/**
 * 「删除这个作品的素材」确认窗的契约（2026-10-09，2026-10-14 随身份模型更新）。
 *
 * 三条要钉住：
 *  1. 壳走全站统一弹窗，标题与作品名都在；
 *  2. **后果必须说在明面上** —— 学习进度不删、库外文件不碰、重新导入可恢复；
 *  3. 确认后按组删：组内各记录软删、库内副本真删、**库外文件一个不动**。
 */

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

const NOW = "2026-10-09T12:00:00.000Z";

function syncFields() {
  return { rev: 1, rowDigest: "d", clientUpdatedAt: NOW, deletedAt: null };
}

function buttonByText(modal: DeleteWorkMediaModal, text: string): HTMLButtonElement {
  const found = Array.from(modal.contentEl.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === text,
  );
  if (!found) throw new Error(`弹窗里找不到按钮「${text}」`);
  return found;
}

const TARGET: DeleteWorkTarget = {
  title: "MyGO",
  recordCount: 2,
  inLibraryPaths: ["/media/MyGO/ep1.mkv", "/media/MyGO/ep2.mkv"],
  bytes: 3 * 1024 * 1024,
  outsideCount: 1,
  recordCids: ["r1", "r2"],
};

function build(overrides: Partial<DeleteWorkTarget> = {}): DeleteWorkMediaModal {
  const modal = new DeleteWorkMediaModal({} as never, {} as never, { ...TARGET, ...overrides });
  modal.open();
  return modal;
}

describe("删除作品素材的确认窗", () => {
  it("壳走统一弹窗，标题与作品名都在", () => {
    const modal = build();
    expect(modal.modalEl.classList.contains("yl-dialog")).toBe(true);
    expect(modal.contentEl.textContent).toContain("删除这个作品的素材");
    expect(modal.contentEl.textContent).toContain("MyGO");
  });

  it("把后果说在明面上：学习进度不删、库外文件不动、可恢复", () => {
    const text = build().contentEl.textContent ?? "";
    expect(text).toContain("学习进度不会被删除");
    expect(text).toContain("重新导入同一集就能恢复");
    expect(text).toContain("留在你原来的位置，不会被删");
    expect(text).toContain("共 2 条记录 · 2 个文件");
  });

  it("没有库外文件时不必提「留在原来的位置」", () => {
    const text = build({ outsideCount: 0 }).contentEl.textContent ?? "";
    expect(text).not.toContain("留在你原来的位置");
  });

  it("点「取消」：关窗，什么都不发生", () => {
    const onDone = vi.fn();
    const modal = new DeleteWorkMediaModal({} as never, {} as never, TARGET, { onDone });
    modal.open();
    buttonByText(modal, "取消").click();
    expect(onDone).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toBe("");
  });

  it("确认后按组删：各记录软删、库内副本删掉、库外文件与素材行不动", async () => {
    root = mkdtempSync(join(tmpdir(), "yl-del-work-"));
    const mediaDir = join(root, "media");
    mkdirSync(join(mediaDir, "MyGO"), { recursive: true });
    const insideA = join(mediaDir, "MyGO", "ep1.mkv");
    const insideB = join(mediaDir, "MyGO", "ep2.mkv");
    const outside = join(root, "user-original", "ep1.ja-zh.ass");
    mkdirSync(join(root, "user-original"), { recursive: true });
    writeFileSync(insideA, "0123456789");
    writeFileSync(insideB, "abcdefghij");
    writeFileSync(outside, "keep-me");

    const db = await VaultDb.open("delete-work-media");
    await Promise.all([
      db.put<RecordRow>(STORE.records, {
        ...syncFields(),
        cid: "r1",
        videoSha256: "sha-video-1",
        jaSubSha256: "sha-ja-1",
        zhSubSha256: null,
        title: "MyGO",
        titleJa: "",
        romaji: "",
        year: null,
        coverUrl: "",
        note: "",
        season: 1,
        number: "1",
        episodeTitle: "",
        durationMs: null,
      }),
      db.put<RecordRow>(STORE.records, {
        ...syncFields(),
        cid: "r2",
        videoSha256: "sha-video-2",
        jaSubSha256: "sha-ja-2",
        zhSubSha256: null,
        title: "MyGO",
        titleJa: "",
        romaji: "",
        year: null,
        coverUrl: "",
        note: "",
        season: 1,
        number: "2",
        episodeTitle: "",
        durationMs: null,
      }),
      db.put<AssetRow>(STORE.assets, {
        ...syncFields(),
        cid: "A:sha-video-1",
        kind: "video",
        sha256: "sha-video-1",
        filename: "ep1.mkv",
        sizeBytes: 10,
        language: "ja",
        subtitleFormat: "",
        localPath: insideA,
        available: true,
      }),
      db.put<AssetRow>(STORE.assets, {
        ...syncFields(),
        cid: "A:sha-video-2",
        kind: "video",
        sha256: "sha-video-2",
        filename: "ep2.mkv",
        sizeBytes: 10,
        language: "ja",
        subtitleFormat: "",
        localPath: insideB,
        available: true,
      }),
    ]);

    const plugin = { db, settings: { mediaDir } } as unknown as YoungLookPlugin;
    const modal = new DeleteWorkMediaModal({} as never, plugin, {
      ...TARGET,
      inLibraryPaths: [insideA, insideB],
    });
    modal.open();
    buttonByText(modal, "删除").click();

    // 库内副本都删掉 = 整个流程跑完了
    await vi.waitFor(
      () => {
        expect(existsSync(insideA)).toBe(false);
        expect(existsSync(insideB)).toBe(false);
      },
      { timeout: 3000 },
    );

    const [r1, r2, a1] = await Promise.all([
      db.get<RecordRow>(STORE.records, "r1"),
      db.get<RecordRow>(STORE.records, "r2"),
      db.get<AssetRow>(STORE.assets, "A:sha-video-1"),
    ]);
    expect(r1?.deletedAt).not.toBeNull();
    expect(r2?.deletedAt).not.toBeNull();
    // 素材行不删：软删的是记录行，素材行可能被别的记录共享（跨记录共享的硬边界）
    expect(a1?.deletedAt).toBeNull();
    expect(existsSync(outside)).toBe(true);

    db.close();
  });
});
