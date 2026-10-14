import "fake-indexeddb/auto";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { VaultDb, STORE } from "../src/storage/db";
import { importSubtitle } from "../src/services/importer";
import type { SubtitleImportRequest } from "../src/services/importer";
import type { AssetRow, RecordLineRow, RecordRow, SentenceRow } from "../src/types/entities";

/**
 * 导入链路的整体测试。
 *
 * 用假 IndexedDB + 内存版笔记后端，这样不用起 Electron 也能覆盖：
 * 文件哈希身份、行落库、重导/并列新记录的决策树、素材库收纳、
 * 以及句子层跨记录共享（进度/纠错零匹配逻辑跟着句子哈希走）。
 *
 * 身份模型（2026-10-14 重构定稿）：
 *  · 学习记录的键 = (视频 sha256, 日文字幕 sha256) 的组合哈希 —— 同一对文件
 *    重导 = 同一条记录（复活/补绑）；任何一份换了都是**另一条记录**，不拦不猜；
 *  · 句子 = 三句哈希寻址的共享层，跨记录复用，重导零覆盖；
 *  · 台词行（原文/时间轴）是记录自己的本地层，重导整段重写。
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

// 另一份内容不同的字幕（哈希不同）：用来模拟"另一个视频恰好取了同一个名字"。
const otherSubPath = join(dir, "[Group] Another [01][BDRip].JPSC.ass");
writeFileSync(otherSubPath, ASS.replace("これはテストです", "これはべつのテストです"), "utf8");

// 256KB 的假视频。视频和字幕配套必填，所以几乎每个成功用例都要带上它。
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

  it("落库：记录 / 素材 / 句子 / 台词 四张表", async () => {
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

    const records = await db.getAll<RecordRow>(STORE.records);
    const assets = await db.getAll<AssetRow>(STORE.assets);
    const sentences = await db.getAll<SentenceRow>(STORE.sentences);
    const lines = await db.getAll<RecordLineRow>(STORE.lines);

    expect(records).toHaveLength(1);
    // 字幕 + 视频，配套各一条
    expect(assets).toHaveLength(2);
    expect(sentences).toHaveLength(2);
    expect(lines).toHaveLength(2);

    expect(records[0].number).toBe("1");
    expect(records[0].durationMs).toBe(6000); // 最后一条台词的终点（卡拉OK行不算）
    expect(sentences.map((row) => row.ja).sort()).toEqual(["これはテストです", "大丈夫"]);
    expect(lines.every((row) => row.recordCid === records[0].cid)).toBe(true);
  });

  it("同一份文件导入两次不产生重复行、recordCid 保持不变（reimported）", async () => {
    const request = { subtitlePath: subPath, videoPath, workTitle: "MyGO", number: 1 };
    const first = await importSubtitle(db, request);
    const second = await importSubtitle(db, request);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.result.recordCid).toBe(first.result.recordCid);
    expect(second.result.reimported).toBe(true);
    expect(await db.count(STORE.records)).toBe(1);
    expect(await db.count(STORE.sentences)).toBe(2);
    expect(await db.count(STORE.lines)).toBe(2);
  });

  /**
   * ⚠️ 这里刻意**没有**"导入写了哪份笔记"的用例，因为导入不写 vault：
   * 导入是"把视频和字幕对上号"，笔记是"学完一句记一句"（见 tests/studyNote.test.ts）。
   * 导入时往 vault 丢笔记，用户会在笔记列表里看到一堆自己还没学过的台词。
   * 这条边界现在由签名守着（`importSubtitle(db, request)` 收不到任何写文件的出口）。
   */
});

