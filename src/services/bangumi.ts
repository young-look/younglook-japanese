/**
 * Bangumi 免费元数据 —— 导入弹窗「自动识别」的第二个来源（第一个是本地
 * 文件名解析 guess.ts）。作品名/年份/集标题从 api.bgm.tv 免费拿，平台
 * 一分钱不出、一个请求不经自家后端。
 *
 * 三条铁律：
 *  - **可降级**：断网、超时、查无结果一律静默回落成「没查到」，导入主流程
 *    本来就是纯本地的，这里只是锦上添花，绝不能拦路。
 *  - **守规矩**：Bangumi 要求自定义 User-Agent（默认浏览器 UA 会被限流），
 *    所以必须走 obsidian 的 requestUrl（Electron 主进程能改 UA，渲染层
 *    fetch 禁改）。obsidian 模块的取法统一走 http.ts 的 loadRequestUrl
 *    （require 优先 —— 在插件沙箱里动态 import("obsidian") 解析不到，
 *    旧写法在这里静默挂过）；单测只测本模块的纯函数，不碰网络。
 *  - **少打扰**：同一个识别词的查询结果进 localStorage（连「查无结果」
 *    也负缓存），缓存未过期绝不二次请求。
 */

import { loadRequestUrl } from "./http";

export interface BgmSubject {
  id: number;
  /** Bangumi 收录的日文/官方名 */
  name: string;
  /** 中文名，可能为空 */
  nameCn: string;
  year: number | null;
  /** 与查询串的相似度 0~100 */
  score: number;
}

interface BgmSearchItem {
  id: number;
  name?: string;
  name_cn?: string;
  date?: string;
}

interface BgmEpisodeItem {
  type?: number;
  ep?: number | string;
  name?: string;
  name_cn?: string;
}

const BGM_BASE = "https://api.bgm.tv";

/**
 * UA 里的插件版本由 `main.ts` 启动时注入（`manifest.version`）。
 *
 * ⚠️ **不许在这里写死版本号**：写死一次就等于埋一次「UA 说 0.2.1、manifest 说 0.1.3」的
 * 错位（2026-10-21 上架复核时就是这么发现的）。Bangumi 拿 UA 认人，版本不对会误导对方限流排查。
 */
let uaVersion = "0.0.0";

export function setBgmVersion(version: string): void {
  const trimmed = (version ?? "").trim();
  if (trimmed) uaVersion = trimmed;
}

function userAgent(): string {
  return `young-look-obsidian/${uaVersion} (https://younglook.cc)`;
}
const REQUEST_TIMEOUT_MS = 6000;

const SUBJECT_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 收录信息基本不变，缓半年
const EPISODES_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 搜索结果里相似度至少要这么高才敢自动填，低了宁可让人手填。 */
const ADOPT_MIN_SCORE = 60;

// ── 标题相似度（口径对齐 core/library/services/parsing.py 的严格版）──

/**
 * 归一化到「只留有信息量的字符」：去标点、空格、大小写、下划线和弯撇号。
 * BT 标题里 `It's` 的撇号有直有弯、`BanG_Dream` 的下划线是空格 ——
 * 不清掉的话正确的匹配会被这些小人难住。
 */
