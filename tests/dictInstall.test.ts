import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DICT_MANIFEST_PATH,
  dictDirOf,
  fetchDictManifest,
  installDict,
  isDictInstalled,
  manifestBytes,
  type DictManifest,
} from "../src/services/dictInstall";

/**
 * 词典的按需下载（2026-10-11）。
 *
 * 这组用例钉的是**两件会静默出事的事**：
 *  · 清单里的文件名校验（`../` 或带路径分隔符的名字能写到插件目录外）；
 *  · 原子性 —— 校验不过 / 网络断了的时候，磁盘上**不能**出现一本半成品词典
 *    （分词器读到坏词典是直接抛错，用户看到的是"这功能坏了"）。
 */

const sha = (content: string) => createHash("sha256").update(content).digest("hex");

function fileBody(name: string, content: string) {
  return { name, url: `/storage/assets/dict/${name}`, sha256: sha(content), bytes: content.length };
}

const BODY = { "base.dat.gz": "BASE", "tid_pos.dat.gz": "TIDPOS", "unk.dat.gz": "UNK" };

function manifestOf(names = Object.keys(BODY)): DictManifest {
  return {
    version: "1",
    files: names.map((name) => ({
      name,
      url: `https://x.cc/storage/assets/dict/${name}`,
      sha256: sha(BODY[name as keyof typeof BODY]),
      bytes: BODY[name as keyof typeof BODY].length,
    })),
  };
}

/** 假下载：按 url 末段给内容，可以指定某几个文件返回错误码。 */
function fakeFetch(broken: Record<string, number> = {}) {
  return vi.fn(async (input: string) => {
    const name = decodeURIComponent(new URL(input).pathname.split("/").pop() ?? "");
    const status = broken[name];
    if (status) return new Response("nope", { status });
    return new Response(BODY[name as keyof typeof BODY] ?? "");
  });
}

const temps: string[] = [];

function tempPluginDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yl-dict-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("fetchDictManifest", () => {
  it("相对路径归一化成绝对地址、sha 统一小写、字节数读进来", async () => {
    const manifest = await fetchDictManifest("https://x.cc/", async () =>
      new Response(
        JSON.stringify({
          version: "1",
          files: [{ name: "base.dat.gz", url: "/storage/assets/dict/base.dat.gz", sha256: "AB12", bytes: 10 }],
        }),
        { status: 200 },
      ),
    );
    expect(manifest?.version).toBe("1");
    // 🔥 渲染进程里 fetch 相对路径会拼到 app:// 源上必挂 —— 必须在这里归一化
    expect(manifest?.files[0].url).toBe("https://x.cc/storage/assets/dict/base.dat.gz");
    expect(manifest?.files[0].sha256).toBe("ab12");
    expect(manifest?.files[0].bytes).toBe(10);
  });

  it("清单地址带时间戳破缓存（nginx 对 /storage/ 下发长缓存）", async () => {
    const fetchImpl = vi.fn(async (_input: string) => new Response('{"files":[]}', { status: 200 }));
    await fetchDictManifest("https://x.cc", fetchImpl);
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url.startsWith(`https://x.cc${DICT_MANIFEST_PATH}?t=`)).toBe(true);
    expect(Number(url.split("t=")[1])).toBeGreaterThan(0);
  });

  it("文件名为空 / 带路径分隔符 / 带 .. 一律拒收（不许写到插件目录外）", async () => {
    for (const name of ["", " ", "../evil", "a/b.dat.gz", "a\\b.dat.gz", "."]) {
      const manifest = await fetchDictManifest("https://x.cc", async () =>
        new Response(
          JSON.stringify({ files: [{ name, url: "/storage/assets/dict/x", sha256: "AA" }] }),
          { status: 200 },
        ),
      );
      expect(manifest, `名字 ${JSON.stringify(name)} 不该被接受`).toBeNull();
    }
  });

  it("拿不到清单的几种情况都返回 null（词典没得下不该变成一条报错）", async () => {
    const notOk = await fetchDictManifest("https://x.cc", async () => new Response("", { status: 404 }));
    expect(notOk).toBeNull();

    const empty = await fetchDictManifest("https://x.cc", async () =>
      new Response(JSON.stringify({ files: [] }), { status: 200 }),
    );
    expect(empty).toBeNull();

    const boom = await fetchDictManifest("https://x.cc", async () => {
      throw new Error("断网");
    });
    expect(boom).toBeNull();

    expect(await fetchDictManifest("   ", async () => new Response("{}", { status: 200 }))).toBeNull();
  });
});

