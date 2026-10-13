import { describe, expect, it } from "vitest";
import { decodeExp, isAccessExpired } from "../src/services/auth/tokens";

/** 造一个 JWT（只关心 payload，签名段随便填）。 */
function jwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_")
      .replace(/=+$/u, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.sig`;
}

const NOW_SECONDS = Math.floor(Date.now() / 1000);

describe("decodeExp", () => {
  it("空串与坏令牌都返回 null", () => {
    expect(decodeExp("")).toBeNull();
    expect(decodeExp("   ")).toBeNull();
    expect(decodeExp("not-a-jwt")).toBeNull();
    expect(decodeExp("a.b.c")).toBeNull();
  });

  it("没有 exp 的令牌返回 null", () => {
    expect(decodeExp(jwt({ user_uid: "123" }))).toBeNull();
  });

  it("正常令牌解出秒级 exp", () => {
    expect(decodeExp(jwt({ exp: NOW_SECONDS + 3600 }))).toBe(NOW_SECONDS + 3600);
  });

  it("非法 exp 值返回 null", () => {
    expect(decodeExp(jwt({ exp: "soon" }))).toBeNull();
    expect(decodeExp(jwt({ exp: 0 }))).toBeNull();
    expect(decodeExp(jwt({ exp: -1 }))).toBeNull();
  });
});

describe("isAccessExpired", () => {
  it("没有令牌算已过期", () => {
    expect(isAccessExpired("")).toBe(true);
  });

  it("解不出 exp 也算已过期（宁可多刷一次，别撞 401）", () => {
    expect(isAccessExpired("garbage")).toBe(true);
  });

  it("还没到期 → 没过期", () => {
    expect(isAccessExpired(jwt({ exp: NOW_SECONDS + 3600 }))).toBe(false);
  });

  it("已经过期 → 过期", () => {
    expect(isAccessExpired(jwt({ exp: NOW_SECONDS - 10 }))).toBe(true);
  });

  it("提前量：还有 30 秒但 skew 是 120 → 判过期", () => {
    const token = jwt({ exp: NOW_SECONDS + 30 });
    expect(isAccessExpired(token, 120)).toBe(true);
    expect(isAccessExpired(token, 0)).toBe(false);
  });
});
