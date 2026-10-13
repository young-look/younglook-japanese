/**
 * 弹层的标准收尾（2026-09-28 用户定）：**点其他位置就关，不必再点一次开关按钮。**
 *
 * 两条纪律：
 *  1. 只在弹层**开着的时候**挂监听，关掉就摘。常驻监听会和"打开它的那次点击"
 *     打架 —— 监听先注册的话，同一次点击先开再关，弹层一闪就没。
 *     开关路径都是 click，这里听 `pointerdown`（先于 click），所以"开着时点开关按钮"
 *     也能赶在按钮的 toggle 之前跑到 —— `alsoInside` 里的元素不算外面，
 *     那一下让给按钮自己的 toggle 收尾，否则"外面关 + 按钮又开"会闪一下。
 *  2. 用捕获阶段：先于一切 click 处理器跑，哪怕点到的东西在这一下里把自己删了
 *     （比如目录跳转会 remove 整个 overlay），也照样关得掉。
 *
 * @returns 摘除监听的函数 —— 弹层关闭、宿主视图卸载时都必须调用，不然监听泄漏。
 */
export function onClickOutside(
  el: HTMLElement,
  onOutside: () => void,
  alsoInside: HTMLElement[] = [],
): () => void {
  const handler = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (el.contains(target)) return;
    if (alsoInside.some((node) => node.contains(target))) return;
    onOutside();
  };
  document.addEventListener("pointerdown", handler, true);
  return () => document.removeEventListener("pointerdown", handler, true);
}