describe("同名记录的决策树", () => {
  let db: VaultDb;
  const base = { subtitlePath: subPath, videoPath };

  beforeEach(async () => {
    db = await freshDb();
  });

  it("同一份素材重来一次 = 重导，只有一条记录", async () => {
    const request = { ...base, workTitle: "MyGO", year: 2023, season: 1, number: 1 };
    expect((await importSubtitle(db, request)).ok).toBe(true);
    expect((await importSubtitle(db, request)).ok).toBe(true);
    expect(await db.count(STORE.records)).toBe(1);
  });

  it("🔥 同名同季集、换了素材 → 放行为**并列新记录**，标题自动缀视频文件名", async () => {
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
      videoPath: join(dir, "another-video.mkv") && videoPath, // 同视频、换字幕也是另一条
      workTitle: "MyGO",
      year: 2023,
      season: 1,
      number: 1,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result.recordCid).not.toBe(
      first.ok ? first.result.recordCid : "",
    );
    expect(second.result.titleSuffixed).toBe(true);
    const records = await db.getAll<RecordRow>(STORE.records);
    expect(records).toHaveLength(2);
    // 缀的是视频文件名（去掉扩展名），展示上一眼能分清
    expect(records.map((row) => row.title)).toContain("MyGO");
    expect(records.some((row) => row.title.startsWith("MyGO（"))).toBe(true);
  });

  it("同一对文件改集号重导 → 还是同一条记录（展示字段以这次为准）", async () => {
    expect((await importSubtitle(db, { ...base, workTitle: "MyGO", number: 1 })).ok).toBe(true);
    expect((await importSubtitle(db, { ...base, workTitle: "MyGO", number: 2 })).ok).toBe(true);
    // 身份 = 文件哈希对：同一对文件不管填什么集号都是同一条记录
    expect(await db.count(STORE.records)).toBe(1);
    const record = (await db.getAll<RecordRow>(STORE.records))[0];
    expect(record.number).toBe("2");
  });

  it("同一对文件改季号重导 → 同一条记录", async () => {
    expect(
      (await importSubtitle(db, { ...base, workTitle: "MyGO", season: 1, number: 1 })).ok,
    ).toBe(true);
    expect(
      (await importSubtitle(db, { ...base, workTitle: "MyGO", season: 2, number: 1 })).ok,
    ).toBe(true);
    expect(await db.count(STORE.records)).toBe(1);
    const record = (await db.getAll<RecordRow>(STORE.records))[0];
    expect(record.season).toBe(2);
  });

  it("同名同集换素材 → 放行（新文件对 = 新记录，不再有 rebind 猜测）", async () => {
    // 第一次导入
    expect((await importSubtitle(db, { ...base, workTitle: "某场讲座", number: "" })).ok).toBe(true);
    // 同一份文件再来一次 = 重导，还是一条
    expect((await importSubtitle(db, { ...base, workTitle: "某场讲座", number: "" })).ok).toBe(true);

    // 同名 + 换了另一份字幕 / 另一个视频文件（哈希全不同）→ 并列新记录
    const otherVideoPath = join(dir, "[Group] Another [01][BDRip].mkv");
    writeFileSync(otherVideoPath, Buffer.alloc(256 * 1024, 9));
    const outcome = await importSubtitle(db, {
      subtitlePath: otherSubPath,
      videoPath: otherVideoPath,
      workTitle: "某场讲座",
      number: "",
    });
    expect(outcome.ok).toBe(true);
    expect(await db.count(STORE.records)).toBe(2);

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
    expect(await db.count(STORE.records)).toBe(3);
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
    expect(await db.count(STORE.records)).toBe(0);
  });
});

