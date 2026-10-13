/**
 * 本机媒体文件的播放地址。
 *
 * Obsidian 桌面版的 `app://` 协议能按**绝对路径**访问本机文件（视频留在
 * 用户原来的位置，插件只记路径，所以必须走这条路），而且支持 Range 请求 ——
 * 几个 GB 的视频拖进度条不会整段进内存。
 *
 * 关键坑：`app://` 的主机段是一个**每次启动随机生成**的 id
 * （主进程里 `app://${随机36位hex}/`），硬编码 `app://local/...` 之类都不认。
 * 所以这里从 vault 里任意一个文件的真实资源路径里把前缀抠出来复用 ——
 * 同一次会话内前缀稳定。
 */

import type { App, TFile } from "obsidian";

let cachedPrefix: string | null = null;

function extractPrefix(app: App): string | null {
  if (cachedPrefix) return cachedPrefix;
  const files: TFile[] = app.vault.getFiles();
  for (const file of files) {
    try {
      const url = app.vault.getResourcePath(file);
      // 形如 app://<id>/<绝对路径>?<时间戳>，取到第三段斜杠为止
      const match = /^(app:\/\/[^/]+\/)/u.exec(url);
      if (match) {
        cachedPrefix = match[1];
        return cachedPrefix;
      }
    } catch {
      // 单个文件取不到资源路径就换下一个
    }
  }
  return null;
}

/** 每段路径单独编码，保留路径分隔符；盘符冒号不编码。 */
function encodeAbsolutePath(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/gu, "/");
  return normalized
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/%3A/giu, ":"))
    .join("/");
}

/**
 * 本机绝对路径 → 可播放的 URL。拿不到前缀（vault 一个文件都没有等极端情况）
 * 返回 null，由调用方给出人话提示。
 */
export function localMediaUrl(app: App, absolutePath: string): string | null {
  const prefix = extractPrefix(app);
  if (!prefix) return null;
  return `${prefix}${encodeAbsolutePath(absolutePath)}`;
}
