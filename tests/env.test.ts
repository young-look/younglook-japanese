import { describe, expect, it } from "vitest";
import {
  BUILD_ENV,
  PRESETS,
  resolveTargets,
  normalizeServerEnv,
} from "../src/config/env";
import { defaultSettings, fillDefaults, migrateServerEnv } from "../src/settings/defaults";
import type { PluginSettings } from "../src/settings/types";

/**
 * 开发 / 生产环境的分流。
 *
 * 这里守的是一条硬规矩：**生产构建绝不能连本机，开发构建绝不能连线上**。
 * 只要还有"忘了改"的可能，就一定会有人在调试时把测试数据和真金白银的
 * 余额写到线上库里，所以这件事必须由构建期常量定死，不能靠手填。
 */
describe("resolveTargets", () => {
  it("auto 跟着构建环境走", () => {
    expect(resolveTargets("auto", "", "dev")).toEqual(PRESETS.dev);
    expect(resolveTargets("auto", "", "prod")).toEqual(PRESETS.prod);
  });

  it("显式指定就无视构建环境", () => {
    expect(resolveTargets("dev", "", "prod")).toEqual(PRESETS.dev);
    expect(resolveTargets("prod", "", "dev")).toEqual(PRESETS.prod);
  });

  it("生产构建的 auto 绝不能落到本机", () => {
    const { api, web } = resolveTargets("auto", "", "prod");
    expect(api).toBe("https://younglook.cc");
    expect(api).not.toMatch(/127\.0\.0\.1|localhost/iu);
    expect(web).not.toMatch(/127\.0\.0\.1|localhost/iu);
  });

  it("本机的网页端是 5173，不是接口那个 8060", () => {
    // Django 只提供 /api、/admin、/storage，/plugin/connect 是前端路由
    expect(PRESETS.dev.api).toBe("http://127.0.0.1:8060");
    expect(PRESETS.dev.web).toBe("http://127.0.0.1:5173");
  });

  it("自定义地址默认前后端同源", () => {
    expect(resolveTargets("custom", "https://staging.example.com/", "dev")).toEqual({
      api: "https://staging.example.com",
      web: "https://staging.example.com",
    });
  });

  it("自定义填成本机 8060 时，网页端仍走 vite", () => {
    expect(resolveTargets("custom", "http://127.0.0.1:8060", "prod").web).toBe(
      PRESETS.dev.web,
    );
  });

  it("自定义为空时退回构建环境，别连出个空地址", () => {
    expect(resolveTargets("custom", "   ", "prod").api).toBe(PRESETS.prod.api);
  });

  it("脏数据一律当 auto", () => {
    expect(normalizeServerEnv(undefined)).toBe("auto");
    expect(normalizeServerEnv("nonsense")).toBe("auto");
    expect(normalizeServerEnv("dev")).toBe("dev");
  });
});

describe("老配置迁移", () => {
  it("存着线上地址 → 开发构建里换成本机", () => {
    // 现实场景：用户早先装过，data.json 里已经落盘成线上地址。
    // 只改默认值对已装插件无效，必须显式迁移，否则调试还是打线上。
    const { env, customUrl } = migrateServerEnv(
      { serverUrl: PRESETS.prod.api } as Partial<PluginSettings>,
      "dev",
    );
    expect(env).toBe("auto");
    expect(customUrl).toBe("");
    expect(resolveTargets(env, customUrl, "dev").api).toBe(PRESETS.dev.api);
  });

  it("存着本机地址 → 生产构建里换成线上", () => {
    const { env, customUrl } = migrateServerEnv(
      { serverUrl: PRESETS.dev.api } as Partial<PluginSettings>,
      "prod",
    );
    expect(env).toBe("auto");
    expect(resolveTargets(env, customUrl, "prod").api).toBe(PRESETS.prod.api);
  });

  it("自己填过的地址保留成 custom", () => {
    const { env, customUrl } = migrateServerEnv(
      { serverUrl: "https://staging.example.com" } as Partial<PluginSettings>,
      "dev",
    );
    expect(env).toBe("custom");
    expect(customUrl).toBe("https://staging.example.com");
  });

  it("空地址跟着构建环境走", () => {
    expect(migrateServerEnv({}, "dev").env).toBe("auto");
    expect(migrateServerEnv({ serverUrl: "" }, "prod").env).toBe("auto");
  });

  it("已经存过 serverEnv 的不再被迁移改写", () => {
    const { env, customUrl } = migrateServerEnv(
      { serverEnv: "prod", customServerUrl: "https://x.example.com" } as Partial<PluginSettings>,
      "dev",
    );
    expect(env).toBe("prod");
    expect(customUrl).toBe("https://x.example.com");
  });
});

describe("fillDefaults", () => {
  it("serverUrl 每次都按当前环境重算", () => {
    const dev = fillDefaults({ serverUrl: PRESETS.prod.api }, "dev");
    expect(dev.serverUrl).toBe(PRESETS.dev.api);

    const prod = fillDefaults({ serverUrl: PRESETS.dev.api }, "prod");
    expect(prod.serverUrl).toBe(PRESETS.prod.api);
  });

  it("缺省配置跟着当前构建走", () => {
    expect(defaultSettings().serverEnv).toBe("auto");
    expect(fillDefaults(undefined).serverUrl).toBe(PRESETS[BUILD_ENV].api);
  });

  it("老配置缺的新字段要补齐，别留 undefined", () => {
    const settings = fillDefaults({ vaultFolder: "x" });
    expect(settings.refreshToken).toBe("");
    expect(settings.authServerUrl).toBe("");
    expect(settings.customServerUrl).toBe("");
    expect(settings.lastStatsSyncAt).toBe(0);
  });

  // 2026-10-12 拍板：从未选择过 = 默认内置模型。settings 整包落盘，从没碰过
  // 模式选择的存量用户存的正是旧默认 "off" —— 跟 vaultFolder 同一判据：
  // 存的 = 旧默认 = 没自己挑过 → 升到新默认；显式选过的不动。
  it("AI 模式迁移：旧默认 off 升到内置模型，显式选择保留", () => {
    expect(fillDefaults(undefined).aiMode).toBe("hosted");
    expect(fillDefaults({ aiMode: "off" }).aiMode).toBe("hosted");
    expect(fillDefaults({ aiMode: "byok" }).aiMode).toBe("byok");
    expect(fillDefaults({ aiMode: "hosted" }).aiMode).toBe("hosted");
  });
});
