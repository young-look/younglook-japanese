/**
 * Obsidian 原生界面上的品牌图标（海獭）。
 *
 * ── 样式不在 JS 里，在 styles.css 里 ───────────────────────────────────────
 * ribbon 按钮和标签页这两处的图标由**宿主**渲染：它拿 `getIcon()` 的名字调
 * `setIcon()`，而 `setIcon()` 会清空容器再画 svg，什么时候重新画由宿主说了算
 * （布局变化、插件重载都会重画一次）。插进去的 `<img>` 会在下一次重绘里被吃掉，
 * 图标随机退回 lucide。所以改的是**容器的伪元素**——宿主重绘动不到它，
 * 原来的 svg 用 CSS 关掉即可，`getIcon()` 照旧返回 lucide 名字当降级：万一
 * 这段样式没装上，用户看到的还是原来的书本图标，不会开出一块空白。
 *
 * 这套 CSS 以前是在这里拼字符串、再 `document.createElement("style")` 塞进
 * `document.head` 的。社区目录**不允许插件自己创建 style 元素**，而且那样
 * 插件被禁用后样式还留在 DOM 里。现在整段静置在 `styles.css`，由 Obsidian
 * 自己装载/卸载 —— 两个问题一起没了（详见 styles.css 末尾那段注释）。
 *
 * ── 为什么要黑、白两份素材 ────────────────────────────────────────────────
 * 海獭目前只有位图线稿（`src/assets/otter-black.png` 黑线 / `otter-white.png`
 * 白线），不是单色 SVG，没法跟 `currentColor` 走。深色主题必须换成白线那版，
 * 否则黑线融进深色背景看不见。素材哪天成了矢量 SVG，就可以直接 `addIcon()`
 * 注册、把 styles.css 里那段删掉。
 */

/**
 * 打在宿主要素上的标记类。
 *
 * ribbon 按钮只有 `addRibbonIcon()` 的返回值这一个可靠句柄（它的 class 全是
 * 宿主的），所以加一层自己的 class 让 CSS 能选中它。
 *
 * ⚠️ 标签页那边的选择器是按 view type 写死在 styles.css 里的（视图 type 是编译期
 * 常量，没必要运行时拼）。**新增品牌视图时记得去补那条选择器。**
 */
const HOST_CLASS = "yl-brand-icon-host";

/**
 * 给 ribbon 按钮打标。`addRibbonIcon()` 返回的那个元素本身就是图标容器
 * （宿主已经给它加了 `clickable-icon`，所以是居中 flex），不需要再改动 DOM。
 */
export function markAsBrandIcon(el: HTMLElement): void {
  el.addClass(HOST_CLASS);
}
