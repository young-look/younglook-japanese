/**
 * 日语词典的**按需安装**：首次使用时从服务器拉一份，落到插件目录的 `dict/`。
 *
 * ══ 为什么词典要下来，而不是随包发 ══════════════════════════════
 * kuromoji 的 IPADIC 是 **17MB** 的压缩二进制，且是**运行时**按路径读的
 * （`builder({dicPath})`），esbuild 打不进 main.js（见 `sync-dict.mjs`）。
 * 社区市场的发布形态只认 release 里的三件套（main.js / manifest.json /
 * styles.css），17MB 的词典既不进去、也不该塞进 main.js（base64 内联要让
 * main.js 涨到 22MB，市场里没有先例）。所以它只能**按需下载**。
 *
 * ══ 为什么它和「插件自更新」不是一回事 ══════════════════════════
 * 自更新是**改插件自身**，社区目录明确禁止（2026-10-18 整条链路已删除，
 * 见 README「联网与数据」）；词典是用户的**数据/资源**，官方政策允许运行时
 * 下载外部资源（Copilot 下载 opencode、Smart Connections 下载 embedding
 * 模型都是既有实践）。
 * 纪律（清单 + sha256 + 原子落盘）以后若还复用，记住**别把它变成自更新**：
 * 一个改代码、一个添资源，回滚口径完全不同。
 *
 * 🔒 三条铁律（与 update 同款，理由一样）：
 *  · **先全部下载 + 全部 sha256 校验，通过之后才碰磁盘上的旧词典** —— 任何一步
 *    失败都原样退出，绝不出现"下了一半"的词典（分词器读到坏词典会直接抛错）；
 *  · 落盘走「临时目录 → 整体 rename」的原子操作，旧目录留 `.bak` 可手工回滚；
 *  · 校验不过的文件**删掉重下**，不留半成品（下一趟接着用等于把坏文件当好文件）。
 *
 * ⚠️ 下载源在 `settings.serverUrl` 后面拼 `DICT_MANIFEST_PATH`（nginx 直接吐
 *    静态文件，不经过后端）—— 换域名不用重发清单。
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 词典清单在服务端 storage 里的位置（目录布局见仓库根 storage/README.md） */
export const DICT_MANIFEST_PATH = "/storage/assets/dict/dict.json";

/** 词典落在插件目录下的子目录名 —— 必须与 `dictPath.ts` 的候选路径一致 */
export const DICT_DIR_NAME = "dict";

/**
 * 「装好了」的判据：这个文件在，分词器才建得起来。
 * （kuromoji 的 build 一上来就读它，缺了必抛；拿它当哨兵文件与 `dictPath.ts` 同口径。）
 */
export const DICT_SENTINEL = "base.dat.gz";

export interface DictFile {
  name: string;
  /** 清单里的相对路径（`/storage/assets/dict/…`），fetch 前归一化成绝对地址 */
  url: string;
  sha256: string;
  /** 字节数。清单给了就用来显示总体积/进度；缺了当 0（只是少个数，不影响安装） */
  bytes: number;
}

export interface DictManifest {
  version: string;
  files: DictFile[];
}

import { httpFetch, type FetchLike } from "./http";

/** 词典目录（安装目标）。 */
export function dictDirOf(pluginDir: string): string {
  return path.join(pluginDir, DICT_DIR_NAME);
}

/** 词典是不是已经装好（哨兵文件在）。任何 IO 异常都当"没装"。 */
export function isDictInstalled(pluginDir: string): boolean {
  try {
    return fs.existsSync(path.join(dictDirOf(pluginDir), DICT_SENTINEL));
  } catch {
    return false;
  }
}

/** 清单里的文件名只允许纯文件名 —— 带路径分隔符 / `..` 的一律拒收（不许写到目录外）。 */
function isSafeName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !/[/\\]/u.test(name);
}

/**
 * 读服务端的词典清单。任何异常（404 / 断网 / 格式不对 / 一个文件都没有）
 * 返回 null —— 词典没得下只是"注音没了"，绝不能让它变成一条报错把页面打断。
 */
