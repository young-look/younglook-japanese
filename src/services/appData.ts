/**
 * 应用数据目录：插件自己的东西放这里，**不进 vault**。
 *
 * vault 是用户的内容，会被官方 Sync 和第三方同步工具一起搬走。素材库（media/）
 * 收的是用户导入的视频，一集常见 1~3 GB，混进 vault 等于往用户的云盘里塞
 * 几十 GB 的同步量，而且它不是笔记、不该进搜索。
 * 放系统应用数据目录，跟用户的东西彻底分开：不进 vault、不参与同步、
 * 不会被"清空缓存"顺手删掉，卸载插件也还在。
 *
 * 目录约定见 docs/12-video-clipping.md §3.3：
 *   macOS   ~/Library/Application Support/young-look/
 *   Windows %LOCALAPPDATA%\young-look\
 *   Linux   ~/.local/share/young-look
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * ⚠️ 这里**不许 import obsidian**：`Platform` 来自 obsidian 包，而单测环境解析不了
 * obsidian（`appDataDir` 被 mediaStore → importer 一路引用，带进来就是整条导入
 * 链路的单测全挂）。`process.platform` 在桌面端 Electron 里同样可靠。
 */

/** 目录名跟插件 id（young-look）一致，找起来好找。 */
export const APP_DATA_DIR_NAME = "young-look";

/** 应用数据根目录。只算路径，不创建。 */
export function appDataDir(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(base, APP_DATA_DIR_NAME);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_DATA_DIR_NAME);
  }
  // Linux 及其它 unix 走 XDG
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, APP_DATA_DIR_NAME);
}

/** 确保应用数据目录下的某个子目录存在，返回它的绝对路径。 */
export function ensureAppDataSubdir(name: string): string {
  const dir = join(appDataDir(), name);
  mkdirSync(dir, { recursive: true });
  return dir;
}