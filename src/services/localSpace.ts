/**
 * 本机空间 —— 「匿名空间恒存在 + 一份空间只跟一个账号」的判定规则。
 *
 * 背景演进：
 *  · 2026-10-09 旧模型里「匿名」只是"当前空间还没主人"。于是 A 登录认领后这份空间
 *    就归了 A，B 登录时只剩「改用 / 保留」两条路 —— 共用电脑（情侣、家庭）上
 *    后登录的人能一键把前一个人的数据抢走。
 *  · 2026-10-10 模型重构，把归属反过来推：匿名空间**恒存在**（`owner === ""`）、
 *    不属于任何账号；登录 = 进入"我在本机的空间"（没有就新建）；登出 = 切回匿名
 *    空间，谁的数据也看不见。绑定是**永久**的（登录不可逆）。
 *
 * 这里**只有纯函数**，不碰库、不发请求、不弹窗 —— 这是整套设计里最该被单测钉住的
 * 一段，跟 UI 与存储解耦才好测。
 */

import type { LocalSpace } from "../settings/types";

/** 账号的最小身份 —— 换账号弹窗与存储页的归属提示都只需要这两样。 */
export interface SpacePeer {
  name: string;
  uid: string;
}

/**
 * 两台服务器地址是不是同一台。末尾斜杠不算区别（`serverUrl` 各处都会顺手去掉）。
 */
export function sameServer(a: string, b: string): boolean {
  const left = (a ?? "").trim().replace(/\/+$/u, "");
  const right = (b ?? "").trim().replace(/\/+$/u, "");
  return Boolean(left) && left === right;
}

/**
 * 本机的**匿名空间** —— 那份不属于任何账号、恒存在的空间。
 *
 * 不变量（由 `migrateSpaces` 与认领流程共同保证）：`spaces` 里**恒有且仅有**一条
 * `owner === ""` 的空间。认领时它是"被认领的那一份"，随即补一条新的空匿名空间。
 */
export function anonymousSpace(spaces: readonly LocalSpace[]): LocalSpace | null {
  return spaces.find((space) => (space?.owner ?? "").trim() === "") ?? null;
}

/**
 * 这份本机空间里有没有**这个账号**的空间（同账号 + 同服务器）。
 *
 * `uid` 为空 → null（保守：拿不到账号身份时绝不认领，宁可不切）。**只比 uid 是
 * bug**：dev 与线上是两个库、uid 都从 1 起，同一个数字是两个人。
 */
export function findSpaceForAccount(
  spaces: readonly LocalSpace[],
  account: { uid: string; serverUrl: string },
): LocalSpace | null {
  const uid = (account?.uid ?? "").trim();
  if (!uid) return null;
  return (
    spaces.find(
      (space) => space.owner.trim() === uid && sameServer(space.ownerServer, account.serverUrl),
    ) ?? null
  );
}

/**
 * 启动时该打开哪一份空间（**只选库，不弹窗**）。
 *
 *  · 登录着 → 待在"我的空间"；本机还没建出来就保持不动（建空间由登录流程负责）；
 *  · 没登录 → 匿名空间。
 * 找不到目标时退回当前/第一条，绝不让 `activeSpaceId` 指空。
 */
export function resolveActiveSpaceId(
  spaces: readonly LocalSpace[],
  input: { hasAccount: boolean; uid: string; serverUrl: string; currentId: string },
): string {
  const fallback = spaces.find((space) => space.id === input.currentId)?.id ?? spaces[0]?.id ?? input.currentId;
  if (input.hasAccount) {
    const mine = findSpaceForAccount(spaces, { uid: input.uid, serverUrl: input.serverUrl });
    return mine?.id ?? fallback;
  }
  return anonymousSpace(spaces)?.id ?? fallback;
}

/**
 * 给新账号开一份本机空间时用的库标识。
 *
 * 老库用 `vaultLocalId` 本身，新开的一律加序号后缀（`-2`、`-3`…）——
 * 用序号而不是 uid：库名会进 IndexedDB、也会进日志，短且没有转义问题就够了。
 */
export function nextSpaceId(spaces: readonly LocalSpace[], vaultLocalId: string): string {
  const used = new Set(spaces.map((space) => space.id));
  for (let round = 2; round < 100; round += 1) {
    const id = `${vaultLocalId}-${round}`;
    if (!used.has(id)) return id;
  }
  // 走到这儿说明表里有近百条空间了（不可能是真实用法）——给个绝不会撞的名字
  return `${vaultLocalId}-${Date.now()}`;
}

/**
 * 账号的显示名：`昵称（UID xxxxxxxx）`。
 *
 * UID 只取前 8 位 —— 用来分辨「同名同姓的两个账号」，不需要完整值。
 * 没有昵称时退回 UID，两样都没有时给一个中性说法。
 */
export function accountLabel(name: string, uid: string): string {
  const nickname = (name ?? "").trim();
  const short = (uid ?? "").trim().slice(0, 8);
  if (nickname && short) return `${nickname}（UID ${short}）`;
  if (nickname) return nickname;
  if (short) return `UID ${short}`;
  return "这个账号";
}
