// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { installObsidianDomHelpers } from "./obsidianDom";
import { buildProviderSelect, type ProviderSelect } from "../src/views/providerSelect";
import { AI_PROVIDERS } from "../src/settings/providers";

/**
 * 账户页「供应商下拉框」的行为契约（2026-10-09）。
 *
 * 这一组守的是那句用户话：**「选完供应商等于是填好了接口地址」** —— 以及它的三个
 * 反面：认不出的地址不能被硬认成某一家、选「自定义」不能把已有地址清掉、
 * 收起时挂在 document 上的监听不能留下（留下就是每开关一次漏一对）。
 *
 * 全部是"改了不报错、只是行为不对"的静默项，所以在这里钉住。
 */

installObsidianDomHelpers();

interface Mounted {
  root: HTMLElement;
  select: ProviderSelect;
  /** 悬停牌收到过的文字（按顺序）*/
  tips: string[];
  /** 模型名输入框（检查占位提示跟着换没换）*/
  modelInput: HTMLInputElement;
  /** 交给调用方保管的清理函数还在不在 —— 在 = 菜单开着（没摘监听）*/
  hasCloser(): boolean;
  baseUrl(): string;
}

const mounted: HTMLElement[] = [];

function mount(initialUrl: string): Mounted {
  const root = document.createElement("div");
  document.body.appendChild(root);
  mounted.push(root);

  let baseUrl = initialUrl;
  const tips: string[] = [];
  let closer: (() => void) | null = null;
  const modelInput = document.createElement("input");

  const select = buildProviderSelect(root, {
    // 跟视图里 makeField 同一套外观（这里只关心 DOM 结构成立）
    makeField(label, placeholder) {
      const field = root.createDiv({ cls: "yl-pc-field" });
      field.createDiv({ cls: "yl-pc-faint yl-pc-xs", text: label });
      const input = field.createEl("input", { cls: "yl-pc-input", attr: { placeholder } });
      // 视图里的 makeField 会把手填的值直接写回设置 —— 这里照做，否则"手填后提示跟着换"
      // 这条根本测不到（getBaseUrl 读的还是旧值）
      input.addEventListener("change", () => {
        baseUrl = input.value.trim();
      });
      return { field, input };
    },
    getBaseUrl: () => baseUrl,
    onPick: (url) => {
      if (url !== null) baseUrl = url;
    },
    modelInput: () => modelInput,
    showTip: (_el, text) => tips.push(text),
    hideTip: () => {},
    keepCloser: (fn) => {
      closer = fn;
    },
  });
  select.sync(baseUrl);

  return {
    root,
    select,
    tips,
    modelInput,
    hasCloser: () => closer !== null,
    baseUrl: () => baseUrl,
  };
}

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

function nameOf(select: ProviderSelect): string {
  return select.trigger.querySelector(".yl-pc-select-name")?.textContent ?? "";
}

function itemsOf(select: ProviderSelect): HTMLButtonElement[] {
  // Array.from 而不是展开 —— tsconfig 的 lib 里没有 DOM.Iterable，NodeList 不可迭代
  return Array.from(select.menu.querySelectorAll<HTMLButtonElement>(".yl-pc-select-item"));
}

function itemNamed(select: ProviderSelect, text: string): HTMLButtonElement {
  const found = itemsOf(select).find((el) => el.textContent === text);
  if (!found) throw new Error(`下拉里没有「${text}」这一项`);
  return found;
}

const DEEPSEEK = "https://api.deepseek.com/v1";

describe("供应商下拉：认地址", () => {
  it("地址正是名单里某一家 → 触发器显示品牌名，地址输入框收起（地址挪去悬停牌）", () => {
    const m = mount(DEEPSEEK);
    expect(nameOf(m.select)).toBe("深度求索 DeepSeek");
    expect(m.select.urlField.style.display).toBe("none");
    // 悬停触发器交代的就是这条地址
    m.select.trigger.dispatchEvent(new MouseEvent("mouseenter"));
    expect(m.tips).toContain(DEEPSEEK);
  });

  it("认不出的地址 → 当自定义：输入框露出来，且地址**原样留着**（绝不覆盖）", () => {
    const selfHosted = "https://gateway.example.com/v1";
    const m = mount(selfHosted);
    expect(nameOf(m.select)).toBe("自定义");
    expect(m.select.urlField.style.display).not.toBe("none");
    expect(m.select.urlInput.value).toBe(selfHosted);
  });

  it("空地址 → 也是自定义（还没填）", () => {
    const m = mount("");
    expect(nameOf(m.select)).toBe("自定义");
    expect(m.select.urlField.style.display).not.toBe("none");
  });
});

