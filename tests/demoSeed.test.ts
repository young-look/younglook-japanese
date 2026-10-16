import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEMO_WORK_TITLE } from "../src/services/demo";
import { defaultSettings } from "../src/settings/defaults";
import { collectInventory } from "../src/services/dataInventory";
import {
  DEMO_MANIFEST_PATH,
  installDemoPack,
  fetchDemoManifest,
  demoManifestBytes,
  type DemoFile,
  type DemoManifest,
} from "../src/services/demoPack";
import { resolveMediaDir, safeSegment } from "../src/services/mediaStore";
import { VaultDb, STORE } from "../src/storage/db";
import { assetShaCid } from "../src/core/ids";
import { loadRecordList, loadStudySentences } from "../src/services/study";
import type { AssetRow } from "../src/types/entities";

/**
 * 演示素材的**按需下载**（2026-10-13）。
 *
 * 演示包不再内联进 main.js —— 它托管在服务端 `/storage/media/videos/`，用户点首页那条
 * 「示例」时才下载。这组用例钉的是同词典下载一脉相承的**两条会静默出事的纪律**：
 *  · 清单里的文件名可不可信（`../` 或带路径分隔符的名字能写到暂存目录外）；
 *  · **失败时库里不能留下半条素材** —— 首页「示例」占位行的判据 = `loadRecordList` 为空
 *    （2026-10-16 起；原先那个 `demoSeeded` 标记已退役）。下载 / 校验 / 导入任一步没走完，
 *    库里就必须还是空的，占位行才留得住；反过来只要真导进来了，库里就有素材、占位行自然
 *    收起。所以下面每个失败用例都钉死"库还是 0 条"。判据本身见 `services/demo.ts` 头注释。
 */

const sha = (content: Buffer): string => createHash("sha256").update(content).digest("hex");

/** 字幕：真实风格的中日对照 SRT（两句）。 */
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

/** 读不出时间轴的字幕：导入会失败（用来验证"导入失败不落标记"）。 */
const SRT_BAD = "这不是带时间轴的字幕\n就是几行普通文字\n";

/** 造一份"演示视频"字节 —— 内容随意，导入只认它存在 + 采样指纹。 */
const VIDEO = Buffer.alloc(128 * 1024, 7);

function fileEntry(name: string, content: Buffer | string): DemoFile {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return { name, url: `https://x.cc/storage/media/videos/${name}`, sha256: sha(buf), bytes: buf.length };
}

function manifestOf(files: DemoFile[]): DemoManifest {
  return { version: "demo-1", files };
}

/** 假下载：按 url 末段给内容，可以指定某几个文件返回错误码。 */
function fakeFetch(bodies: Record<string, Buffer | string>, broken: Record<string, number> = {}) {
  return vi.fn(async (input: string) => {
    const name = decodeURIComponent(new URL(input).pathname.split("/").pop() ?? "");
    const status = broken[name];
    if (status) return new Response("nope", { status });
    const body = bodies[name];
    if (body === undefined) return new Response("", { status: 404 });
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    // 拷成独立 Uint8Array：`Buffer` 的 `ArrayBufferLike` 类型不满足 `BodyInit`
    return new Response(new Uint8Array(buf));
  });
}

const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** 一个新库 + 一个空素材库目录（本机空间的）+ 一个空暂存目录。 */
async function harness(): Promise<{ db: VaultDb; base: string; mediaDir: string; stagingDir: string }> {
  const db = await VaultDb.open(Math.random().toString(36).slice(2, 10));
  // 与生产调用方一致：演示素材和用户导入同一个落点 —— 本机空间的素材库 `<基准>/<空间 id>`
  const base = path.join(tempDir("yl-demo-media-"), "media");
  const mediaDir = resolveMediaDir(base, "sp-1");
  const stagingDir = path.join(tempDir("yl-demo-stage-"), "staging");
  fs.mkdirSync(mediaDir, { recursive: true });
  return { db, base, mediaDir, stagingDir };
}

