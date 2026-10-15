import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  findEditClash,
  saveRecordEdit,
  type RecordEditValues,
} from "../src/services/episodeEdit";
import { removeRecord } from "../src/services/study";
import { STORE, VaultDb } from "../src/storage/db";
import type { RecordRow } from "../src/types/entities";

/**
 * 「编辑这条记录」的数据层口径：
 *  · 编辑只改**展示字段**，recordCid 不动 —— 进度/笔记/录音零影响（身份 = 文件哈希对）；
 *  · 名字改了要重新查重名，撞了就是两条长得一样的记录（按 episodeStem 比对）；
 *  · 学习记录（progress/sessions/录音）在任何一条路里都不动。
 */

const NOW = "2026-09-25T12:00:00.000Z";

function makeRecord(
  cid: string,
  title: string,
  season: number | null,
  number: string,
  year: number | null = null,
): RecordRow {
  return {
    cid,
    videoSha256: `v-${cid}`,
    jaSubSha256: `j-${cid}`,
    zhSubSha256: null,
    title,
    titleJa: "",
    romaji: "",
    year,
    coverUrl: "",
    note: "",
    season,
    number,
    episodeTitle: "",
    durationMs: null,
    clientUpdatedAt: NOW,
    deletedAt: null,
    rev: 0,
    rowDigest: "",
  };
}

let db: VaultDb;

beforeEach(async () => {
  db = await VaultDb.open(Math.random().toString(36).slice(2, 10));
});

async function seed(db_: VaultDb, ...rows: RecordRow[]): Promise<void> {
  for (const row of rows) await db_.put(STORE.records, row);
}

const editOf = (overrides: Partial<RecordEditValues> = {}): RecordEditValues => ({
  workTitle: "MyGO",
  year: null,
  season: null,
  number: "1",
  episodeTitle: "",
  ...overrides,
});

// ── findEditClash ────────────────────────────────────────────────────────────

describe("findEditClash", () => {
  it("同作品另一条记录占了同样的季集号（改名后才会撞上的也算）", async () => {
    await seed(
      db,
      makeRecord("r:1", "MyGO", null, "1"),
      makeRecord("r:2", "MyGO", null, "2"),
    );
    // 把 r:1 编辑成第 2 集 → 和 r:2 撞
    const clash = await findEditClash(
      db,
      { recordCid: "r:1" },
      { workTitle: "MyGO", season: null, number: "2" },
    );
    expect(clash).toBe("MyGO");
  });

  it("别的作品同名同季集也拦（两部片子摆在一起就分不清了）", async () => {
    await seed(
      db,
      makeRecord("r:a1", "MyGO", null, "1"),
      makeRecord("r:b1", "孤独摇滚", null, "1"),
    );
    const clash = await findEditClash(
      db,
      { recordCid: "r:a1" },
      { workTitle: "孤独摇滚", season: null, number: "1" },
    );
    expect(clash).toBe("孤独摇滚");
  });

  it("自己不算撞；没撞上返回 null", async () => {
    await seed(db, makeRecord("r:1", "MyGO", null, "1"));
    const clash = await findEditClash(
      db,
      { recordCid: "r:1" },
      { workTitle: "MyGO", season: null, number: "1" },
    );
    expect(clash).toBeNull();
  });
});

// ── saveRecordEdit ───────────────────────────────────────────────────────────

