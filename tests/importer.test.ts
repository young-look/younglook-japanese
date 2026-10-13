import "fake-indexeddb/auto";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { VaultDb, STORE } from "../src/storage/db";
import { importSubtitle } from "../src/services/importer";
import type { SubtitleImportRequest } from "../src/services/importer";
import type { AssetRow, EpisodeRow, SliceRow, WorkRow } from "../src/types/entities";

/**
 * 导入链路的整体测试。
 *
 * 用假 IndexedDB + 内存版笔记后端，这样不用起 Electron 也能覆盖：
 * 身份派生、行落库、待办登记、笔记围栏、重复导入、以及与用户手写内容的共存。
 */

const ASS = [
  "[Script Info]",
  "ScriptType: v4.00+",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:01.00,0:00:03.00,DefaultJP,,0,0,0,,これはテストです",
  "Dialogue: 0,0:00:04.00,0:00:06.00,DefaultJP,,0,0,0,,大丈夫",
  "Dialogue: 0,0:00:07.00,0:00:09.00,OP_JP,,0,0,0,,歌詞の一行",
  "",
].join("\n");

const dir = mkdtempSync(join(tmpdir(), "yl-import-"));
const subPath = join(dir, "[Group] Title [01][BDRip].JPSC.ass");
writeFileSync(subPath, ASS, "utf8");

// 另一份内容不同的字幕（指纹不同）：用来模拟"另一个视频恰好取了同一个名字"。
const otherSubPath = join(dir, "[Group] Another [01][BDRip].JPSC.ass");
writeFileSync(otherSubPath, ASS.replace("これはテストです", "これはべつのテストです"), "utf8");

// 256KB 的假视频，足够首尾各 64KB 的采样指纹。视频和字幕配套必填，
// 所以几乎每个成功用例都要带上它。
const videoPath = join(dir, "[Group] Title [01][BDRip].mkv");
writeFileSync(videoPath, Buffer.alloc(256 * 1024, 7));

async function freshDb(): Promise<VaultDb> {
  return VaultDb.open(Math.random().toString(36).slice(2, 10));
}

