// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultSettings } from "../src/settings/defaults";
import { collectInventory } from "../src/services/dataInventory";
import { STORE, VaultDb } from "../src/storage/db";
import type {
  AssetRow,
  EpisodeRow,
  MyNoteRow,
  ProgressRow,
  SliceRow,
  WordRow,
  WorkRow,
} from "../src/types/entities";

/**
 * 「数据」页的盘点：本机各类数据占多少、在不在、会不会上云。
 *
 * 这里钉三件最容易悄悄坏掉的事：
 *  1. **素材的大小读的是"现在"**（stat），不是导入时记的那个数 —— 用户在素材库外
 *     换过文件的话，两个数是不一样的；
 *  2. **"文件不在了"必须是结论而不是异常** —— 备 Lesson 目录被整理过，
 *     这一页要如实说「找不到」，而不是炸掉或假装没事；
 *  3. **每一类数据只归一个大类**（2026-10-10 用户拍板）：学习档案（云端同步）/
 *     本地设置 / 视频、字幕与录音，后两个只在本机。去向只有两种，混合的概念必须
 *     拆成两行。这几行的方向要与 sync/snapshot.ts 的实际打包行为一致
 *     （句子原文永远不上行）。
 */

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

const NOW = "2026-10-02T12:00:00.000Z";

function syncFields() {
  return { rev: 1, rowDigest: "d", clientUpdatedAt: NOW, deletedAt: null };
}

async function seed(videoPath: string, gonePath: string, outsidePath: string): Promise<VaultDb> {
  const db = await VaultDb.open("data-inventory");
  await Promise.all([
    db.put<WorkRow>(STORE.works, {
      ...syncFields(),
      cid: "w1",
      title: "MyGO",
      titleJa: "マイゴ",
      romaji: "",
      year: null,
      coverUrl: "",
      note: "",
    }),
    db.put<EpisodeRow>(STORE.episodes, {
      ...syncFields(),
      cid: "e1",
      workCid: "w1",
      season: 1,
      number: "1",
      title: "",
      durationMs: null,
    }),
    db.put<AssetRow>(STORE.assets, {
      ...syncFields(),
      cid: "a-video",
      kind: "video",
      episodeCid: "e1",
      filename: "ep1.mkv",
      sizeBytes: 3,
      durationSeconds: 1420,
      language: "ja",
      subtitleFormat: "",
      subtitleGroup: "",
      fingerprint: null,
      fpVersion: 1,
      localPath: videoPath,
      available: true,
    }),
    db.put<AssetRow>(STORE.assets, {
      ...syncFields(),
      cid: "a-sub",
      kind: "subtitle",
      episodeCid: "e1",
      filename: "ep1.ja-zh.ass",
      sizeBytes: 3,
      durationSeconds: null,
      language: "ja-zh",
      subtitleFormat: "ass",
      subtitleGroup: "",
      fingerprint: null,
      fpVersion: 1,
      localPath: outsidePath,
      available: true,
    }),
    db.put<AssetRow>(STORE.assets, {
      ...syncFields(),
      cid: "a-gone",
      kind: "video",
      episodeCid: "e1",
      filename: "gone.mkv",
      sizeBytes: 999999,
      durationSeconds: null,
      language: "ja",
      subtitleFormat: "",
      subtitleGroup: "",
      fingerprint: null,
      fpVersion: 1,
      localPath: gonePath,
      available: true,
    }),
    db.put<SliceRow>(STORE.slices, {
      ...syncFields(),
      cid: "s1",
      episodeCid: "e1",
      assetCid: "a-video",
      index: 1,
      startMs: 0,
      endMs: 2000,
      ja: "一行日文",
      zh: "一行中文",
      speaker: "",
      textHash: "h",
      parserVersion: 1,
      analysis: null,
    }),
    // 一条被用户改过的句子（进 corrections）、一条有 AI 解析结果的句子（进 analysis）
    db.put<SliceRow>(STORE.slices, {
      ...syncFields(),
      cid: "s2",
      episodeCid: "e1",
      assetCid: "a-video",
      index: 2,
      startMs: 2000,
      endMs: 4000,
      ja: "二行日文",
      zh: "二行中文",
      speaker: "",
      textHash: "h2",
      parserVersion: 1,
      analysis: null,
      textFixes: { ja: "二行日文（改过）", zh: "二行中文（改过）" },
      correctionsUpdatedAt: NOW,
    }),
    db.put<SliceRow>(STORE.slices, {
      ...syncFields(),
      cid: "s3",
      episodeCid: "e1",
      assetCid: "a-video",
      index: 3,
      startMs: 4000,
      endMs: 6000,
      ja: "三行日文",
      zh: "三行中文",
      speaker: "",
      textHash: "h3",
      parserVersion: 1,
      analysis: {
        text: "三行日文",
        tokens: [],
        translation: "三行中文的意思",
      } as unknown as SliceRow["analysis"],
    }),
    db.put<ProgressRow>(STORE.progress, {
      ...syncFields(),
      cid: "p1",
      sliceCid: "s1",
      copyAttempts: 1,
      copyDoneAt: NOW,
      copyEpoch: 1,
      copyText: "一行日文",
      readAloudAt: NOW,
      readAloudVerifiedAt: NOW,
      readAloudSeconds: 3,
      readEpoch: 1,
      imitationText: "我自己敲的一句",
      imitationCorrect: true,
      imitationVerifiedAt: NOW,
      imitationFeedback: {},
      imitationHint: null,
      imitationChat: [{ role: "user", content: "这是什么意思？", ts: NOW }],
      imitationEpoch: 1,
      completedAt: NOW,
    }),
    db.put<WordRow>(STORE.words, {
      ...syncFields(),
      cid: "word1",
      lemma: "行く",
      pos: "verb",
      surface: "行く",
      reading: "いく",
      romaji: "iku",
      definition: "去",
      meaningSource: "dictionary",
      status: "learning",
      mastery: 0.4,
      lastReviewedAt: null,
      reviewCount: 0,
      lapseCount: 0,
      correctCount: 0,
      exposureCount: 1,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    }),
    db.put<MyNoteRow>(STORE.myNotes, {
      hash: "note-hash",
      text: "我自己写的一条笔记",
      updatedAt: NOW,
    }),
  ]);
  return db;
}

