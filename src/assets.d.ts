// 图片资源经 esbuild 的 dataurl loader 内联成 base64 data URL 字符串（见 esbuild.config.mjs）。
declare module "*.png" {
  const src: string;
  export default src;
}

// SVG 走 esbuild 的 text loader，拿到的是**源码字符串**（不是 data URL）。
// 存储页那三枚去向图标要现插进 DOM、并让 fill="currentColor" 跟着主题走，
// 所以必须是源码而不是 `<img src>` 用的 data URL。见 esbuild.config.mjs 的 loader。
declare module "*.svg" {
  const source: string;
  export default source;
}

// ⚠️ 演示素材（demo.mp4 / demo.srt）已不再经 esbuild 内联进 main.js ——
// 改走服务端按需下载（services/demoPack.ts）。所以这里不再有 *.mp4 / *.srt 声明。
