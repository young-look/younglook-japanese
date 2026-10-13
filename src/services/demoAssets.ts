/**
 * 内置演示素材的**打包态**：demo.mp4 / demo.srt 由 esbuild 的 loader 静态
 * 打进 main.js（mp4 → dataurl、srt → text，见 esbuild.config.mjs），不依赖
 * 插件目录里有没有实物文件。
 *
 * ══ 为什么需要它 ══════════════════════════════════════════
 * Obsidian 社区商店 / BRAT 只安装 Release 里的三件套（main.js / manifest.json /
 * styles.css），`plugin/demo/` 目录不会跟过去。原先「启动时从插件目录读素材」
 * 的做法下，公开渠道用户的演示素材永远是缺的，而且是**静默的缺**（代码刻意
 * 不报错）—— 用户看到的就是「装完插件一片空白」。
 *
 * 词典 17MB 走「首次使用时下载」是因为体积不许进包；demo 才 1.1MB，dataurl
 * 内联后 main.js 涨约 1.5MB，一次构建、全渠道可用，比再养一条下载通道划算
 * （用户拍板 2026-10-12：以后就默认这一个演示视频）。
 *
 * ══ 消费方式 ══════════════════════════════════════════════
 * 只有 demoSeed.ts 用：启动时若插件目录里缺文件，用这里的内置包补一份到磁盘，
 * 之后的探测 / 导入 / 收素材库全部走原有逻辑，一行不用改。自建渠道（软链装、
 * 手工拷整个目录）的用户磁盘上本来就有文件，这条路不会触发。
 *
 * ⚠️ 测试环境（vitest/vite）里 import 进来的是 URL 而不是内容 ——
 * `dataUrlToBytes` 认不出 data URL 会返回 null，恢复逻辑自动跳过，
 * 测试自己造文件，不依赖这条路径。
 */

import DEMO_VIDEO_DATA_URL from "../../demo/demo.mp4";
import DEMO_SUBTITLE_TEXT from "../../demo/demo.srt";

/** 打进 main.js 的演示视频（data URL）。非 data URL = 没走 esbuild 构建（测试环境）。 */
export const bundledDemoVideoUrl = DEMO_VIDEO_DATA_URL;

/** 打进 main.js 的演示字幕（SRT 源码）。 */
export const bundledDemoSubtitleText = DEMO_SUBTITLE_TEXT;

/**
 * data URL（`data:…;base64,…`）→ 字节数组。
 *
 * 不是 data URL（测试环境 vite 给的是路径/URL）返回 null —— 调用方据此
 * 判断「这次构建没带内置包」，跳过恢复而不是写出垃圾文件。
 */
export function dataUrlToBytes(url: string): Uint8Array | null {
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const binary = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 字幕内容是不是真 SRT（而不是测试环境给出的 URL）。
 *
 * 判据用时间轴箭头 `-->`：SRT 的硬特征，URL/路径里不可能出现。
 * 视频那边有 data URL 前缀兜底，字幕没有类似前缀，只能按内容认。
 */
export function looksLikeSrt(text: string): boolean {
  return text.includes("-->");
}
