// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultSettings } from "../src/settings/defaults";
import { DEMO_WORK_TITLE } from "../src/services/demo";
import { safeSegment } from "../src/services/mediaStore";
import { collectInventory } from "../src/services/dataInventory";
import { STORE, VaultDb } from "../src/storage/db";
import type {
  AssetRow,
  MyNoteRow,
  ProgressRow,
  RecordLineRow,
  RecordRow,
  SentenceRow,
  WordRow,
} from "../src/types/entities";

/**
 * 「数据」页的盘点：本机各类数据占多少、在不在、会不会上云。
 *
 * 这里钉三件最容易悄悄坏掉的事：
 *  1. **素材的大小读的是"现在"**（stat），不是导入时记的那个数 —— 用户在素材库外
 *     换过文件的话，两个数是不一样的；
 *  2. **"文件不在了"必须是结论而不是异常** —— 备份目录被整理过，
 *     这一页要如实说「找不到」，而不是炸掉或假装没事；
 *  3. **每一类数据只归一个大类**（2026-10-10 用户拍板）：学习档案（云端同步）/
 *     本地设置 / 视频、字幕与录音，后两个只在本机。去向只有两种，混合的概念必须
 *     拆成两行。这几行的方向要与 sync/snapshot.ts 的实际打包行为一致
 *     （台词原文永远不上行）。
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
    // r1：视频在库里、字幕在库外（用户原位置）
    db.put<RecordRow>(STORE.records, {
      ...syncFields(),
      cid: "r1",
      videoSha256: "vsha",
      jaSubSha256: "ssha",
      zhSubSha256: null,
      title: "MyGO",
      titleJa: "マイゴ",
      romaji: "",
      year: null,
      coverUrl: "",
      note: "",
      season: 1,
      number: "1",
      episodeTitle: "",
      durationMs: 1420000,
    }),
    // r2：同作品名的另一条记录，视频丢了（文件不在了的那份）
    db.put<RecordRow>(STORE.records, {
      ...syncFields(),
      cid: "r2",
      videoSha256: "gsha",
      jaSubSha256: "ssha",
      zhSubSha256: null,
      title: "MyGO",
      titleJa: "マイゴ",
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
      cid: "A:vsha",
      kind: "video",
      sha256: "vsha",
      filename: "ep1.mkv",
      sizeBytes: 3,
      language: "ja",
      subtitleFormat: "",
      localPath: videoPath,
      available: true,
    }),
    db.put<AssetRow>(STORE.assets, {
      ...syncFields(),
      cid: "A:ssha",
      kind: "subtitle",
      sha256: "ssha",
      filename: "ep1.ja-zh.ass",
      sizeBytes: 3,
      language: "ja-zh",
      subtitleFormat: "ass",
      localPath: outsidePath,
      available: true,
    }),
    db.put<AssetRow>(STORE.assets, {
      ...syncFields(),
      cid: "A:gsha",
      kind: "video",
      sha256: "gsha",
      filename: "gone.mkv",
      sizeBytes: 999999,
      language: "ja",
      subtitleFormat: "",
      localPath: gonePath,
      available: true,
    }),
    // 台词层：三条台词挂 r1；句子层只有 s2 改过覆盖层、s3 有 AI 解析
    db.put<RecordLineRow>(STORE.lines, {
      recordCid: "r1",
      index: 1,
      sentenceCid: "s1",
      startMs: 0,
      endMs: 2000,
      ja: "一行日文",
      zh: "一行中文",
      speaker: "",
    }),
    db.put<RecordLineRow>(STORE.lines, {
      recordCid: "r1",
      index: 2,
      sentenceCid: "s2",
      startMs: 2000,
      endMs: 4000,
      ja: "二行日文",
      zh: "二行中文",
      speaker: "",
    }),
    db.put<RecordLineRow>(STORE.lines, {
      recordCid: "r1",
      index: 3,
      sentenceCid: "s3",
      startMs: 4000,
      endMs: 6000,
      ja: "三行日文",
      zh: "三行中文",
      speaker: "",
    }),
    db.put<SentenceRow>(STORE.sentences, {
      rev: 0,
      rowDigest: "",
      cid: "s1",
      ja: "一行日文",
      textHash: "h1",
      analysis: null,
      clientUpdatedAt: NOW,
    }),
    db.put<SentenceRow>(STORE.sentences, {
      rev: 0,
      rowDigest: "",
      cid: "s2",
      ja: "二行日文",
      textHash: "h2",
      analysis: null,
      textFixes: { ja: "二行日文（改过）", zh: "二行中文（改过）" },
      correctionsUpdatedAt: NOW,
      clientUpdatedAt: NOW,
    }),
    db.put<SentenceRow>(STORE.sentences, {
      rev: 0,
      rowDigest: "",
      cid: "s3",
      ja: "三行日文",
      textHash: "h3",
      analysis: {
        text: "三行日文",
        tokens: [],
        translation: "三行中文的意思",
      } as unknown as SentenceRow["analysis"],
      clientUpdatedAt: NOW,
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
    expect(group.records).toBe(2);
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

    // ① 学习档案（云端同步）：句子进度整行上云，对话随进度走，学习记录与文件信息
    //    也在同步名单里；记着上次学到哪一页的偏好也属于学习记录（2026-10-10 拍板）
    for (const key of [
      "prefs", "progress", "words", "days", "imitation", "chat", "records",
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

/**
 * 演示包**下载后**就算用户数据（2026-10-14 用户拍板，取代 10-04 的旧口径）。
 *
 * 旧口径的前提是演示素材打在 main.js 里、随插件分发；10-13 起它改走服务端按需下载，
 * 用户点首页「示例」的「开始学」才落进素材库 —— 与用户自己导入的**同一个目录**
 * （`<基准>/<空间 id>/<作品名>/`，2026-10-14 起不再有共享的 `_demo/`）。那几 MB 是
 * 用户自己点下来的、真实占着这台机器的盘，存储页必须如实反映：素材清单、句子原文、
 * 学习记录、文件信息一视同仁。这条钉的就是"不再按作品名整集扣掉"。
 */
