/**
 * 在系统的文件管理器里显示某个文件 / 文件夹（数据页那颗「显示」）。
 *
 * 走系统命令而不是 Electron 的 remote：插件在 Obsidian 桌面端本来就有完整的
 * Node，命令行的行为在系统之间也是最一致的 —— macOS 的「访达」、Windows 的
 * 「资源管理器」各有壮大剑，用 Electron shell 反而多一层不确定性。
 *
 * ⚠️ **失败了也要体面**：返回 false 让调用方去兜底（通常是把路径复制到剪贴板）。
 * 这一层不认识 Obsidian 的 Notice，也就不会因为一个 tooltip 把 Node 拉进来。
 */

import { spawn } from "node:child_process";
import { dirname } from "node:path";

/**
 * @param path 绝对路径。传目录 = 打开这个目录；传文件 = 打开它所在的目录并选中它。
 * @returns 命令是不是发出去了。**不代表用户真的看见了窗口**（系统可能拒绝），
 *          只是说"这一层没有出错"。
 */
export function revealInShell(path: string): boolean {
  const target = path?.trim();
  if (!target) return false;
  try {
    if (process.platform === "darwin") {
      // -R：在访达中显示（选中），等价于 Finder 里右键「在访达中显示」
      spawn("open", ["-R", target], { detached: true, stdio: "ignore" }).unref();
      return true;
    }
    if (process.platform === "win32") {
      spawn("explorer", [`/select,${target.replace(/\//gu, "\\")}`], {
        detached: true,
        stdio: "ignore",
      }).unref();
      return true;
    }
    // Linux 没有统一的"选中"协议，退回打开它所在的目录
    spawn("xdg-open", [dirname(target)], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

/** 打开一个目录（不带选中）。导出文件夹、素材库这类"看一看"的入口用它。 */
export function openFolderInShell(dir: string): boolean {
  const target = dir?.trim();
  if (!target) return false;
  try {
    if (process.platform === "darwin") {
      spawn("open", [target], { detached: true, stdio: "ignore" }).unref();
      return true;
    }
    if (process.platform === "win32") {
      spawn("explorer", [target.replace(/\//gu, "\\")], { detached: true, stdio: "ignore" }).unref();
      return true;
    }
    spawn("xdg-open", [target], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}
