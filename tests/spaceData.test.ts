import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import { DEMO_WORK_TITLE } from "../src/services/demo";
import { spaceHasUserData } from "../src/services/spaceData";
import { STORE, VaultDb } from "../src/storage/db";
import type { RecordRow } from "../src/types/entities";

/**
 * 「这份本机库里有没有**用户自己的**数据」—— 首次登录时的认领判据。
 *
 * 登录时若本机没有该账号的空间，会看匿名空间是否为空：空 → 直接新建账号空间；
 * 非空 → 弹窗问「要不要认领」。
 *
 * 🔥 这组用例守的就是那个**最容易被忽略的坑**：用户下载过示例素材后，它会落成一条
 *    学习记录躺在当前库里（services/demoPack.ts），于是判据要是连演示记录一起数进去，
 *    "空"就不成立了，用户一登录就被问"要不要认领"，认领还会把演示记录一起搬进
 *    账号空间。所以演示记录**必须不算**用户数据（这正是不能直接用 `probeVaultDatabase`
 *    的原因：它只数 sentences/progress，那些恰恰会被演示记录填满）。
 */

function record(cid: string, title: string): RecordRow {
  return { cid, title, deletedAt: null } as unknown as RecordRow;
}

describe("spaceHasUserData", () => {
  let db: VaultDb;

  beforeEach(async () => {
    db = await VaultDb.open(Math.random().toString(36).slice(2, 10));
  });

  it("空库（什么都没铺）→ false", async () => {
    expect(await spaceHasUserData(db)).toBe(false);
  });

  it("🔥 只有演示记录 → false（下载过示例素材就是这个状态，不能算「非空」）", async () => {
    await db.put(STORE.records, record("r-demo", DEMO_WORK_TITLE));
    expect(await spaceHasUserData(db)).toBe(false);
  });

  it("用户自己导入的记录 → true", async () => {
    await db.put(STORE.records, record("r-mine", "MyGO!!!!!"));
    expect(await spaceHasUserData(db)).toBe(true);
  });

  it("演示记录 + 自己导入的记录 → true（用户那一条说了算）", async () => {
    await db.put(STORE.records, record("r-demo", DEMO_WORK_TITLE));
    await db.put(STORE.records, record("r-mine", "MyGO!!!!!"));
    expect(await spaceHasUserData(db)).toBe(true);
  });

  it("只有本机笔记（未登录时写的）→ true（那也是用户自己写的）", async () => {
    await db.put(STORE.myNotes, { hash: "n-1", text: "笔记" });
    expect(await spaceHasUserData(db)).toBe(true);
  });

  it("记录标题前后带空白时按去掉空白比对（免得演示记录因为空格被当成用户的）", async () => {
    await db.put(STORE.records, record("r-demo", `  ${DEMO_WORK_TITLE}  `));
    expect(await spaceHasUserData(db)).toBe(false);
  });
});
