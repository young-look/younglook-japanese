import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { progressCid } from "../src/core/ids";
import { STORE, VaultDb } from "../src/storage/db";
import { MATCH_WINDOW, applyRebind, planRebind, type RebindPair } from "../src/services/sliceRebind";
import type { ProgressRow, SliceRow } from "../src/types/entities";

/** 一个最简切片行（只填 rebind 关心的字段）。 */
function sliceRow(cid: string, index: number, ja: string): SliceRow {
  return {
    rev: 0, rowDigest: "", cid, episodeCid: "E:1", assetCid: "A:1", index,
    startMs: index * 1000, endMs: index * 1000 + 900, ja, zh: "", speaker: "",
    textHash: `th-${cid}`, parserVersion: 1, analysis: null,
    clientUpdatedAt: "2026-10-06T12:00:00.000Z", deletedAt: null,
  } as unknown as SliceRow;
}

/** 一条学完了抄写的进度行。 */
function progressRow(sliceCid: string): ProgressRow {
  return {
    cid: progressCid(sliceCid), sliceCid,
    copyAttempts: 2, copyDoneAt: "2026-10-06T12:00:00.000Z", copyEpoch: 1, copyText: "写了",
    readAloudAt: null, readAloudSeconds: 0, readEpoch: 0,
    imitationText: "", imitationCorrect: null, imitationAiCheckedAt: null,
    clientUpdatedAt: "2026-10-06T12:00:00.000Z", deletedAt: null,
  } as unknown as ProgressRow;
}

describe("planRebind：按日文相似度认回旧句子", () => {
  it("完全相同的句子直接认回", () => {
    const plan = planRebind(
      [sliceRow("S:old1", 0, "今日はいい天気ですね。")],
      [{ index: 0, ja: "今日はいい天気ですね！" }],
    );
    expect(plan.get(0)).toBe("S:old1");
  });

  it("只差标点 / 全角半角 / 片假名写法也算同一句", () => {
    const plan = planRebind(
      [sliceRow("S:old1", 3, "アリガトウ、先生。")],
      [{ index: 3, ja: "ありがとう、先生" }],
    );
    expect(plan.get(0)).toBe("S:old1");
  });

  it("两句风马牛不相及的台词不绑", () => {
    const plan = planRebind(
      [sliceRow("S:old1", 0, "今日はいい天気ですね。")],
      [{ index: 0, ja: "戦略的撤退を実行するしかない。" }],
    );
    expect(plan.size).toBe(0);
  });

  it("前缀句不误绑（ありがとう vs ありがとうございます）", () => {
    const plan = planRebind(
      [sliceRow("S:old1", 0, "ありがとう")],
      [{ index: 0, ja: "ありがとうございます" }],
    );
    expect(plan.size).toBe(0);
  });

  it("句序偏移在窗口内能认回，超出窗口不绑", () => {
    const old = [sliceRow("S:old1", 0, "ずっと探していたんだ。")];
    expect(planRebind(old, [{ index: 5, ja: "ずっと探して居たんだ。" }]).get(0)).toBe("S:old1");
    // 超出 ±15 句窗口 → 不认
    expect(planRebind(old, [{ index: MATCH_WINDOW + 1, ja: "ずっと探して居たんだ。" }]).size).toBe(0);
  });

  it("一个旧句只能被认领一次（两句新句抢同一个旧进度时谁更像谁得）", () => {
    const plan = planRebind(
      [sliceRow("S:old1", 0, "ちょっと待ってて。")],
      [
        { index: 0, ja: "ちょっと待ってて！" },
        { index: 1, ja: "ちょっと待っててね。" },
      ],
    );
    // index 0 完全归一化相同（分数更高）拿到认领权；index 1 只能当新句
    expect(plan.get(0)).toBe("S:old1");
    expect(plan.has(1)).toBe(false);
  });

  it("空历史 / 空新句都返回空计划", () => {
    expect(planRebind([], [{ index: 0, ja: "あ" }]).size).toBe(0);
    expect(planRebind([sliceRow("S:1", 0, "あ")], []).size).toBe(0);
  });
});

