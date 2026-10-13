/**
 * Obsidian 原生界面上的品牌图标（海獭）。
 *
 * ── 为什么不直接塞 `<img>` ────────────────────────────────────────────────
 * ribbon 按钮和标签页这两处的图标由**宿主**渲染：它拿 `getIcon()` 的名字调
 * `setIcon()`，而 `setIcon()` 会清空容器再画 svg，什么时候重新画由宿主说了算
 * （布局变化、插件重载都会重画一次）。插进去的 `<img>` 会在下一次重绘里被吃掉，
 * 图标随机退回 lucide。所以这里改的是**容器的伪元素**——宿主重绘动不到它，
 * 原来的 svg 用 CSS 关掉即可，`getIcon()` 照旧返回 lucide 名字当降级：万一
 * 这段样式没装上，用户看到的还是原来的书本图标，不会开出一块空白。
 *
 * ── 为什么要黑、白两份素材 ────────────────────────────────────────────────
 * 海獭目前只有位图线稿（`src/assets/otter-black.png` 黑线 / `otter-white.png`
 * 白线），不是单色 SVG，没法跟 `currentColor` 走。深色主题必须换成白线那版，
 * 否则黑线融进深色背景看不见。素材哪天成了矢量 SVG，这里整套 CSS 就可以删掉，
 * 直接 `addIcon()` 注册即可。
 */
import otterBlack from "../assets/otter-black.png";
import otterWhite from "../assets/otter-white.png";

const STYLE_ID = "yl-brand-icon";

/**
 * 打在宿主要素上的标记类。
 *
 * ribbon 按钮只有 `addRibbonIcon()` 的返回值这一个可靠句柄（它的 class 全是
 * 宿主的），所以加一层自己的 class 来选中；标签页则是按 view type 选。
 */
const HOST_CLASS = "yl-brand-icon-host";

/**
 * 装一次就行；重复调用不再插第二条 style（插件重载时 `onload` 会重跑）。
 *
 * @param viewTypes 要换成海獭的视图 type，作用在该视图的标签页图标上。
 */
export function installBrandIcons(viewTypes: string[]): void {
  if (document.getElementById(STYLE_ID)) return;

  const hosts = [`.${HOST_CLASS}`];
  for (const viewType of viewTypes) {
    hosts.push(`.workspace-tab-header[data-type="${viewType}"] .workspace-tab-header-inner-icon`);
  }

  const el = document.createElement("style");
  el.id = STYLE_ID;
  // 尺寸跟着宿主的图标变量走：标签页用 --icon-size，ribbon 那颗是大的 --icon-l
  // （宿主自己也这么分，见 app.css 里 ribbon/l 分裂的那条规则）。
  // 透明度只在 ribbon 上跟一下（宿主给 ribbon 的 svg 是 --icon-opacity 0.85，
  // 标签页的原生图标是 1）—— 统一设会让标签页那颗比邻居淡。
  el.textContent = `
${hosts.join(",\n")} {
  align-items: center;
  display: flex;
  justify-content: center;
}
${hosts.map((h) => `${h} > svg`).join(",\n")} {
  display: none;
}
${hosts.map((h) => `${h}::before`).join(",\n")} {
  background-image: url("${otterBlack}");
  background-position: center;
  background-repeat: no-repeat;
  background-size: contain;
  content: "";
  display: block;
  height: var(--icon-size, 20px);
  width: var(--icon-size, 20px);
}
.${HOST_CLASS}::before {
  height: var(--icon-l, 24px);
  opacity: var(--icon-opacity, 1);
  width: var(--icon-l, 24px);
}
${hosts.map((h) => `.theme-dark ${h}::before`).join(",\n")} {
  background-image: url("${otterWhite}");
}
`.trim();
  document.head.appendChild(el);
}

/**
 * 给 ribbon 按钮打标。`addRibbonIcon()` 返回的那个元素本身就是图标容器
 * （宿主已经给它加了 `clickable-icon`，所以是居中 flex），不需要再改动 DOM。
 */
export function markAsBrandIcon(el: HTMLElement): void {
  el.addClass(HOST_CLASS);
}
