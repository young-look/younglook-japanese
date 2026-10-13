import "fake-indexeddb/auto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { VaultDb, STORE } from "../src/storage/db";
import { probeFile } from "../src/storage/files";
import {
  DEMO_LEGACY_WORK_TITLES,
  DEMO_META_KEY,
  DEMO_VIDEO_FILE,
  DEMO_WORK_TITLE,
  ensureDemoMaterial,
  restoreBundledDemo,
} from "../src/services/demoSeed";
import { safeSegment, DEMO_MEDIA_SUBDIR } from "../src/services/mediaStore";
import { importSubtitle } from "../src/services/importer";
import { loadEpisodeList, loadSlices, removeEpisode } from "../src/services/study";
import type { DemoSeedHost } from "../src/services/demoSeed";
import type { AssetRow, EpisodeRow, SliceRow } from "../src/types/entities";

/**
 * 内置演示素材铺设与跟随更新的测试。
 *
 * 素材本来随插件自带（plugin/demo/），测试里用合成文件替代：假视频只要
 * 过得了素材完整性门槛（≥100KB）和采样指纹，字幕用真实风格的中日对照 SRT。
 *
 * ⚠️ `manifest.dir` 的形态是这次的坑：Obsidian 给的是**相对 vault 根**的路径，
 * 相对时必须锚到 vaultBasePath 解析 —— 否则相对的是 Obsidian 进程的工作目录，
 * 文件永远"找不到"，铺设永远静默失败。
 */

const SRT = [
  "1",
  "00:00:00,000 --> 00:00:03,000",
  "好きなアニメで日本語を学ぼう。",
  "用喜欢的动漫学日语吧。",
  "",
  "2",
  "00:00:03,000 --> 00:00:06,000",
  "一句ずつ、ゆっくりと。",
  "一句一句，慢慢来。",
  "",
].join("\n");

/** 换新测试用的"另一版"素材：字幕多了第三句，视频内容也不同。 */
const SRT_V2 = [
  "1",
  "00:00:00,000 --> 00:00:02,000",
  "ようこそ。",
  "欢迎。",
  "",
  "2",
  "00:00:02,000 --> 00:00:04,000",
  "ここから始めましょう。",
  "从这里开始吧。",
  "",
  "3",
  "00:00:04,000 --> 00:00:06,000",
  "一緒に勉強しましょう。",
  "一起学习吧。",
  "",
].join("\n");

/** 造一份"插件目录"：demo/ 里放着合成视频和字幕，返回 vault 根（它的父目录）。 */
function makePluginDir(): { vaultRoot: string; pluginDirName: string; demoDir: string } {
  const vaultRoot = mkdtempSync(join(tmpdir(), "yl-vault-"));
  const pluginDirName = ".obsidian/plugins/young-look";
  const demoDir = join(vaultRoot, pluginDirName, "demo");
  mkdirSync(demoDir, { recursive: true });
  // 128KB：过了 MIN_DEMO_BYTES（100KB）的完整性门槛，也够首尾 64KB 的采样指纹
  writeFileSync(join(demoDir, "demo.mp4"), Buffer.alloc(128 * 1024, 7));
  writeFileSync(join(demoDir, "demo.srt"), SRT, "utf8");
  return { vaultRoot, pluginDirName, demoDir };
}

function makeHost(vaultRoot: string, pluginDirName: string, mediaDir: string): DemoSeedHost {
  return {
    // 故意用相对路径 —— 这就是 Obsidian 实际给的形态
    manifest: { dir: pluginDirName },
    vaultBasePath: vaultRoot,
    settings: { mediaDir },
  };
}

function makeMediaDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "yl-media-")), "media");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function liveVideoAsset(db: VaultDb, episodeCid: string): Promise<AssetRow> {
  const rows = await db.getAllByIndex<AssetRow>(STORE.assets, "by_episode", episodeCid);
  const video = rows.find((row) => row.kind === "video" && !row.deletedAt);
  expect(video).toBeDefined();
  return video!;
}