describe("applyRebind：把学习数据搬到新 cid", () => {
  let db: VaultDb;
  const dbSuffix = () => Math.random().toString(36).slice(2, 8);

  beforeEach(async () => {
    db = await VaultDb.open(`rebind-${dbSuffix()}`);
  });

  it("progress 换 cid 搬家：cid 重算、sliceCid 改指、旧键打墓碑", async () => {
    await db.put(STORE.progress, progressRow("S:old1"));
    const { moved } = await applyRebind(db, [{ from: "S:old1", to: "S:new1" }]);
    expect(moved).toBe(1);

    const movedRow = await db.get<ProgressRow>(STORE.progress, progressCid("S:new1"));
    expect(movedRow?.copyDoneAt).toBe("2026-10-06T12:00:00.000Z");
    expect(movedRow?.sliceCid).toBe("S:new1");
    // 旧键不硬删 —— 硬删会被云端原样拉回「复活」；墓碑盖掉云端那行
    const tombstone = await db.get<ProgressRow>(STORE.progress, progressCid("S:old1"));
    expect(tombstone?.deletedAt).toBeTruthy();
    expect((tombstone?.clientUpdatedAt ?? "") > progressRow("S:old1").clientUpdatedAt).toBe(true);
    await db.close();
  });

  it("目标位置已有进度时不覆盖（换字幕不抹新学的进度）", async () => {
    await db.put(STORE.progress, progressRow("S:old1"));
    const fresh = { ...progressRow("S:new1"), copyAttempts: 9 };
    await db.put(STORE.progress, fresh as ProgressRow);

    const { moved } = await applyRebind(db, [{ from: "S:old1", to: "S:new1" }]);
    expect(moved).toBe(0);
    const kept = await db.get<ProgressRow>(STORE.progress, progressCid("S:new1"));
    expect(kept?.copyAttempts).toBe(9);
    // 旧键仍要打墓碑（云端那行得被盖成已删，不能留着当活账）
    const tombstone = await db.get<ProgressRow>(STORE.progress, progressCid("S:old1"));
    expect(tombstone?.deletedAt).toBeTruthy();
    await db.close();
  });

  it("recordings 整键搬家，曝光标记跟着走", async () => {
    await db.put(STORE.recordings, {
      cid: "S:old1", sliceCid: "S:old1", blob: new Blob(["x"], { type: "audio/webm" }),
      mimeType: "audio/webm", seconds: 3,
      clientUpdatedAt: "2026-10-06T12:00:00.000Z",
    } as never);
    await db.put(STORE.meta, { key: "exposed:S:old1", value: true } as never);

    const { moved } = await applyRebind(db, [{ from: "S:old1", to: "S:new1" }]);
    expect(moved).toBe(2); // 录音 + 曝光标记（progress 没建行，notes 已退役）

    const recording = await db.get<{ cid: string }>(STORE.recordings, "S:new1");
    expect(recording?.cid).toBe("S:new1");
    const marker = await db.get<{ value: boolean }>(STORE.meta, "exposed:S:new1");
    expect(marker?.value).toBe(true);
    // 旧键全清
    expect(await db.get(STORE.recordings, "S:old1")).toBeUndefined();
    expect(await db.get(STORE.meta, "exposed:S:old1")).toBeUndefined();
    await db.close();
  });

  it("被认领的旧切片行删除；没被认领的旧句保留", async () => {
    await db.bulkPut(STORE.slices, [
      sliceRow("S:old1", 0, "今日はいい天気ですね。"),
      sliceRow("S:old2", 1, "これは旧字幕だけのセリフだ。"),
    ] as never);
    // 新字幕里只有第 0 句（第 1 句没了）
    const plan = planRebind(
      [sliceRow("S:old1", 0, "今日はいい天気ですね。"), sliceRow("S:old2", 1, "これは旧字幕だけのセリフだ。")],
      [{ index: 0, ja: "今日はいい天気ですね！" }],
    );
    const pairs: RebindPair[] = [];
    for (const [, from] of plan) pairs.push({ from, to: "S:new1" });

    await applyRebind(db, pairs);
    expect(await db.get(STORE.slices, "S:old1")).toBeUndefined();
    // 旧字幕独有的句子不删 —— 用户切回旧字幕还用得上
    const kept = await db.get<SliceRow>(STORE.slices, "S:old2");
    expect(kept?.ja).toBe("これは旧字幕だけのセリフだ。");
    await db.close();
  });

  it("空 pairs 幂等：什么都不动", async () => {
    const { moved } = await applyRebind(db, []);
    expect(moved).toBe(0);
    await db.close();
  });

  it("搬过来的 progress 默认带「关联恢复」标记（服务端据此去重等级线）", async () => {
    await db.put(STORE.progress, progressRow("S:old1"));
    await applyRebind(db, [{ from: "S:old1", to: "S:new1" }]);
    const moved = await db.get<{ recovery?: { from: string; source: string } }>(
      STORE.progress, progressCid("S:new1"),
    );
    expect(moved?.recovery?.from).toBe("S:old1");
    expect(moved?.recovery?.source).toBe("slice-rebind");
    await db.close();
  });

  it("source 可覆盖；markRecovery:false 时明确不打标记", async () => {
    await db.put(STORE.progress, progressRow("S:old1"));
    await applyRebind(db, [{ from: "S:old1", to: "S:new1" }], { source: "cloud-assoc" });
    const a = await db.get<{ recovery?: { source: string } }>(STORE.progress, progressCid("S:new1"));
    expect(a?.recovery?.source).toBe("cloud-assoc");

    await db.put(STORE.progress, progressRow("S:old2"));
    await applyRebind(db, [{ from: "S:old2", to: "S:new2" }], { markRecovery: false });
    const b = await db.get<{ recovery?: unknown }>(STORE.progress, progressCid("S:new2"));
    expect(b?.recovery).toBeUndefined();
    await db.close();
  });
});