describe("collectInventory", () => {
  it("素材按作品分组，大小读当下的文件；不在了 / 没收进库的如实标注", async () => {
    root = mkdtempSync(join(tmpdir(), "yl-data-inv-"));
    const mediaDir = join(root, "media");
    mkdirSync(join(mediaDir, "MyGO"), { recursive: true });
    const video = join(mediaDir, "MyGO", "ep1.mkv");
    writeFileSync(video, "0123456789");
    // 留在用户原来的位置（库外）：存在，但不能算"收进了素材库"
    const outside = join(root, "user-original", "ep1.ja-zh.ass");
    mkdirSync(join(root, "user-original"), { recursive: true });
    writeFileSync(outside, "abc");
    const gone = join(mediaDir, "MyGO", "gone.mkv");

    const db = await seed(video, gone, outside);
    const settings = Object.assign(defaultSettings(), {
      vaultFolder: "young_look",
      mediaDir,
    });
    const inventory = await collectInventory({
      db,
      settings,
      pluginId: "young-look",
    });
    db.close();

    expect(existsSync(video)).toBe(true);
    expect(inventory.media.count).toBe(3);
    expect(inventory.media.missing).toBe(1);
    expect(inventory.media.outside).toBe(1);

    const group = inventory.media.groups[0];
    expect(group.title).toBe("MyGO");
    expect(group.episodes).toBe(1);
    expect(group.videoCount).toBe(2);
    expect(group.subtitleCount).toBe(1);
    expect(group.attention).toBe(2);

    // 大小读的是"现在"这一份，不是导入时记的 sizeBytes（上面故意写成 3）
    const rows = group.files.slice().sort((a, b) => a.filename.localeCompare(b.filename));
    expect(rows[0].filename).toBe("ep1.ja-zh.ass");
    expect(rows[0].bytes).toBe(3);
    expect(rows[0].insideMedia).toBe(false);
    expect(rows[1].filename).toBe("ep1.mkv");
    expect(rows[1].bytes).toBe(10);
    expect(rows[1].insideMedia).toBe(true);
    expect(rows[2].exists).toBe(false);
    // 读不到了就退回库里记得的那一个数 —— 至少说明"它曾经多大"
    expect(rows[2].bytes).toBe(999999);
  });
});

