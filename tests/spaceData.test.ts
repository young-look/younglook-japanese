import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import { DEMO_LEGACY_WORK_TITLES, DEMO_WORK_TITLE } from "../src/services/demoSeed";
import { spaceHasUserData } from "../src/services/spaceData";
import { STORE, VaultDb } from "../src/storage/db";
import type { WorkRow } from "../src/types/entities";

/**
 * 「这份本机库里有没有**用户自己的**数据」—— 首次登录时的认领判据。
 *
 * 登录时若本机没有该账号的空间，会看匿名空间是否为空：空 → 直接新建账号空间；
 * 非空 → 弹窗问「要不要认领」。
 *
 * 🔥 这组用例守的就是那个**最容易被忽略的坑**：插件首启会往当前库里铺一份
 *    演示素材（services/demoSeed.ts），于是**每个全新用户的匿名库立刻就有数据**
 *    —— 判据要是连演示集一起数进去，"空"永远不成立，每个新用户一登录就被问
 *    "要不要认领"，认领还会把演示集一起搬进账号空间。
 *    所以演示集**必须不算**用户数据（这正是不能直接用 `probeVaultDatabase`
 *    的原因：它只数 slices/progress，那些恰恰被演示集填满）。
 */

function work(cid: string, title: string): WorkRow {
  return { cid, title, deletedAt: null } as unknown as WorkRow;
}

describe("spaceHasUserData", () => {
  let db: VaultDb;

  beforeEach(async () => {
    db = await VaultDb.open(Math.random().toString(36).slice(2, 10));
  });

  it("空库（什么都没铺）→ false", async () => {
    expect(await spaceHasUserData(db)).toBe(false);
  });

  it("🔥 只有演示作品 → false（新用户首启就是这个状态，不能算「非空」）", async () => {
    await db.put(STORE.works, work("w-demo", DEMO_WORK_TITLE));
    expect(await spaceHasUserData(db)).toBe(false);
  });

  it("🔥 演示素材的**历史作品名**同样不算（换过名字的老演示集）", async () => {
    for (const title of DEMO_LEGACY_WORK_TITLES) {
      await db.put(STORE.works, work(`w-${title}`, title));
    }
    expect(await spaceHasUserData(db)).toBe(false);
  });

  it("用户自己导入的作品 → true", async () => {
    await db.put(STORE.works, work("w-mine", "MyGO!!!!!"));
    expect(await spaceHasUserData(db)).toBe(true);
  });

  it("演示集 + 自己导入的作品 → true（用户那一条说了算）", async () => {
    await db.put(STORE.works, work("w-demo", DEMO_WORK_TITLE));
    await db.put(STORE.works, work("w-mine", "MyGO!!!!!"));
    expect(await spaceHasUserData(db)).toBe(true);
  });

  it("只有本机笔记（未登录时写的）→ true（那也是用户自己写的）", async () => {
    await db.put(STORE.myNotes, { hash: "n-1", text: "笔记" });
    expect(await spaceHasUserData(db)).toBe(true);
  });

  it("作品标题前后带空白时按去掉空白比对（免得演示集因为空格被当成用户的）", async () => {
    await db.put(STORE.works, work("w-demo", `  ${DEMO_WORK_TITLE}  `));
    expect(await spaceHasUserData(db)).toBe(false);
  });
});
