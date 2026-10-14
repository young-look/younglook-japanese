import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { STORE, VaultDb, listVaultDatabaseKeys, probeVaultDatabase } from "../src/storage/db";
import { pickLibrary } from "../src/services/vaultKey";
import { recoverLocalLibrary } from "../src/services/recover";
import type { ProgressRow, SentenceRow } from "../src/types/entities";

/**
 * 回归测试：本地库的**库名必须稳定 + 老库必须能被认回来并合并**。
 *
 * 守的是 2026-09-25 的真实事故 —— vaultLocalId 随机生成又没落盘，每次重载插件
 * 都开一个新空库，用户看到的是"一更新数据就全没了，还得重新导入"。
 * pickLibrary 的选择规则另有纯函数单测，这里走真实 IndexedDB：
 * 真的建库、真的写行、再真的探回来、真的合并。
 */

const VAULT = "/Users/you/Vaults/douyin";

function slice(cid: string, index: number): SentenceRow {
  return {
    rev: 0,
    rowDigest: "",
    cid,
    ja: `テスト${index}`,
    textHash: `h${index}`,
    analysis: null,
    clientUpdatedAt: "2026-09-25T00:00:00.000Z",
  };
}

function progress(sliceCid: string): ProgressRow {
  return {
    cid: `P:${sliceCid}`,
    sliceCid,
    completedAt: "2026-09-24T10:00:00.000Z",
    rev: 1,
    rowDigest: "pr",
  } as ProgressRow;
}

describe("本地库找回（真实 IndexedDB）", () => {
  it("老库能被探测到内容，新开的空库不会冒充", async () => {
    // 老版本留下的库：一个随机 id，装着 3 句台词
    const old = await VaultDb.open("oldkey0000000");
    for (let index = 1; index <= 3; index += 1) await old.put(STORE.sentences, slice(`S:${index}`, index));
    await old.put(STORE.meta, { key: "vaultPath", value: VAULT });
    old.close();

    // 本次加载新开的库（老版本的 bug：每次重载都换一个随机 id）
    const fresh = await VaultDb.open("freshkey000000");
    fresh.close();

    const keys = await listVaultDatabaseKeys();
    expect(keys).toContain("oldkey0000000");
    expect(keys).toContain("freshkey000000");

    const probes = [];
    for (const key of ["oldkey0000000", "freshkey000000"]) {
      probes.push({ key, ...(await probeVaultDatabase(key)) });
    }
    const oldProbe = probes.find((probe) => probe.key === "oldkey0000000");
    const freshProbe = probes.find((probe) => probe.key === "freshkey000000");
    expect(oldProbe?.sentences).toBe(3);
    expect(oldProbe?.vaultPath).toBe(VAULT);
    expect(freshProbe?.sentences).toBe(0);

    // 找回：当前空库 fresh 不参与候选，oldkey 被认回来
    const picked = pickLibrary(probes, VAULT, "freshkey000000");
    expect(picked.key).toBe("oldkey0000000");
  });

  it("探测不存在的库不会炸，只是报 0", async () => {
    const probe = await probeVaultDatabase("never-existed-key");
    expect(probe.sentences).toBe(0);
    expect(probe.vaultPath).toBeNull();
  });

  it("多份旧库并进认回来的那份：不用重新导入，且登记了待同步", async () => {
    // 第 4 集那份旧库：学过第 1 句
    const ep4 = await VaultDb.open("orphan-ep4");
    await ep4.put(STORE.sentences, slice("S:ep4-1", 1));
    await ep4.put(STORE.sentences, slice("S:ep4-2", 2));
    ep4.close();

    // 第 8 集那份旧库：带着学习进度，而且**同一集**也学过另一句
    const ep8 = await VaultDb.open("orphan-ep8");
    await ep8.put(STORE.sentences, slice("S:ep8-1", 1));
    await ep8.put(STORE.progress, progress("S:ep8-1"));
    ep8.close();

    // 另一个 vault 的库：归属标记对不上，绝不能碰
    const stranger = await VaultDb.open("other-vault-lib");
    await stranger.put(STORE.sentences, slice("S:other-1", 1));
    await stranger.put(STORE.meta, { key: "vaultPath", value: "/Users/you/Vaults/网文" });
    stranger.close();

    const current = await VaultDb.open("current-empty");
    current.close();

    const keys = ["orphan-ep4", "orphan-ep8", "other-vault-lib", "current-empty"];
    const probes = [];
    for (const key of keys) probes.push({ key, ...(await probeVaultDatabase(key)) });

    const outcome = await recoverLocalLibrary({ currentKey: "current-empty", vaultPath: VAULT, probes });
    const adoptedKey = outcome.adoptedKey;
    // 认领台词最多的那份当主库，其余的并进来
    expect(adoptedKey).toBe("orphan-ep4");
    expect([...outcome.mergedKeys].sort()).toEqual(["orphan-ep8"]);
    expect(outcome.skippedKeys).toEqual(["other-vault-lib"]);
    expect(outcome.slices).toBe(1); // 合并进来的台词数（不含主库自己那两句）

    // 认回来的库里两边内容都在，别 vault 的一条都没进来
    const adopted = await VaultDb.open(adoptedKey as string);
    const rows = await adopted.getAll<SentenceRow>(STORE.sentences);
    const cids = rows.map((row) => row.cid).sort();
    expect(cids).toEqual(["S:ep4-1", "S:ep4-2", "S:ep8-1"]);
    const progressRow = await adopted.get<ProgressRow>(STORE.progress, "P:S:ep8-1");
    expect(progressRow?.sliceCid).toBe("S:ep8-1");

    // 归属标记写上了，下次不用再猜
    const tag = await adopted.get<{ key: string; value: string }>(STORE.meta, "vaultPath");
    expect(tag?.value).toBe(VAULT);
    adopted.close();

    // 别 vault 的库原封不动
    const untouched = await VaultDb.open("other-vault-lib");
    expect((await untouched.getAll<SentenceRow>(STORE.sentences)).map((row) => row.cid)).toEqual(["S:other-1"]);
    untouched.close();
  });
});
