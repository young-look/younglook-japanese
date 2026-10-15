/**
 * 「你的学习」四张指标卡的内联 SVG（2026-10-04 v2 渐变徽章版）。
 *
 * 不走 Obsidian 的 setIcon（lucide 描边风）：徽章上的图标要**实心**才压得住
 * 渐变底，而且火焰要配雪花角标、等级要按 7 个等级换图标，都是私有图形。
 * 全部 24×24 viewBox，颜色用 currentColor（白色由 .yl-pc-tile 的 color 给）。
 */

/** 火焰（连续学习）：fill 实心，三态只换徽章底色，图形本身不变 */
export const ICON_FLAME = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`;

/** 雪花（宽限角标）：三轴六向的极简雪花，叠在结冰火焰的右下角 */
export const ICON_FLAKE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/></svg>`;

/** 句子（总句子数）：引号气泡 */
export const ICON_SENT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 14a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/><path d="M9 8.5h6M9 12h4"/></svg>`;

/** 累计学习：阶梯上行 + 箭头，累计向前、进步不止 */
export const ICON_TOTAL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20h4v-5H3zM10 20h4v-9h-4zM17 20h4V7h-4z"/><path d="M14 4h7M21 4v7"/></svg>`;

/** 词汇（总词汇量）：翻开的书 */
export const ICON_VOCAB = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/></svg>`;

/**
 * 等级图标，按 LEVEL_LADDER 序（下标 = level − 1）：港口→海湾→迷雾→风暴→远洋→群岛→新大陆。
 * 航海旅程隐喻，全部 stroke 风（压在青色渐变上）。
 * ⚠️ 与 services/level.ts 的 LEVEL_LADDER 一一对应，那边加级这边必须跟上。
 */
export const LEVEL_ICONS: ReadonlyArray<string> = [
  // 港口：锚
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5" r="3"/><path d="M12 22V8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/></svg>`,
  // 海湾：波浪
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/></svg>`,
  // 迷雾：云 + 雾线
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 14.3A4.5 4.5 0 0 1 7.2 5.5a5.5 5.5 0 0 1 10.6 1.6A4 4 0 0 1 17 14.9"/><path d="M4 17h13M7 20.5h10"/></svg>`,
  // 风暴：云 + 闪电
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16.3A4.5 4.5 0 0 1 7.2 7.5a5.5 5.5 0 0 1 10.6 1.6A4 4 0 0 1 17 16.9"/><path d="M13 12l-2.5 4h3L11 20.5"/></svg>`,
  // 远洋：罗盘
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M16.2 7.8l-2.1 6.3-6.3 2.1 2.1-6.3z"/></svg>`,
  // 群岛：山峦
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3l4 8 5-5 5 15H2L8 3z"/></svg>`,
  // 新大陆：旗
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/></svg>`,
];
