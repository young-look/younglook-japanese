/**
 * 「我的笔记」统一入口：**登录走服务端，未登录落本地（纯单机）**。
 *
 * 学习页按钮虚线、历史页句下笔记、笔记抽屉回填读的都是这里维护的
 * hash → 内容 缓存；写操作也必须穿过这里 —— 缓存与源头（服务端 / 本地库）
 * 才不会各说各话。
 *
 * 为什么登录后的笔记不再进快照同步（2026-10-09 改版）：
 *   · 笔记一旦公开就是「发在平台上的内容」，源头在服务端按账号走，
 *     换设备登录同一账号自然都在 —— 快照再捎一份就成了两条真相；
 *   · 未登录没有身份，本来也不同步（纯单机，见 entities 的 MyNoteRow）。
 *
 * 缓存按「源头」（local / server）记账：登录态切换后第一次读取会重拉，
 * 两个页面（学习页 / 个人中心）共享同一份，不会各拉各的。
 */

import { STORE, type VaultDb } from "../../storage/db";
import type { PluginSettings } from "../../settings/types";
import type { MyNoteRow } from "../../types/entities";
import { log } from "../../core/logger";
import * as api from "./api";

let cache: Map<string, string> | null = null;
let cacheSource: "local" | "server" | null = null;

/** 登录了吗（与服务端有身份 = 笔记在云端、对同句的人可见）。 */
export function isLoggedIn(settings: PluginSettings): boolean {
  return settings.refreshToken.trim() !== "";
}

/**
 * 登录态切换后调一下：把缓存作废，下一次读取按新身份重拉。
 * （连接 / 退出账号的入口负责叫它，见 main.ts。）
 */
export function invalidateNoteCache(): void {
  cache = null;
  cacheSource = null;
}

/** hash → 我写的笔记内容。失败直接抛，调用方弹提示；登录态切换自动重拉。 */
export async function loadMyNotes(
  settings: PluginSettings,
  db: VaultDb,
): Promise<Map<string, string>> {
  const source = isLoggedIn(settings) ? "server" : "local";
  if (cache && cacheSource === source) return cache;

  const map = new Map<string, string>();
  if (source === "server") {
    for (const [hash, text] of await api.fetchMyNotes(settings)) {
      if (text.trim()) map.set(hash, text);
    }
  } else {
    for (const row of await db.getAll<MyNoteRow>(STORE.myNotes)) {
      if (row.text.trim()) map.set(row.hash, row.text);
    }
  }
  cache = map;
  cacheSource = source;
  return map;
}

/** 当前缓存（没拉过 = null）—— 按钮虚线这类「顺手看一眼」的同步读法用。 */
export function peekMyNotes(): Map<string, string> | null {
  return cache;
}

/** 切片 cid（`S:<hash>`）→ 我写的笔记内容；没写过是空串。读缓存，不发请求。 */
export function myNoteFor(cid: string): string {
  return cache?.get(cid.slice(2)) ?? "";
}

/**
 * 保存一句的笔记。
 *
 * 登录：服务端为准，成功后把本地同 hash 行清掉 —— 不清的话，之后在服务端
 * 删掉这条，本地残留会被抽屉当成「没上云的旧稿」回填出来，像见鬼了一样。
 * 未登录：写本地表（纯单机）。
 */
export async function saveMyNote(
  settings: PluginSettings,
  db: VaultDb,
  sliceCid: string,
  text: string,
): Promise<void> {
  const hash = sliceCid.slice(2);
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) {
    await deleteMyNote(settings, db, sliceCid);
    return;
  }
  if (isLoggedIn(settings)) {
    await api.saveMyNoteRemote(settings, hash, clean);
    await db.delete(STORE.myNotes, hash).catch(() => undefined);
  } else {
    const row: MyNoteRow = { hash, text: clean, updatedAt: new Date().toISOString() };
    await db.put(STORE.myNotes, row);
  }
  cache?.set(hash, clean);
}

/**
 * 认领「未登录时写的笔记」（2026-10-09 多账号隔离）。
 *
 * 用户拍板的口径：未登录期间这份数据是匿名的，首次登录时整个匿名账户被认领给
 * 那个账号 —— 笔记也跟着一起关联，所以要交上去。
 *
 * 逐条上传、**成功一条删一条**：失败的留在本地，下次进入登录态时再试。
 * 绝不能在上传还没成功时就把本地那一份删掉 —— 那是这条笔记唯一的存在。
 *
 * @returns 成功交出去的条数
 */
export async function claimLocalNotes(settings: PluginSettings, db: VaultDb): Promise<number> {
  if (!isLoggedIn(settings)) return 0;

  let rows: MyNoteRow[] = [];
  try {
    rows = await db.getAll<MyNoteRow>(STORE.myNotes);
  } catch (error) {
    log.warn("读本机笔记失败，这次不认领", error);
    return 0;
  }

  let moved = 0;
  for (const row of rows) {
    const hash = (row.hash ?? "").trim();
    const text = (row.text ?? "").trim();
    if (!hash || !text) continue;
    try {
      await api.saveMyNoteRemote(settings, hash, text);
      await db.delete(STORE.myNotes, hash).catch(() => undefined);
      moved += 1;
    } catch {
      // 单条失败不该打断整批：剩下的继续传，失败的留到下次
      log.warn("未登录时写的笔记没能交给账号，留在本机下次再试", { hash });
    }
  }
  // 交出去过就得作废缓存，否则抽屉还按"本机那份"回填
  if (moved > 0) invalidateNoteCache();
  return moved;
}

/** 删一句的笔记。服务端还挂着时先删服务端；本地行一律清。 */
export async function deleteMyNote(
  settings: PluginSettings,
  db: VaultDb,
  sliceCid: string,
): Promise<void> {
  const hash = sliceCid.slice(2);
  if (isLoggedIn(settings)) {
    await api.deleteMyNoteRemote(settings, hash);
  }
  await db.delete(STORE.myNotes, hash).catch(() => undefined);
  cache?.delete(hash);
}
