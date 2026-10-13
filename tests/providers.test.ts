import { describe, expect, it } from "vitest";
import {
  AI_PROVIDERS,
  modelPlaceholder,
  normalizeBaseUrl,
  providerByBaseUrl,
} from "../src/settings/providers";

/**
 * 这组用例守的是账户页那个**供应商下拉框**（2026-10-09）：
 * 「选一家 = 接口地址填好」这句话只在下拉能准确认出地址时才成立。
 *
 * 认错的后果不是报错，而是**悄悄换掉用户的 AI 供应商**（把地址改成别家的），
 * 或者把用户手填的自建地址标成"某家官方地址"而不再让他编辑 —— 两种都静默。
 */

describe("providerByBaseUrl", () => {
  it("名单里每一家都能被自己的地址认出来（反查是双向的）", () => {
    for (const p of AI_PROVIDERS) {
      expect(providerByBaseUrl(p.baseUrl)?.id, `${p.id} 认不出自己`).toBe(p.id);
    }
  });

  it("手抄常见误差照认：多余尾斜杠 / 前后空格 / 大小写不同", () => {
    expect(providerByBaseUrl("  https://api.deepseek.com/v1/  ")?.id).toBe("deepseek");
    expect(providerByBaseUrl("HTTPS://API.DEEPSEEK.COM/V1")?.id).toBe("deepseek");
    expect(providerByBaseUrl("https://ark.cn-beijing.volces.com/api/v3///")?.id).toBe("volcengine");
  });

  it("认不出就是认不出：绝不猜最近的那家", () => {
    // 自建代理 / 中转站 / 少写一段路径 —— 一律 null（界面走「自定义」，不覆盖）
    expect(providerByBaseUrl("")).toBeNull();
    expect(providerByBaseUrl("   ")).toBeNull();
    expect(providerByBaseUrl("http://localhost:3000/v1")).toBeNull();
    expect(providerByBaseUrl("https://api.deepseek.com")).toBeNull();
    expect(providerByBaseUrl("https://gateway.example.com/v1")).toBeNull();
  });
});

describe("AI_PROVIDERS 名单本身", () => {
  it("地址不重复 —— 重复的那家永远选不到（反查只会命中排前面那个）", () => {
    const seen = new Map<string, string>();
    for (const p of AI_PROVIDERS) {
      const key = normalizeBaseUrl(p.baseUrl);
      const dup = seen.get(key);
      expect(dup, `${p.id} 与 ${dup ?? ""} 地址相同：${p.baseUrl}`).toBeUndefined();
      seen.set(key, p.id);
    }
  });

  it("id 不重复", () => {
    expect(new Set(AI_PROVIDERS.map((p) => p.id)).size).toBe(AI_PROVIDERS.length);
  });

  it("每一家的地址都是 http(s) 绝对地址，且不残留模板占位", () => {
    for (const p of AI_PROVIDERS) {
      expect(p.baseUrl, p.id).toMatch(/^https:\/\/[^\s]+$/u);
      expect(p.baseUrl, p.id).not.toMatch(/\s/u);
      expect(p.name.trim(), p.id).not.toBe("");
      expect(p.modelHint.trim(), p.id).not.toBe("");
    }
  });
});

describe("modelPlaceholder", () => {
  it("认出来了给这家的例子，认不出只说要填什么（不乱举例子）", () => {
    expect(modelPlaceholder("https://api.deepseek.com/v1")).toBe("如 deepseek-chat");
    expect(modelPlaceholder("https://gateway.example.com/v1")).toBe("填该服务商的模型名");
    expect(modelPlaceholder("")).toBe("填该服务商的模型名");
  });

  it("火山方舟这类的提示要说清是接入点 ID，不能报一个具体模型名当保证", () => {
    expect(modelPlaceholder("https://ark.cn-beijing.volces.com/api/v3")).toContain("ep-");
  });
});
