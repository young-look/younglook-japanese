/**
 * 演示素材的**按需下载**：用户在首页那条「示例」上点「开始学」时，从服务端拉一份
 * （演示视频 + 中日对照字幕），校验后交给现成的导入流程落成一集。
 *
 * ══ 为什么是下载，而不是打进 main.js ══════════════════════════════
 * 以前演示素材由 esbuild 的 loader 静态内联（mp4 → dataurl、srt → text），
 * 几 MB 的视频变成 base64 塞进 main.js，把产物从几百 KB 撑到近 6MB —— 安装慢、
 * 更新慢、社区市场的审核也不喜欢大包。视频属于**资源**不是代码，官方政策允许
 * 运行时下载（与词典同一套论证，见 services/dictInstall.ts 的头注释）。
 *
 * ══ 为什么单独一条通道，不与词典/自更新合并 ══════════════════════
 * 三条链子改的东西不同（一个添资源、一个添资源、一个改代码），回滚口径也不同。
 * 这里只借用 dictInstall / update 的两条纪律：
 *  · **先全部下载 + 全部 sha256 校验，通过之后才交给导入**；
 *  · 落盘走「下到内存 → 校验 → 才写文件」，校验不过的删掉重下，不留半个文件。
 * 不做目录级原子 rename —— `importSubtitle` 经 `takeIntoMediaDir` 把文件**复制**
 * 进素材库，暂存目录只是一次性的复制源，天然不需要原子换。
 *
 * 🔒 **导入成功之后才落 `demoSeeded` 标记**（见 demo.ts）：先落标记会让首页占位行
 *    消失，而演示又没真的进来 —— 正是"装完一片空白"那种静默缺口。
 *
 * ⚠️ 下载源在 `settings.serverUrl` 后面拼 `DEMO_MANIFEST_PATH`（nginx 直接吐静态
 *    文件，不经过后端）—— 换域名不用重发清单。
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensureAppDataSubdir } from "./appData";
import { DEMO_WORK_TITLE, markDemoSeeded } from "./demo";
import { importSubtitle } from "./importer";
import type { VaultDb } from "../storage/db";

/** 演示包清单在服务端 storage 里的位置 */
export const DEMO_MANIFEST_PATH = "/storage/media/videos/demo.json";

/** 暂存目录名 —— 落在应用数据目录下（vault **外**），免得几 MB 临时文件被 Sync 上传。 */
export const DEMO_STAGING_DIR_NAME = "demo.staging";

export interface DemoFile {
  /** 客户端落盘时用的文件名（就是服务端清单里的原始名：demo.mp4 / demo.srt） */
  name: string;
  /** 清单里的相对路径（`/storage/media/videos/…`），fetch 前归一化成绝对地址 */
  url: string;
  sha256: string;
  /** 字节数。清单给了就用来显示总体积/进度；缺了当 0（只是少个数，不影响安装） */
  bytes: number;
}

export interface DemoManifest {
  version: string;
  files: DemoFile[];
}

export type FetchLike = (input: string) => Promise<Response>;

/** 清单里的文件名只允许纯文件名 —— 带路径分隔符 / `..` 的一律拒收（不许写到目录外）。 */
function isSafeName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !/[/\\]/u.test(name);
}

/**
 * 读服务端的演示包清单。任何异常（404 / 断网 / 格式不对 / 一个文件都没有）
 * 返回 null —— 演示没得下只是"少一个样片"，绝不能让它变成一条报错把首页打断。
 */
export async function fetchDemoManifest(
  serverUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<DemoManifest | null> {
  const base = serverUrl.trim().replace(/\/+$/u, "");
  if (!base) return null;
  try {
    // nginx 对 /storage/ 下发长缓存 —— 时间戳破缓存，拿到的永远是最新清单
    const response = await fetchImpl(`${base}${DEMO_MANIFEST_PATH}?t=${Date.now()}`);
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown; files?: unknown };
    if (!Array.isArray(body.files) || body.files.length === 0) return null;

    const files: DemoFile[] = [];
    for (const raw of body.files as Array<Record<string, unknown>>) {
      const name = typeof raw?.name === "string" ? raw.name.trim() : "";
      const url = typeof raw?.url === "string" ? raw.url.trim() : "";
      const sha256 = typeof raw?.sha256 === "string" ? raw.sha256.trim().toLowerCase() : "";
      if (!isSafeName(name) || !url || !sha256) return null;
      let absolute: URL;
      try {
        // 渲染进程里 fetch 相对路径会以 app://obsidian.md 为基准解析，必然失败 ——
        // 这里统一归一化成绝对地址，下载方不用关心清单怎么写。
        absolute = new URL(url, `${base}/`);
      } catch {
        return null;
      }
      files.push({
        name,
        url: absolute.toString(),
        sha256,
        bytes: Number.isFinite(raw?.bytes) ? Math.max(0, Number(raw.bytes)) : 0,
      });
    }
    return { version: typeof body.version === "string" ? body.version.trim() : "", files };
  } catch {
    return null;
  }
}

/** 清单里所有文件的字节数之和（清单缺 bytes 时是 0，界面据此决定要不要显示体积）。 */
export function demoManifestBytes(manifest: DemoManifest): number {
  return manifest.files.reduce((sum, file) => sum + file.bytes, 0);
}