describe("saveRecordEdit", () => {
  it("改名：记录行更新，cid 不动、摘要重算", async () => {
    const record = makeRecord("r:1", "MyGO", null, "1", 2023);
    await seed(db, record);

    const outcome = await saveRecordEdit(db, record, editOf({ workTitle: "新名字", year: 2024 }));

    expect(outcome.ok).toBe(true);
    const row = await db.get<RecordRow>(STORE.records, "r:1");
    expect(row?.title).toBe("新名字");
    expect(row?.year).toBe(2024);
    expect(row?.rowDigest).not.toBe("");
    // cid 没动 —— 进度/笔记全挂在句子哈希与文件哈希上，零影响
    expect(row?.cid).toBe("r:1");
    expect(record.cid).toBe("r:1");
  });

  it("改季集号：集号沿用导入的归一化", async () => {
    const record = makeRecord("r:1", "MyGO", null, "1");
    await seed(db, record);

    const outcome = await saveRecordEdit(db, record, editOf({ season: 2, number: "5.0" }));

    expect(outcome.ok).toBe(true);
    const row = await db.get<RecordRow>(STORE.records, "r:1");
    expect(row?.season).toBe(2);
    expect(row?.number).toBe("5");
  });

  it("什么都没改：空操作，不写库", async () => {
    const record = makeRecord("r:1", "MyGO", null, "1");
    await seed(db, record);

    const outcome = await saveRecordEdit(db, record, editOf());

    expect(outcome.ok).toBe(true);
    const row = await db.get<RecordRow>(STORE.records, "r:1");
    expect(row?.clientUpdatedAt).toBe(NOW);
    expect(row?.rowDigest).toBe("");
  });

  it("撞名：返回 ok:false，什么都没写", async () => {
    const record = makeRecord("r:1", "MyGO", null, "1");
    await seed(db, record, makeRecord("r:2", "MyGO", null, "2"));
    const before = await db.getAll<RecordRow>(STORE.records);

    const outcome = await saveRecordEdit(db, record, editOf({ number: "2" }));

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("MyGO");
    const after = await db.getAll<RecordRow>(STORE.records);
    expect(after.map((row) => row.clientUpdatedAt)).toEqual(
      before.map((row) => row.clientUpdatedAt),
    );
  });
});

// ── 与移除的边界 ─────────────────────────────────────────────────────────────

describe("移除只软删记录行，学习进度一律不动（钉住既有口径）", () => {
  it("removeRecord 不碰 progress", async () => {
    const record = makeRecord("r:1", "MyGO", null, "1");
    await seed(db, record);
    await db.put(STORE.progress, {
      cid: "P:slice:1",
      sliceCid: "slice:1",
      copyAttempts: 1,
      copyDoneAt: NOW,
      copyEpoch: 0,
      copyText: "写过的字",
      readAloudAt: NOW,
      readAloudSeconds: 3,
      readEpoch: 0,
      imitationText: "",
      imitationCorrect: null,
      imitationVerifiedAt: null,
      imitationFeedback: {},
      imitationHint: null,
      imitationChat: [],
      imitationEpoch: 0,
      completedAt: NOW,
      clientUpdatedAt: NOW,
      deletedAt: null,
      rev: 0,
      rowDigest: "",
    });

    await removeRecord(db, "r:1");

    const progress = await db.get<{ completedAt: string | null }>(STORE.progress, "P:slice:1");
    expect(progress?.completedAt).toBe(NOW);
    expect((await db.get<RecordRow>(STORE.records, "r:1"))?.deletedAt).not.toBeNull();
  });

  it("removeRecord 不碰 lines —— 历史页据此照常显示原句", async () => {
    await seed(db, makeRecord("r:1", "MyGO", null, "1"));
    await db.put(STORE.lines, {
      recordCid: "r:1",
      index: 0,
      sentenceCid: "slice:1",
      ja: "春日影を弾いた",
      zh: "弹了春日影",
      speaker: "",
      startMs: 0,
      endMs: 1000,
    });

    await removeRecord(db, "r:1");

    // 历史页遍历的是**全部**记录（含软删的），靠的就是台词行还在 ——
    // 谁要是让 removeRecord 顺手清了 lines，移除一集就会把历史一起抹掉
    const lines = await db.getAll<{ recordCid: string }>(STORE.lines);
    expect(lines).toHaveLength(1);
    expect(lines[0].recordCid).toBe("r:1");
  });
});
