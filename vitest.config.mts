import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * 测试环境把 demo 素材（.mp4 / .srt）的 import 全指到空桩。
 *
 * 这两个文件在真实构建里由 esbuild 的 dataurl/text loader 打进 main.js
 * （见 esbuild.config.mjs 与 services/demoAssets.ts）；vite 这边没有对应
 * loader，默认会拿 SRT 的**文本内容**当 JS 解析然后炸掉。桩返回空字符串 ——
 * demoAssets 的恢复逻辑认「不是 data URL / 不是 SRT」会自动跳过，测试自己造
 * 文件，不依赖内置包（demoSeed.test.ts 里另有针对恢复函数的直接用例）。
 */
const demoAssetStub = {
  name: "yl-demo-asset-stub",
  enforce: "pre" as const,
  resolveId(id: string) {
    if (id.endsWith(".mp4") || id.endsWith(".srt")) return "\0yl-demo-asset-stub";
    return null;
  },
  load(id: string) {
    if (id === "\0yl-demo-asset-stub") return "export default '';";
    return null;
  },
};

/**
 * 单测默认跑在 node 环境。
 *
 * 涉及 IndexedDB 的用例需要在文件头加 `// @vitest-environment jsdom`
 * 并配 `fake-indexeddb`（真实 IndexedDB 在 Node 里不存在）。
 */
export default defineConfig({
  // 跟 esbuild.config.mjs 同一个注入点。测试里默认按开发构建跑；
  // 需要验证生产分支时直接往 resolveTargets() 传 buildEnv，不用改这里。
  define: {
    __YL_ENV__: JSON.stringify("dev"),
    __YL_BRANCH__: JSON.stringify("test"),
  },
  plugins: [demoAssetStub],
  resolve: {
    alias: {
      // obsidian 包没有 node 运行时入口，谁在测试里 import 到它就指向桩模块
      obsidian: fileURLToPath(new URL("./tests/obsidianStub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
  },
});
