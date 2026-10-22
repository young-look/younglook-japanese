/**
 * 从服务端提示词唯一源头生成插件的 TS 常量。
 *
 * 为什么要有这一步：内置模型与 BYOK 走两条链路，但**提示词口径必须一致** ——
 * 否则用户会看到「用自己的 Key 判对、用内置模型判错」。服务端不再能依赖
 * （BYOK 的定位就是服务器连不上时的退路），所以插件包里必须内嵌同一份文案。
 * 这份文案的唯一源头是 `core/learning/services/hosted_prompts.py`，
 * 这里在构建时把它解析成 `src/services/ai/prompts.gen.ts` —— 手抄双份由此消失。
 *
 * 解析只覆盖 `NAME = "…".join([...])` 形式的**字符串常量列表**，必须忠实于
 * Python 语义：同一元素里相邻的字面量（中间无逗号）是**隐式拼接**（不分隔），
 * 元素之间用 join 分隔符连接 —— 搞错这点就会静默漂移。
 *
 * 生成物进版本库（不像 dict/）：它是几 KB 的文本，进 git 让 diff 可审。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 两种仓库布局都要能跑：
//  · monorepo（本仓库）：scripts/..  = plugin/，再往上一级才是根，core/ 在根下；
//  · 公开仓库 young-look/younglook-japanese：**plugin/ 就是仓库根**，没有 core/。
// 所以路径一律先按 plugin 目录锚定，core/ 再去探测 —— 写死的 `../../core` 在公开仓库里
// 会指到仓库外面（`npm run build` 直接退出 1，社区目录的 Build verification 就是这么挂的）。
const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..");
const pyPath = join(pluginDir, "..", "core", "learning", "services", "hosted_prompts.py");
const outPath = join(pluginDir, "src", "services", "ai", "prompts.gen.ts");

const PROMPTS = ["ANALYZE_SYSTEM", "ANALYZE_WORDS_SYSTEM", "IMITATION_SYSTEM", "ASK_SYSTEM"];

let py = "";
if (existsSync(pyPath)) {
  py = readFileSync(pyPath, "utf8");
} else if (existsSync(outPath)) {
  // 公开仓库里没有 Django 端（core/ 不随插件发版）。生成物已在版本库里，
  // 直接用它 —— 单一来源在 monorepo 内仍然强制（那边 core/ 一定在，会走正常同步）。
  console.log("[sync-prompts] 找不到提示词源头（公开仓库布局），沿用已提交的 prompts.gen.ts");
  process.exit(0);
} else {
  console.error("[sync-prompts] 既找不到 core/learning/services/hosted_prompts.py，也没有已生成的 prompts.gen.ts");
  process.exit(1);
}

/** 解析 Python 字符串字面量（单/双引号），处理常见转义。返回 [内容, 结束位置]。 */
function parseLiteral(src, start) {
  const quote = src[start];
  let i = start + 1;
  let out = "";
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      const next = src[i + 1];
      const escapes = { "\\": "\\", "'": "'", '"': '"', n: "\n", t: "\t", r: "\r" };
      if (next in escapes) {
        out += escapes[next];
        i += 2;
        continue;
      }
      out += ch; // 未知转义按 Python 的规矩原样保留反斜杠
      i += 1;
      continue;
    }
    if (ch === quote) return [out, i + 1];
    out += ch;
    i += 1;
  }
  throw new Error("字符串字面量没有闭合");
}

/** 解析 `"sep".join([...])` 列表体：按顶层逗号分元素，元素内相邻字面量隐式拼接。 */
function parseJoinList(body, separator) {
  const elements = [];
  let current = "";
  let sawElement = false;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"' || ch === "'") {
      const [text, next] = parseLiteral(body, i);
      current += text;
      sawElement = true;
      i = next;
      continue;
    }
    if (ch === "#") {
      while (i < body.length && body[i] !== "\n") i += 1;
      continue;
    }
    if (ch === ",") {
      elements.push(current);
      current = "";
      sawElement = false;
      i += 1;
      continue;
    }
    if (ch === "]") {
      if (sawElement || current !== "") elements.push(current);
      return elements.join(separator);
    }
    i += 1; // 空白、换行
  }
  throw new Error("列表没有闭合");
}

const prompts = {};
for (const name of PROMPTS) {
  const header = py.match(new RegExp(`${name} = ("(?:[^"\\\\]|\\\\.)*")\\.join\\(\\[`));
  if (!header) {
    console.error(`[sync-prompts] 在 hosted_prompts.py 里找不到 ${name} = "…".join([…])`);
    process.exit(1);
  }
  const separator = JSON.parse(header[1]);
  const start = header.index + header[0].length;
  // 从列表体开始找配对的 `])`：字面量内部可能出现 ]，所以用计数扫描
  const body = py.slice(start);
  let close;
  {
    let cursor = 0;
    let depth = 1; // header 已经吃掉 `[`
    for (;;) {
      const ch = body[cursor];
      if (ch === '"' || ch === "'") {
        cursor = parseLiteral(body, cursor)[1];
        continue;
      }
      if (ch === "[") depth += 1;
      if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          close = cursor;
          break;
        }
      }
      cursor += 1;
      if (cursor > body.length) throw new Error(`${name} 列表没有闭合`);
    }
  }
  prompts[name] = parseJoinList(body.slice(0, close + 1), separator); // 含闭括号本身
}

const banner = `// ⚠️ 自动生成，别手改 —— 构建时由 scripts/sync-prompts.mjs 从
// core/learning/services/hosted_prompts.py 生成（sha1 ${createHash("sha1").update(py).digest("hex").slice(0, 12)}）。
// 背景：BYOK 直连用户自己的端点、不经过服务端，提示词必须打进插件包；
// 唯一源头在服务端那份 python 文件，两边口径一致靠生成而不是靠人抄。
`;

const body = PROMPTS.map((name) => `export const ${name} = ${JSON.stringify(prompts[name])};`).join("\n\n");

writeFileSync(outPath, `${banner}\n${body}\n`, "utf8");
console.log(`[sync-prompts] ${PROMPTS.length} 份提示词已生成到 src/services/ai/prompts.gen.ts`);
