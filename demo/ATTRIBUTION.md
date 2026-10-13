# 演示素材署名 / Attribution

插件首次运行时会自动把一份自带演示素材导成一集，让用户打开插件就能点开学起来，
而不是面对一个空白页。这份素材**随插件一起分发**（`plugin/demo/`，examples 式，
进版本库），不从服务器下载 —— 插件默认完全本地可用，首启零网络依赖。

## 素材清单与来源

| 项 | 内容 |
| --- | --- |
| 文件 | `demo.mp4`（视频）+ `demo.srt`（中日对照字幕） |
| 规格 | 约 10 秒 / 1.1MB，H.264 + AAC（Chromium 直接能解），横屏 16:9 |
| 制作 | 本项目自制，不含第三方素材，无需外部署名 |
| 字幕 | `demo.srt` 是本项目自己写的三条中日对照台词，就是给新用户的"开场白" |

> 若日后换成外部素材（番剧片段、他人视频），必须在此补上署名与许可，
> 并确认许可允许随插件再分发。

## 为什么进版本库（以及上一版为什么不是）

1.1MB 的 mp4 作为插件自带素材随仓库走：装插件 = 拿到素材，首启就能导入，
零网络依赖。上一版用的是 13MB 的 Wikimedia Commons 视频（CC BY 3.0），
因为体积不进版本库，走的是「发版前 `npm run fetch-demo` 下载 → 推到服务器
`/storage/plugin/demo/` → 用户首启从服务器拉」的老路 —— 那条路要求首启联网
且配好服务器，与"默认完全本地使用"冲突，已随 2026-10-03 的改动废弃：

- `scripts/fetch-demo.mjs` 已删除；
- `services/demoSeed.ts` 的下载逻辑已移除（改为直接从插件目录导入）；
- `scripts/release.mjs` 的 staging 块已移除，线上 `/storage/plugin/demo/`
  会在下次 `./yolo plugin-release`（`rsync --delete`）时被清掉，这是预期的。

上一版素材的署名信息需要时从本文件的 git 历史找回。那一代的 `demo.webm`
（13MB）已于 2026-10-04 从仓库删除 —— 现行代码只认 `demo.mp4`。

⚠️ 历史安装的善后：webm 时代铺出去的演示集作品名是「示例 · 一問一答」，
视频指向当年从服务器下载的副本。`services/demoSeed.ts` 认得这个名字
（`DEMO_LEGACY_WORK_TITLES`），启动时会把它整集换新成当前自带的
mp4 + srt —— 不需要用户手动删重导。

## 用别的素材要改哪里

换素材时改这三处，别漏：

1. `demo/` 里的文件本体（文件名保持 `demo.mp4` / `demo.srt` 最省事；
   改名的话同步改 `services/demoSeed.ts` 的 `DEMO_VIDEO_FILE` / `DEMO_SUBTITLE_FILE`）；
2. `services/demoSeed.ts` 的 `DEMO_WORK_TITLE`（列表里显示的作品名）；
3. 本文件的素材清单。

另外素材必须是**横屏**：播放器容器固定 16:9（`.yl-video-box`），竖屏素材
两侧会留大黑边。