describe("collectInventory · 下载后的演示包照常计入", () => {
  it("素材、台词、记录都不再按作品名扣掉", async () => {
    root = mkdtempSync(join(tmpdir(), "yl-data-inv-demo-"));
    const mediaDir = join(root, "media");
    // 与用户导入同一条路：演示素材落在本机空间的素材库里
    const demoDir = join(mediaDir, "sp-1", safeSegment(DEMO_WORK_TITLE));
    mkdirSync(demoDir, { recursive: true });
    const video = join(demoDir, "demo.mp4");
    writeFileSync(video, Buffer.alloc(100 * 1024, 7));
    const subtitle = join(demoDir, "demo.srt");
    writeFileSync(subtitle, "1\n00:00:00,000 --> 00:00:03,000\n好きなアニメで日本語を学ぼう。\n");
    const videoBytes = statSync(video).size;
    const subBytes = statSync(subtitle).size;

    const db = await VaultDb.open("data-inventory-demo");
    await Promise.all([
      db.put<RecordRow>(STORE.records, {
        ...syncFields(),
        cid: "r-demo",
        videoSha256: "dv",
        jaSubSha256: "ds",
        zhSubSha256: null,
        title: DEMO_WORK_TITLE,
        titleJa: "",
        romaji: "",
        year: null,
        coverUrl: "",
        note: "",
        season: 0,
        number: "",
        episodeTitle: "",
        durationMs: 6000,
      }),
      db.put<AssetRow>(STORE.assets, {
        ...syncFields(),
        cid: "A:dv",
        kind: "video",
        sha256: "dv",
        filename: "demo.mp4",
        // 导入时记的旧数：盘点必须读当下的真实大小（100 KB）
        sizeBytes: 1,
        language: "ja",
        subtitleFormat: "",
        localPath: video,
        available: true,
      }),
      db.put<AssetRow>(STORE.assets, {
        ...syncFields(),
        cid: "A:ds",
        kind: "subtitle",
        sha256: "ds",
        filename: "demo.srt",
        sizeBytes: 1,
        language: "ja-zh",
        subtitleFormat: "srt",
        localPath: subtitle,
        available: true,
      }),
      db.put<RecordLineRow>(STORE.lines, {
        recordCid: "r-demo",
        index: 1,
        sentenceCid: "sd1",
        startMs: 0,
        endMs: 3000,
        ja: "好きなアニメで日本語を学ぼう。",
        zh: "用喜欢的动漫学日语吧。",
        speaker: "",
      }),
    ]);
    // 带着活跃空间盘：演示素材就在本空间目录里（不再有共享的 `_demo/`）
    const inventory = await collectInventory({
      db,
      settings: Object.assign(defaultSettings(), {
        vaultFolder: "young_look",
        mediaDir,
        activeSpaceId: "sp-1",
      }),
      pluginId: "young-look",
    });
    db.close();

    // 素材清单：两个文件都在、没有"需要留意"，大小读当下的
    expect(inventory.media.count).toBe(2);
    expect(inventory.media.missing).toBe(0);
    expect(inventory.media.outside).toBe(0);
    const group = inventory.media.groups[0];
    expect(group.title).toBe(DEMO_WORK_TITLE);
    expect(group.records).toBe(1);
    expect(group.videoCount).toBe(1);
    expect(group.subtitleCount).toBe(1);
    expect(group.attention).toBe(0);
    expect(group.inLibraryCount).toBe(2);
    expect(group.bytes).toBe(videoBytes + subBytes);

    // 台词、记录、文件信息都照常计入（旧口径这里全是 0）
    const rowOf = (key: string) =>
      [...inventory.archive.rows, ...inventory.localSettings.rows, ...inventory.media.rows].find(
        (row) => row.key === key,
      );
    expect(rowOf("slices-text")?.count).toBe(1);
    expect(rowOf("records")?.count).toBe(1);
    expect(rowOf("assets-info")?.count).toBe(2);
    expect(rowOf("assets-local")?.count).toBe(2);

    // 合计（hero 那个数）：素材文件 + 「句子原文」那一行（台词也是字幕的衍生品）
    expect(inventory.media.bytes).toBe((group.bytes ?? 0) + (rowOf("slices-text")?.bytes ?? 0));
    expect(inventory.media.bytes).toBeGreaterThan(videoBytes + subBytes);
    expect(inventory.localBytes).toBeGreaterThanOrEqual(inventory.media.bytes);
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