export function normalizeForMatch(text: string): string {
  const value = (text ?? "").normalize("NFKC").toLowerCase();
  return value
    .replace(/[’‘_]/gu, "")
    .replace(/[^\p{L}\p{N}\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+/gu, "");
}

function diceBigrams(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = (s: string) => {
    const counts = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const gram = s.slice(i, i + 2);
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    return counts;
  };
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const shortGrams = grams(shorter);
  const longGrams = grams(longer);
  let overlap = 0;
  for (const [gram, count] of shortGrams) {
    overlap += Math.min(count, longGrams.get(gram) ?? 0);
  }
  const total = shorter.length - 1 + (longer.length - 1);
  return total > 0 ? overlap / total : 0;
}

/**
 * 0~100 的标题相似度（严格版）。子串命中必须占较短串的足够比例才算数 ——
 * 拿四字别名去蹭八十字简介的漏洞，parsing.py 里已经踩过一次，别再踩。
 */
export function similarity(a: string, b: string): number {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (longer.includes(shorter)) {
    const ratio = shorter.length / longer.length;
    if (ratio >= 0.5) return 96;
    if (ratio >= 0.34) return 82;
    // 片段占比太小，不足以认定是同一部作品，退回模糊比
  }
  return Math.round(diceBigrams(na, nb) * 100);
}

const QUERY_STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "and", "or", "is", "are",
  "it", "its", "be", "with", "for", "no", "at", "by",
]);
const QUERY_TOKEN_RE = /[\w\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+/gu;

/**
 * 把标题压成「只留有信息量的词」当第二个检索词。
 *
 * 用完整标题 `BanG Dream! It's MyGO!!!!!` 搜，会因为弯撇号 `It’s` 和
 * `!!!!!` 这种重复标点搜空；压成 `BanG Dream MyGO` 就稳了（parsing.py
 * 的 loose_query 同款，实测教训）。
 */
export function looseQuery(title: string): string {
  const text = (title ?? "").normalize("NFKC").replace(/[’‘']/gu, "");
  const kept = (text.match(QUERY_TOKEN_RE) ?? []).filter((t) => !QUERY_STOPWORDS.has(t.toLowerCase()));
  return kept.length >= 2 ? kept.join(" ") : "";
}

export function yearFromDate(date?: string): number | null {
  const head = (date ?? "").slice(0, 4);
  return /^\d{4}$/u.test(head) ? Number(head) : null;
}

/** 从搜索结果里挑与查询最像的条目；够不上阈值宁可返回 null。 */
export function pickBestSubject(items: BgmSearchItem[], query: string, minScore = ADOPT_MIN_SCORE): BgmSubject | null {
  let best: BgmSubject | null = null;
  for (const item of items ?? []) {
    if (!item || typeof item.id !== "number") continue;
    const score = Math.max(similarity(query, item.name ?? ""), similarity(query, item.name_cn ?? ""));
    if (!best || score > best.score) {
      best = { id: item.id, name: item.name ?? "", nameCn: item.name_cn ?? "", year: yearFromDate(item.date), score };
    }
  }
  return best && best.score >= minScore ? best : null;
}

// ── 缓存（localStorage；坏了就当没缓存，只多打几次请求）──

function cacheGet<T>(key: string, ttlMs: number): T | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return undefined;
    const entry = JSON.parse(raw) as { at?: number; value?: T };
    if (typeof entry?.at !== "number" || Date.now() - entry.at > ttlMs) return undefined;
    return entry.value;
  } catch {
    return undefined;
  }
}

function cacheSet<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(key, JSON.stringify({ at: Date.now(), value }));
  } catch {
    // 配额满/隐私模式：缓存只是优化，失败无所谓
  }
}

// ── 对外入口 ──

/**
 * 按标题搜 Bangumi，返回最佳匹配（相似度达标）或 null。
 * 先用原标题搜，搜空了再用 looseQuery 压缩版补一枪；结果进缓存。
 */
export async function lookupSubject(query: string): Promise<BgmSubject | null> {
  const trimmed = (query ?? "").trim();
  if (!trimmed) return null;
  const key = `yl-bgm:subject:${normalizeForMatch(trimmed)}`;
  const cached = cacheGet<BgmSubject | null>(key, SUBJECT_TTL_MS);
  if (cached !== undefined) return cached;

  const subject = (await bgmSearch(trimmed)) ?? (await bgmSearch(looseQuery(trimmed)));
  cacheSet(key, subject);
  return subject;
}

/**
 * 拿某部作品的某集标题。番剧正篇（type=0）里按集号对；找不到返回空串。
 * 整份集数表按作品缓存。
 */
export async function lookupEpisodeTitle(subjectId: number, number: string): Promise<string> {
  const target = Number(number);
  if (!subjectId || !Number.isFinite(target)) return "";
  const key = `yl-bgm:eps:${subjectId}`;
  let episodes = cacheGet<BgmEpisodeItem[]>(key, EPISODES_TTL_MS);
  if (episodes === undefined) {
    const json = await bgmRequest<{ data?: BgmEpisodeItem[] }>(`/v0/episodes?subject_id=${subjectId}`);
    episodes = json?.data ?? [];
    cacheSet(key, episodes);
  }
  const hit = (episodes ?? []).find((e) => Number(e.type) === 0 && Number(e.ep) === target);
  return hit?.name || hit?.name_cn || "";
}

async function bgmSearch(keyword: string): Promise<BgmSubject | null> {
  if (!keyword) return null;
  const json = await bgmRequest<{ data?: BgmSearchItem[] }>("/v0/search/subjects", {
    method: "POST",
    body: JSON.stringify({ keyword, filter: { type: [2] }, limit: 8 }),
  });
  return pickBestSubject(json?.data ?? [], keyword);
}

async function bgmRequest<T>(path: string, init?: { method?: string; body?: string }): Promise<T | null> {
  try {
    // requestUrl 的取法统一走 http.ts 的 loadRequestUrl（require 优先 ——
    // 动态 import("obsidian") 在插件沙箱里解析不到，旧写法在这里静默挂过）
    const requestUrl = await loadRequestUrl();
    const request = requestUrl({
      url: `${BGM_BASE}${path}`,
      method: init?.method ?? "GET",
      headers: { "User-Agent": userAgent(), "Content-Type": "application/json", Accept: "application/json" },
      body: init?.body,
      throw: false,
    });
    const timeout = new Promise<null>((resolve) =>
      window.setTimeout(() => resolve(null), REQUEST_TIMEOUT_MS),
    );
    const response = await Promise.race([request, timeout]);
    if (!response || response.status !== 200) return null;
    return (response.json ?? null) as T | null;
  } catch {
    // 断网/限流/超时：降级成「没查到」，导入照走
    return null;
  }
}
