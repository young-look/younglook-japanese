/**
 * 「供应商」下拉框 —— 账户页自定义模型那一轨的接口地址入口（2026-10-09 用户拍板）。
 *
 * ══ 它解决的是什么 ══════════════════════════════════════════════════
 * 原先只有一个空的「接口地址」输入框。普通用户不知道自己那家的地址长什么样，
 * 得先去官网翻文档、抄一行 URL 回来 —— 抄错一个字符，症状只是"测试连接不通"，
 * 而且完全看不出错在哪。
 *
 * 现在：**选一家 = 地址填好**。版面上只出品牌名，真实地址挂在**零延迟悬停牌**
 * 上（原生 `title` 的系统提示框慢一秒，2026-10-09 用户点名弃用）。
 * 「自定义」是逃生舱 —— 选它才露出输入框，自建代理 / 中转站走这条。
 *
 * ══ 三条容易踩的坑（都踩过或差点踩）══════════════════════════════════
 *  1. **认不出就不认**：`settings.byok.baseUrl` 反查不到服务商时一律当「自定义」
 *     处理，把输入框露出来。绝不"猜最近的那家" —— 猜错等于在用户完全无感的情况下
 *     把地址换成别家的。
 *  2. **「自定义」不清空地址**：它只是"我要手填"，不是"我不要这个地址了"。
 *  3. **点外面 / Esc 收起** 靠挂在 document 上的监听，菜单 DOM 被重画时这些监听
 *     **不会跟着消失** —— 所以 `close()` 必须由调用方在重画 / 关页前主动调一次
 *     （通过 `keepCloser` 把清理函数交出去保管）。
 *
 * 纯 DOM 组件：不读也不写设置，选中哪家由调用方通过 `onPick` + `getBaseUrl` 决定。
 * 这样它能在 jsdom 里整块真跑（见 tests/providerSelect.test.ts）。
 */

import { setIcon } from "obsidian";
import {
  AI_PROVIDERS,
  CUSTOM_PROVIDER_NAME,
  modelPlaceholder,
  providerByBaseUrl,
} from "../settings/providers";

export interface ProviderSelectDeps {
  /** 造一个「标签 + 输入框」字段 —— 由调用方给，保证跟旁边 API Key / 模型名 同一套外观 */
  makeField(label: string, placeholder: string): { field: HTMLElement; input: HTMLInputElement };
  /** 当前地址（每次同步现读，别缓存 —— 用户可能刚在手填） */
  getBaseUrl(): string;
  /** 选中一家（非 null）或「自定义」（null）。**写回设置由调用方负责，且必须同步完成** */
  onPick(baseUrl: string | null): void;
  /** 模型名输入框（惰性取 —— 它通常在这个下拉之后才建出来） */
  modelInput(): HTMLInputElement;
  /** 零延迟悬停牌（全页共用一枚，见 PersonalCenterView.showHoverTip） */
  showTip(el: HTMLElement, text: string): void;
  hideTip(): void;
  /** 把「点外面 / Esc 收起」的清理函数交出去保管；传 null 表示已收起、无需清理 */
  keepCloser(close: (() => void) | null): void;
}

export interface ProviderSelect {
  /** 触发器（测试 / 焦点操作用） */
  readonly trigger: HTMLButtonElement;
  /** 菜单容器（测试用） */
  readonly menu: HTMLElement;
  /** 接口地址字段（显隐挂在它身上；测试用） */
  readonly urlField: HTMLElement;
  /** 接口地址输入框（测试用） */
  readonly urlInput: HTMLInputElement;
  /** 按给定地址把这一块重画一遍 */
  sync(baseUrl: string): void;
  /** 收起菜单并摘掉 document 上的监听 */
  close(): void;
}

