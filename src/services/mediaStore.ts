/**
 * 素材库：把用户导入的**视频和字幕**收进插件自己的目录。
 *
 * 为什么不再用"用户原来的位置"（2026-10-01 改）：
 * 原来只记绝对路径，用户一整理 Downloads、外接硬盘一拔，路径就指空了 ——
 * 列表里那一集看着还在，点进去却播不出来。素材收归插件保管，这份数据才站得住。
 *
 * 为什么放在 vault **外面**（这正是重点）：
 * vault 是用户自己的地方，会被 Obsidian Sync、iCloud、OneDrive、Syncthing 一起搬走。
 * 一集动画常见 1~3 GB，几部番塞进去就是几十 GB 的同步量，而且它既不是笔记、
 * 也不该进用户的搜索。笔记和截图留在 vault，素材单独放，两边互不拖累。
 * 默认在系统应用数据目录下的 media/，设置页可以改成任何地方
 * （外接硬盘、NAS、专门的素材盘都行）。
 *
 * 三条硬边界：
 *  · **绝不删除用户原来的文件**。是复制，不是搬家 —— 用户自己整理的文件夹
 *    不能由我们来动（Electron 里挪进废纸篓也不该我们说了算）。
 *  · **复制失败绝不拦住导入**。磁盘满、目标盘只读、跨设备拷贝中断……都只是
 *    "这一集没能收进库"，退回按原路径播放，让人还能接着学。
 *  · 不碰笔记、不碰本地库、不知道 vault 的存在 —— 这一层只干文件的事。
 */

