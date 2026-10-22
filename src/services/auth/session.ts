/**
 * 用刷新令牌换新的访问令牌。
 *
 * 服务端开了 `ROTATE_REFRESH_TOKENS` + `BLACKLIST_AFTER_ROTATION`：
 * **旧的 refresh 用过一次就作废**，响应里会带回一个新的。
 * 所以这里必须把新 refresh 存回去 —— 只换 access、留着旧 refresh，
 * 下一次刷新必然 401，用户就会被无缘无故踢下线。
 */

import { log } from "../../core/logger";
import { httpFetch, type FetchLike } from "../http";

export interface RefreshedSession {
  access: string;
  refresh: string;
}

/**
 * 刷新的三种结局，**调用方必须区分对待**：
 *  · ok        —— 拿到一对新令牌；
 *  · invalid   —— 服务端明确拒绝这个 refresh（401/403：过期 / 被拉黑 / 被撤销）。
 *                 登录态真没了，只能让用户重新连接；
 *  · transient —— 网络断 / 超时 / 5xx / 响应畸形。**令牌多半还活着**，只是这一下
 *                 没连上 —— 绝不能据此清登录态，否则一次网络抖动、一次服务重启，
 *                 用户就被"无故踢下线"。
 */
export type RefreshOutcome =
  | { kind: "ok"; session: RefreshedSession }
  | { kind: "invalid" }
  | { kind: "transient" };

function normalizeUrl(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/u, "");
}

/**
 * 换一对新令牌。不抛异常：刷新发生在后台，抛出去没人接，只会变成一条未捕获错误。
 * 失败时用 RefreshOutcome 的 kind 说明原因，由调用方决定清登录态还是保留重试。
 */
export async function refreshSession(
  serverUrl: string,
  refreshToken: string,
  fetchImpl: FetchLike = httpFetch,
): Promise<RefreshOutcome> {
  const base = normalizeUrl(serverUrl);
  const refresh = (refreshToken ?? "").trim();
  // 服务端地址没配好是配置问题，不是"令牌死了"；没有 refresh 才是真没得续
  if (!base) return { kind: "transient" };
  if (!refresh) return { kind: "invalid" };

  try {
    const response = await fetchImpl(`${base}/api/v1/auth/refresh/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 服务端优先读 httpOnly cookie，没有才看 body —— 插件没有 cookie，走 body
      body: JSON.stringify({ refresh }),
      timeoutMs: 15_000,
    });
    if (!response.ok) {
      // 只有服务端明确拒绝这个令牌才算登录态失效；5xx 是服务端自己的事
      if (response.status === 401 || response.status === 403) {
        log.warn("刷新令牌被服务端拒绝", { status: response.status });
        return { kind: "invalid" };
      }
      log.warn("刷新登录状态失败（服务端暂时不可用，保留登录态）", { status: response.status });
      return { kind: "transient" };
    }
    const body = (await response.json()) as {
      data?: { access?: unknown; refresh?: unknown };
    };
    const data = body.data ?? {};
    const access = typeof data.access === "string" ? data.access.trim() : "";
    if (!access) {
      // 200 却没有 access：多半是网关/代理返回了奇怪的东西，按临时故障处理
      log.warn("刷新响应里没有 access，按服务端临时故障处理，保留登录态");
      return { kind: "transient" };
    }
    // 服务端没回新 refresh（以后改成不轮换时）就沿用旧的，别把它清成空串
    const next =
      typeof data.refresh === "string" && data.refresh.trim() ? data.refresh.trim() : refresh;
    return { kind: "ok", session: { access, refresh: next } };
  } catch (error) {
    log.warn("刷新登录状态出错（网络问题，保留登录态）", error);
    return { kind: "transient" };
  }
}
