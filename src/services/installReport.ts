/**
 * 「按需资源装成功」的一次上报。
 *
 * ══ 为什么需要它 ══════════════════════════════════════════════════════
 * 词典（17MB）和示例素材（视频 + 字幕）都由 nginx 直接吐静态文件
 * （`/storage/…`），**不经过 Django** —— 下载这件事在服务端原先没有任何
 * 痕迹，连「装了多少人」都答不上来。装成功之后报一次，OPS 的
 * 「安装与下载」页才有数据（服务端 `ops/api.py`）。
 *
 * 口径：**下载并安装成功 = 安装成功**。点过「下载」按钮但中途失败的不报，
 * 断点续传下一次装成了才算 —— 这条记录代表「他真的用上了」。
 *
 * 🔒 三条纪律（改之前先读完）
 *  · **不需要登录**：刚装好插件的人还没账号，要求登录会把绝大多数真实安装
 *    漏掉。服务端按来源 IP 去重，用户什么都不用做。
 *  · **fire-and-forget**：绝不 await 在用户的操作路径上，失败只写日志。
 *    上报挂了绝不能变成用户眼前的一条报错 —— 东西已经装好了。
 *  · **只报三件事**：装了什么（dict / demo）、资源版本、插件版本。
 *    不带文件名、不带路径、不带任何学习内容、不带账号信息。
 *    见 README「联网与数据」。
 */
import type { PluginSettings } from "../settings/types";
import { log } from "../core/logger";

/** 目前只有两类按需资源，与服务端 `AssetInstall.KIND_CHOICES` 一一对应 */
export type InstallKind = "dict" | "demo";

export interface InstallReportOptions {
  settings: PluginSettings;
  kind: InstallKind;
  /** 服务端清单里的资源版本（`dict.json` / `demo.json` 的 version），可能为空串 */
  assetVersion: string;
  /** 插件自己的版本（`manifest.version`），用来排查「老版本装不上」 */
  pluginVersion: string;
  /** 仅供测试注入；生产不传，走全局 fetch */
  fetchImpl?: typeof fetch;
}

/**
 * 上报一次安装成功。**同步返回、不抛异常**：调用方拿到就忘掉它。
 */
export function reportAssetInstall(opts: InstallReportOptions): void {
  const base = opts.settings.serverUrl.trim().replace(/\/+$/u, "");
  // 没配服务端就没地方报（自建/离线场景），静默跳过
  if (!base) return;

  const doFetch = opts.fetchImpl ?? fetch;
  void (async () => {
    try {
      const response = await doFetch(`${base}/api/v1/installs/report/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: opts.kind,
          version: opts.assetVersion,
          plugin_version: opts.pluginVersion,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        // 404（服务端还是旧版）不该打扰用户：下次装东西再报
        log.warn(`安装上报未成功：HTTP ${response.status}`);
      }
    } catch (error) {
      log.warn("安装上报失败（不影响使用）", error);
    }
  })();
}
