/**
 * 词典目录定位（需要 Obsidian 的 vault 适配器，所以和分词逻辑分开，
 * 这样分词那半边可以在 Node 里直接单测）。
 */

import { FileSystemAdapter, type App } from "obsidian";
import { existsSync } from "fs";
import { join } from "path";

/**
 * 插件自己的目录（绝对路径）。移动端 / 拿不到文件系统时返回 null。
 *
 * 这里走 `getFullPath(configDir/plugins/<id>)` —— 与 `main.ts` 里
 * `basePath()` 那套（`getBasePath()` + `manifest.dir`）指向同一个目录，
 * 用哪个都行；合并成一处是为了让「词典装到哪」只有一个答案。
 */
export function pluginDirPath(app: App, pluginId: string): string | null {
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) return null;
  return adapter.getFullPath(`${app.vault.configDir}/plugins/${pluginId}`);
}

/**
 * 找 kuromoji 词典目录。
 *
 * 两个候选，按发布形态优先：
 *  1. `<插件目录>/dict` —— 发布包里带的（构建时由 scripts/sync-dict.mjs 同步）；
 *  2. `<插件目录>/node_modules/kuromoji/dict` —— 开发时没跑同步脚本的兜底。
 *
 * 注意插件目录可能是**软链**（本项目开发时装法），`getFullPath` 会经过软链解析，
 * 所以两种情况都能命中。
 */
export function resolveDictPath(app: App, pluginId: string): string | null {
  const pluginDir = pluginDirPath(app, pluginId);
  if (!pluginDir) return null;
  const candidates = [join(pluginDir, "dict"), join(pluginDir, "node_modules", "kuromoji", "dict")];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "base.dat.gz"))) return candidate;
  }
  return null;
}
