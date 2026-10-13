/**
 * 生成「词典下载包」：把 `plugin/dict/` 的词典文件摆成服务端能直接吐的形状，
 * 并写出客户端要读的那份清单。
 *
 * 产物（都落在仓库根的 `storage/dict/`，与插件自更新通道的 `storage/plugin/` 并列）：
 *   storage/dict/<name>.dat.gz   —— 12 个文件，约 17MB
 *   storage/dict/dict.json       —— 清单：每个文件的相对地址 + sha256 + 字节数
 *
 * ⚠️ 为什么单独一条链子、不塞进 `plugin-release`：
 *    · 词典**不随发布包走**（社区市场只认 release 三件套，17MB 塞不进 main.js）；
 *    · 它的更新节奏也不同 —— 词典一年不动，插件一周一发，绑在一起每次发版
 *      都要重传 17MB。
 *
 * 用法：
 *   node scripts/dict-manifest.mjs        # 生成（每次重算 sha256）
 *   推送到服务端见仓库根 ./yolo 里的 dict-release（或手工 rsync storage/dict/）
 *
 * ⚠️ 词典源是 `plugin/dict/`（由 sync-dict.mjs 从 node_modules 同步来的，不入库）——
 *    所以跑之前先 `npm run sync-dict`。
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pluginDir, "..");
const from = path.join(pluginDir, "dict");
const to = path.join(repoRoot, "storage", "dict");

/** 清单版本。词典内容变了就抬它（客户端只用它显示/排错，不进安装判据）。 */
const MANIFEST_VERSION = "ipadic-1";

if (!fs.existsSync(from)) {
  console.error("[dict-manifest] 找不到 plugin/dict，先跑: npm run sync-dict");
  process.exit(1);
}

fs.mkdirSync(to, { recursive: true });

const names = fs
  .readdirSync(from)
  .filter((name) => name.endsWith(".dat.gz"))
  .sort();

if (names.length === 0) {
  console.error("[dict-manifest] plugin/dict 里没有 .dat.gz，先跑: npm run sync-dict");
  process.exit(1);
}

const files = [];
let total = 0;
for (const name of names) {
  const buffer = fs.readFileSync(path.join(from, name));
  fs.writeFileSync(path.join(to, name), buffer);
  total += buffer.length;
  files.push({
    name,
    // 相对路径：客户端拼在 serverUrl 后面，换域名不用重发清单
    url: `/storage/dict/${name}`,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    bytes: buffer.length,
  });
}

const manifest = { version: MANIFEST_VERSION, files };
fs.writeFileSync(path.join(to, "dict.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`✓ 词典包就绪: storage/dict/（${files.length} 个文件，${(total / 1048576).toFixed(1)}MB）`);
console.log("  推到服务端后，客户端从 https://younglook.cc/storage/dict/dict.json 读清单");
