import { describe, expect, it, vi } from "vitest";
import { reportAssetInstall } from "../src/services/installReport";
import type { PluginSettings } from "../src/settings/types";
import type { FetchLike } from "../src/services/http";

/**
 * 安装上报（2026-10-18，2026-10-18 晚改按 IP 去重）。
 *
 * 钉三件事：
 *  · **不需要登录** —— 没账号也要报（刚装插件的人不可能已经登录），
 *    请求不带 Authorization；
 *  · 报的内容只有三样（kind / 资源版本 / 插件版本），不多带东西；
 *  · **失败静默** —— 上报挂了绝不能抛到用户的操作路径上（东西已经装好了）。
 */
function settingsOf(over: Partial<PluginSettings> = {}): PluginSettings {
  return {
    serverUrl: "https://younglook.cc/",
    authToken: "",
    ...over,
  } as PluginSettings;
}

describe("reportAssetInstall", () => {
  it("未登录也上报：POST 到 /api/v1/installs/report/，只带三样东西", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as FetchLike;

    reportAssetInstall({
      settings: settingsOf(),
      kind: "dict",
      assetVersion: "2026-10-18",
      pluginVersion: "0.1.2",
      fetchImpl,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://younglook.cc/api/v1/installs/report/");
    expect((init as RequestInit).method).toBe("POST");
    // 不带令牌：服务端按 IP 去重，客户端不该把账号信息掺进这条统计里
    expect((init as RequestInit).headers).not.toHaveProperty("Authorization");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      kind: "dict",
      version: "2026-10-18",
      plugin_version: "0.1.2",
    });
  });

  it("登录了也不带令牌（账号与这条统计无关）", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as FetchLike;
    reportAssetInstall({
      settings: settingsOf({ authToken: "tok-123" }),
      kind: "demo",
      assetVersion: "1",
      pluginVersion: "0.1.2",
      fetchImpl,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).headers).not.toHaveProperty("Authorization");
  });

  it("没配服务端：一个请求都不发", async () => {
    const fetchImpl = vi.fn() as unknown as FetchLike;
    reportAssetInstall({
      settings: settingsOf({ serverUrl: "  " }),
      kind: "demo",
      assetVersion: "1",
      pluginVersion: "0.1.2",
      fetchImpl,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("网络挂了 / 服务端 500：静默返回，不抛异常", async () => {
    const boom = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as FetchLike;
    expect(() =>
      reportAssetInstall({
        settings: settingsOf(),
        kind: "demo",
        assetVersion: "1",
        pluginVersion: "0.1.2",
        fetchImpl: boom,
      }),
    ).not.toThrow();
    await vi.waitFor(() => expect(boom).toHaveBeenCalled());

    const fiveHundred = vi.fn(async () => new Response("", { status: 500 })) as unknown as FetchLike;
    expect(() =>
      reportAssetInstall({
        settings: settingsOf(),
        kind: "dict",
        assetVersion: "1",
        pluginVersion: "0.1.2",
        fetchImpl: fiveHundred,
      }),
    ).not.toThrow();
    await vi.waitFor(() => expect(fiveHundred).toHaveBeenCalled());
  });
});