export interface DemoPackProgress {
  /** 已经就位的文件数（含这次跳过重下的） */
  done: number;
  total: number;
  /** 已经下到本机的字节数 */
  bytes: number;
  /** 清单声明的总体积；0 = 清单没给 */
  bytesTotal: number;
  /** 刚处理完的文件名 */
  name: string;
}

export interface InstallDemoPackOptions {
  db: VaultDb;
  /** 素材库目录：演示素材经 importSubtitle 收进其中（调用方传本机空间的素材库，
   *  与用户导入同一个落点 —— 演示素材没有单独的目录，见 mediaStore.resolveMediaDir） */
  mediaDir: string;
  manifest: DemoManifest;
  fetchImpl?: FetchLike;
  onProgress?: (progress: DemoPackProgress) => void;
  /**
   * 暂存目录。默认落在应用数据目录下的 `demo.staging`（vault 外）。
   * 仅供测试注入临时目录 —— 生产调用方不要传。
   */
  stagingDir?: string;
}

export type InstallDemoPackResult =
  | { ok: true; recordCid: string }
  | { ok: false; reason: string };

/** 文件已在暂存目录里、且 sha 对得上 = 上一趟下过的，直接跳过（按文件粒度的断点续传）。 */
function stagedIsValid(target: string, sha256: string): boolean {
  try {
    if (!fs.existsSync(target)) return false;
    const digest = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    return digest === sha256;
  } catch {
    return false;
  }
}

const isVideoName = (name: string): boolean => /\.(mp4|webm|mov|mkv|m4v)$/iu.test(name);
const isSubtitleName = (name: string): boolean => /\.(srt|ass|ssa|vtt|lrc)$/iu.test(name);

/**
 * 下载演示包并导成一集。
 *
 * 顺序：逐个文件「下载 → sha256 校验 → 写进暂存目录」；**全部就位之后**才调用
 * `importSubtitle` 把它导成一集（素材照常收进素材库）。成功后才落 `demoSeeded`
 * 标记、清掉暂存目录。
 *
 * 中途任何失败：返回 `{ ok:false, reason }`，让界面说"下载失败，再试一次"。
 * 暂存目录**故意留着** —— 已经下好且校验过的文件下一趟按 sha 跳过，"下到一半断了"
 * 不用从头再来。导入失败（例如重名）同样不落标记，占位行会继续挂着。
 */
export async function installDemoPack(opts: InstallDemoPackOptions): Promise<InstallDemoPackResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const staging = opts.stagingDir ?? ensureAppDataSubdir(DEMO_STAGING_DIR_NAME);
  fs.mkdirSync(staging, { recursive: true });

  // 暂存目录**不清空** —— 上次断在半路时里面躺着的都是校验过的成品，重来直接跳过。
  // 只把「这次清单里没有的」清掉（清单换版时留着的旧文件不该混进来）。
  const wanted = new Set(opts.manifest.files.map((file) => file.name));
  for (const entry of fs.readdirSync(staging)) {
    if (!wanted.has(entry)) fs.rmSync(path.join(staging, entry), { recursive: true, force: true });
  }

  const total = opts.manifest.files.length;
  const bytesTotal = demoManifestBytes(opts.manifest);
  let bytes = 0;

  try {
    for (let index = 0; index < total; index += 1) {
      const file = opts.manifest.files[index];
      const target = path.join(staging, file.name);

      if (!stagedIsValid(target, file.sha256)) {
        const response = await fetchImpl(file.url);
        if (!response.ok) throw new Error(`下载 ${file.name} 失败（HTTP ${response.status}）`);
        const buffer = Buffer.from(await response.arrayBuffer());
        const digest = createHash("sha256").update(buffer).digest("hex");
        if (digest !== file.sha256) {
          // 校验不过 = 这个文件不能留：留着下一趟会被 stagedIsValid 当成"下好了"
          fs.rmSync(target, { force: true });
          throw new Error(`${file.name} 校验失败`);
        }
        fs.writeFileSync(target, buffer);
        bytes += buffer.length;
      } else {
        bytes += fs.statSync(target).size;
      }

      opts.onProgress?.({ done: index + 1, total, bytes, bytesTotal, name: file.name });
    }

    // 按扩展名认视频/字幕，别把名字写死成 demo.mp4（清单里的 name 才是权威）
    const video = opts.manifest.files.find((file) => isVideoName(file.name));
    const subtitle = opts.manifest.files.find((file) => isSubtitleName(file.name));
    if (!video || !subtitle) return { ok: false, reason: "演示包缺少视频或字幕文件。" };

    const outcome = await importSubtitle(opts.db, {
      subtitlePath: path.join(staging, subtitle.name),
      videoPath: path.join(staging, video.name),
      workTitle: DEMO_WORK_TITLE,
      // 不是番剧，集号留空（留空会排到列表最后，不会跟用户自己的正片抢位置）
      number: "",
      mediaDir: opts.mediaDir,
    });
    if (!outcome.ok) return { ok: false, reason: outcome.reason };

    // 🔒 只有真的导进来了才落标记（顺序不能反，见文件头）
    await markDemoSeeded(opts.db);
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: true, recordCid: outcome.result.recordCid };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "下载失败" };
  }
}