export function buildProviderSelect(
  parent: HTMLElement,
  deps: ProviderSelectDeps,
): ProviderSelect {
  const field = parent.createDiv({ cls: "yl-pc-field" });
  field.createDiv({ cls: "yl-pc-faint yl-pc-xs", text: "供应商" });
  const wrap = field.createDiv({ cls: "yl-pc-select" });

  const trigger = wrap.createEl("button", {
    cls: "yl-pc-select-btn",
    attr: { type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" },
  });
  const nameEl = trigger.createSpan({ cls: "yl-pc-select-name" });
  setIcon(trigger.createSpan({ cls: "yl-pc-select-chev" }), "chevron-down");
  const menu = wrap.createDiv({ cls: "yl-pc-select-menu is-hidden", attr: { role: "listbox" } });

  // 接口地址：选中常用供应商时由下拉代填并**收起**（地址挪到悬停牌上）；
  // 认不出是哪家才露出来给人手填。
  const { field: urlField, input: urlInput } = deps.makeField("接口地址", "https://…/v1");

  // 选项清单：常用供应商一行一个，末尾「其他 → 自定义」。
  // 每项都挂 dataset.tip —— 悬停牌显示的就是这家真实的接口地址（不用 title，
  // 否则会跟牌子叠成两个提示框，而且原生的那个慢一秒）。
  const items: { id: string | null; el: HTMLButtonElement }[] = [];
  const addItem = (id: string | null, name: string, tip: string, baseUrl: string | null): void => {
    const item = menu.createEl("button", {
      cls: "yl-pc-select-item",
      text: name,
      attr: { type: "button", role: "option", "aria-label": `${name}，${tip}` },
    });
    item.dataset.tip = tip;
    item.addEventListener("click", () => pick(baseUrl));
    items.push({ id, el: item });
  };
  menu.createDiv({ cls: "yl-pc-select-group", text: "常见供应商" });
  for (const p of AI_PROVIDERS) addItem(p.id, p.name, p.baseUrl, p.baseUrl);
  menu.createDiv({ cls: "yl-pc-select-group", text: "其他" });
  addItem(null, CUSTOM_PROVIDER_NAME, "自己填接口地址（自建代理 / 中转站）", null);

  // 🔥 用户**明确选了「自定义」**这个状态必须自己记着，不能靠"地址反查不出服务商"推。
  //    反推有个静默坑：当前地址本来就是某家的官方地址时（比如默认的百炼），点「自定义」
  //    会立刻被反查拉回那一家 —— 输入框不出现、字也不变，看着像"点了没反应"。
  //    所以这里是一个显式开关：选一家 = false，选自定义 = true，手填后失效（见 change）。
  let customMode = false;

  const sync = (baseUrl: string): void => {
    const url = baseUrl.trim();
    const picked = customMode ? null : providerByBaseUrl(url);
    const name = picked ? picked.name : CUSTOM_PROVIDER_NAME;
    nameEl.setText(name);
    trigger.setAttribute("aria-label", `供应商：${name}`);
    // 悬停交代的就是这条地址
    trigger.dataset.tip = url || "还没填接口地址";
    trigger.toggleClass("is-custom", !picked);
    urlField.toggle(!picked);
    urlInput.value = url;
    deps.modelInput().placeholder = modelPlaceholder(url);
    for (const item of items) item.el.toggleClass("is-active", item.id === (picked?.id ?? null));
  };

  const close = (): void => {
    menu.addClass("is-hidden");
    trigger.removeClass("is-open");
    trigger.setAttribute("aria-expanded", "false");
    deps.keepCloser(null);
    deps.hideTip();
  };

  const open = (): void => {
    menu.removeClass("is-hidden");
    trigger.addClass("is-open");
    trigger.setAttribute("aria-expanded", "true");
    // 点外面 / 按 Esc 收起。⚠️ capture 阶段：菜单里的钮自己也会 click，
    // 冒泡阶段拦会晚一步（点选项时菜单已经关了）。
    const onDown = (ev: MouseEvent): void => {
      const target = ev.target;
      if (target instanceof Node && wrap.contains(target)) return;
      close();
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape") return;
      close();
      trigger.focus();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    // 交给调用方保管 —— 菜单 DOM 被重画时这些监听不会自己消失（见文件头坑 3）
    deps.keepCloser(() => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    });
  };

  const pick = (baseUrl: string | null): void => {
    customMode = baseUrl === null;
    deps.onPick(baseUrl);
    close();
    sync(deps.getBaseUrl());
    // 自定义那档：露出输入框后直接把光标放进去，省一次点击
    if (baseUrl === null) urlInput.focus();
  };

  trigger.addEventListener("click", () => {
    if (menu.hasClass("is-hidden")) open();
    else close();
  });
  // 悬停即读地址：触发器上显示的是"你选了哪家"，地址靠牌子交代
  trigger.addEventListener("mouseenter", () => deps.showTip(trigger, trigger.dataset.tip ?? ""));
  trigger.addEventListener("mouseleave", () => deps.hideTip());
  menu.addEventListener("mouseover", (ev) => {
    const target = ev.target;
    const tip = target instanceof HTMLElement ? target.dataset.tip : undefined;
    if (target instanceof HTMLElement && tip) deps.showTip(target, tip);
    else deps.hideTip();
  });
  menu.addEventListener("mouseleave", () => deps.hideTip());
  // 菜单里滚动时牌子跟不上（fixed 定位不随容器滚），直接收掉
  menu.addEventListener("scroll", () => deps.hideTip(), { passive: true });
  // 手填的地址如果正好是名单里的某一家，下拉跟着变（两个控件说的是同一件事）——
  // 手填即退出「自定义」模式：地址本身就能说明是哪一家了。
  urlInput.addEventListener("change", () => {
    customMode = false;
    sync(deps.getBaseUrl());
  });

  return { trigger, menu, urlField, urlInput, sync, close };
}
