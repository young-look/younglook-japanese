import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * 单测默认跑在 node 环境。
 *
 * 涉及 IndexedDB 的用例需要在文件头加 `// @vitest-environment jsdom`
 * 并配 `fake-indexeddb`（真实 IndexedDB 在 Node 里不存在）。
 *
 * ⚠️ 以前这里挂过一个把 `.mp4`/`.srt` import 指到空桩的插件 —— 那时演示素材
 * 由 esbuild 的 loader 内联进 main.js。现在演示素材改走服务端按需下载
 * （services/demoPack.ts），代码里不再 import 这两个扩展名，桩随之删除。
 */
export default defineConfig({
  // 跟 esbuild.config.mjs 同一个注入点。测试里默认按开发构建跑；
  // 需要验证生产分支时直接往 resolveTargets() 传 buildEnv，不用改这里。
  define: {
    __YL_ENV__: JSON.stringify("dev"),
    __YL_BRANCH__: JSON.stringify("test"),
  },
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