async function liveVideoAsset(db: VaultDb, videoSha256: string): Promise<AssetRow> {
  const video = await db.get<AssetRow>(STORE.assets, assetShaCid(videoSha256));
  expect(video).toBeDefined();
  return video!;
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("下载后的演示包在「存储」页有体现", () => {
  it("🔥 点「开始学」下载 → 素材、台词、记录都进盘点（2026-10-14 用户拍板）", async () => {
    const { db, base, mediaDir, stagingDir } = await harness();
    const bodies = { "demo.mp4": VIDEO, "demo.srt": SRT };
    const manifest = manifestOf([fileEntry("demo.mp4", VIDEO), fileEntry("demo.srt", SRT)]);
    const result = await installDemoPack({
      db,
      mediaDir,
      manifest,
      stagingDir,
      fetchImpl: fakeFetch(bodies),
    });
    expect(result).toMatchObject({ ok: true });

    // 设置里填的是**基准目录**（app 侧那套：settings.mediaDir + activeSpaceId 一起决定落点）
    const inventory = await collectInventory({
      db,
      settings: Object.assign(defaultSettings(), {
        vaultFolder: "young_look",
        mediaDir: base,
        activeSpaceId: "sp-1",
      }),
      pluginId: "young-look",
    });

    const group = inventory.media.groups.find((row) => row.title === DEMO_WORK_TITLE);
    expect(group).toBeDefined();
    expect(group?.videoCount).toBe(1);
    expect(group?.subtitleCount).toBe(1);
    expect(group?.bytes).toBeGreaterThan(VIDEO.length);
    // 收进了库（本空间目录）→ 不是"需要留意"，删得掉
    expect(group?.attention).toBe(0);
    expect(group?.inLibraryCount).toBe(2);
    expect(inventory.media.count).toBe(2);
  });
});

describe("fetchDemoManifest", () => {
  it("相对路径归一化成绝对地址、sha 统一小写、字节数读进来", async () => {
    const manifest = await fetchDemoManifest("https://x.cc/", async () =>
      new Response(
        JSON.stringify({
          version: "demo-1",
          files: [{ name: "demo.mp4", url: "/storage/media/videos/demo-abc.mp4", sha256: "AB12", bytes: 123 }],
        }),
        { status: 200 },
      ),
    );
    expect(manifest?.version).toBe("demo-1");
    // 🔥 渲染进程里 fetch 相对路径会拼到 app:// 源上必挂 —— 必须在这里归一化成绝对地址
    expect(manifest?.files[0].url).toBe("https://x.cc/storage/media/videos/demo-abc.mp4");
    expect(manifest?.files[0].sha256).toBe("ab12");
    expect(manifest?.files[0].bytes).toBe(123);
  });

  it("清单地址带时间戳破缓存（nginx 对 /storage/ 下发长缓存）", async () => {
    const fetchImpl = vi.fn(
      async (_input: string) =>
        new Response(
          JSON.stringify({ files: [{ name: "demo.srt", url: "/storage/media/videos/demo.srt", sha256: "aa" }] }),
          { status: 200 },
        ),
    );
    await fetchDemoManifest("https://x.cc", fetchImpl);
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url.startsWith(`https://x.cc${DEMO_MANIFEST_PATH}?t=`)).toBe(true);
    expect(Number(url.split("t=")[1])).toBeGreaterThan(0);
  });

  it("🔥 文件 URL 上的 ?v=<sha8> 查询参数必须原样保留（破 nginx 30 天 immutable 缓存的唯一手段）", async () => {
    const manifest = await fetchDemoManifest("https://x.cc/", async () =>
      new Response(
        JSON.stringify({
          version: "demo-1",
          files: [
            { name: "demo.mp4", url: "/storage/media/videos/demo.mp4?v=592636a1", sha256: "AB12", bytes: 1 },
            { name: "demo.srt", url: "/storage/media/videos/demo.srt?v=5b4d0b46", sha256: "CD34", bytes: 2 },
          ],
        }),
        { status: 200 },
      ),
    );
    // 母带即对外文件（文件名固定），换素材只换 ?v= —— 查询串一丢就命中旧字节，
    // sha256 校验必挂，用户永远下不到新演示。
    expect(manifest?.files[0].url).toBe("https://x.cc/storage/media/videos/demo.mp4?v=592636a1");
    expect(manifest?.files[1].url).toBe("https://x.cc/storage/media/videos/demo.srt?v=5b4d0b46");
    // name 仍然是纯文件名（落盘用），不受查询串影响
    expect(manifest?.files.map((f) => f.name)).toEqual(["demo.mp4", "demo.srt"]);
  });

  it("文件名为空 / 带路径分隔符 / 带 .. 一律拒收（不许写到暂存目录外）", async () => {
    for (const name of ["", " ", "../evil", "a/b.mp4", "a\\b.mp4", "."]) {
      const manifest = await fetchDemoManifest("https://x.cc", async () =>
        new Response(
          JSON.stringify({ files: [{ name, url: "/storage/media/videos/x", sha256: "AA" }] }),
          { status: 200 },
        ),
      );
      expect(manifest, `名字 ${JSON.stringify(name)} 不该被接受`).toBeNull();
    }
  });

  it("拿不到清单的几种情况都返回 null（演示没得下不该变成一条报错）", async () => {
    const notOk = await fetchDemoManifest(
      "https://x.cc",
      async () => new Response("", { status: 404 }),
    );
    expect(notOk).toBeNull();

    const empty = await fetchDemoManifest("https://x.cc", async () =>
      new Response(JSON.stringify({ files: [] }), { status: 200 }),
    );
    expect(empty).toBeNull();

    const boom = await fetchDemoManifest("https://x.cc", async () => {
      throw new Error("断网");
    });
    expect(boom).toBeNull();

    expect(await fetchDemoManifest("   ", async () => new Response("{}", { status: 200 }))).toBeNull();
  });
});

