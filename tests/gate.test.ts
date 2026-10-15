import { describe, expect, it } from "vitest";
import { byokUiState, resolveAiGate, resolveAiRoute } from "../src/services/ai/gate";
import type { PluginSettings } from "../src/settings/types";

/**
 * AI 门控的用例。
 *
 * 最要紧的一条：**BYOK 不拦**。用户自带 Key 时请求直连他自己的端点，
 * 不经过我们的服务器、不扣余额，所以哪怕没登录也必须能点 ——
 * 一旦这里被拦住，就等于对已经自带 Key 的用户二次收费（docs/13 第一节）。
 * 2026-10-10 起还有一个前置：「自带 Key」指的是**已保存的快照**（byokSaved），
 * 账户页上填而未保存的草稿不参与判定。
 */
function settings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return {
    vaultFolder: "看动漫学日语",
    mediaDir: "",
    aiMode: "hosted",
    byok: { baseUrl: "https://example.com/v1", apiKey: "sk-test", model: "qwen-plus" },
    byokSaved: null,
    byokLocked: false,
    serverEnv: "prod",
    customServerUrl: "",
    serverUrl: "https://younglook.cc",
    authServerUrl: "",
    authToken: "token-abc",
    refreshToken: "refresh-abc",
    lastStatsSyncAt: 0,
    aiBalanceMillis: 0,
    accountProfile: null,
    autoSyncMinutes: 15,
    vaultLocalId: "test",
    spaces: [{ id: "test", owner: "", ownerServer: "", ownerName: "" }],
    activeSpaceId: "test",
    autoOpenPage: true,
    lastView: "",
    lastUpdateCheckAt: 0,
    dictPromptSeen: false,
    micQualityPromptSeen: false,
    prefsUpdatedAt: "",
    lastVerifyDay: "",
    ...overrides,
  };
}