describe("collectInventory · 三个大类的归属", () => {
  it("学习档案全云端；本地设置、视频字幕与录音只在本机", async () => {
    root = mkdtempSync(join(tmpdir(), "yl-data-inv-2-"));
    const mediaDir = join(root, "media");
    mkdirSync(mediaDir, { recursive: true });
    const video = join(mediaDir, "ep1.mkv");
    writeFileSync(video, "x");

    const db = await seed(video, join(mediaDir, "gone.mkv"), join(root, "outside.ass"));
    const settings = Object.assign(defaultSettings(), {
      vaultFolder: "young_look",
      mediaDir,
    });
    const inventory = await collectInventory({
      db,
      settings,
      pluginId: "young-look",
    });
    db.close();

    const rowOf = (key: string) =>
      [...inventory.archive.rows, ...inventory.localSettings.rows, ...inventory.media.rows].find(
        (row) => row.key === key,
      );

    // ① 学习档案（云端同步）：句子进度整行上云，对话随进度走，作品与文件信息
    //    也在同步名单里；记着上次学到哪一页的偏好也属于学习记录（2026-10-10 拍板）
    for (const key of [
      "prefs", "progress", "words", "days", "imitation", "chat", "works",
      "slices-corrections", "slices-analysis", "assets-info", "my-notes",
    ]) {
      expect(rowOf(key)?.trait, `${key} 应是云端同步`).toBe("cloud");
      expect(inventory.archive.rows.some((row) => row.key === key), `${key} 应在学习档案里`).toBe(true);
    }

    // ② 本地设置（只在本机）：登录状态、自备模型用量、文件放在这台机器的哪儿
    for (const key of ["settings-local", "usage", "assets-local"]) {
      expect(rowOf(key)?.trait, `${key} 应是只在本机`).toBe("local");
      expect(inventory.localSettings.rows.some((row) => row.key === key), `${key} 应在本地设置里`).toBe(true);
    }

    // ③ 视频、字幕与录音（只在本机）：台词原文与跟读录音都是字幕的衍生品
    for (const key of ["slices-text", "recordings"]) {
      expect(rowOf(key)?.trait, `${key} 应是只在本机`).toBe("local");
      expect(inventory.media.rows.some((row) => row.key === key), `${key} 应在视频字幕与录音里`).toBe(true);
    }

    // 一个大类里的去向只有一个 —— 不再有"部分上云"那种混合说法
    expect(inventory.archive.rows.every((row) => row.trait === "cloud")).toBe(true);
    expect(inventory.localSettings.rows.every((row) => row.trait === "local")).toBe(true);
    expect(inventory.media.rows.every((row) => row.trait === "local")).toBe(true);

    // 仿写这一行的"条目数"按有仿写文本的进度行算
    expect(inventory.archive.rows.find((row) => row.key === "imitation")?.count).toBe(1);
    // 拆出来的三行各按自己的口径计数：改过 1 条、有解析 1 条、原文 3 条
    expect(inventory.archive.rows.find((row) => row.key === "slices-corrections")?.count).toBe(1);
    expect(inventory.archive.rows.find((row) => row.key === "slices-analysis")?.count).toBe(1);
    expect(rowOf("slices-text")?.count).toBe(3);

    // 三大类加起来就是本机总量（页面 hero 那个数）
    expect(inventory.localBytes).toBe(
      inventory.media.bytes + inventory.localSettings.bytes + inventory.archive.bytes,
    );
    expect(inventory.localBytes).toBeGreaterThan(0);
  });
});

