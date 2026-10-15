/**
 * 演示素材的**身份**与「已下载」标记。
 *
 * 演示素材（视频 + 字幕）**不再打进 main.js**：它托管在服务端 `/storage/media/videos/`，
 * 用户在首页那条「示例」上点「开始学」时才按需下载（见 `services/demoPack.ts`）。
 * 以前由 esbuild 的 loader 把 mp4 内联成 dataurl，几 MB 的 base64 把产物撑到近 6MB。
 *
 * 这里只放两样东西：
 *  · **演示集的作品名** —— 认亲靠它（演示集的 cid 由名字派生）。`spaceData`
 *    的登录认领判据拿 `isDemoWorkTitle()` 把演示集排除（那是我们分发的素材，
 *    不是用户自己的数据，不该触发「认领匿名数据」）；存储盘点（`dataInventory`）
 *    **不**排除 —— 演示包是用户点下载才落进本机素材库的，占着用户的盘，要如实
 *    计入（2026-10-14 用户拍板）；
 *  · **本机「演示包已下载」标记**（meta，不上行）—— 首页占位行是否出现的唯一判据。
 *
 * ⚠️ 项目未上线、没有存量用户：不保留历史作品名清单、不做任何迁移/兼容。
 */

import { STORE, type VaultDb } from "../storage/db";

/**
 * 演示集在首页那一行显示的标题。
 *
 * 「示例素材」这个前缀是**功能**不是装饰：用户要能一眼认出这不是自己导的，
 * 才敢放心删（那一行的「⋯ → 移除」就是给它准备的）。
 */
export const DEMO_WORK_TITLE = "示例素材 · 好きなアニメで日本語を学ぼう";

/** 本地库里的「演示包已经下载过」标记。放 meta（本机数据、不上行）。 */
export const DEMO_META_KEY = "demoSeeded";

interface MetaRow {
  key: string;
  value: string;
}

/**
 * 作品名是不是演示集 —— 全站**唯一**的认亲口径。
 *
 * 不要在各处自己写 `title === DEMO_WORK_TITLE`：`spaceData`（登录认领判据，
 * 排除演示集）要求与这里一致，各写一份早晚漂移。前后空白按去掉比对。
 */
export function isDemoWorkTitle(title: string | undefined | null): boolean {
  return (title ?? "").trim() === DEMO_WORK_TITLE;
}

/** 演示包是否已经下载过（标记在）。任何 IO 异常都当"没下过"。 */
export async function isDemoSeeded(db: VaultDb): Promise<boolean> {
  try {
    const row = await db.get<MetaRow>(STORE.meta, DEMO_META_KEY);
    return Boolean(row?.value);
  } catch {
    return false;
  }
}

/** 记下「演示包已下载」（幂等，只写一次）。只在导入成功之后调用。 */
export async function markDemoSeeded(db: VaultDb): Promise<void> {
  const existing = await db.get<MetaRow>(STORE.meta, DEMO_META_KEY);
  if (existing?.value) return;
  await db.put(STORE.meta, { key: DEMO_META_KEY, value: new Date().toISOString() } satisfies MetaRow);
}