import { copyFile, mkdir, rmdir, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { appDataDir } from "./appData";
import { fileExists, probeFile } from "../storage/files";

/** 素材库在应用数据目录下的子目录名。 */
export const MEDIA_SUBDIR = "media";

/** 演示素材（插件自带）在基准目录下的共享子目录名 —— 不按空间分。 */
export const DEMO_MEDIA_SUBDIR = "_demo";

/** 默认素材库位置。vault 外面，跟笔记彻底分开（见文件头）。 */
export function defaultMediaDir(): string {
  return join(appDataDir(), MEDIA_SUBDIR);
}

/** 素材库的**基准目录**（不含空间层）。留空 = 默认位置。 */
function mediaRoot(setting?: string): string {
  const value = (setting ?? "").trim();
  return value ? resolve(value) : defaultMediaDir();
}

/**
 * 设置里的值 → 某个本机空间实际使用的目录。**留空 = 用默认位置**，且**按空间再分一层**。
 *
 * 每个空间一个子目录（`<base>/<spaceId>`）：两个账号的素材**完全隔离、不跨空间去重**
 * （2026-10-10 用户拍板 —— 简单起见宁可各存一份）。指纹复用因此天然只在**本空间内**
 * 发生；删除也天然只覆盖本空间（见 `removeMediaFiles`）。这也顺手解决了"一方删素材
 * 穿透到另一方"的隐患。
 *
 * ⚠️ 项目未上线，旧全局目录里的素材**不做迁移**：新模型下它们不在任何空间根内、
 *    既不能删也不影响新导入。
 */
export function resolveMediaDir(setting: string | undefined, spaceId: string): string {
  const base = mediaRoot(setting);
  return spaceId ? join(base, spaceId) : base;
}

/**
 * **演示素材**的共享目录 —— 插件自带，不按空间分。
 *
 * 演示视频可能几十 MB，按空间各拷一份纯属浪费；它不算用户数据（存储盘点里也被
 * `demoEpisodeCidsOf` 排除），共享一份不违反"两账号隔离"。
 */
export function resolveDemoMediaDir(setting?: string): string {
  return join(mediaRoot(setting), DEMO_MEDIA_SUBDIR);
}

export interface IngestResult {
  /** 最终应该记进素材行的绝对路径（搬运失败时 = 用户原来的路径） */
  path: string;
  /** 最终文件名。素材行的 filename 要跟着一起换，别留着旧名字误导人 */
  filename: string;
  /** 这次真的复制了文件 */
  copied: boolean;
  /** 库里已经有一份一模一样的，直接复用了它的位置（不重复占空间） */
  reused: boolean;
  /** 失败原因（人话）。有值 = 已经退回原路径 */
  error?: string;
}

/** 文件名里的非法字符。按最严的 Windows 来：冒号、星号、竖线这些 macOS 是允许的。 */
const ILLEGAL_NAME_CHARS = /[\u0000-\u001f\u007f"*/:<>?\\|]/g;

/** 作品名当目录名：非法字符换掉、掐掉首尾空白和点、限长、空则给个兜底名。 */
export function safeSegment(raw: string): string {
  const cleaned = raw.replace(ILLEGAL_NAME_CHARS, "_").replace(/\s+/gu, " ").trim();
  const trimmed = cleaned.replace(/^[.\s]+|[.\s]+$/gu, "");
  return trimmed.slice(0, 80) || "未命名";
}

/** path 是否已经在 dir 里面（含就是 dir 本身）。 */
function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  if (rel === "") return true;
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  // macOS 的文件系统大小写不敏感，用户随手改了个大小写不该算两份
  return !rel.split(/[\\/]/u)[0].includes("..");
}

/**
 * path 是否落在素材库根里面。给「删除」把关的公开口子：
 * 移除一集时，只有收进了素材库的副本可以删，用户自己原位置的那份永远不能碰。
 */
export function insideMediaRoot(path: string, mediaDir: string): boolean {
  return isInside(resolve(path), resolve(mediaDir));
}

/**
 * 挑一个不撞车的落点。
 *
 * 同名冲突时先看内容：指纹一样就是同一份文件（重导同一个视频），复用它、不复制第二份；
 * 指纹不一样才加序号区分 —— 同名不同内容的两个文件谁也不许覆盖谁。
 */
async function pickTarget(
  dirPath: string,
  filename: string,
  fingerprint: string | null,
): Promise<{ target: string; reused: boolean }> {
  const ext = extname(filename);
  const stem = basename(filename, ext);
  for (let round = 1; round <= 50; round += 1) {
    const target = round === 1 ? join(dirPath, filename) : join(dirPath, `${stem} (${round})${ext}`);
    if (!(await fileExists(target))) return { target, reused: false };
    if (fingerprint) {
      const probe = await probeFile(target);
      if (probe.fingerprint && probe.fingerprint === fingerprint) return { target, reused: true };
    }
  }
  // 一个目录里挤了 50 个同名文件属于极端情况，退回同名那一个（不让它退出去没得放）
  return { target: join(dirPath, filename), reused: false };
}

/** 把失败原因说成人话（不出堆栈、不出 errno）。 */
function describeFailure(error: unknown): string {
  const code = (error as { code?: string } | null)?.code ?? "";
  if (code === "ENOSPC") return "目标盘空间不够。";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "这个目录写不进去（没有权限）。";
  if (code === "ENOENT") return "目标目录不存在，而且建不出来。";
  if (code === "EXDEV") return "这个跨设备的复制被系统拦下了。";
  return "复制没能完成。";
}

/**
 * 把一份素材收进素材库。**不清用户的原文件**，只复制。
 *
 * 失败一律回退：调用方拿到的是原路径 + 一句人话原因，导入照常成立
 * （copyFile-only 的改进不能让用户连学都没法学）。
 */
export async function takeIntoMediaDir(params: {
  sourcePath: string;
  mediaDir: string;
  workTitle: string;
  /** 导入时已经算好的采样指纹，用来判断"库里那份是不是同一个文件" */
  fingerprint: string | null;
  sizeBytes: number;
}): Promise<IngestResult> {
  const original = params.sourcePath;
  const fallback: IngestResult = {
    path: original,
    filename: basename(original),
    copied: false,
    reused: false,
  };

  try {
    const root = resolve(params.mediaDir);
    // 已经在库里了（重导同一个视频、或从库里选的文件）：原地不动，别再复制一份
    if (isInside(original, root)) return { ...fallback, reused: true };
    if (!(await fileExists(original))) {
      return { ...fallback, error: "素材文件已经不在原来的位置了。" };
    }

    const dirPath = join(root, safeSegment(params.workTitle));
    await mkdir(dirPath, { recursive: true });

    const { target, reused } = await pickTarget(dirPath, basename(original), params.fingerprint);
    if (!reused) {
      await copyFile(original, target);
      // 拷完核一遍大小：断在半路的半成品比没有更糟，播放器会一直转圈
      const copied = await stat(target);
      if (copied.size !== params.sizeBytes) {
        await rm(target, { force: true });
        return { ...fallback, error: "复制没完成（目标盘可能写满了）。" };
      }
    }
    return { path: target, filename: basename(target), copied: !reused, reused };
  } catch (error) {
    return { ...fallback, error: describeFailure(error) };
  }
}

export interface RemoveMediaResult {
  /** 真正删掉的文件数 */
  removed: number;
  /** 想删但没删掉的（被占用、权限……），路径原样带回，由调用方决定怎么跟用户说 */
  failed: string[];
}

/**
 * 从素材库删除一批文件（移除一集时勾选「一并删除视频和字幕文件」走这里）。
 *
 * 双保险，两头都拦：
 *  · 调用方该先用 `insideMediaRoot` 筛一遍（弹窗上只显示库内副本的体积）；
 *  · 这里再筛一遍 —— 库外的路径一律跳过。用户自己原位置的文件、vault 里的笔记，
 *    无论怎么传进来都删不到。
 *
 * 尽力而为：单个文件删不掉（占用、权限）不算失败，记下来继续删别的；
 * 删空的作品目录顺手清掉壳（目录里还有东西时 `rm` 非递归会自然失败，忽略即可）。
 */
export async function removeMediaFiles(paths: string[], mediaDir: string): Promise<RemoveMediaResult> {
  const root = resolve(mediaDir);
  const result: RemoveMediaResult = { removed: 0, failed: [] };
  const touchedDirs = new Set<string>();

  for (const raw of paths) {
    const target = resolve(raw);
    if (!isInside(target, root) || target === root) continue;
    try {
      await rm(target, { force: true });
      result.removed += 1;
      touchedDirs.add(dirname(target));
    } catch {
      result.failed.push(target);
    }
  }

  for (const dir of touchedDirs) {
    if (!isInside(dir, root) || dir === root) continue;
    // 用 rmdir（不是 rm）：只收走**空**的壳，里面还留着别的集的文件时它会抛
    // ENOTEMPTY —— 正是想要的守门。`rm` 不带 recursive 对目录直接抛 EISDIR，用不了。
    await rmdir(dir).catch(() => undefined);
  }
  return result;
}
