/**
 * 插件自更新：检查服务端上的最新版本，下载三件套并原子替换自身。
 *
 * 为什么插件要自己做这件事：Obsidian 的内置更新器只管社区商店插件
 * （走 GitHub Releases）；我们是从服务器手工分发的，官方不管 —— 而用户
 * 手工覆盖三个文件不现实。桌面端插件有 Node 权限（isDesktopOnly），
 * 可以写自己的插件目录，社区的热重载插件就是这么干的。
 *
 * 🔒 两条铁律：
 *  · **先全部下载 + 全部 sha256 校验，通过之后才碰磁盘上的旧文件** ——
 *    任何一步失败都原样退出，绝不出现"换了一半"的插件（变砖）；
 *  · 替换是「写临时文件 → rename」的原子操作，旧文件留 .bak 可手工回滚；
 *    data.json（用户配置与登录态）从头到尾不碰。
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** latest.json 在服务端 storage 里的位置（nginx 直接吐静态文件，不经过后端） */
export const UPDATE_MANIFEST_PATH = "/storage/plugin/latest.json";

/** 更新涉及的三件套 —— 少一件都不算完整更新 */
export const RELEASE_FILES = ["main.js", "manifest.json", "styles.css"] as const;

export interface RemoteFile {
  url: string;
  sha256: string;
}

export interface RemoteRelease {
  version: string;
  notes: string;
  files: Record<string, RemoteFile>;
}

export type FetchLike = (input: string) => Promise<Response>;

/**
 * 读服务端的 latest.json。任何异常（404 / 网络断 / 格式不对 / 缺文件条目）
 * 都返回 null —— 更新检查是锦上添花的事，绝不能因为它报错影响插件使用。
 */
export async function fetchLatestRelease(
  serverUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<RemoteRelease | null> {
  const base = serverUrl.trim().replace(/\/+$/u, "");
  if (!base) return null;
  try {
    // nginx 对 /storage/ 下发 30 天 immutable 缓存 —— 时间戳参数破缓存，
    // 保证拿到的永远是最新那份 latest.json（三件套本身按版本子目录走，不怕缓存）。
    const response = await fetchImpl(`${base}${UPDATE_MANIFEST_PATH}?t=${Date.now()}`);
    if (!response.ok) return null;
    const body = (await response.json()) as {
      version?: unknown;
      notes?: unknown;
      files?: Record<string, { url?: unknown; sha256?: unknown }>;
    };
    const version = typeof body.version === "string" ? body.version.trim() : "";
    if (!version || !body.files) return null;
    const files: Record<string, RemoteFile> = {};
    for (const name of RELEASE_FILES) {
      const file = body.files[name];
      if (!file || typeof file.url !== "string" || typeof file.sha256 !== "string") return null;
      // 清单里的 url 可能是相对路径（release.mjs 写的就是 /storage/...）：渲染进程里
      // 直接 fetch 相对路径会以 app://obsidian.md 为基准解析，必然 Failed to fetch。
      // 这里统一按服务端地址归一化成绝对 URL，下载方不用再关心清单的写法。
      let url: URL;
      try {
        url = new URL(file.url, `${base}/`);
      } catch {
        return null;
      }
      files[name] = { url: url.toString(), sha256: file.sha256.trim().toLowerCase() };
    }
    return { version, notes: typeof body.notes === "string" ? body.notes : "", files };
  } catch {
    return null;
  }
}

/**
 * 版本号比较：a > b 返回正数，小于返回负数，相等返回 0。
 * 只认数字段（0.1.10 > 0.1.9），缺的段当 0；解析不出的段当 0 ——
 * 我们自己的发版号永远是纯数字段，够用。
 */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).trim().split(".").map((part) => Number(part) || 0);
  const pb = String(b).trim().split(".").map((part) => Number(part) || 0);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export interface ApplyResult {
  /** 成功替换的文件名 */
  updated: string[];
}

/**
 * 把 release 三件套落到插件目录。
 *
 * 次序：下载（内存）→ 逐个 sha256 校验 → 全部通过后才逐个
 * 「写 .download 临时文件 → 旧文件改名 .bak → rename 就位」。
 * 下载/校验阶段失败：磁盘一个字节都没动；替换阶段失败：尽力把 .bak 还原回去。
 */
export async function applyRelease(
  pluginDir: string,
  release: RemoteRelease,
  fetchImpl: FetchLike = fetch,
): Promise<ApplyResult> {
  const buffers = new Map<string, Buffer>();
  for (const name of RELEASE_FILES) {
    const file = release.files[name];
    if (!file) throw new Error(`更新包缺少 ${name}`);
    const response = await fetchImpl(file.url);
    if (!response.ok) throw new Error(`下载 ${name} 失败（HTTP ${response.status}）`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(buffer).digest("hex");
    if (digest !== file.sha256) {
      throw new Error(`${name} 校验失败，已放弃更新`);
    }
    buffers.set(name, buffer);
  }

  const updated: string[] = [];
  for (const name of RELEASE_FILES) {
    const target = path.join(pluginDir, name);
    const staging = `${target}.download`;
    const backup = `${target}.bak`;
    fs.writeFileSync(staging, buffers.get(name)!);
    try {
      if (fs.existsSync(target)) fs.renameSync(target, backup);
      fs.renameSync(staging, target);
    } catch (error) {
      // rename 半路失败：把 .bak 还原回去，别让插件目录空着
      if (!fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target);
      throw error;
    }
    updated.push(name);
  }
  return { updated };
}
