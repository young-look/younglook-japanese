/**
 * 本机空间里有没有「用户自己产生的数据」—— 登录认领的判据。
 *
 * 登录时若本机没有该账号的空间，会看匿名空间是否为空：空 → 直接新建账号空间；
 * 非空 → 弹窗问「要不要认领」。这里的「非空」**必须排除插件自带的演示集**：
 * 首启会把演示素材铺进当前库（services/demoSeed.ts），否则每个新用户一登录就会被
 * 问「要不要认领匿名数据」，而认领会把演示集也一起搬进账号空间。
 *
 * ⚠️ **不复用 `probeVaultDatabase`**（它只数 slices/progress，会被演示集填满）。
 * 判据只认两样确定属于用户的东西：
 *  · **用户自己导入的作品**（作品名不在演示清单里）；
 *  · **用户写过的本机笔记**（`my_notes`，演示集不写）。
 */

import type { VaultDb } from "../storage/db";
import { STORE } from "../storage/db";
import { DEMO_LEGACY_WORK_TITLES, DEMO_WORK_TITLE } from "./demoSeed";

/** 只用到 title，结构上够用即可（不依赖 works 表的完整形状）。 */
interface WorkLike {
  title?: string;
}

/**
 * 这份库里有没有用户自己的数据（演示集不算）。
 *
 * 传的是**待检查空间的库** —— 登录时即匿名库（当前活跃库）。读不出来（损坏、
 * 被别的标签页占着升级）时一律当作「没有」，走"直接新建"那条最不打扰的路。
 */
export async function spaceHasUserData(db: VaultDb): Promise<boolean> {
  try {
    if ((await db.count(STORE.myNotes)) > 0) return true;
    const works = await db.getAll<WorkLike>(STORE.works);
    const demoTitles = new Set<string>([DEMO_WORK_TITLE, ...DEMO_LEGACY_WORK_TITLES]);
    return works.some((work) => !demoTitles.has((work?.title ?? "").trim()));
  } catch {
    return false;
  }
}