export async function fetchDictManifest(
  serverUrl: string,
  fetchImpl: FetchLike = httpFetch,
): Promise<DictManifest | null> {
  const base = serverUrl.trim().replace(/\/+$/u, "");
  if (!base) return null;
  try {
    // nginx 对 /storage/ 下发长缓存 —— 时间戳破缓存，拿到的永远是最新清单
    const response = await fetchImpl(`${base}${DICT_MANIFEST_PATH}?t=${Date.now()}`);
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown; files?: unknown };
    if (!Array.isArray(body.files) || body.files.length === 0) return null;

    const files: DictFile[] = [];
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
export function manifestBytes(manifest: DictManifest): number {
  return manifest.files.reduce((sum, file) => sum + file.bytes, 0);
}

export interface DictProgress {
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

export interface InstallDictOptions {
  fetchImpl?: FetchLike;
  onProgress?: (progress: DictProgress) => void;
}

export interface InstallDictResult {
  /** 词典目录的绝对路径 */
  dir: string;
  bytes: number;
  /** 这次真的走了网络的文件数（其余是断点续传跳过的） */
  downloaded: number;
}

/** 文件已经在暂存目录里、且 sha 对得上 = 上一趟下过的，直接跳过（按文件粒度的断点续传）。 */
function alreadyStaged(target: string, sha256: string): boolean {
  try {
    if (!fs.existsSync(target)) return false;
    const digest = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    return digest === sha256;
  } catch {
    return false;
  }
}

/**
 * 下载并安装词典。
 *
 * 顺序：逐个文件「下载 → sha256 校验 → 写进暂存目录」；**全部就位之后**才把
 * 正式目录换掉（旧的先改名 `.bak`，换成功再删）。中途任何一步失败：正式目录
 * 一个字节没动，抛出去让界面说"下载失败，再试一次"。
 *
 * 下一趟重试时暂存目录还在（它就是为断点续传留的）—— 已经下好的文件按 sha
 * 跳过，所以"下到 11/12 断了"不会从头再来。
 */
export async function installDict(
  pluginDir: string,
  manifest: DictManifest,
  opts: InstallDictOptions = {},
): Promise<InstallDictResult> {
  const fetchImpl = opts.fetchImpl ?? httpFetch;
  const staging = path.join(pluginDir, `${DICT_DIR_NAME}.staging`);
  // 🔥 暂存目录**不清空** —— 上次断在半路时里面躺着的都是校验过的成品，重来直接跳过。
  //    只把「这次清单里没有的」清掉（清单换了版本时留着的旧文件不该混进正式目录）。
  fs.mkdirSync(staging, { recursive: true });
  const wanted = new Set(manifest.files.map((file) => file.name));
  for (const entry of fs.readdirSync(staging)) {
    if (!wanted.has(entry)) fs.rmSync(path.join(staging, entry), { recursive: true, force: true });
  }

  const total = manifest.files.length;
  const bytesTotal = manifestBytes(manifest);
  let bytes = 0;
  let downloaded = 0;

  // 🔥 暂存目录**故意留着**（出错也不删）：里面每个文件都是「下完且校验过」
  //    才写进去的（下载落在内存里、校验过了才 writeFileSync），不会出现半个文件。
  //    断网 / 关 Obsidian 之后重来，`alreadyStaged` 会把下好的那些按 sha 跳过 ——
  //    "下到 11/12 断了"不用从头再来。校验不过的那一个在上面已经删掉了，
  //    下一趟会重下它，不会把坏文件当好文件。
  for (let index = 0; index < total; index += 1) {
    const file = manifest.files[index];
    const target = path.join(staging, file.name);

    if (!alreadyStaged(target, file.sha256)) {
      const response = await fetchImpl(file.url);
      if (!response.ok) throw new Error(`下载 ${file.name} 失败（HTTP ${response.status}）`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const digest = createHash("sha256").update(buffer).digest("hex");
      if (digest !== file.sha256) {
        // 校验不过 = 这个文件不能留：留着下一趟会被 alreadyStaged 当成"下好了"
        fs.rmSync(target, { force: true });
        throw new Error(`${file.name} 校验失败，已放弃安装`);
      }
      fs.writeFileSync(target, buffer);
      downloaded += 1;
      bytes += buffer.length;
    } else {
      bytes += fs.statSync(target).size;
    }

    opts.onProgress?.({ done: index + 1, total, bytes, bytesTotal, name: file.name });
  }

  // ── 到这一步才算"下载完成"：换目录 ────────────────────────────────
  const dir = dictDirOf(pluginDir);
  const backup = `${dir}.bak`;
  fs.rmSync(backup, { recursive: true, force: true });
  const hadOld = fs.existsSync(dir);
  if (hadOld) fs.renameSync(dir, backup);
  try {
    fs.renameSync(staging, dir);
  } catch (error) {
    // rename 半路失败：把旧词典还原回去，别让插件目录里一本词典都没有
    if (hadOld && !fs.existsSync(dir)) fs.renameSync(backup, dir);
    throw error;
  }
  fs.rmSync(backup, { recursive: true, force: true });
  return { dir, bytes, downloaded };
}
