import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { applyRelease, compareVersions, fetchLatestRelease } from "../src/services/update";

const sha = (content: string) => createHash("sha256").update(content).digest("hex");

describe("compareVersions", () => {
  it("逐段比较数字：0.1.10 > 0.1.9，而不是字符串序", () => {
    expect(compareVersions("0.2.0", "0.1.0")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
  });

  it("缺的段当 0；解析不出的段也当 0（我们的发版号永远是纯数字）", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.1.0-beta", "0.1.0")).toBe(0);
  });
});

describe("fetchLatestRelease", () => {
  const okBody = {
    version: "0.2.0",
    notes: "修复登录稳定性",
    files: {
      "main.js": { url: "/storage/plugin/0.2.0/main.js", sha256: "AA11" },
      "manifest.json": { url: "/storage/plugin/0.2.0/manifest.json", sha256: "BB22" },
      "styles.css": { url: "/storage/plugin/0.2.0/styles.css", sha256: "CC33" },
    },
  };

  it("解析 latest.json，三件套齐全，sha 统一小写", async () => {
    const outcome = await fetchLatestRelease("https://x.cc/", async () =>
      new Response(JSON.stringify(okBody), { status: 200 }),
    );
    expect(outcome?.version).toBe("0.2.0");
    expect(outcome?.notes).toBe("修复登录稳定性");
    expect(outcome?.files["main.js"].sha256).toBe("aa11");
  });

  it("相对 url 按服务端地址归一化成绝对地址——渲染进程里 fetch 相对路径会拼到 app:// 源上必挂", async () => {
    const outcome = await fetchLatestRelease("https://x.cc", async () =>
      new Response(JSON.stringify(okBody), { status: 200 }),
    );
    expect(outcome?.files["main.js"].url).toBe("https://x.cc/storage/plugin/0.2.0/main.js");
  });

  it("缺任何一个文件条目都视为无效（更新必须是完整三件套）", async () => {
    const broken = {
      ...okBody,
      files: { "main.js": okBody.files["main.js"] },
    };
    const outcome = await fetchLatestRelease("https://x.cc", async () =>
      new Response(JSON.stringify(broken), { status: 200 }),
    );
    expect(outcome).toBeNull();
  });

  it("404 / 坏 JSON / 空地址 → null，绝不抛异常", async () => {
    expect(
      await fetchLatestRelease("https://x.cc", async () => new Response("no", { status: 404 })),
    ).toBeNull();
    expect(
      await fetchLatestRelease("https://x.cc", async () => new Response("<html>", { status: 200 })),
    ).toBeNull();
    expect(await fetchLatestRelease("", async () => new Response("{}", { status: 200 }))).toBeNull();
  });
});

describe("applyRelease（真 http + 真 fs 端到端）", () => {
  const contents: Record<string, string> = {
    "main.js": "NEW-JS",
    "manifest.json": "{}",
    "styles.css": ".yl{}",
  };
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const url = request.url ?? "";
      if (url.includes("missing")) {
        response.writeHead(404).end();
        return;
      }
      const name = path.basename(url.split("?")[0] ?? "");
      response.writeHead(200).end(contents[name] ?? "");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const releaseFor = (overrides: Record<string, string> = {}) => ({
    version: "0.2.0",
    notes: "",
    files: Object.fromEntries(
      Object.entries(contents).map(([name, content]) => [
        name,
        { url: `${baseUrl}/${name}`, sha256: overrides[name] ?? sha(content) },
      ]),
    ),
  });

  const writeOldFiles = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yl-update-"));
    for (const name of Object.keys(contents)) {
      fs.writeFileSync(path.join(dir, name), `OLD-${name}`);
    }
    return dir;
  };

  it("完整走一遍：下载 → 校验 → 原子替换，旧文件留 .bak，无残留临时文件", async () => {
    const dir = writeOldFiles();
    const result = await applyRelease(dir, releaseFor());
    expect(result.updated).toEqual(["main.js", "manifest.json", "styles.css"]);
    expect(fs.readFileSync(path.join(dir, "main.js"), "utf8")).toBe("NEW-JS");
    expect(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).toBe("{}");
    expect(fs.readFileSync(path.join(dir, "styles.css"), "utf8")).toBe(".yl{}");
    // 旧文件可回滚；临时文件不残留
    expect(fs.readFileSync(path.join(dir, "main.js.bak"), "utf8")).toBe("OLD-main.js");
    expect(fs.existsSync(path.join(dir, "main.js.download"))).toBe(false);
  });

  it("🔥 sha256 不匹配：拒绝替换，磁盘一个字节都没动", async () => {
    const dir = writeOldFiles();
    await expect(
      applyRelease(dir, releaseFor({ "main.js": "deadbeef" })),
    ).rejects.toThrow(/校验失败/);
    expect(fs.readFileSync(path.join(dir, "main.js"), "utf8")).toBe("OLD-main.js");
    expect(fs.existsSync(path.join(dir, "main.js.bak"))).toBe(false);
  });

  it("🔥 下载 404：拒绝替换，磁盘一个字节都没动", async () => {
    const dir = writeOldFiles();
    const release = releaseFor();
    release.files["styles.css"] = { url: `${baseUrl}/missing`, sha256: sha(contents["styles.css"]!) };
    await expect(applyRelease(dir, release)).rejects.toThrow(/下载 styles\.css 失败/);
    expect(fs.readFileSync(path.join(dir, "main.js"), "utf8")).toBe("OLD-main.js");
    expect(fs.existsSync(path.join(dir, "main.js.bak"))).toBe(false);
  });
});