describe("demoManifestBytes", () => {
  it("清单里缺 bytes 的文件当 0 —— 只是少个数，不影响安装", () => {
    const manifest = manifestOf([
      { name: "a", url: "https://x.cc/a", sha256: "a", bytes: 100 },
      { name: "b", url: "https://x.cc/b", sha256: "b", bytes: 0 },
    ]);
    expect(demoManifestBytes(manifest)).toBe(100);
  });
});

describe("installDemoPack", () => {
  it("下载 + 导入成功：建集、素材进本空间素材库、暂存被清", async () => {
    const { db, mediaDir, stagingDir } = await harness();
    const bodies = { "demo.mp4": VIDEO, "demo.srt": SRT };
    const manifest = manifestOf([fileEntry("demo.mp4", VIDEO), fileEntry("demo.srt", SRT)]);

    const seen: number[] = [];
    const result = await installDemoPack({
      db,
      mediaDir,
      manifest,
      stagingDir,
      fetchImpl: fakeFetch(bodies),
      onProgress: (progress) => seen.push(progress.done),
    });

    expect(result).toMatchObject({ ok: true });
    // 🔒 这条非空就是首页「示例」占位行收起的**唯一依据**（判据见 demo.ts 头注释）
    const episodes = await loadRecordList(db);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].record.title).toBe(DEMO_WORK_TITLE);
    expect(await loadStudySentences(db, episodes[0].record.cid)).toHaveLength(2);

    // 素材收进了本机空间的素材库（与用户导入同一条路：`<空间 id>/<作品名>/`）
    const video = await liveVideoAsset(db, episodes[0].record.videoSha256);
    expect(video.localPath).toContain(path.join("sp-1", safeSegment(DEMO_WORK_TITLE)));
    // 暂存目录用完即清
    expect(fs.existsSync(stagingDir)).toBe(false);
    expect(seen).toEqual([1, 2]);
  });

  it("sha 对不上：返回失败、库里不留素材，坏文件也不留在暂存目录", async () => {
    const { db, mediaDir, stagingDir } = await harness();
    const bodies = { "demo.mp4": VIDEO, "demo.srt": SRT };
    const manifest = manifestOf([fileEntry("demo.mp4", VIDEO), fileEntry("demo.srt", SRT)]);
    // 字幕声明成"别的字节"的 sha ⇒ 下载下来校验必失败
    manifest.files[1].sha256 = sha(Buffer.from("完全不同的内容"));

    const result = await installDemoPack({
      db,
      mediaDir,
      manifest,
      stagingDir,
      fetchImpl: fakeFetch(bodies),
    });

    expect(result.ok).toBe(false);
    expect(await loadRecordList(db)).toHaveLength(0);
    // 校验不过的那个文件必须删掉（留着下一趟会被当成"已下好"）
    expect(fs.existsSync(path.join(stagingDir, "demo.srt"))).toBe(false);
    // 前一个已校验过的文件留着 —— 下一趟重试不用重下它
    expect(fs.existsSync(path.join(stagingDir, "demo.mp4"))).toBe(true);
  });

  it("🔒 导入失败（字幕读不出时间轴）：库里仍是空的，占位行继续挂着", async () => {
    const { db, mediaDir, stagingDir } = await harness();
    const bodies = { "demo.mp4": VIDEO, "demo.srt": SRT_BAD };
    const manifest = manifestOf([fileEntry("demo.mp4", VIDEO), fileEntry("demo.srt", SRT_BAD)]);

    const result = await installDemoPack({
      db,
      mediaDir,
      manifest,
      stagingDir,
      fetchImpl: fakeFetch(bodies),
    });

    expect(result.ok).toBe(false);
    expect(await loadRecordList(db)).toHaveLength(0);
    // 失败时暂存目录**保留** —— 已下好的文件下一趟按 sha 跳过
    expect(fs.existsSync(path.join(stagingDir, "demo.mp4"))).toBe(true);
  });

  it("网络失败：重试时已下好且 sha 对得上的文件不再重下", async () => {
    const { db, mediaDir, stagingDir } = await harness();
    const bodies = { "demo.mp4": VIDEO, "demo.srt": SRT };
    const manifest = manifestOf([fileEntry("demo.mp4", VIDEO), fileEntry("demo.srt", SRT)]);

    // 第一趟：字幕 500 ⇒ 整体失败，但视频已经躺进暂存目录
    const first = await installDemoPack({
      db,
      mediaDir,
      manifest,
      stagingDir,
      fetchImpl: fakeFetch(bodies, { "demo.srt": 500 }),
    });
    expect(first.ok).toBe(false);

    // 第二趟：视频 sha 对得上 ⇒ 不该再走网络请求它
    const fetchImpl = fakeFetch(bodies);
    const second = await installDemoPack({ db, mediaDir, manifest, stagingDir, fetchImpl });
    expect(second).toMatchObject({ ok: true });
    const asked = fetchImpl.mock.calls.map((call) => new URL(call[0]).pathname);
    expect(asked.some((p) => p.endsWith("demo.mp4"))).toBe(false);
    // 第二趟真的导进来了 ⇒ 库里 1 条素材（首页占位行据此收起）
    expect(await loadRecordList(db)).toHaveLength(1);
  });

  it("暂存目录里清单之外的旧文件会被清掉（换版本时不该混进来）", async () => {
    const { db, mediaDir, stagingDir } = await harness();
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, "旧的.mp4"), "x");
    const bodies = { "demo.mp4": VIDEO, "demo.srt": SRT };
    const manifest = manifestOf([fileEntry("demo.mp4", VIDEO), fileEntry("demo.srt", SRT)]);

    const result = await installDemoPack({
      db,
      mediaDir,
      manifest,
      stagingDir,
      fetchImpl: fakeFetch(bodies),
    });

    expect(result).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(stagingDir, "旧的.mp4"))).toBe(false);
  });

  it("清单缺视频或字幕：直接从清单判断失败，库里不留素材", async () => {
    const { db, mediaDir, stagingDir } = await harness();
    const onlyVideo = manifestOf([fileEntry("demo.mp4", VIDEO)]);

    const result = await installDemoPack({
      db,
      mediaDir,
      manifest: onlyVideo,
      stagingDir,
      fetchImpl: fakeFetch({ "demo.mp4": VIDEO }),
    });

    expect(result).toMatchObject({ ok: false });
    expect(await loadRecordList(db)).toHaveLength(0);
  });
});