describe("manifestBytes", () => {
  it("清单里缺 bytes 的文件当 0 —— 只是少个数，不影响安装", () => {
    const manifest: DictManifest = {
      version: "1",
      files: [
        { name: "a", url: "https://x.cc/a", sha256: "a", bytes: 100 },
        { name: "b", url: "https://x.cc/b", sha256: "b", bytes: 0 },
      ],
    };
    expect(manifestBytes(manifest)).toBe(100);
  });
});

describe("installDict", () => {
  it("文件逐个落到 dict/，暂存目录与 .bak 都不留", async () => {
    const pluginDir = tempPluginDir();
    expect(isDictInstalled(pluginDir)).toBe(false);

    const seen: number[] = [];
    const result = await installDict(pluginDir, manifestOf(), {
      fetchImpl: fakeFetch(),
      onProgress: (progress) => seen.push(progress.done),
    });

    expect(result.downloaded).toBe(3);
    expect(result.dir).toBe(dictDirOf(pluginDir));
    expect(fs.readFileSync(path.join(result.dir, "base.dat.gz"), "utf8")).toBe("BASE");
    expect(fs.readFileSync(path.join(result.dir, "unk.dat.gz"), "utf8")).toBe("UNK");
    expect(isDictInstalled(pluginDir)).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, "dict.staging"))).toBe(false);
    expect(fs.existsSync(`${dictDirOf(pluginDir)}.bak`)).toBe(false);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("sha 对不上：整本词典都不落地，坏文件也不留在暂存目录里", async () => {
    const pluginDir = tempPluginDir();
    const manifest = manifestOf(["base.dat.gz", "tid_pos.dat.gz"]);
    manifest.files[1].sha256 = sha("别的什么东西");

    await expect(installDict(pluginDir, manifest, { fetchImpl: fakeFetch() })).rejects.toThrow(
      /tid_pos\.dat\.gz 校验失败/u,
    );
    // 🔥 关键：正式目录一个字节都没动
    expect(fs.existsSync(dictDirOf(pluginDir))).toBe(false);
    expect(isDictInstalled(pluginDir)).toBe(false);
    // 校验不过的那个文件必须删掉（留着下一趟会被当成"已下好"）
    expect(fs.existsSync(path.join(pluginDir, "dict.staging", "tid_pos.dat.gz"))).toBe(false);
    // 前一个已经校验过的文件留着 —— 下一趟重试不用重下它
    expect(fs.existsSync(path.join(pluginDir, "dict.staging", "base.dat.gz"))).toBe(true);
  });

  it("网络失败：正式目录不动，重试时已下好的文件按 sha 跳过", async () => {
    const pluginDir = tempPluginDir();
    await expect(
      installDict(pluginDir, manifestOf(), { fetchImpl: fakeFetch({ "tid_pos.dat.gz": 500 }) }),
    ).rejects.toThrow(/HTTP 500/u);
    expect(fs.existsSync(dictDirOf(pluginDir))).toBe(false);

    // 第二趟：base 已经躺在暂存目录里且 sha 对得上 → 不该再走网络
    const fetchImpl = fakeFetch();
    const result = await installDict(pluginDir, manifestOf(), { fetchImpl });
    expect(result.downloaded).toBe(2);
    const asked = fetchImpl.mock.calls.map((call) => new URL(call[0]).pathname);
    expect(asked.some((p) => p.endsWith("base.dat.gz"))).toBe(false);
    expect(isDictInstalled(pluginDir)).toBe(true);
  });

  it("已经有旧词典时：换掉它，旧目录不留在 .bak", async () => {
    const pluginDir = tempPluginDir();
    const dir = dictDirOf(pluginDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "base.dat.gz"), "旧的");

    await installDict(pluginDir, manifestOf(), { fetchImpl: fakeFetch() });

    expect(fs.readFileSync(path.join(dir, "base.dat.gz"), "utf8")).toBe("BASE");
    expect(fs.existsSync(`${dir}.bak`)).toBe(false);
  });

  it("暂存目录里清单之外的旧文件会被清掉（换版本时不该混进正式目录）", async () => {
    const pluginDir = tempPluginDir();
    const staging = path.join(pluginDir, "dict.staging");
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, "旧的.dat.gz"), "x");

    await installDict(pluginDir, manifestOf(["base.dat.gz"]), { fetchImpl: fakeFetch() });

    expect(fs.existsSync(path.join(dictDirOf(pluginDir), "旧的.dat.gz"))).toBe(false);
    expect(fs.existsSync(path.join(dictDirOf(pluginDir), "base.dat.gz"))).toBe(true);
  });
});
