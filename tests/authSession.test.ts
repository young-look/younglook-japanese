import { describe, expect, it, vi } from "vitest";
import { refreshSession } from "../src/services/auth/session";
import { type FetchLike } from "../src/services/http";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** 假 fetch：记录请求，按脚本返回。 */
function fakeFetch(handler: (url: string, init: RequestInit) => Response): {
  impl: FetchLike;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as FetchLike;
  return { impl, calls };
}

describe("refreshSession", () => {
  it("把 refresh 放进 body，并返回新的一对令牌", async () => {
    const { impl, calls } = fakeFetch(() =>
      jsonResponse(200, { code: 0, data: { access: "NEW-ACCESS", refresh: "NEW-REFRESH" } }),
    );

    const outcome = await refreshSession("https://younglook.cc/", "OLD-REFRESH", impl);

    expect(calls[0].url).toBe("https://younglook.cc/api/v1/auth/refresh/");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ refresh: "OLD-REFRESH" });
    expect(outcome).toEqual({
      kind: "ok",
      session: { access: "NEW-ACCESS", refresh: "NEW-REFRESH" },
    });
  });

  it("🔥 必须用响应里那个新 refresh —— 服务端开了轮换，旧的立刻作废", async () => {
    const { impl } = fakeFetch(() =>
      jsonResponse(200, { code: 0, data: { access: "A2", refresh: "R2" } }),
    );
    const outcome = await refreshSession("https://younglook.cc", "R1", impl);
    expect(outcome).toEqual({ kind: "ok", session: { access: "A2", refresh: "R2" } });
    if (outcome.kind === "ok") expect(outcome.session.refresh).not.toBe("R1");
  });

  it("401 = 服务端明确拒绝这个令牌 → invalid（唯一该清登录态的情况）", async () => {
    const { impl } = fakeFetch(() => jsonResponse(401, { code: 4003 }));
    expect(await refreshSession("https://younglook.cc", "R1", impl)).toEqual({ kind: "invalid" });
  });

  it("403 同样算 invalid", async () => {
    const { impl } = fakeFetch(() => jsonResponse(403, {}));
    expect(await refreshSession("https://younglook.cc", "R1", impl)).toEqual({ kind: "invalid" });
  });

  it("🔥 5xx 是服务端自己的问题 → transient，绝不能当成令牌失效", async () => {
    const { impl } = fakeFetch(() => jsonResponse(502, {}));
    expect(await refreshSession("https://younglook.cc", "R1", impl)).toEqual({
      kind: "transient",
    });
  });

  it("网络错是 transient，不抛", async () => {
    const impl = (async () => {
      throw new Error("offline");
    }) as FetchLike;
    await expect(refreshSession("https://younglook.cc", "R1", impl)).resolves.toEqual({
      kind: "transient",
    });
  });

  it("200 却没有 access：响应畸形按 transient 处理，不清登录态", async () => {
    const { impl } = fakeFetch(() => jsonResponse(200, { code: 0, data: {} }));
    expect(await refreshSession("https://younglook.cc", "R1", impl)).toEqual({
      kind: "transient",
    });
  });

  it("服务端没回新 refresh 时沿用旧的，别清成空串", async () => {
    const { impl } = fakeFetch(() => jsonResponse(200, { code: 0, data: { access: "A2" } }));
    const outcome = await refreshSession("https://younglook.cc", "R1", impl);
    expect(outcome).toEqual({ kind: "ok", session: { access: "A2", refresh: "R1" } });
  });

  it("没有 refresh 令牌时不发请求，报 invalid", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(200, {}));
    expect(await refreshSession("https://younglook.cc", "", impl)).toEqual({ kind: "invalid" });
    expect(calls.length).toBe(0);
  });

  it("服务端地址是空的：配置问题按 transient，不清登录态", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(200, {}));
    expect(await refreshSession("  ", "R1", impl)).toEqual({ kind: "transient" });
    expect(calls.length).toBe(0);
  });

  it("日志不吞掉异常：fetch 抛错时也不影响后续调用", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const impl = (async () => {
      throw new Error("boom");
    }) as FetchLike;
    await refreshSession("https://younglook.cc", "R1", impl);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
