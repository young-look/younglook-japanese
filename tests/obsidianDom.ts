/**
 * jsdom 补 Obsidian 运行时挂在 HTMLElement 上的那套扩展（createDiv / setText /
 * hide/show / toggleClass…），让 study 下的卡片构建函数（buildAnalysis /
 * buildImitation / buildAssistant）能在单测里真跑 —— 否则「AI 按钮置灰、点击弹
 * 统一弹窗」这条用户拍板的行为没法在视图层钉住（2026-10-04 用户令）。
 *
 * 只补测试真正用到的子集，语义对齐 Obsidian：
 *  - hide/show 走 inline `display`，isShown 以 `display !== "none"` 为准；
 *  - toggleClass(cls, value?) = classList.toggle；
 *  - createEl 的 opts 支持 cls / text / attr / type（input 的 type 属性），
 *    以及 Obsidian 的字符串简写 `createDiv("cls")`。
 *
 * ⚠️ 必须在**调用**构建函数之前 install（模块顶层只 import 不碰 DOM，顺序无忧）；
 *    幂等，重复 install 是空操作。
 */
type CreateOpts = {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
  type?: string;
};

export function installObsidianDomHelpers(): void {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  if (proto.__ylDomHelpersInstalled === true) return;
  proto.__ylDomHelpersInstalled = true;

  const make = (tag: string, opts?: CreateOpts | string): HTMLElement => {
    const el = document.createElement(tag);
    if (typeof opts === "string") {
      el.className = opts;
      return el;
    }
    if (opts) {
      if (opts.cls) el.className = opts.cls;
      if (opts.text !== undefined) el.textContent = opts.text;
      if (opts.type) (el as HTMLInputElement).type = opts.type;
      if (opts.attr) {
        for (const [name, value] of Object.entries(opts.attr)) el.setAttribute(name, value);
      }
    }
    return el;
  };

  proto.createEl = function (this: HTMLElement, tag: string, opts?: CreateOpts | string) {
    const el = make(tag, opts);
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (this: HTMLElement, opts?: CreateOpts | string) {
    const el = make("div", opts);
    this.appendChild(el);
    return el;
  };
  proto.createSpan = function (this: HTMLElement, opts?: CreateOpts | string) {
    const el = make("span", opts);
    this.appendChild(el);
    return el;
  };
  proto.toggle = function (this: HTMLElement, cls: string, value?: boolean) {
    this.classList.toggle(cls, value);
  };
  proto.setText = function (this: HTMLElement, text: string) {
    this.textContent = text;
  };
  proto.appendText = function (this: HTMLElement, text: string) {
    this.appendChild(document.createTextNode(text));
  };
  proto.empty = function (this: HTMLElement) {
    while (this.firstChild) this.removeChild(this.firstChild);
  };
  proto.hide = function (this: HTMLElement) {
    this.style.display = "none";
  };
  proto.show = function (this: HTMLElement) {
    this.style.display = "";
  };
  proto.isShown = function (this: HTMLElement) {
    return this.style.display !== "none";
  };
  // ⚠️ Obsidian 的 `toggle(visible?)` 是**可见性**切换，不是 class 切换
  //（StudyView 的 videoMetaEl、assistant 的 badge 都靠它显隐）—— 别跟 toggleClass 混了。
  proto.toggle = function (this: HTMLElement, value?: boolean) {
    const visible = value ?? this.style.display === "none";
    if (visible) this.style.display = "";
    else this.style.display = "none";
  };
  proto.addClass = function (this: HTMLElement, ...classes: string[]) {
    this.classList.add(...classes);
  };
  proto.removeClass = function (this: HTMLElement, ...classes: string[]) {
    this.classList.remove(...classes);
  };
  proto.toggleClass = function (this: HTMLElement, cls: string, value?: boolean) {
    this.classList.toggle(cls, value);
  };
  proto.hasClass = function (this: HTMLElement, cls: string) {
    return this.classList.contains(cls);
  };
  // 社区目录要求别直接写 el.style.xxx，改走 setCssStyles（普通样式）/ setCssProps
  // （CSS 变量）。这里补上，语义对齐 Obsidian：camelCase 的 key 转成 kebab 再写。
  proto.setCssStyles = function (this: HTMLElement, styles: Record<string, string | undefined>) {
    for (const [name, value] of Object.entries(styles)) {
      const prop = name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      this.style.setProperty(prop, value ?? "");
    }
  };
  proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
    for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
  };
  proto.setAttr = function (this: HTMLElement, name: string, value: string) {
    this.setAttribute(name, value);
  };
  proto.getAttr = function (this: HTMLElement, name: string) {
    return this.getAttribute(name);
  };
  proto.removeAttr = function (this: HTMLElement, name: string) {
    this.removeAttribute(name);
  };

  // practices / analysis 顶部用的**全局** createDiv("cls")（Obsidian 的 window 级助手）
  const globals = window as unknown as Record<string, unknown>;
  globals.createEl = (tag: string, opts?: CreateOpts | string) => make(tag, opts);
  globals.createDiv = (opts?: CreateOpts | string) => make("div", opts);
  globals.createSpan = (opts?: CreateOpts | string) => make("span", opts);
}
