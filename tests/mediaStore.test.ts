import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultMediaDir,
  insideMediaRoot,
  removeMediaFiles,
  resolveMediaDir,
} from "../src/services/mediaStore";

/**
 * 素材库的「删」只有一条红线：**库外的路径碰都不许碰**。
 * 移除一集时勾选「一并删除视频和字幕文件」走 removeMediaFiles，
 * 用户自己原位置的那份（兜底路径）、vault 里的任何东西，都不能被删到。
 */

let root: string;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function makeLibrary(): { workDir: string; video: string; subtitle: string } {
  root = mkdtempSync(join(tmpdir(), "yl-media-remove-"));
  const workDir = join(root, "MyGO");
  mkdirSync(workDir, { recursive: true });
  const video = join(workDir, "ep1.mkv");
  const subtitle = join(workDir, "ep1.ass");
  writeFileSync(video, "v");
  writeFileSync(subtitle, "s");
  return { workDir, video, subtitle };
}

describe("removeMediaFiles", () => {
  it("库内的副本删掉；删空的目录壳也清掉", async () => {
    const { workDir, video, subtitle } = makeLibrary();

    const result = await removeMediaFiles([video, subtitle], root);

    expect(result.removed).toBe(2);
    expect(result.failed).toEqual([]);
    expect(existsSync(video)).toBe(false);
    expect(existsSync(subtitle)).toBe(false);
    // 作品目录空了，壳一起收走
    expect(existsSync(workDir)).toBe(false);
  });

  it("库外的路径一律跳过 —— 用户自己的原文件永远不动", async () => {
    const { video } = makeLibrary();
    const outsideDir = mkdtempSync(join(tmpdir(), "yl-media-user-"));
    try {
      const userFile = join(outsideDir, "ep1.mkv");
      writeFileSync(userFile, "原文件");

      const result = await removeMediaFiles([video, userFile], root);

      expect(result.removed).toBe(1);
      expect(existsSync(userFile)).toBe(true);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("目录还没空（别的集还住在里面）时，壳留着", async () => {
    const { workDir, video } = makeLibrary();
    const other = join(workDir, "ep2.mkv");
    writeFileSync(other, "v");

    const result = await removeMediaFiles([video], root);

    expect(result.removed).toBe(1);
    expect(existsSync(workDir)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it("根本不存在的路径不报错", async () => {
    makeLibrary();
    const result = await removeMediaFiles([join(root, "MyGO", "ghost.mkv")], root);
    expect(result.failed).toEqual([]);
  });
});

/**
 * 素材按**本机空间**分目录（2026-10-10 模型重构）。
 *
 * 每个空间一个子目录 `<基准目录>/<空间 id>` —— 两个账号的素材完全隔离、**不跨空间
 * 去重**（用户拍板：简单起见宁可各存一份）。指纹复用与删除都天然被锁在本空间内，
 * 顺手解决了"一方删素材穿透到另一方"的隐患。
 *
 * ⚠️ **演示素材也走这里**（2026-10-14 用户拍板：与用户导入一视同仁）：示例那一集下载后
 *    落在本空间的素材库里，不再有共享的 `_demo/` 特殊目录 —— 盘点、删除、「在不在库里」
 *    的判断都只需要这一个根。
 */
describe("resolveMediaDir（素材按本机空间隔离）", () => {
  function baseDir(): string {
    root = mkdtempSync(join(tmpdir(), "yl-media-space-"));
    return root;
  }

  it("落在 <基准目录>/<空间 id>：两个空间各存一份，互不相见", () => {
    const base = baseDir();
    expect(resolveMediaDir(base, "base")).toBe(join(base, "base"));
    expect(resolveMediaDir(base, "base-2")).toBe(join(base, "base-2"));
  });

  it("空间 id 为空 → 就用基准目录本身（不凭空多一层）", () => {
    const base = baseDir();
    expect(resolveMediaDir(base, "")).toBe(resolve(base));
  });

  it("留空 = 默认位置，同样按空间再分一层", () => {
    expect(resolveMediaDir("", "base")).toBe(join(defaultMediaDir(), "base"));
  });
});

describe("insideMediaRoot", () => {
  it("库内的算，库外不算；根本身由 removeMediaFiles 另设关卡", () => {
    const dir = mkdtempSync(join(tmpdir(), "yl-media-root-"));
    try {
      expect(insideMediaRoot(join(dir, "MyGO", "ep1.mkv"), dir)).toBe(true);
      expect(insideMediaRoot(join(dir, "MyGO"), dir)).toBe(true);
      // 根本身也返回 true（isInside 的定义）；「别把根删了」由 removeMediaFiles 拦
      expect(insideMediaRoot(dir, dir)).toBe(true);
      const outside = mkdtempSync(join(tmpdir(), "yl-media-out-"));
      try {
        expect(insideMediaRoot(join(outside, "ep1.mkv"), dir)).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
