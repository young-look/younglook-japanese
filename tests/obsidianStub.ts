/**
 * obsidian 的 npm 包只有类型声明，没有 node 能用的运行时入口。
 * 单测里凡是真正 import 到 obsidian 模块的代码（目前只有 bangumi.ts
 * 的 requestUrl）会被 vitest.config 的 alias 打到这个桩上 ——
 * 这些是网络路径，单测不该执行；真执行了就立刻失败，别悄悄吐错误数据。
 */
export async function requestUrl(): Promise<never> {
  throw new Error("requestUrl 不该在单测里被调用（网络层不在单测范围）");
}

/**
 * 真包里 `FileSystemAdapter` 是个类：能拿到 vault 绝对路径的桌面端是它的实例。
 * `services/dictPath.ts` 用 `instanceof` 判断这件事 —— 这里给一个空类，任何
 * 伪装出来的 adapter 都算不上它的实例，于是那条判断按"拿不到绝对路径"走
 * （词典目录就当不存在），与移动端上的行为一致。
 */
export class FileSystemAdapter {}

/**
 * 图标渲染走 Obsidian 自带的 lucide 图标集，单测不关心 SVG 长什么样 —— 空实现。
 * study 卡片与 ui/button 都会在构建时调它，没有这个桩连卡片都搭不起来。
 */
export function setIcon(_el: HTMLElement, _name: string): void {}

/** 提示条：单测环境弹不出来，也不该弹。留个空壳让 import 成立。 */
export class Notice {
  constructor(_message?: string, _timeout?: number) {}
}

/**
 * 视图基类的最小壳（`StudyView` / `PersonalCenterView` 继承它）。
 *
 * 单测要的是"视图里的**分支**对不对"（比如学习卡片「返回」按来路退到哪一页，
 * 见 tests/studyBackNavigation.test.ts），不是渲染出来长什么样 —— 所以这里只给
 * 三个真节点（containerEl / contentEl）+ app + leaf，够构造、够挂监听即可。
 * ⚠️ 用纯 jsdom API 建节点，不依赖 `installObsidianDomHelpers()`（那个补丁是给
 *    运行时的 `createDiv` 这类扩展方法用的，构造期不该假定它已经装上）。
 */
export class ItemView {
  app: unknown = {};
  containerEl: HTMLElement;
  contentEl: HTMLElement;

  constructor(public leaf: unknown) {
    this.containerEl = document.createElement("div");
    this.contentEl = document.createElement("div");
    this.containerEl.appendChild(this.contentEl);
  }
}

/** 右键菜单：单测不点它，只要 `addItem().setTitle()...` 这条链能跑通。 */
export class MenuItem {
  setTitle(_title: string): this {
    return this;
  }
  setIcon(_icon: string): this {
    return this;
  }
  onClick(_callback: (evt: MouseEvent) => unknown): this {
    return this;
  }
}

export class Menu {
  addItem(cb: (item: MenuItem) => unknown): this {
    cb(new MenuItem());
    return this;
  }
  showAtMouseEvent(_evt: MouseEvent): void {}
}

/** vault 文件对象：单测只当类型/占位用（路径由测试自己塞）。 */
export class TFile {
  path = "";
}

/**
 * 键位作用域（真身是 obsidian 的 `Scope`）。单测只关心一件事：**「锁定」的
 * 弹窗能不能被 Esc 关掉** —— 所以这里给一个够用的壳，`register` 记下处理器，
 * `triggerEscape()` 手动按一下，返回 `false` 表示被拦下（阻止默认）。
 */
export class Scope {
  private handlers: Array<{ key: string | null; fn: (evt: KeyboardEvent) => unknown }> = [];

  register(_modifiers: unknown, key: string | null, fn: (evt: KeyboardEvent) => unknown): unknown {
    this.handlers.push({ key, fn });
    return {};
  }

  /** 单测用：模拟按 Esc，透传"是否被拦下"（`false` = 拦下了）。 */
  triggerEscape(): boolean {
    for (const handler of this.handlers) {
      if (handler.key !== "Escape") continue;
      const result = handler.fn(new KeyboardEvent("keydown", { key: "Escape" }));
      if (result === false) return false;
    }
    return true;
  }
}

/**
 * 弹窗基类的最小可用壳（`ui/dialog.ts` 的 `DialogModal` 继承它）。
 *
 * 真身挂在应用窗口上，单测里没有那层宿主 —— 但"弹窗里到底写了什么、点了哪颗钮
 * 会发生什么"是**用户可见的契约**，值得钉住（重新解析的确认窗、模型配置窗都靠它）。
 * 所以这里只做到够用：给 `contentEl` / `modalEl` 两个真实节点、一个 `scope`，
 * `open()` 触发 `onOpen()`（子类在里面搭壳），`close()` 触发 `onClose()`。
 *
 * ⚠️ 用到它的测试必须先把 `installObsidianDomHelpers()` 装上（createDiv / empty /
 *    addClass 这些是 Obsidian 给 HTMLElement 打的补丁，不是 jsdom 自带的）。
 * ⚠️ `DocumentFragment` 在 jsdom 里是存在的；这里只是按真身把标题行的节点挂上。
 */
export class Modal {
  readonly containerEl: HTMLElement;
  readonly modalEl: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly contentEl: HTMLElement;
  readonly scope: Scope;

  constructor(public app: unknown) {
    this.containerEl = document.createElement("div");
    this.modalEl = this.containerEl.createDiv({ cls: "modal" });
    this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
    this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
    this.scope = new Scope();
  }

  /** 真身是异步动画后回调 `onOpen`；单测要的是"打开后长什么样"，同步调即可 */
  open(): void {
    this.onOpen();
  }

  close(): void {
    this.onClose();
  }

  onOpen(): void {}
  onClose(): void {}
}
