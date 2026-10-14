/**
 * 生成「演示素材下载包」清单：读 `storage/media/videos/` 的母带，写出客户端要读的那份清单。
 *
 * 产物（只一份，落在母带旁边）：
 *   storage/media/videos/demo.json   —— 清单：每个文件的相对地址 + sha256 + 字节数
 *
 * ⚠️ **母带即对外文件**：不再额外产出 `demo-<sha8>.mp4` 这类内容哈希副本。
 *    早期那么做是为了绕开 nginx 的 30 天 `immutable` 缓存（固定名一旦换内容，
 *    客户端会命中旧字节 → sha256 校验必然失败）。代价是同一份视频存两遍 ——
 *    用户明言「后面会弄多个很大的视频」，翻倍不能忍。现在改成清单里的 URL 带
 *    `?v=<sha8>` 查询参数：内容一变 sha8 就变、URL 就变、缓存条目就变，
 *    一样能破缓存，但只存一份。
 *
 * ⚠️ 为什么单独一条链子、不塞进 `plugin-release`：
 *    · 演示素材**不随发布包走**（社区市场只认 release 三件套；以前靠 dataurl 内联
 *      进 main.js，几 MB 的 base64 把产物撑到近 6MB，已改掉）；
 *    · 它的更新节奏也不同 —— 演示一节视频定稿后基本不动，插件一周一发。
 *
 * 用法：
 *   node scripts/demo-manifest.mjs      # 生成（每次重算 sha256）
 *   推送到服务端见仓库根 ./yolo 里的 demo-release（或手工 rsync storage/media/videos/）
 *
 * 素材源就是 `storage/media/videos/` 本身。换素材、署名与许可见 docs/feature/demo-videos.md。
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pluginDir, "..");
/** 母带目录 = 对外目录（也是清单的落点） */
const dir = path.join(repoRoot, "storage", "media", "videos");

/** 清单版本。素材换了内容只换 URL 里的 sha8，这个字段给客户端显示/排错用。 */
const MANIFEST_VERSION = "demo-1";

/** 演示包里的两件套：文件名即客户端落盘时用的名字（importSubtitle 按它区分视频/字幕）。 */
const SOURCES = ["demo.mp4", "demo.srt"];

if (!fs.existsSync(dir)) {
  console.error("[demo-manifest] 找不到 storage/media/videos/");
  process.exit(1);
}

/** 对外 URL 前缀（nginx 的 /storage/ alias 到仓库根 storage/） */
const URL_PREFIX = "/storage/media/videos";

const files = [];
let total = 0;
for (const name of SOURCES) {
  const sourcePath = path.join(dir, name);
  if (!fs.existsSync(sourcePath)) {
    console.error(`[demo-manifest] 缺少 storage/media/videos/${name}`);
    process.exit(1);
  }
  const buffer = fs.readFileSync(sourcePath);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  total += buffer.length;
  files.push({
    // name = 客户端落盘时用的文件名；
    // url = 服务端取件地址（相对路径，客户端拼在 serverUrl 后面，换域名不用重发清单）。
    //      ?v= 带内容哈希前 8 位：换素材即换 URL，绕开 nginx 30 天 immutable 缓存。
    name,
    url: `${URL_PREFIX}/${name}?v=${sha256.slice(0, 8)}`,
    sha256,
    bytes: buffer.length,
  });
}

const manifest = { version: MANIFEST_VERSION, files };
fs.writeFileSync(path.join(dir, "demo.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`✓ 演示包清单就绪: storage/media/videos/（${files.length} 个文件，${(total / 1048576).toFixed(2)}MB）`);
console.log("  推到服务端后，客户端从 https://younglook.cc/storage/media/videos/demo.json 读清单");
