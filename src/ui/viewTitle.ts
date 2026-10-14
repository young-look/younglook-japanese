/**
 * 页签标题与页头标题的分家（2026-10-14 用户定）。
 *
 * Obsidian 默认拿 `getDisplayText()` 同一个串渲染两处：工作区页签
 * （workspace-leaf 的 tab）和页签下面那行页头（.view-header-title）。
 * 产品口径两者不同 —— 页签带品牌前缀「洋流」，页头只写页面名 —— 所以这里
 * 直接改两处 DOM：
 *   · 选集页（首页）：页签「洋流」　　　页头「首页」
 *   · 学习卡：　　　　页签「洋流 · 学习页」页头「学习页」
 *   · 个人中心：　　　页签「洋流 · 个人中心」页头「个人中心」
 *
 * 页签那处走的是宿主未在文档里承诺的 `tabHeaderInnerTitleEl`（社区插件
 * 通行做法），取不到就退回 `.tab-inner-title` 选择器；页头在页内容器里
 * 自己查。两处都「存在才写」，宿主哪天改了内部结构不至于抛错 —— 页签
 * `getDisplayText()` 仍返回页签名，宿主重算页签时结果也是对的。
 */
import type { WorkspaceLeaf } from "obsidian";

export function setViewTitle(
  leaf: WorkspaceLeaf,
  containerEl: HTMLElement,
  tabText: string,
  headerText: string,
): void {
  type TabHeaderExtras = {
    tabHeaderInnerTitleEl?: HTMLElement;
    tabHeaderEl?: HTMLElement;
  };
  const extras = leaf as WorkspaceLeaf & TabHeaderExtras;
  const tabTitle = extras.tabHeaderInnerTitleEl
    ?? extras.tabHeaderEl?.querySelector<HTMLElement>(".tab-inner-title")
    ?? null;
  tabTitle?.setText(tabText);
  containerEl.querySelector<HTMLElement>(".view-header-title")?.setText(headerText);
}
