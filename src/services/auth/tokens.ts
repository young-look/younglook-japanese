/**
 * JWT 的过期时间解析（纯函数，不依赖网络）。
 *
 * 为什么只看 payload 而不发请求问服务端：判断「要不要刷新」这件事
 * 每秒都可能被问一次（AI 解析、统计上报），为一个本地能算出来的结论
 * 打网络请求太贵了。真正过没过期由服务端说了算，这里只是**提前量**。
 */

/** JWT 是 base64url 编码的，标准 base64 解不了 `-` / `_`。 */
function decodeSegment(segment: string): string | null {
  const padded = segment.replace(/-/gu, "+").replace(/_/gu, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  try {
    return atob(padded + pad);
  } catch {
    return null;
  }
}

/**
 * 取 JWT 的过期时间（**秒**）。解不出来返回 null。
 *
 * 解不出来一律当作「已过期」处理：宁可多刷新一次，也不要拿着一个
 * 看不懂的令牌去撞 401。
 */
export function decodeExp(token: string): number | null {
  const trimmed = (token ?? "").trim();
  if (!trimmed) return null;
  const parts = trimmed.split(".");
  if (parts.length < 2) return null;
  const json = decodeSegment(parts[1]);
  if (!json) return null;
  try {
    const payload = JSON.parse(json) as { exp?: unknown };
    const exp = Number(payload?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp : null;
  } catch {
    return null;
  }
}

/**
 * 这个访问令牌是不是已经（或马上就要）过期。
 *
 * `skewSeconds` 是提前量：等到真过期那一刻再刷新，请求已经发出去了，
 * 服务端照样 401 —— 提前两分钟换，请求就不会撞在边界上。
 */
export function isAccessExpired(token: string, skewSeconds = 120): boolean {
  const exp = decodeExp(token);
  if (exp === null) return true;
  return Date.now() / 1000 >= exp - skewSeconds;
}