describe("供应商下拉：选中", () => {
  it("选一家 = 地址填好，并且菜单自己收起来", () => {
    const m = mount("https://gateway.example.com/v1");
    m.select.trigger.click();
    expect(m.hasCloser()).toBe(true);

    itemNamed(m.select, "深度求索 DeepSeek").click();

    expect(m.baseUrl()).toBe(DEEPSEEK);
    expect(nameOf(m.select)).toBe("深度求索 DeepSeek");
    expect(m.select.urlField.style.display).toBe("none");
    // 收起 = 挂 document 上的那对监听已经摘掉
    expect(m.hasCloser()).toBe(false);
    expect(m.select.menu.hasClass("is-hidden")).toBe(true);
  });

  it("选「自定义」不清空已有地址，只把输入框露出来", () => {
    const m = mount(DEEPSEEK);
    m.select.trigger.click();
    itemNamed(m.select, "自定义").click();

    expect(m.baseUrl()).toBe(DEEPSEEK);
    expect(nameOf(m.select)).toBe("自定义");
    expect(m.select.urlField.style.display).not.toBe("none");
    expect(m.select.urlInput.value).toBe(DEEPSEEK);
  });

  it("★ 当前地址本来就是某家的官方地址时，点「自定义」也要真的露出输入框", () => {
    // 这一条是从一个真 bug 回填的：最初"是不是自定义"靠**地址反查**推 ——
    // 于是地址正好是官方地址时（比如默认的百炼），点「自定义」立刻被反查拉回那一家，
    // 字不变、输入框不出现，看着就是"点了没反应"。现在靠显式开关，钉住。
    const m = mount("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(nameOf(m.select)).toBe("阿里云百炼（通义千问）");

    m.select.trigger.click();
    itemNamed(m.select, "自定义").click();

    expect(nameOf(m.select)).toBe("自定义");
    expect(m.select.urlField.style.display).not.toBe("none");
    // 地址原封不动 —— 「自定义」只是"我要手填"
    expect(m.baseUrl()).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });

  it("名单里每一家都在下拉里，且每一家都能被选中并写上自己的地址", () => {
    const m = mount("");
    m.select.trigger.click();
    const names = itemsOf(m.select).map((el) => el.textContent);
    for (const p of AI_PROVIDERS) expect(names).toContain(p.name);

    for (const p of AI_PROVIDERS) {
      m.select.sync(m.baseUrl()); // 菜单可能已被上一次选择收起
      m.select.trigger.click();
      itemNamed(m.select, p.name).click();
      expect(m.baseUrl(), p.name).toBe(p.baseUrl);
      expect(nameOf(m.select), p.name).toBe(p.name);
    }
  });
});

describe("供应商下拉：悬停出地址", () => {
  it("悬停任意一项 → 牌子显示这家的真实接口地址", () => {
    const m = mount("");
    m.select.trigger.click();
    const item = itemNamed(m.select, "火山方舟（豆包）");
    item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(m.tips.at(-1)).toBe("https://ark.cn-beijing.volces.com/api/v3");
  });

  it("悬停在菜单空白处 → 牌子收掉（不留上一条的残影）", () => {
    const m = mount("");
    m.select.trigger.click();
    itemNamed(m.select, "智谱 GLM").dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    const count = m.tips.length;
    m.select.menu.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(m.tips.length).toBe(count);
  });

  it("模型名输入框的占位提示跟着**地址**走：认得出给例子，认不出只说要填什么", () => {
    const m = mount("");
    m.select.trigger.click();
    itemNamed(m.select, "深度求索 DeepSeek").click();
    expect(m.modelInput.placeholder).toBe("如 deepseek-chat");

    // 选「自定义」后地址还留着 DeepSeek 的 —— 提示仍按"地址是哪家"给，
    // 跟输入框里的字保持一致（不是按"选了哪个模式"给）
    m.select.trigger.click();
    itemNamed(m.select, "自定义").click();
    expect(m.modelInput.placeholder).toBe("如 deepseek-chat");

    // 手填成自己的网关 → 认不出了，提示改成"填该服务商的模型名"
    m.select.urlInput.value = "https://gateway.example.com/v1";
    m.select.urlInput.dispatchEvent(new Event("change"));
    expect(m.modelInput.placeholder).toBe("填该服务商的模型名");
  });
});

describe("供应商下拉：收起", () => {
  it("点外面收起（菜单里的点击不算外面）", () => {
    const m = mount(DEEPSEEK);
    m.select.trigger.click();
    // 菜单里的 mousedown 不算"点外面"
    m.select.trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(m.hasCloser()).toBe(true);

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(m.select.menu.hasClass("is-hidden")).toBe(true);
    expect(m.hasCloser()).toBe(false);
  });

  it("Esc 收起", () => {
    const m = mount(DEEPSEEK);
    m.select.trigger.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(m.select.menu.hasClass("is-hidden")).toBe(true);
    expect(m.hasCloser()).toBe(false);
  });

  it("收起后再点触发器能重新打开（且不会留下上一轮的监听）", () => {
    const m = mount(DEEPSEEK);
    m.select.trigger.click();
    m.select.trigger.click();
    expect(m.select.menu.hasClass("is-hidden")).toBe(true);
    expect(m.hasCloser()).toBe(false);

    m.select.trigger.click();
    expect(m.select.menu.hasClass("is-hidden")).toBe(false);
    expect(m.hasCloser()).toBe(true);
    m.select.close();
  });
});