describe("视频文件（与字幕配套必填）", () => {
  let db: VaultDb;

  beforeEach(async () => {
    db = await freshDb();
  });

  it("视频作为第二个素材落库，按文件 sha256 寻址", async () => {
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
    expect(video?.sizeBytes).toBe(256 * 1024);
    // 视频素材的键 = A: + 文件 sha256；记录行引用的就是这个哈希
    expect(video?.cid).toBe(`A:${video?.sha256}`);
    expect(video?.sha256).toBe(
      (await db.get<RecordRow>(STORE.records, outcome.result.recordCid))?.videoSha256,
    );

    // 1 record + 2 assets + 2 sentences + 2 lines
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
    expect(await db.count(STORE.sentences)).toBe(0);
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
    expect(await db.count(STORE.sentences)).toBe(0);
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

  it("两份文件导入：中文按时间轴配进台词行，三份素材都登记", async () => {
    const outcome = await importSubtitle(db, {
      subtitlePath: subPath,
      translationPath: zhSrtPath,
      videoPath,
      workTitle: "MyGO",
      number: 1,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const lines = await db.getAll<RecordLineRow>(STORE.lines);
    expect(lines).toHaveLength(2);
    const byJa = new Map(lines.map((line) => [line.ja, line.zh]));
    expect(byJa.get("これはテストです")).toBe("这是测试");
    expect(byJa.get("大丈夫")).toBe("没关系");

    // 日文字幕 + 中文字幕 + 视频
    const assets = await db.getAll<AssetRow>(STORE.assets);
    expect(assets).toHaveLength(3);
    expect(assets.find((asset) => asset.localPath === subPath)?.language).toBe("ja");
    expect(assets.find((asset) => asset.localPath === zhSrtPath)?.language).toBe("zh");
    expect(assets.find((asset) => asset.kind === "video")).toBeDefined();

    // 记录行记下了中文翻译字幕的哈希（换中文翻译不产生新记录）
    const record = await db.get<RecordRow>(STORE.records, outcome.result.recordCid);
    expect(record?.zhSubSha256).toBeTruthy();
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

    const lines = await db.getAll<RecordLineRow>(STORE.lines);
    const byJa = new Map(lines.map((line) => [line.ja, line.zh]));
    expect(byJa.get("これはテストです")).toBe("这是测试");
    // 身份稳定：不管用户怎么填顺序，日文文件不变，三句哈希就不变
    const sentences = await db.getAll<SentenceRow>(STORE.sentences);
    expect(sentences.some((row) => row.ja === "これはテストです")).toBe(true);
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
    expect(await db.count(STORE.sentences)).toBe(0);
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
    expect(await db.count(STORE.sentences)).toBe(2);
  });
});

describe("换字幕重导：并列新记录，句子层跨记录共享（2026-10-14 模型）", () => {
  let db: VaultDb;
  const base = { subtitlePath: subPath, videoPath };

  beforeEach(async () => {
    db = await freshDb();
  });

  // 同一个视频、字幕只差一个字的表记 —— 日文字幕哈希不同 → 另一条记录；
  // 但三句哈希相同的句子（「大丈夫」）共享同一个句子层。
  const v2Dir = mkdtempSync(join(tmpdir(), "yl-resub-"));
  const v2SubPath = join(v2Dir, "[Group] Title [01][BDRip].JPSC.ass");
  writeFileSync(v2SubPath, ASS.replace("これはテストです", "これはテストですね"), "utf8");

  it("换字幕 = 新记录；学过的进度和纠错留在句子上，一条不丢", async () => {
    const first = await importSubtitle(db, {
      ...base, workTitle: "MyGO", year: 2023, season: 1, number: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.result.reimported).toBe(false);

    // 学了第一句（抄写完成）+ 给「大丈夫」那句留一条用户纠错
    const linesV1 = (await db.getAll<RecordLineRow>(STORE.lines)).sort((a, b) => a.index - b.index);
    expect(linesV1).toHaveLength(2);
    const firstSentence = await db.get<SentenceRow>(STORE.sentences, linesV1[0].sentenceCid);
    const secondSentence = await db.get<SentenceRow>(STORE.sentences, linesV1[1].sentenceCid);
    await db.put(STORE.progress, {
      cid: `P:${linesV1[0].sentenceCid}`, sliceCid: linesV1[0].sentenceCid,
      copyAttempts: 3, copyDoneAt: "2026-10-06T12:00:00.000Z", copyEpoch: 1, copyText: "写了",
      readAloudAt: null, readAloudSeconds: 0, readEpoch: 0,
      imitationText: "", imitationCorrect: null,
      clientUpdatedAt: "2026-10-06T12:00:00.000Z", deletedAt: null,
    } as never);
    await db.put(STORE.sentences, {
      ...secondSentence!,
      textFixes: { ja: "大丈夫だよ" },
      correctionsUpdatedAt: "2026-10-06T13:00:00.000Z",
    });

    // 换字幕重导：同一个视频 + 另一份日文字幕 = 另一条记录
    const second = await importSubtitle(db, {
      ...base, subtitlePath: v2SubPath, workTitle: "MyGO", year: 2023, season: 1, number: 1,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result.reimported).toBe(false);
    expect(second.result.recordCid).not.toBe(first.result.recordCid);

    // 🔒 句子层是共享的：改过的「大丈夫」纠错原样保留，重导不抹不掉
    const keptSentence = await db.get<SentenceRow>(STORE.sentences, linesV1[1].sentenceCid);
    expect(keptSentence?.textFixes?.ja).toBe("大丈夫だよ");
    expect(keptSentence?.correctionsUpdatedAt).toBe("2026-10-06T13:00:00.000Z");

    // 进度还挂在原来的句子哈希上，一个字节都没动（没有墓碑、没有迁移）
    const progress = await db.get<{ sliceCid: string; copyAttempts: number; deletedAt: string | null }>(
      STORE.progress, `P:${linesV1[0].sentenceCid}`,
    );
    expect(progress?.sliceCid).toBe(linesV1[0].sentenceCid);
    expect(progress?.copyAttempts).toBe(3);
    expect(progress?.deletedAt).toBeNull();

    // 新记录的台词指向新的句子（「これはテストですね」是新的三句哈希）；
    // 「大丈夫」那句新旧记录共享同一个句子行
    const linesV2 = (
      await db.getAll<RecordLineRow>(STORE.lines)
    ).filter((row) => row.recordCid === second.result.recordCid).sort((a, b) => a.index - b.index);
    expect(linesV2).toHaveLength(2);
    // 三句哈希带上下文：第 1 句改了一个字，第 2 句的 prev 也跟着变 →
    // 两句都是新 cid（只有完整三句窗口相同的句子才共享）
    expect(linesV2[0].sentenceCid).not.toBe(linesV1[0].sentenceCid);
    expect(linesV2[1].sentenceCid).not.toBe(linesV1[1].sentenceCid);

    // 旧句子一个不删：旧记录的台词行还指着它们，切回旧字幕照样能学。
    // 三句哈希带上下文 —— 第 1 句改了字，第 2 句的 prev 也变，所以是 4 个句子行
    expect(await db.count(STORE.sentences)).toBe(4);
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

    const sentences = await db.getAll<SentenceRow>(STORE.sentences);
    // 旧的两个句子原样保留（「大丈夫」独有句不删）；新版把「大丈夫」删了，
    // 第 1 句的 next 也变了 → 三句哈希不同，多出一个新句子变体，共 3 个句子行
    expect(sentences).toHaveLength(3);
    expect(sentences.some((row) => row.ja === "大丈夫")).toBe(true);
    // 同一句原文的两个变体各归各的句子行（三句哈希不同，互不覆盖）
    expect(sentences.filter((row) => row.ja === "これはテストです").length).toBe(2);
    // 并列出了第二条记录
    expect(await db.count(STORE.records)).toBe(2);
  });

  it("慢阶段挂进度回调：先算文件指纹、再收素材库（UI 靠它显示「正在干什么」）", async () => {
    const phases: string[] = [];
    const outcome = await importSubtitle(db, {
      subtitlePath: subPath,
      videoPath,
      workTitle: "BanG Dream! It's MyGO!!!!!",
      number: 1,
      mediaDir: join(dir, "media-progress"),
      onProgress: (phase) => phases.push(phase),
    });

    expect(outcome.ok).toBe(true);
    // 顺序钉死：哈希（身份判定）必然先于素材入库；不带 mediaDir 时只有 hash
    expect(phases).toEqual(["hash", "save"]);
  });
});
