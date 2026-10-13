// @vitest-environment node
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { STORE, VaultDb } from "../src/storage/db";
import { loadDraft, saveDraft } from "../src/services/studyDrafts";

/**
 * 抄写/仿写草稿的本机暂存（2026-10-07 口径的地面工事：没有「保存」了，
 * 敲的字自动落这里）。钉死三条口径：
 *  1. 存了就读得回来，没写过返回空串（调用方不用判 undefined）；
 *  2. **空串 = 删除**：检查通过（留档接管）和「重置」都按删除算，
 *     meta 里不留尸体 —— 不然重置完还会从草稿里长回旧字；
 *  3. meta 表是本机暂存：不进同步快照（KNOWN_COLLECTIONS 没有 meta），
 *     草稿是 scratch 性质，与录音同口径，只对敲它的那台设备有意义。
 */

async function db(): Promise<VaultDb> {
  return VaultDb.open(`test-draft-${Math.random().toString(36).slice(2)}`);
}

describe("saveDraft / loadDraft", () => {
  it("存了就读得回来（copy / imitation 各存各的）", async () => {
    const dbv = await db();
    await saveDraft(dbv, "copy", "S:1", "敲了一半的");
    await saveDraft(dbv, "imitation", "S:1", "猫が寝ていると思う。");
    expect(await loadDraft(dbv, "copy", "S:1")).toBe("敲了一半的");
    expect(await loadDraft(dbv, "imitation", "S:1")).toBe("猫が寝ていると思う。");
    dbv.close();
  });

  it("没写过返回空串，不是 undefined", async () => {
    const dbv = await db();
    expect(await loadDraft(dbv, "copy", "S:none")).toBe("");
    dbv.close();
  });

  it("🔥 存空串 = 删除：重置/检查通过之后草稿不再长回来", async () => {
    const dbv = await db();
    await saveDraft(dbv, "copy", "S:1", "敲了一半的");
    await saveDraft(dbv, "copy", "S:1", "");
    expect(await loadDraft(dbv, "copy", "S:1")).toBe("");
    // meta 表里真没有这行了 —— 不是空值行占着位
    const rows = await dbv.getAll<{ key: string; value: string }>(STORE.meta);
    expect(rows.find((row) => row.key === "draft:copy:S:1")).toBeUndefined();
    dbv.close();
  });

  it("两步的草稿互不干扰：清抄写的不动仿写的", async () => {
    const dbv = await db();
    await saveDraft(dbv, "copy", "S:1", "copy-draft");
    await saveDraft(dbv, "imitation", "S:1", "imitation-draft");
    await saveDraft(dbv, "copy", "S:1", "");
    expect(await loadDraft(dbv, "copy", "S:1")).toBe("");
    expect(await loadDraft(dbv, "imitation", "S:1")).toBe("imitation-draft");
    dbv.close();
  });
});