describe("AI 门控", () => {
  it("关闭模式：不可用，且不该把用户往登录上引", () => {
    const gate = resolveAiGate(settings({ aiMode: "off" }));
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("off");
    expect(gate.canLogin).toBe(false);
    expect(gate.message).toContain("AI 解析");
  });

  it("内置模型未登录：拦下，并告诉用户登录能解决", () => {
    const gate = resolveAiGate(settings({ aiMode: "hosted", authToken: "" }));
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("need-login");
    expect(gate.canLogin).toBe(true);
    // 指向必须是**插件内的登录入口**（个人中心），不能是网页/「连接账号」
    expect(gate.message).toContain("登录");
    expect(gate.message).toContain("个人中心");
  });

  it("内置模型已登录且有余量：放行", () => {
    expect(
      resolveAiGate(settings({ aiMode: "hosted", authToken: "tok", aiBalanceMillis: 500 })).ok,
    ).toBe(true);
  });

  it("内置模型已登录但没余额：拦下（need-balance），这不是登录问题", () => {
    // 2026-10-04 用户拍板：没余额也拦在点击这一步，按钮置灰、点击弹统一弹窗
    // （2026-10-05 起主钮是「去配置」：充值或改用自定义模型都在账户页选）——
    // 绝不能退回"放行请求、等 402 再就地摆提示"的旧口径。
    const gate = resolveAiGate(settings({ aiMode: "hosted", authToken: "tok", aiBalanceMillis: 0 }));
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("need-balance");
    expect(gate.canLogin).toBe(false);
    expect(gate.message).toContain("余额");
  });

  it("BYOK 已保存（有快照）：**未登录也放行**（永久免费，不该要账号）", () => {
    const gate = resolveAiGate(
      settings({
        aiMode: "byok",
        authToken: "",
        byokSaved: { baseUrl: "https://example.com/v1", apiKey: "sk-test", model: "qwen-plus" },
      }),
    );
    expect(gate.ok).toBe(true);
  });

  it("BYOK 只认已保存的快照：填了草稿但没点保存 = 还没生效，引导去保存", () => {
    const unsaved = resolveAiGate(
      settings({ aiMode: "byok", byok: { baseUrl: "https://x/v1", apiKey: " ", model: "m" } }),
    );
    expect(unsaved.ok).toBe(false);
    if (!unsaved.ok) {
      expect(unsaved.reason).toBe("off");
      expect(unsaved.canLogin).toBe(false);
      expect(unsaved.message).toContain("保存");
    }

    // 快照本身缺项同样不算生效（防御）
    expect(
      resolveAiGate(settings({ aiMode: "byok", byokSaved: { baseUrl: "", apiKey: "k", model: "m" } })).ok,
    ).toBe(false);
    expect(
      resolveAiGate(settings({ aiMode: "byok", byokSaved: { baseUrl: "https://x/v1", apiKey: "k", model: "" } }))
        .ok,
    ).toBe(false);
  });

  it("编辑中（解锁改动草稿）旧快照继续生效", () => {
    const gate = resolveAiGate(
      settings({
        aiMode: "byok",
        byok: { baseUrl: "https://draft.example.com/v1", apiKey: "sk-draft", model: "draft" },
        byokSaved: { baseUrl: "https://example.com/v1", apiKey: "sk-test", model: "qwen-plus" },
        byokLocked: false,
      }),
    );
    expect(gate.ok).toBe(true);
  });

  it("只有空白字符的令牌不算登录", () => {
    expect(resolveAiGate(settings({ aiMode: "hosted", authToken: "   " })).ok).toBe(false);
  });

  // 2026-10-12 用户拍板：双轨平级自由选，**废除「有余额先扣余额」的自动顺序**
  // —— resolveAiRoute 只看 aiMode（自定义模型仍须已保存快照），余额多少只影响
  // 内置模型那条轨本身能不能用。
  it("resolveAiRoute：aiMode 选谁就用谁，余额不再改变轨道", () => {
    const saved = { baseUrl: "https://example.com/v1", apiKey: "sk-test", model: "qwen-plus" };
    expect(resolveAiRoute(settings({ aiMode: "byok", aiBalanceMillis: 500, byokSaved: saved }))).toBe("byok");
    expect(resolveAiRoute(settings({ aiMode: "byok", aiBalanceMillis: 0, byokSaved: saved }))).toBe("byok");
    expect(resolveAiRoute(settings({ aiMode: "byok", aiBalanceMillis: 500 }))).toBe("off");
    expect(resolveAiRoute(settings({ aiMode: "hosted", aiBalanceMillis: 500 }))).toBe("hosted");
    expect(resolveAiRoute(settings({ aiMode: "hosted", aiBalanceMillis: 0 }))).toBe("hosted");
    expect(resolveAiRoute(settings({ aiMode: "off", aiBalanceMillis: 500 }))).toBe("off");
    expect(resolveAiRoute(settings({ aiMode: "off", aiBalanceMillis: 0 }))).toBe("off");
  });

  it("模式是「关闭」就不放行，哪怕账号里还有余额（选择权在用户）", () => {
    const gate = resolveAiGate(settings({ aiMode: "off", authToken: "tok", aiBalanceMillis: 500 }));
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toBe("off");
  });

  it("选了 BYOK 且快照齐全：有余额也走 BYOK（不再先扣余额）", () => {
    const gate = resolveAiGate(
      settings({
        aiMode: "byok",
        authToken: "tok",
        aiBalanceMillis: 500,
        byokSaved: { baseUrl: "https://example.com/v1", apiKey: "sk-test", model: "qwen-plus" },
      }),
    );
    expect(gate.ok).toBe(true);
  });
});

describe("byokUiState（账户页保存/编辑锁定）", () => {
  const saved = { baseUrl: "https://example.com/v1", apiKey: "sk-test", model: "qwen-plus" };

  it("从没保存过：编辑态，也没有可依赖的快照", () => {
    expect(byokUiState(settings({}))).toEqual({ locked: false, hasSaved: false });
  });

  it("保存过且没在编辑：锁定态", () => {
    expect(byokUiState(settings({ byokSaved: saved, byokLocked: true }))).toEqual({
      locked: true,
      hasSaved: true,
    });
  });

  it("点了「编辑」（byokLocked=false）：解锁，但快照还在、照旧生效", () => {
    expect(byokUiState(settings({ byokSaved: saved, byokLocked: false }))).toEqual({
      locked: false,
      hasSaved: true,
    });
  });

  it("快照缺项时不给锁定（半截配置不该装作已保存）", () => {
    const broken = { baseUrl: "", apiKey: "sk-test", model: "qwen-plus" };
    expect(byokUiState(settings({ byokSaved: broken, byokLocked: true }))).toEqual({
      locked: false,
      hasSaved: false,
    });
  });
});