describe("铺内置演示素材", () => {
  let db: VaultDb;

  beforeEach(async () => {
    db = await VaultDb.open(Math.random().toString(36).slice(2, 10));
  });

  it("相对 manifest.dir 锚到 vaultBasePath：铺上一集、落标记、素材进库", async () => {
    const { vaultRoot, pluginDirName } = makePluginDir();
    const mediaDir = makeMediaDir();

    const seeded = await ensureDemoMaterial(makeHost(vaultRoot, pluginDirName, mediaDir), db);

    expect(seeded).toBe(true);
    const episodes = await loadEpisodeList(db);
    expect(episodes).toHaveLength(1);
    const flag = await db.get<{ key: string; value: string }>(STORE.meta, DEMO_META_KEY);
    expect(flag?.value).toBeTruthy();
    // 素材收进了素材库（跟用户导入同一条路），不是指着插件目录播
    expect(readdirSync(mediaDir).length).toBeGreaterThan(0);
  });

  it("manifest.dir 是绝对路径时直接用", async () => {
    const { vaultRoot, pluginDirName } = makePluginDir();
    const mediaDir = makeMediaDir();
    const host: DemoSeedHost = {
      manifest: { dir: join(vaultRoot, pluginDirName) },
      vaultBasePath: vaultRoot,
      settings: { mediaDir },
    };

    expect(await ensureDemoMaterial(host, db)).toBe(true);
    expect(await loadEpisodeList(db)).toHaveLength(1);
  });

  it("插件目录缺文件：不铺、不落标记（下次启动还会再试）", async () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "yl-vault-"));
    const mediaDir = makeMediaDir();

    const seeded = await ensureDemoMaterial(
      makeHost(vaultRoot, ".obsidian/plugins/young-look", mediaDir),
      db,
    );

    expect(seeded).toBe(false);
    expect(await loadEpisodeList(db)).toHaveLength(0);
    const flag = await db.get<{ key: string; value: string }>(STORE.meta, DEMO_META_KEY);
    expect(flag).toBeUndefined();
  });

  it("库里已有素材（老用户）：只落标记，不再塞演示", async () => {
    const { vaultRoot, pluginDirName } = makePluginDir();
    const mediaDir = makeMediaDir();
    const host = makeHost(vaultRoot, pluginDirName, mediaDir);

    // 先铺一次拿到一集，再抹掉标记 —— 模拟"用户有自己的素材、但标记丢了"的老库
    expect(await ensureDemoMaterial(host, db)).toBe(true);
    await db.delete(STORE.meta, DEMO_META_KEY);

    const seeded = await ensureDemoMaterial(host, db);

    expect(seeded).toBe(false);
    const flag = await db.get<{ key: string; value: string }>(STORE.meta, DEMO_META_KEY);
    expect(flag?.value).toBeTruthy();
    // 没有再塞第二份演示
    expect(await loadEpisodeList(db)).toHaveLength(1);
  });

  it("铺过一次（有标记）就不再重复铺", async () => {
    const { vaultRoot, pluginDirName } = makePluginDir();
    const mediaDir = makeMediaDir();
    const host = makeHost(vaultRoot, pluginDirName, mediaDir);

    expect(await ensureDemoMaterial(host, db)).toBe(true);
    expect(await ensureDemoMaterial(host, db)).toBe(false);
    expect(await loadEpisodeList(db)).toHaveLength(1);
    expect(existsSync(join(mediaDir))).toBe(true);
  });

  it("旧版演示（历史作品名）：整集换新成当前版本，旧的软删、库内副本清走", async () => {
    const { vaultRoot, pluginDirName } = makePluginDir();
    const mediaDir = makeMediaDir();
    // 模拟 webm 时代铺出去的旧演示：历史作品名 + 旧素材（收进了素材库）
    const legacyVideo = join(vaultRoot, "legacy-video.webm");
    writeFileSync(legacyVideo, Buffer.alloc(8 * 1024, 3));
    const legacySrt = join(vaultRoot, "legacy.srt");
    writeFileSync(legacySrt, SRT, "utf8");
    expect(
      await importSubtitle(db, {
        subtitlePath: legacySrt,
        videoPath: legacyVideo,
        workTitle: DEMO_LEGACY_WORK_TITLES[0],
        number: "",
        mediaDir,
      }),
    ).toMatchObject({ ok: true });
    expect(await loadEpisodeList(db)).toHaveLength(1);

    expect(await ensureDemoMaterial(makeHost(vaultRoot, pluginDirName, mediaDir), db)).toBe(true);

    const episodes = await loadEpisodeList(db);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].work.title).toBe(DEMO_WORK_TITLE);
    // 旧集整体软删（旧的演示集行 + 旧作品行），不是真删
    const rawEpisodes = await db.getAll<EpisodeRow>(STORE.episodes);
    expect(rawEpisodes.filter((row) => row.deletedAt).length).toBeGreaterThan(0);
    // 演示素材住共享的 `_demo/` 下（2026-10-10：素材按空间隔离，演示集除外），
    // 里面只剩当前这一版演示的目录。
    // ⚠️ 上面那段 `importSubtitle` 是按**旧布局**（直接铺在 mediaDir 根下）造的历史
    //    数据，它在新模型的删除根（`_demo/`）之外 ⇒ 清不掉，会留在老位置。
    //    这是 `mediaStore.resolveMediaDir` 里写明的取舍：项目未上线，不写老数据迁移。
    expect(readdirSync(join(mediaDir, DEMO_MEDIA_SUBDIR))).toEqual([safeSegment(DEMO_WORK_TITLE)]);
  });

  it("只是视频换新版：句子原地保留，视频素材换成自带的新版", async () => {
    const { vaultRoot, pluginDirName, demoDir } = makePluginDir();
    const mediaDir = makeMediaDir();
    const host = makeHost(vaultRoot, pluginDirName, mediaDir);
    expect(await ensureDemoMaterial(host, db)).toBe(true);

    const episodeCid = (await loadEpisodeList(db))[0].episode.cid;
    const slicesBefore = await loadSlices(db, episodeCid);
    const oldVideo = await liveVideoAsset(db, episodeCid);

    // 插件换了新渲染的 demo.mp4（内容不同），字幕没动
    writeFileSync(join(demoDir, "demo.mp4"), Buffer.alloc(132 * 1024, 9));
    expect(await ensureDemoMaterial(host, db)).toBe(true);

    // 句子原封不动（slice cid 稳定 = 学习记录不丢）
    const slicesAfter = await loadSlices(db, episodeCid);
    expect(slicesAfter.map((row: SliceRow) => row.cid)).toEqual(slicesBefore.map((row) => row.cid));

    const newVideo = await liveVideoAsset(db, episodeCid);
    const bundled = await probeFile(join(demoDir, "demo.mp4"));
    expect(newVideo.fingerprint).toBe(bundled.fingerprint);
    expect(newVideo.cid).not.toBe(oldVideo.cid);
    // 旧视频素材行软删（播放按「第一个活着的 video」取，旧行必须让位）
    const rawAssets = await db.getAll<AssetRow>(STORE.assets);
    expect(rawAssets.find((row) => row.cid === oldVideo.cid)?.deletedAt).toBeTruthy();
    // 新视频落到本来的名字：旧的库内副本先收走，不漂移成 "demo (2).mp4"
    expect(
      readdirSync(join(mediaDir, DEMO_MEDIA_SUBDIR, safeSegment(DEMO_WORK_TITLE))),
    ).toContain("demo.mp4");
  });

  it("字幕变了：整集重铺成自带的新字幕", async () => {
    const { vaultRoot, pluginDirName, demoDir } = makePluginDir();
    const mediaDir = makeMediaDir();
    const host = makeHost(vaultRoot, pluginDirName, mediaDir);
    expect(await ensureDemoMaterial(host, db)).toBe(true);

    const episodeCid = (await loadEpisodeList(db))[0].episode.cid;
    const slicesBefore = await loadSlices(db, episodeCid);

    writeFileSync(join(demoDir, "demo.srt"), SRT_V2, "utf8");
    expect(await ensureDemoMaterial(host, db)).toBe(true);

    const episodes = await loadEpisodeList(db);
    expect(episodes).toHaveLength(1);
    const slicesAfter = await loadSlices(db, episodeCid);
    expect(slicesAfter).toHaveLength(3);
    expect(slicesAfter[0].ja).toBe("ようこそ。");
    // 旧切片整体软删，不留半新半旧的句子
    const rawSlices = await db.getAll<SliceRow>(STORE.slices);
    const deletedOld = rawSlices.filter((row) => row.deletedAt && slicesBefore.some((s) => s.cid === row.cid));
    expect(deletedOld).toHaveLength(slicesBefore.length);
  });

  it("用户删了演示集：不再自动重建，换新也不打扰", async () => {
    const { vaultRoot, pluginDirName, demoDir } = makePluginDir();
    const mediaDir = makeMediaDir();
    const host = makeHost(vaultRoot, pluginDirName, mediaDir);
    expect(await ensureDemoMaterial(host, db)).toBe(true);

    const episodeCid = (await loadEpisodeList(db))[0].episode.cid;
    await removeEpisode(db, episodeCid);

    // 就算自带素材又更新了一版，删过的也不回来
    writeFileSync(join(demoDir, "demo.mp4"), Buffer.alloc(140 * 1024, 5));
    expect(await ensureDemoMaterial(host, db)).toBe(false);
    expect(await loadEpisodeList(db)).toHaveLength(0);
  });
});

