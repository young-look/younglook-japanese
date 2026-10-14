// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { STORE, VaultDb } from "../src/storage/db";
import type { StudySentence } from "../src/types/entities";
import { deleteRecording, loadRecording, saveRecording } from "../src/services/recordings";
import {
  recordReadAloud,
  resetPracticeRecord,
  submitCopy,
  submitImitation,
} from "../src/services/study";

/**
 * 「重置」的数据层契约（2026-10-04 用户拍板，防回归钉子）：
 *
 * 重置 = 这一步**完全恢复初始** —— 完成时刻、留档、尝试次数全清
 * （取代旧"重做不动完成时刻"的约定）；仿写连核对时刻与评语一起清；
 * completedAt 由三步齐全推导，缺一步整句就回到未完成。
 */

const slice: StudySentence = {
  cid: "slice-1",
  index: 1,
  startMs: 0,
  endMs: 1500,
  ja: "猫が寝ている。",
  zh: "猫在睡觉。",
  speaker: "",
  textHash: "hash",
  analysis: null,
};

/** 三步全部做完（跟读 + 抄写两遍 + 仿写 AI 判过），拿到"已学完"的状态 */
async function seedCompleted(db: VaultDb) {
  await recordReadAloud(db, slice, 3.2, true);
  await submitCopy(db, slice, { text: slice.ja, passed: true });
  await submitCopy(db, slice, { text: slice.ja, passed: true });
  await submitImitation(db, slice, {
    text: "犬が遊んでいる。",
    correct: true,
    verified: true,
    feedback: { correct: true, reason: "结构一致", suggestion: "" },
  });
}

let vault: VaultDb | null = null;

afterEach(async () => {
  await vault?.close();
  vault = null;
});

async function freshDb(): Promise<VaultDb> {
  vault = await VaultDb.open(`reset-${Math.random().toString(36).slice(2)}`);
  return vault;
}

async function progressOf(db: VaultDb) {
  const rows = await db.getAll<{ cid: string; sliceCid: string } & Record<string, unknown>>(
    STORE.progress,
  );
  return rows.find((row) => row.sliceCid === slice.cid)!;
}

describe("重置 · 数据层契约", () => {
  it("三步齐全后整句已完成；重置任何一步都会把 completedAt 打回 null", async () => {
    const db = await freshDb();
    await seedCompleted(db);
    expect((await progressOf(db)).completedAt).toBeTruthy();

    await resetPracticeRecord(db, slice, "read");
    expect((await progressOf(db)).completedAt).toBeNull();
  });

  it("重置跟读：完成时刻与时长清零，其余两步不动", async () => {
    const db = await freshDb();
    await seedCompleted(db);

    await resetPracticeRecord(db, slice, "read");
    const row = await progressOf(db);
    expect(row.readAloudAt).toBeNull();
    // 「有没有让 AI 判过」也是这一步的状态，跟着一起清 —— 留着它下一遍还没核对
    // 就会显示成青蓝的「正解 ✓」
    expect(row.readAloudVerifiedAt).toBeNull();
    expect(row.readAloudSeconds).toBe(0);
    expect(row.readEpoch).toBe(1);
    // 其他两步的记录原样保留
    expect(row.copyDoneAt).toBeTruthy();
    expect(row.imitationCorrect).toBe(true);
  });

  it("重置抄写：完成时刻、留档、尝试次数全清（旧口径只清留档，已作废）", async () => {
    const db = await freshDb();
    await seedCompleted(db);
    expect((await progressOf(db)).copyAttempts).toBe(2);

    await resetPracticeRecord(db, slice, "copy");
    const row = await progressOf(db);
    expect(row.copyDoneAt).toBeNull();
    expect(row.copyText).toBe("");
    expect(row.copyAttempts).toBe(0);
    expect(row.copyEpoch).toBe(1);
    // 跟读的记录原样保留
    expect(row.readAloudAt).toBeTruthy();
  });

  it("重置仿写：结论、核对时刻、评语全清 —— 不留「AI 判过」的假象", async () => {
    const db = await freshDb();
    await seedCompleted(db);

    await resetPracticeRecord(db, slice, "imitation");
    const row = await progressOf(db);
    expect(row.imitationCorrect).toBeNull();
    expect(row.imitationVerifiedAt).toBeNull();
    expect(row.imitationFeedback).toEqual({});
    expect(row.imitationText).toBe("");
    expect(row.imitationEpoch).toBe(1);
  });

  it("跟读的录音跟着重置一起删：回到「没录过」的状态", async () => {
    const db = await freshDb();
    await saveRecording(db, slice.cid, new Blob(["x"]), "audio/webm", 3.2);
    expect(await loadRecording(db, slice.cid)).toBeTruthy();

    await deleteRecording(db, slice.cid);
    expect(await loadRecording(db, slice.cid)).toBeUndefined();
  });
});
