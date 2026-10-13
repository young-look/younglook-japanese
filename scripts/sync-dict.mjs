/**
 * 把 kuromoji 的词典从 node_modules 同步到插件目录。
 *
 * 为什么要有这一步：kuromoji 是**运行时**读词典文件的（`builder({dicPath})`），
 * esbuild 只打包 JS、不会把 17MB 的 .dat.gz 塞进 main.js。
 * 所以发布包里必须带上 `dict/`，插件启动时按这个路径加载。
 *
 * 目录不进版本库（见 plugin/.gitignore）：它是可再生的依赖产物，
 * 而且 17MB 的二进制进了 git 历史就再也瘦不下来了。
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const from = join(root, "node_modules", "kuromoji", "dict");
const to = join(root, "dict");

if (!existsSync(from)) {
  console.error("[sync-dict] 找不到 node_modules/kuromoji/dict，先跑 npm install");
  process.exit(1);
}

rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log("[sync-dict] 词典已同步到 plugin/dict");