/**
 * 内置包落盘恢复（2026-10-12，公开渠道只装三件套，demo/ 不跟过去）。
 *
 * 合成的「内置包」：128KB 的 data URL 视频 + 真 SRT 文本，分别对应
 * esbuild 的 dataurl / text loader 产物形态。
 */
describe("内置演示素材落盘恢复", () => {
  const fakeVideoUrl = `data:video/mp4;base64,${Buffer.alloc(128 * 1024, 7).toString("base64")}`;

  function emptyDemoDir(): string {
    const dir = join(mkdtempSync(join(tmpdir(), "yl-demo-")), "demo");
    return dir; // 故意不建：恢复要能自己建
  }

  it("缺文件：视频和字幕都从内置包落盘，大小过完整性门槛", () => {
    const dir = emptyDemoDir();

    expect(restoreBundledDemo(dir, fakeVideoUrl, SRT)).toBe(true);

    expect(statSync(join(dir, DEMO_VIDEO_FILE)).size).toBe(128 * 1024);
    expect(readFileSync(join(dir, DEMO_VIDEO_FILE))).toEqual(Buffer.alloc(128 * 1024, 7));
    expect(readFileSync(join(dir, "demo.srt"), "utf8")).toBe(SRT);
  });

  it("文件已在：不覆盖（用户改过 demo/ 里的文件也保持原样）", () => {
    const dir = emptyDemoDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DEMO_VIDEO_FILE), Buffer.alloc(128 * 1024, 3));
    writeFileSync(join(dir, "demo.srt"), "用户自己改过的字幕", "utf8");

    expect(restoreBundledDemo(dir, fakeVideoUrl, SRT)).toBe(false);
    expect(readFileSync(join(dir, DEMO_VIDEO_FILE))).toEqual(Buffer.alloc(128 * 1024, 3));
    expect(readFileSync(join(dir, "demo.srt"), "utf8")).toBe("用户自己改过的字幕");
  });

  it("只缺一样：只补缺的那份", () => {
    const dir = emptyDemoDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DEMO_VIDEO_FILE), Buffer.alloc(128 * 1024, 7));

    expect(restoreBundledDemo(dir, fakeVideoUrl, SRT)).toBe(true);
    expect(readFileSync(join(dir, DEMO_VIDEO_FILE))).toEqual(Buffer.alloc(128 * 1024, 7));
    expect(readFileSync(join(dir, "demo.srt"), "utf8")).toBe(SRT);
  });

  it("没走 esbuild 构建（测试环境 import 到的是 URL）：整体跳过，不写垃圾", () => {
    const dir = emptyDemoDir();

    expect(restoreBundledDemo(dir, "/demo/demo.mp4", "/demo/demo.srt")).toBe(false);
    expect(existsSync(join(dir, DEMO_VIDEO_FILE))).toBe(false);
    expect(existsSync(join(dir, "demo.srt"))).toBe(false);
  });
});
