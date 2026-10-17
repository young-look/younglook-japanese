import { describe, expect, it } from "vitest";
import { resolveAiRoute } from "../src/services/ai/gate";
import {
  DEFAULT_BYOK,
  renameSpace,
  stashBundle,
  switchSpace,
} from "../src/settings/aiSpace";
import { fillDefaults } from "../src/settings/defaults";
import type { PluginSettings } from "../src/settings/types";

/**
 * AI 配置按本机空间分桶（2026-10-17 方案 B）。
 *
 * 要守住的是那一件事：**换空间（= 换账号）之后，上一个账号的自定义模型配置
 * 不能还在、更不能还生效**。它原来的样子是整个 vault 一份，于是新账号登录后
 * 既看得见别人的 Key，`resolveAiRoute` 还会拿它直接发请求、记在别人账上。
 *
 * 另一半同样重要：老配置（升级前只有顶层那一份）**一个字节都不能丢**，
 * 得原地归到当时那个活跃空间。
 */

const A_SAVED = {
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: "sk-account-a",
  model: "glm-5.2",
};

/** 两份空间：匿名 + 账号 A 的（A 就是认领了匿名那份的老用户，id 不变） */
function spaces() {
  return [
    { id: "space-anon", owner: "", ownerServer: "", ownerName: "" },
    { id: "space-b", owner: "u-2", ownerServer: "https://younglook.cc", ownerName: "小明" },
  ];
}

/** 升级前的真实配置：顶层四字段有值、data.json 里没有 byokBySpace */
function legacy(): PluginSettings {
  return fillDefaults({
    vaultLocalId: "vault-1",
    spaces: spaces(),
    activeSpaceId: "space-anon",
    aiMode: "byok",
    byok: { ...A_SAVED },
    byokSaved: { ...A_SAVED },
    byokLocked: true,
  });
}

describe("老配置迁移（升级前只有顶层那一份）", () => {
  it("归到当前活跃空间，四个字段原样保留", () => {
    const settings = legacy();
    expect(settings.byokBySpace["space-anon"]).toMatchObject({
      aiMode: "byok",
      byokLocked: true,
    });
    expect(settings.byokBySpace["space-anon"].byok.apiKey).toBe("sk-account-a");
    expect(settings.byokBySpace["space-anon"].byokSaved?.model).toBe("glm-5.2");
    // 工作副本与桶一致（顶层不是另一个来源）
    expect(settings.aiMode).toBe("byok");
    expect(settings.byok.apiKey).toBe("sk-account-a");
    expect(settings.byokSaved?.apiKey).toBe("sk-account-a");
  });

  it("旧默认 off 仍然升成「内置模型」", () => {
    const settings = fillDefaults({
      vaultLocalId: "vault-1",
      spaces: spaces(),
      activeSpaceId: "space-anon",
      aiMode: "off",
    });
    expect(settings.aiMode).toBe("hosted");
    expect(settings.byokBySpace["space-anon"].aiMode).toBe("hosted");
  });
});

describe("换空间 = 换账号的 AI 配置", () => {
  it("新空间什么都没有：空 Key、没保存过、回到内置模型", () => {
    const settings = legacy();
    switchSpace(settings, "space-anon", "space-b");
    settings.activeSpaceId = "space-b";

    expect(settings.byok.apiKey).toBe("");
    expect(settings.byokSaved).toBeNull();
    expect(settings.byokLocked).toBe(false);
    expect(settings.aiMode).toBe("hosted");
    // 表单初值仍是默认供应商，但那是"没配过"的样子，不是别人的配置
    expect(settings.byok.baseUrl).toBe(DEFAULT_BYOK.baseUrl);
    expect(resolveAiRoute(settings)).toBe("hosted");
  });

  it("切回去还在：原空间的配置没有被新空间覆盖", () => {
    const settings = legacy();
    switchSpace(settings, "space-anon", "space-b");
    settings.activeSpaceId = "space-b";
    switchSpace(settings, "space-b", "space-anon");
    settings.activeSpaceId = "space-anon";

    expect(settings.byok.apiKey).toBe("sk-account-a");
    expect(settings.byokSaved?.model).toBe("glm-5.2");
    expect(settings.aiMode).toBe("byok");
    expect(resolveAiRoute(settings)).toBe("byok");
  });

  it("新空间自己配的 Key 不会串回老空间", () => {
    const settings = legacy();
    switchSpace(settings, "space-anon", "space-b");
    settings.activeSpaceId = "space-b";
    settings.byok = { baseUrl: "https://api.example.com/v1", apiKey: "sk-account-b", model: "b-model" };
    settings.byokSaved = { ...settings.byok };
    settings.byokLocked = true;
    settings.aiMode = "byok";
    stashBundle(settings); // 等价于一次 saveSettings 落盘

    switchSpace(settings, "space-b", "space-anon");
    settings.activeSpaceId = "space-anon";
    expect(settings.byok.apiKey).toBe("sk-account-a");
    expect(settings.byokSaved?.model).toBe("glm-5.2");
  });
});

describe("saveSettings 的归档（stashBundle）", () => {
  it("草稿改动落盘后再切走切回，改动还在", () => {
    const settings = legacy();
    switchSpace(settings, "space-anon", "space-b");
    settings.activeSpaceId = "space-b";

    settings.byok.apiKey = "sk-typed-not-saved";
    stashBundle(settings); // = saveSettings 落盘前的归档

    switchSpace(settings, "space-b", "space-anon");
    settings.activeSpaceId = "space-anon";
    switchSpace(settings, "space-anon", "space-b");
    settings.activeSpaceId = "space-b";

    expect(settings.byok.apiKey).toBe("sk-typed-not-saved");
  });

  it("活跃空间为空时不写空键（启动极早期）", () => {
    const settings = legacy();
    settings.byokBySpace = {};
    settings.activeSpaceId = "";
    stashBundle(settings);
    expect(Object.keys(settings.byokBySpace)).toHaveLength(0);
  });
});

describe("空间改 id（认回旧库）", () => {
  it("桶跟着搬到新键，配置不丢", () => {
    const settings = legacy();
    renameSpace(settings, "space-anon", "adopted-key");

    expect(settings.byokBySpace["space-anon"]).toBeUndefined();
    expect(settings.byokBySpace["adopted-key"]?.byok.apiKey).toBe("sk-account-a");
  });
});

describe("坏数据清洗", () => {
  it("非法 aiMode / 空快照 / 非字符串字段都收成安全值", () => {
    const settings = fillDefaults({
      vaultLocalId: "vault-1",
      spaces: [{ id: "space-x", owner: "", ownerServer: "", ownerName: "" }],
      activeSpaceId: "space-x",
      byokBySpace: {
        "space-x": {
          // 手改过 / 别的版本写的
          byok: { baseUrl: "", apiKey: 123, model: "" },
          byokSaved: {},
          byokLocked: "yes",
          aiMode: "off",
        },
      },
    } as unknown as Partial<PluginSettings>);

    expect(settings.aiMode).toBe("hosted");
    expect(settings.byok.apiKey).toBe("");
    expect(settings.byok.baseUrl).toBe(DEFAULT_BYOK.baseUrl);
    expect(settings.byok.model).toBe(DEFAULT_BYOK.model);
    expect(settings.byokSaved).toBeNull();
    expect(settings.byokLocked).toBe(false);
  });
});