describe("collectInventory · 我的笔记", () => {
  it("未登录按本机笔记算；登录后只报在云端（本机不留一份）", async () => {
    root = mkdtempSync(join(tmpdir(), "yl-data-inv-notes-"));
    const mediaDir = join(root, "media");
    mkdirSync(mediaDir, { recursive: true });
    const video = join(mediaDir, "ep1.mkv");
    writeFileSync(video, "x");

    const db = await seed(video, join(mediaDir, "gone.mkv"), join(root, "outside.ass"));

    const anon = await collectInventory({
      db,
      settings: Object.assign(defaultSettings(), { vaultFolder: "young_look", mediaDir }),
      pluginId: "young-look",
    });
    const anonRow = anon.archive.rows.find((row) => row.key === "my-notes");
    expect(anonRow?.trait).toBe("cloud");
    expect(anonRow?.count).toBe(1);
    expect(anonRow?.bytes).toBeGreaterThan(0);

    const signed = await collectInventory({
      db,
      settings: Object.assign(defaultSettings(), {
        vaultFolder: "young_look",
        mediaDir,
        refreshToken: "r",
      }),
      pluginId: "young-look",
    });
    const signedRow = signed.archive.rows.find((row) => row.key === "my-notes");
    expect(signedRow?.trait).toBe("cloud");
    // 登录后笔记在服务端：本机这一行不报数字，但去向仍是「云端同步」
    expect(signedRow?.count).toBeNull();
    expect(signedRow?.bytes).toBe(0);

    db.close();
  });
});

/**
 * 云同步被**余额**挡住（存储页那条「云同步已暂停 · 余额用尽」提醒带的判据）。
 *
 * 这一格说的必须是「余额不够」这一件事 —— 它是服务端闸门（登录 + 余额 > 0，
 * 403 need=recharge）在盘点层的镜像。两条纪律：
 *  1. 没连账号不算暂停：那是「还没登录」，syncLine 另有一档文案，别混；
 *  2. 归属不再是这一层的概念（2026-10-10 模型重构：本机数据跟账号**永久绑定**，
 *     不存在"这份数据其实是别人的"这种状态，`ownedBy` / `ownershipOf` 已删）。
 *     所以这里只剩「登录 + 余额 > 0」一个判据。
 */
describe("collectInventory · 云同步暂停（余额用尽）", () => {
  async function inventoryWith(settings: ReturnType<typeof defaultSettings>) {
    root = mkdtempSync(join(tmpdir(), "yl-data-inv-paused-"));
    const mediaDir = join(root, "media");
    mkdirSync(mediaDir, { recursive: true });
    writeFileSync(join(mediaDir, "ep1.mkv"), "x");
    const db = await seed(join(mediaDir, "ep1.mkv"), join(mediaDir, "gone.mkv"), join(root, "o.ass"));
    const out = await collectInventory({
      db,
      settings,
      pluginId: "young-look",
    });
    db.close();
    return out;
  }

  it("已登录 + 余额用尽 → paused（页面据此画提醒带与状态栏那颗灯）", async () => {
    const inv = await inventoryWith(
      Object.assign(defaultSettings(), {
        vaultFolder: "young_look",
        refreshToken: "r",
        aiBalanceMillis: 0,
      }),
    );
    expect(inv.cloud.loggedIn).toBe(true);
    expect(inv.cloud.paused).toBe(true);
    expect(inv.cloud.state).toBe("paused");
  });

  it("已登录 + 还有余额 → 不暂停（充值后自动恢复的就是这一档）", async () => {
    const inv = await inventoryWith(
      Object.assign(defaultSettings(), {
        vaultFolder: "young_look",
        refreshToken: "r",
        aiBalanceMillis: 1000,
      }),
    );
    expect(inv.cloud.paused).toBe(false);
    expect(inv.cloud.state).toBe("synced");
  });

  it("没连账号 → 不算暂停（那是「还没登录」，另一档文案）", async () => {
    const inv = await inventoryWith(
      Object.assign(defaultSettings(), { vaultFolder: "young_look", aiBalanceMillis: 0 }),
    );
    expect(inv.cloud.loggedIn).toBe(false);
    expect(inv.cloud.paused).toBe(false);
    expect(inv.cloud.state).toBe("local");
  });

  it("🔥 暂停只认余额 —— 活跃空间不归当前账号也不影响这一格", async () => {
    const inv = await inventoryWith(
      Object.assign(defaultSettings(), {
        vaultFolder: "young_look",
        refreshToken: "r",
        aiBalanceMillis: 5000,
        serverUrl: "https://younglook.cc",
        spaces: [
          { id: "base", owner: "u-1", ownerServer: "https://younglook.cc", ownerName: "小明" },
        ],
        activeSpaceId: "base",
        accountProfile: { uid: "u-2", nickname: "小红", email: "", avatarUrl: "", fetchedAt: NOW },
      }),
    );
    expect(inv.cloud.paused).toBe(false);
    expect(inv.cloud.state).toBe("synced");
  });
});
