// @vitest-environment node
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { STORE, VaultDb } from "../src/storage/db";
import { bumpStudyDay, dayKey, localTz } from "../src/services/studyDays";
import type { StudyDayRow } from "../src/types/entities";

/**
 * 日活聚合：同一天累加、跨天分桶。
 *
 * 「同一天累加」这条最关键 —— 如果第二次调用把前面的计数冲掉，
 * 用户做完三步之后看板上就只剩最后一步的次数。
 */

async function openDb(): Promise<VaultDb> {
  return VaultDb.open(`test-studydays-${Math.random().toString(36).slice(2)}`);
}

describe("dayKey", () => {
  it("按本地日期取键，不按 UTC", () => {
    // 本地时间 2026-09-26 23:30（UTC 是 15:30），日期键必须是本地那天
    const date = new Date(2026, 8, 26, 23, 30, 0);
    expect(dayKey(date)).toBe("2026-09-26");
  });

  it("个位数月份/日期补零", () => {
    expect(dayKey(new Date(2026, 0, 5, 12, 0, 0))).toBe("2026-01-05");
  });
});

describe("localTz", () => {
  it("能拿到时区名；拿不到也不抛", () => {
    expect(typeof localTz()).toBe("string");
  });
});

describe("bumpStudyDay", () => {
  it("首次调用建行", async () => {
    const db = await openDb();
    const row = await bumpStudyDay(db, { copyCount: 1 });
    expect(row.copyCount).toBe(1);
    expect(row.sentencesCompleted).toBe(0);
    expect(row.day).toBe(dayKey());
    expect(await db.get<StudyDayRow>(STORE.studyDays, dayKey())).toMatchObject({ copyCount: 1 });
    db.close();
  });

  it("同一天累加，不是覆盖", async () => {
    const db = await openDb();
    await bumpStudyDay(db, { copyCount: 1 });
    await bumpStudyDay(db, { readCount: 1 });
    await bumpStudyDay(db, { imitationCount: 1, sentencesCompleted: 1 });
    const row = await db.get<StudyDayRow>(STORE.studyDays, dayKey());
    expect(row).toMatchObject({
      copyCount: 1,
      readCount: 1,
      imitationCount: 1,
      sentencesCompleted: 1,
    });
    db.close();
  });

  it("跨天分桶", async () => {
    const db = await openDb();
    await bumpStudyDay(db, { copyCount: 1 }, "2026-09-25");
    await bumpStudyDay(db, { copyCount: 2 }, "2026-09-26");
    expect((await db.get<StudyDayRow>(STORE.studyDays, "2026-09-25"))?.copyCount).toBe(1);
    expect((await db.get<StudyDayRow>(STORE.studyDays, "2026-09-26"))?.copyCount).toBe(2);
    db.close();
  });

  it("负数不会把计数压到 0 以下", async () => {
    const db = await openDb();
    await bumpStudyDay(db, { copyCount: 3 });
    await bumpStudyDay(db, { copyCount: -10 });
    expect((await db.get<StudyDayRow>(STORE.studyDays, dayKey()))?.copyCount).toBe(0);
    db.close();
  });

  it("0 与非数字不产生写入动作之外的副作用", async () => {
    const db = await openDb();
    const row = await bumpStudyDay(db, { copyCount: 0 });
    expect(row.copyCount).toBe(0);
    expect(row.day).toBe(dayKey());
    db.close();
  });
});
