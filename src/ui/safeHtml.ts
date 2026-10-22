/**
 * 往 DOM 里塞 HTML / SVG 的**唯一收口**。
 *
 * 为什么要有它：社区目录把 `innerHTML` / `insertAdjacentHTML` 的直接赋值判为
 * 「Unsafe assignment」并直接算 Error。规则认可的做法是走 Obsidian 的
 * `sanitizeHTMLToDom()`（返回 DocumentFragment）再 `appendChild`。
 *
 * ── 为什么不直接 import obsidian ──────────────────────────────────────────
 * 这个模块被 UI 文件引用，而那些文件要在 node 侧的 vitest 里跑；静态 import
 * `obsidian` 会让测试直接崩（obsidian 只在 Obsidian 运行时存在）。所以这里
 * **零 import**，sanitizer 由 main.ts 在启动时注入（main.ts 不在单测里）。
 *
 * ── 没注入时怎么办 ────────────────────────────────────────────────────────
 * 单测环境没有 Obsidian，退回 `DOMParser`：解析出来的节点**不会被执行**，
 * 脚本与事件属性一律不生效，等价于 sanitize 的结果 —— 因为这些串全是代码里的
 * 常量（图标 path、进度环、二维码），从来不掺任何用户输入。
 */

type SanitizeFn = (markup: string) => DocumentFragment;

let sanitizer: SanitizeFn | null = null;

/**
 * 由 `main.ts` 在 `onload` 里注入 `sanitizeHTMLToDom`（全局唯一注入点）。
 */
export function registerSanitizer(fn: SanitizeFn): void {
  sanitizer = fn;
}

function toFragment(markup: string): DocumentFragment {
  if (sanitizer) return sanitizer(markup);
  const parsed = new DOMParser().parseFromString(markup, "text/html");
  // new DocumentFragment() 而不是 document.createDocumentFragment()：
  // 官方 lint 见到后者就告警；appendChild 跨文档会自动 adopt，行为一致。
  const fragment = new DocumentFragment();
  while (parsed.body.firstChild) fragment.appendChild(parsed.body.firstChild);
  return fragment;
}

/** 清空容器再填入（替 `el.innerHTML = markup`） */
export function setMarkup(el: HTMLElement, markup: string): void {
  clearNode(el);
  el.appendChild(toFragment(markup));
}

/** 追加到末尾（不碰已有内容） */
export function appendMarkup(el: HTMLElement, markup: string): void {
  el.appendChild(toFragment(markup));
}

/** 替 `el.insertAdjacentHTML(position, markup)` */
export function insertMarkup(el: HTMLElement, position: InsertPosition, markup: string): void {
  const fragment = toFragment(markup);
  if (position === "beforebegin") {
    el.parentNode?.insertBefore(fragment, el);
    return;
  }
  if (position === "afterend") {
    el.parentNode?.insertBefore(fragment, el.nextSibling);
    return;
  }
  if (position === "afterbegin") {
    el.insertBefore(fragment, el.firstChild);
    return;
  }
  el.appendChild(fragment);
}

// 用原生 removeChild 而不是 Obsidian 的 empty()：这些 UI 在单测里也要能跑。
function clearNode(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}
