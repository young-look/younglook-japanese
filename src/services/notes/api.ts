/**
 * 共享笔记的服务端通信（`/api/v1/notes/*`）。
 *
 * 与托管 AI 接口共用鉴权（`resolveToken`：401 强刷一次令牌再试）与基址；
 * 错误一律翻成人话（AiUnavailableError），由调用方弹 Notice。
 *
 * 🔒 这里只发**三句 hash**（`slice.cid` 去掉 `S:` 前缀）与用户写的正文 ——
 * 句子原文、作品、集数一概不出站（docs/me/notes.md 的红线）。
 */

import type { PluginSettings } from "../../settings/types";
import { AiUnavailableError } from "../ai/client";
import { hostedBase, resolveToken } from "../ai/hosted";
import { httpFetch, type HttpResponseLike } from "../http";

/** 别人的共享笔记（抽屉下半区的一张卡）。 */
export interface SharedNote {
  id: number;
  nickname: string;
  content: string;
  likeCount: number;
  liked: boolean;
  updatedAt: string;
}

/** 一句的共享列表：自己的那条 + 别人的（口径在服务端定死，这里只管画）。 */
export interface SharedNotesResult {
  mine: { content: string; updatedAt: string } | null;
  notes: SharedNote[];
}

export interface LikeResult {
  likeCount: number;
  liked: boolean;
}

/** 状态码 → 人话。与 ai/hosted 的 errorFor 同一套话术，但那边不导出，这边单独一份。 */
function errorFor(status: number, message: string | undefined): AiUnavailableError {
  if (status === 401) return new AiUnavailableError("登录状态过期了，到个人中心重新登录一次。");
  if (status === 429) return new AiUnavailableError("用得有点快，缓一下再来。");
  const reason = message?.trim();
  return new AiUnavailableError(reason || `服务器这边出了点问题（HTTP ${status}），稍后再试。`);
}

/** 调一次笔记接口，拆掉 {code,message,data} 信封；非 2xx 抛人话。 */
async function call<T>(
  settings: PluginSettings,
  path: string,
  init: { method: string; body?: Record<string, unknown> },
): Promise<T> {
  const base = hostedBase(settings);
  if (!base) throw new AiUnavailableError("服务端地址是空的，到设置里补上。");

  let token = await resolveToken(settings, false);
  if (!token) {
    throw new AiUnavailableError(
      settings.refreshToken.trim()
        ? "暂时连不上服务端，稍后再试。"
        : "登录后才能使用云端的笔记。登录或注册在个人中心里。",
    );
  }

  const doCall = async (bearer: string): Promise<HttpResponseLike> => {
    try {
      return await httpFetch(`${base}/api/v1/notes/${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${bearer}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        timeoutMs: 20_000,
      });
    } catch {
      throw new AiUnavailableError("连不上服务器，稍后再试。");
    }
  };

  let response = await doCall(token);
  if (response.status === 401) {
    const fresh = await resolveToken(settings, true);
    if (fresh && fresh !== token) {
      token = fresh;
      response = await doCall(token);
    }
  }

  const text = await response.text().catch(() => "");
  let body: { code?: number; message?: string; data?: T } | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as { code?: number; message?: string; data?: T };
    } catch {
      body = null;
    }
  }
  if (!response.ok) throw errorFor(response.status, body?.message);
  return (body?.data ?? ({} as T));
}

/** 我的全部笔记（hash → 内容）。历史页的「句下便签」与学习页虚线共用。 */
export async function fetchMyNotes(settings: PluginSettings): Promise<Map<string, string>> {
  const data = await call<{ notes?: Array<{ hash?: unknown; content?: unknown }> }>(
    settings,
    "mine/",
    { method: "GET" },
  );
  const map = new Map<string, string>();
  for (const row of data.notes ?? []) {
    if (typeof row.hash === "string" && typeof row.content === "string") {
      map.set(row.hash, row.content);
    }
  }
  return map;
}

/** 保存（upsert）自己的笔记。 */
export async function saveMyNoteRemote(
  settings: PluginSettings,
  hash: string,
  content: string,
): Promise<void> {
  await call(settings, "mine/", { method: "POST", body: { hash, content } });
}

/** 删除自己的笔记。 */
export async function deleteMyNoteRemote(settings: PluginSettings, hash: string): Promise<void> {
  await call(settings, `mine/?hash=${encodeURIComponent(hash)}`, { method: "DELETE" });
}

/** 一句的共享列表（含自己的那条）。 */
export async function fetchSharedNotes(
  settings: PluginSettings,
  hash: string,
): Promise<SharedNotesResult> {
  const data = await call<{
    mine?: { content?: unknown; updated_at?: unknown } | null;
    notes?: Array<{
      id?: unknown;
      nickname?: unknown;
      content?: unknown;
      like_count?: unknown;
      liked?: unknown;
      updated_at?: unknown;
    }>;
  }>(settings, `shared/?hash=${encodeURIComponent(hash)}`, { method: "GET" });

  const notes: SharedNote[] = [];
  for (const row of data.notes ?? []) {
    if (
      typeof row.id !== "number" ||
      typeof row.content !== "string" ||
      typeof row.like_count !== "number"
    ) {
      continue; // 缺关键字段的行直接丢，宁可少一条也别画出坏卡
    }
    notes.push({
      id: row.id,
      nickname: typeof row.nickname === "string" ? row.nickname : "",
      content: row.content,
      likeCount: row.like_count,
      liked: row.liked === true,
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
    });
  }
  const mine =
    data.mine && typeof data.mine.content === "string"
      ? {
          content: data.mine.content,
          updatedAt: typeof data.mine.updated_at === "string" ? data.mine.updated_at : "",
        }
      : null;
  return { mine, notes };
}

/** 点赞 / 取消（toggle）。返回最新计数与状态，调用方就地更新卡片。 */
export async function toggleNoteLike(
  settings: PluginSettings,
  id: number,
): Promise<LikeResult> {
  const data = await call<{ like_count?: unknown; liked?: unknown }>(
    settings,
    `${id}/like/`,
    { method: "POST" },
  );
  return {
    likeCount: typeof data.like_count === "number" ? data.like_count : 0,
    liked: data.liked === true,
  };
}