describe("导入字幕", () => {
  let db: VaultDb;

  beforeEach(async () => {
    db = await freshDb();
  });

  it("落库：作品 / 集 / 素材 / 切片四张表", async () => {
    const outcome = await importSubtitle(db, {
      subtitlePath: subPath,
      videoPath,
      workTitle: "BanG Dream! It's MyGO!!!!!",
      year: 2023,
      number: 1,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // 卡拉OK那行要被排除，所以是 2 句不是 3 句
    expect(outcome.result.sliceCount).toBe(2);

    const works = await db.getAll<WorkRow>(STORE.works);
    const episodes = await db.getAll<EpisodeRow>(STORE.episodes);
    const assets = await db.getAll<AssetRow>(STORE.assets);
    const slices = await db.getAll<SliceRow>(STORE.slices);

    expect(works).toHaveLength(1);
    expect(episodes).toHaveLength(1);
    // 字幕 + 视频，配套各一条
    expect(assets).toHaveLength(2);
    expect(slices).toHaveLength(2);

    expect(episodes[0].number).toBe("1");
    expect(assets[0].localPath).toBe(subPath);
    expect(slices.map((slice) => slice.ja).sort()).toEqual(["これはテストです", "大丈夫"]);
  });

  it("每一次改动都登记了待上行（否则崩溃就丢同步）", async () => {
    await importSubtitle(db, {
      subtitlePath: subPath,
      videoPath,
      workTitle: "MyGO",
      number: 1,
    });
  });

  it("同一份文件导入两次不产生重复行、 cid 保持不变", async () => {
    const request = { subtitlePath: subPath, videoPath, workTitle: "MyGO", number: 1 };
    const first = await importSubtitle(db, request);
    const second = await importSubtitle(db, request);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.result.workCid).toBe(first.result.workCid);
    expect(second.result.episodeCid).toBe(first.result.episodeCid);
    expect(second.result.assetCid).toBe(first.result.assetCid);
    expect(await db.count(STORE.works)).toBe(1);
    expect(await db.count(STORE.slices)).toBe(2);
  });

  /**
   * ⚠️ 这里刻意**没有**"导入写了哪份笔记"的用例，因为导入不写 vault：
   * 导入是"把视频和字幕对上号"，笔记是"学完一句记一句"（见 tests/studyNote.test.ts）。
   * 导入时往 vault 丢笔记，用户会在笔记列表里看到一堆自己还没学过的台词。
   * 这条边界现在由签名守着（`importSubtitle(db, request)` 收不到任何写文件的出口）。
   */
});

describe("一个名字只能有一份笔记", () => {
  let db: VaultDb;
  const base = { subtitlePath: subPath, videoPath };

  beforeEach(async () => {
    db = await freshDb();
  });

  it("同一份素材重来一次 = 重导，放行", async () => {
    const request = { ...base, workTitle: "MyGO", year: 2023, season: 1, number: 1 };
    expect((await importSubtitle(db, request)).ok).toBe(true);
    expect((await importSubtitle(db, request)).ok).toBe(true);
    expect(await db.count(STORE.works)).toBe(1);
  });

  it("同名同季集、换了素材 → 拦下来（笔记文件名会撞在一起）", async () => {
    const first = await importSubtitle(db, {
      ...base,
      workTitle: "MyGO",
      year: 2023,
      season: 1,
      number: 1,
    });
    expect(first.ok).toBe(true);

    const second = await importSubtitle(db, {
      ...base,
      subtitlePath: otherSubPath,
      workTitle: "MyGO",
      year: 2024,
      season: 1,
      number: 1,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toContain("笔记");
    expect(second.hint).toContain("季号");
    // 被拦下的时候什么都不许写
    expect(await db.count(STORE.works)).toBe(1);
  });

  it("同名但集号不同 → 各是各的笔记，照常导入", async () => {
    expect((await importSubtitle(db, { ...base, workTitle: "MyGO", number: 1 })).ok).toBe(true);
    expect((await importSubtitle(db, { ...base, workTitle: "MyGO", number: 2 })).ok).toBe(true);
    expect(await db.count(STORE.episodes)).toBe(2);
  });

  it("季号不同就是不同的笔记", async () => {
    expect(
      (await importSubtitle(db, { ...base, workTitle: "MyGO", season: 1, number: 1 })).ok,
    ).toBe(true);
    expect(
      (await importSubtitle(db, { ...base, workTitle: "MyGO", season: 2, number: 1 })).ok,
    ).toBe(true);
  });

  it("同名同集（episodeCid 相同）换素材 → 放行（换机/换字幕重导，学习记录靠 rebind 挂回）", async () => {
    // 第一次导入
    expect((await importSubtitle(db, { ...base, workTitle: "某场讲座", number: "" })).ok).toBe(true);
    // 同一份字幕再来一次 = 重导同一个视频，放行
    expect((await importSubtitle(db, { ...base, workTitle: "某场讲座", number: "" })).ok).toBe(true);

    // 同名 + 换了另一份字幕 / 另一个视频文件（指纹全不同）。
    // 2026-10-09 起**放行** —— episodeCid 由「名字 + 年份 + 季/集号」派生，相同即
    // 数据层面的同一集（这正是"换机后重导同一集"的形状：视频、字幕都可能是新版本）。
    // 学习记录由 sliceRebind 按日文相似度挂回，而非靠素材指纹放行。
    // 靠素材指纹拦的是「不同集恰好共用同一 stem」—— 那种情况下 episodeCid 不同，见上一条用例。
    const otherVideoPath = join(dir, "[Group] Another [01][BDRip].mkv");
    writeFileSync(otherVideoPath, Buffer.alloc(256 * 1024, 9));
    expect(
      (
        await importSubtitle(db, {
          subtitlePath: otherSubPath,
          videoPath: otherVideoPath,
          workTitle: "某场讲座",
          number: "",
        })
      ).ok,
    ).toBe(true);

    // 换个名字 = 另一部作品，照常导入
    expect(
      (
        await importSubtitle(db, {
          subtitlePath: otherSubPath,
          videoPath,
          workTitle: "另一场讲座",
          number: "",
        })
      ).ok,
    ).toBe(true);
  });
});

describe("导入失败时给的是人话", () => {
  let db: VaultDb;

  beforeEach(async () => {
    db = await freshDb();
  });

  it("文件不存在", async () => {
    const outcome = await importSubtitle(db, {
      subtitlePath: join(dir, "不存在.ass"), videoPath, workTitle: "MyGO", number: 1,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("找不到");
  });

  it("格式不认", async () => {
    const txtPath = join(dir, "notes.txt");
    writeFileSync(txtPath, "ただのメモ", "utf8");
    const outcome = await importSubtitle(db, {
      subtitlePath: txtPath, videoPath, workTitle: "MyGO", number: 1,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.hint).toContain(".ass");
  });

  it("没有时间轴的歌词被挡住", async () => {
    const lrcPath = join(dir, "plain.lrc");
    writeFileSync(lrcPath, "[ti:歌名]\nこれは歌詞ですが時間がありません\n", "utf8");
    const outcome = await importSubtitle(db, {
      subtitlePath: lrcPath, videoPath, workTitle: "MyGO", number: 1,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("时间轴");
  });

  it("失败时不写任何东西", async () => {
    const outcome = await importSubtitle(db, {
      subtitlePath: join(dir, "不存在.ass"), videoPath, workTitle: "MyGO", number: 1,
    });
    expect(outcome.ok).toBe(false);
    expect(await db.count(STORE.works)).toBe(0);
  });
});

describe("视频文件（与字幕配套必填）", () => {
  let db: VaultDb;

  beforeEach(async () => {
    db = await freshDb();
  });

  it("视频作为第二个素材挂到同一集，只记路径与指纹", async () => {
    const outcome = await importSubtitle(db, {
      subtitlePath: subPath,
      videoPath,
      workTitle: "MyGO",
      number: 1,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const assets = await db.getAll<AssetRow>(STORE.assets);
    expect(assets).toHaveLength(2);

    const video = assets.find((asset) => asset.kind === "video");
    expect(video).toBeDefined();
    expect(video?.localPath).toBe(videoPath);
    expect(video?.episodeCid).toBe(outcome.result.episodeCid);
    expect(video?.sizeBytes).toBe(256 * 1024);
    expect(video?.fingerprint).toBeTruthy();

    // 1 work + 1 episode + 2 assets + 2 slices
  });

  it("不填视频直接拒绝 —— 字幕和视频必须配套", async () => {
    // 类型上 videoPath 必填，这里故意不给 —— 测的就是运行时这道闸。
    const request = {
      subtitlePath: subPath, workTitle: "MyGO", number: 1,
    } as SubtitleImportRequest;
    const outcome = await importSubtitle(db, request);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("配套");
    // 什么都不许写：字幕进去了、视频没挂上，比导入失败更糟
    expect(await db.count(STORE.slices)).toBe(0);
    expect(await db.count(STORE.assets)).toBe(0);
  });

  it("视频路径填错时报人话错误，什么都不写", async () => {
    const outcome = await importSubtitle(db, {
      subtitlePath: subPath,
      videoPath: join(dir, "不存在.mkv"),
      workTitle: "MyGO",
      number: 1,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("视频");
    expect(await db.count(STORE.slices)).toBe(0);
  });

  it("同一个视频挂两次，身份一致不重复", async () => {
    const request = {
      subtitlePath: subPath, videoPath, workTitle: "MyGO", number: 2,
    };
    const first = await importSubtitle(db, request);
    const second = await importSubtitle(db, request);
    expect(first.ok && second.ok).toBe(true);
    // 字幕 + 视频各一行，第二次导入没有多出行
    expect(await db.count(STORE.assets)).toBe(2);
  });
});

describe("双字幕文件（日语一份、中文一份，同一个视频）", () => {
  let db: VaultDb;

  // 中文 srt，时间轴和上面的 ASS 对齐（1-3s、4-6s）
  const zhSrtPath = join(dir, "[Group] Title [01].zh.srt");
  writeFileSync(
    zhSrtPath,
    ["1", "00:00:01,000 --> 00:00:03,000", "这是测试", "", "2", "00:00:04,000 --> 00:00:06,000", "没关系", ""].join("\n"),
    "utf8",
  );
  // 另一份日文（同语言，用来验证拒绝）
  const ja2Path = join(dir, "[Group] Title [01].JP2.ass");
  writeFileSync(ja2Path, ASS, "utf8");
  // 纯中文字幕（没有日文，单份导入要被拒）
  const zhOnlyPath = join(dir, "[Group] Title [01].zhOnly.srt");
  writeFileSync(
    zhOnlyPath,
    ["1", "00:00:01,000 --> 00:00:03,000", "只有中文", "", "2", "00:00:04,000 --> 00:00:06,000", "没有日文", ""].join("\n"),
    "utf8",
  );

  beforeEach(async () => {
    db = await freshDb();
  });

  it("两份文件导入：中文按时间轴配进切片，三份素材都登记", async () => {
    const outcome = await importSubtitle(db, {
      subtitlePath: subPath,
      translationPath: zhSrtPath,
      videoPath,
      workTitle: "MyGO",
      number: 1,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const slices = await db.getAll<SliceRow>(STORE.slices);
    expect(slices).toHaveLength(2);
    const byJa = new Map(slices.map((slice) => [slice.ja, slice.zh]));
    expect(byJa.get("これはテストです")).toBe("这是测试");
    expect(byJa.get("大丈夫")).toBe("没关系");

    // 日文字幕 + 中文字幕 + 视频
    const assets = await db.getAll<AssetRow>(STORE.assets);
    expect(assets).toHaveLength(3);
    expect(assets.find((asset) => asset.localPath === subPath)?.language).toBe("ja");
    expect(assets.find((asset) => asset.localPath === zhSrtPath)?.language).toBe("zh");
    expect(assets.find((asset) => asset.kind === "video")).toBeDefined();

    // 1 work + 1 episode + 3 assets + 2 slices

    // 切片身份挂在日文字幕上 —— 和单文件导入时一致
    expect(outcome.result.assetCid).toBeTruthy();
  });

  it("填反了也能导：第一份中文、第二份日文，自动认出来", async () => {
    const outcome = await importSubtitle(db, {
      subtitlePath: zhSrtPath,
      translationPath: subPath,
      videoPath,
      workTitle: "MyGO",
      number: 1,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const slices = await db.getAll<SliceRow>(STORE.slices);
    const byJa = new Map(slices.map((slice) => [slice.ja, slice.zh]));
    expect(byJa.get("これはテストです")).toBe("这是测试");
    // 身份稳定：不管用户怎么填顺序，日文文件不变，切片身份就不变
    expect(slices.every((slice) => slice.assetCid === outcome.result.assetCid)).toBe(true);
  });

  it("两份都是日文 → 拒绝", async () => {
    const outcome = await importSubtitle(db, {
      subtitlePath: subPath,
      translationPath: ja2Path,
      videoPath,
      workTitle: "MyGO",
      number: 1,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("同一种语言");
    expect(await db.count(STORE.slices)).toBe(0);
  });

  it("只有一份纯中文字幕 → 拒绝并提示怎么补", async () => {
    const outcome = await importSubtitle(db, {
      subtitlePath: zhOnlyPath, videoPath, workTitle: "MyGO", number: 1,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("没有日文");
    expect(outcome.hint).toContain("添加字幕文件");
  });

  it("第二份字幕路径填错 → 报人话错误，什么都不写", async () => {
    const outcome = await importSubtitle(db, {
      subtitlePath: subPath,
      translationPath: join(dir, "不存在.srt"),
      videoPath,
      workTitle: "MyGO",
      number: 1,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("第二份字幕");
  });
});

/**
 * 素材收进素材库。
 *
 * 2026-10-01 起导入会把视频和字幕复制一份到素材库（vault 外），以前只记用户
 * 原路径，他一整理文件夹这一集就播不出来了。这几条盯着的是：真的复制了、
 * 原件没被动、重复导入不会占两份空间、以及**失败不许拦住学习**。
 */
describe("素材收进素材库", () => {
  let db: VaultDb;
  const mediaRoot = mkdtempSync(join(tmpdir(), "yl-media-"));

  beforeEach(async () => {
    db = await freshDb();
  });

  it("给了素材库目录 → 视频和字幕复制进去，按库里的位置播", async () => {
    const outcome = await importSubtitle(db, {
      subtitlePath: subPath,
      videoPath,
      workTitle: "MyGO",
      number: 1,
      mediaDir: mediaRoot,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const assets = await db.getAll<AssetRow>(STORE.assets);
    expect(assets).toHaveLength(2);
    for (const asset of assets) {
      expect(asset.localPath.startsWith(mediaRoot)).toBe(true);
      expect(existsSync(asset.localPath)).toBe(true);
      // filename 要跟着换到新位置，别留着旧名字误导人
      expect(asset.filename).toBe(basename(asset.localPath));
    }
    // 用户原来那份必须还在：是复制，不是搬家
    expect(existsSync(subPath)).toBe(true);
    expect(existsSync(videoPath)).toBe(true);
    expect(outcome.result.mediaNote).toBeUndefined();
  });

  it("同一份素材重导 → 复用库里那份，不占第二份空间", async () => {
    const request = {
      subtitlePath: subPath, videoPath, workTitle: "重导测试", number: 1, mediaDir: mediaRoot,
    };
    const first = await importSubtitle(db, request);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const before = readdirSync(join(mediaRoot, "重导测试")).sort();

    const second = await importSubtitle(db, request);
    expect(second.ok).toBe(true);
    expect(readdirSync(join(mediaRoot, "重导测试")).sort()).toEqual(before);
    expect(await db.count(STORE.assets)).toBe(2);
  });

  it("选的本来就是库里的文件 → 原地复用，不再复制", async () => {
    const outcome = await importSubtitle(db, {
      subtitlePath: subPath, videoPath, workTitle: "已在库中", number: 1, mediaDir: mediaRoot,
    });
    expect(outcome.ok).toBe(true);
    const assets = await db.getAll<AssetRow>(STORE.assets);
    const video = assets.find((asset) => asset.kind === "video");
    const subtitle = assets.find((asset) => asset.kind === "subtitle");
    expect(video?.localPath && subtitle?.localPath).toBeTruthy();

    const again = await importSubtitle(db, {
      subtitlePath: subtitle!.localPath,
      videoPath: video!.localPath,
      workTitle: "已在库中",
      number: 1,
      mediaDir: mediaRoot,
    });
    expect(again.ok).toBe(true);
    // 目录里还是那两个文件，没有复制出副本
    expect(readdirSync(join(mediaRoot, "已在库中")).sort()).toEqual(
      [basename(subtitle!.localPath), basename(video!.localPath)].sort(),
    );
  });

  it("作品名里的斜杠换掉 —— 不许写出刺穿目录的路径", async () => {
    const outcome = await importSubtitle(db, {
      subtitlePath: subPath, videoPath, workTitle: "A/B", number: 1, mediaDir: mediaRoot,
    });
    expect(outcome.ok).toBe(true);
    expect(existsSync(join(mediaRoot, "A_B"))).toBe(true);
  });

  it("素材库目录建不出来 → 退回原路径，导入照样成立", async () => {
    // 拿一个真实存在的文件当目录用：建目录这一步必然失败
    const blocked = join(dir, "blocked.txt");
    writeFileSync(blocked, "占位", "utf8");

    const outcome = await importSubtitle(db, {
      subtitlePath: subPath, videoPath, workTitle: "写不进去", number: 1, mediaDir: blocked,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.mediaNote).toBeTruthy();

    const video = (await db.getAll<AssetRow>(STORE.assets)).find((asset) => asset.kind === "video");
    expect(video?.localPath).toBe(videoPath);
    // 该学的一样能学：句子一条不少
    expect(await db.count(STORE.slices)).toBe(2);
  });
});

describe("换字幕重导：台词绑定（2026-10-07）", () => {
  let db: VaultDb;
  const base = { subtitlePath: subPath, videoPath };

  beforeEach(async () => {
    db = await freshDb();
  });

  // 同名同季集同年、内容只差一个字的表记 —— episodeCid 一模一样，
  // 指纹不同。以前这条会被 findNoteNameClash 拦下，现在放行并绑回。
  const v2Dir = mkdtempSync(join(tmpdir(), "yl-rebind-"));
  const v2SubPath = join(v2Dir, "[Group] Title [01][BDRip].JPSC.ass");
  writeFileSync(v2SubPath, ASS.replace("これはテストです", "これはテストですね"), "utf8");

  it("换了字幕版本照样导入，进度/纠错挂回新句子，旧句子清掉", async () => {
    const first = await importSubtitle(db, {
      ...base, workTitle: "MyGO", year: 2023, season: 1, number: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.result.reboundCount).toBe(0); // 全新导入，没有历史

    // 学了第一句（抄写完成）+ 给第二句留一条用户纠错
    const slicesV1 = (await db.getAll<SliceRow>(STORE.slices)).sort((a, b) => a.index - b.index);
    expect(slicesV1).toHaveLength(2);
    await db.put(STORE.progress, {
      cid: `P:${slicesV1[0].cid}`, sliceCid: slicesV1[0].cid,
      copyAttempts: 3, copyDoneAt: "2026-10-06T12:00:00.000Z", copyEpoch: 1, copyText: "写了",
      readAloudAt: null, readAloudSeconds: 0, readEpoch: 0,
      imitationText: "", imitationCorrect: null,
      clientUpdatedAt: "2026-10-06T12:00:00.000Z", deletedAt: null,
    } as never);
    await db.put(STORE.slices, {
      ...slicesV1[1],
      textFixes: { ja: "大丈夫だよ" },
      correctionsUpdatedAt: "2026-10-06T13:00:00.000Z",
    });

    // 换字幕重导
    const second = await importSubtitle(db, {
      ...base, subtitlePath: v2SubPath, workTitle: "MyGO", year: 2023, season: 1, number: 1,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // 第 1 句「これはテストです」→「これはテストですね」：相似但 cid 全变
    expect(second.result.reboundCount).toBeGreaterThan(0);

    const slicesV2 = (await db.getAll<SliceRow>(STORE.slices)).sort((a, b) => a.index - b.index);
    expect(slicesV2).toHaveLength(2);
    // 新句子是新的 cid（字幕指纹变了）
    expect(slicesV2[0].cid).not.toBe(slicesV1[0].cid);
    // 🔒 AI 解析 / 用户纠错不被重导抹掉
    expect(slicesV2[1].textFixes?.ja).toBe("大丈夫だよ");
    expect(slicesV2[1].correctionsUpdatedAt).toBe("2026-10-06T13:00:00.000Z");

    // 进度挂到了新句子上；旧键**打墓碑**（不硬删 —— 硬删会被云端原样拉回「复活」）
    const migrated = await db.get<{ sliceCid: string; copyAttempts: number }>(
      STORE.progress, `P:${slicesV2[0].cid}`,
    );
    expect(migrated?.sliceCid).toBe(slicesV2[0].cid);
    expect(migrated?.copyAttempts).toBe(3);
    const tombstone = await db.get<{ deletedAt?: string }>(STORE.progress, `P:${slicesV1[0].cid}`);
    expect(tombstone?.deletedAt).toBeTruthy();
  });

  it("旧字幕独有的句子保留（不删 —— 用户切回旧字幕还用得上）", async () => {
    const first = await importSubtitle(db, {
      ...base, workTitle: "K-On", year: 2009, season: 1, number: 1,
    });
    expect(first.ok).toBe(true);

    // 第二版把「大丈夫」那句删了（字幕组精简；删卡拉OK行没意义 —— 它本来就被排除）
    const shorterPath = join(v2Dir, "short.ass");
    writeFileSync(
      shorterPath,
      ASS.replace("Dialogue: 0,0:00:04.00,0:00:06.00,DefaultJP,,0,0,0,,大丈夫\n", ""),
      "utf8",
    );
    const second = await importSubtitle(db, {
      ...base, subtitlePath: shorterPath, workTitle: "K-On", year: 2009, season: 1, number: 1,
    });
    expect(second.ok).toBe(true);

    const slices = await db.getAll<SliceRow>(STORE.slices);
    // 新版 1 句（卡拉OK行本就被排除）+ 旧字幕独有的「大丈夫」还在
    expect(slices).toHaveLength(2);
    expect(slices.some((row) => row.ja === "大丈夫")).toBe(true);
  });
});
