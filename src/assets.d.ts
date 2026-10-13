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

// 内置演示素材（plugin/demo/）：mp4 走 dataurl 打成 base64 data URL 字符串，
// srt 走 text 拿到字幕源码。二者由 services/demoAssets.ts 消费，启动时若插件
// 目录里缺文件就落盘一份（社区商店/BRAT 只装三件套，目录不跟过去）。
declare module "*.mp4" {
  const src: string;
  export default src;
}

declare module "*.srt" {
  const source: string;
  export default source;
}
