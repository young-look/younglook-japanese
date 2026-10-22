/**
 * 在系统的文件管理器里显示某个文件 / 文件夹（数据页那颗「显示」）。
 *
 * ── 为什么走 Electron 的 shell，不再自己起进程 ──────────────────────────────
 * 以前这里 spawn 了 `open` / `explorer` / `xdg-open`。能用，但**起子进程 = 对
 * 整台机器有完全控制权**，社区目录会把它单独标成一条 Warning（Shell Execution）。
 * Electron 的 `shell` 就是为这件事生的：它交给系统自己那套「在访达中显示」，
 * 三个平台的行为由系统保证，我们一行平台判断都不用写。
 *
 * ⚠️ **失败了也要体面**：返回 false 让调用方去兜底（通常是把路径复制到剪贴板）。
 * 这一层不认识 Obsidian 的 Notice，也就不会为了一个 tooltip 把别的模块拉进来。
 */

/** Electron 的 shell 里我们用到的这两条（其余的不碰）。 */
interface ElectronShell {
  /** 打开所在目录并选中它（macOS 访达 / Windows 资源管理器 / Linux 各自的等价行为）。 */
  showItemInFolder(fullPath: string): void;
  /** 打开文件或目录：返回空串 = 成功，非空串是系统给的报错文案。 */
  openPath(path: string): Promise<string>;
}

/**
 * 拿 electron 模块的口子（默认 = CJS 的 require）。
 *
 * 为什么是运行时取而不是静态 import：`electron` 是 external（不能打进产物），
 * 静态 import 会让**单测一加载就崩** —— node 里没有 electron 模块。
 * 与 `services/bangumi.ts` 那条先例同款（那边是 `await import("obsidian")`）。
 * Electron 的模块取不到时返回 null，由调用方退化成"把路径复制到剪贴板"。
 */
type RequireFn = (id: string) => unknown;

let requireImpl: RequireFn | null = null;

export function setRequireImpl(fn: RequireFn | null): void {
  requireImpl = fn;
}

/**
 * Electron 把 require 挂在 window 上，插件里另两处（选文件拿绝对路径、保存
 * 学习卡片的系统对话框）取的都是同一个东西。
 * 取不到（没有 window / 那里没有 Electron）一律按"取不到"处理。
 */
function nodeRequire(): RequireFn | undefined {
  return (window as unknown as { require?: RequireFn }).require;
}

function electronShell(): ElectronShell | null {
  const req = requireImpl ?? nodeRequire();
  try {
    const mod = req?.("electron") as { shell?: ElectronShell } | null | undefined;
    return mod?.shell ?? null;
  } catch {
    return null;
  }
}

/**
 * @param path 绝对路径。传目录 = 打开这个目录；传文件 = 打开它所在的目录并选中它。
 * @returns 命令是不是发出去了。**不代表用户真的看见了窗口**（系统可能拒绝），
 *          只是说"这一层没有出错"。
 */
export function revealInShell(path: string): boolean {
  const target = path?.trim();
  if (!target) return false;
  const shell = electronShell();
  if (!shell) return false;
  try {
    shell.showItemInFolder(target);
    return true;
  } catch {
    return false;
  }
}

/** 打开一个目录（不带选中）。导出文件夹、素材库这类"看一看"的入口用它。 */
export function openFolderInShell(dir: string): boolean {
  const target = dir?.trim();
  if (!target) return false;
  const shell = electronShell();
  if (!shell) return false;
  try {
    // openPath 的 Promise 给的是"系统报了什么错"，我们不拿它做事，也不让它飘着
    shell.openPath(target).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}
