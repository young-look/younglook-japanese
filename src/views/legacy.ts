/**
 * 已经退役的视图类型。
 *
 * 工作区布局（`.obsidian/workspace.json`）会记住用户上次开着的面板。
 * 视图被删掉之后，那份布局里还留着它的实例 —— 不清掉的话，用户下次打开
 * Obsidian 会看到一个空壳面板（类型已不存在，Obsidian 只能画个残骸）。
 *
 * 所以：**删视图时，把它的类型登记到这里**，onload 时统一 detach。
 */

export const LEGACY_VIEW_TYPES: readonly string[] = [
  // 2026-09-25 退役：「今日练习」侧栏面板（统计 + 一个跳转按钮）
  // 它唯一的作用就是打开学习页，已并进学习页选集页顶部的一行概览。
  "young-look-today",
  // 2026-10-02 收敛：个人中心只剩一份，视图类型统一回 "young-look-personal-center"。
  // "-v3" 是过渡期的别名，存量工作区布局里可能还记着它 → 启动时 detach。
  "young-look-personal-center-v3",
];
