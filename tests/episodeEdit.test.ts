import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  findEditClash,
  saveEpisodeEdit,
  type EpisodeEditValues,
} from "../src/services/episodeEdit";
import { removeEpisode } from "../src/services/study";
import { STORE, VaultDb } from "../src/storage/db";
import type { EpisodeRow, WorkRow } from "../src/types/entities";

/**
 * 「编辑这一集」的数据层口径：
 *  · 编辑只改字段值，cid 不动 —— 本地引用一根手指都不碰；
 *  · 名字改了要重新查重名，撞了就是两条长得一样的记录（按 episodeStem 比对）；
 *  · 学习记录（progress/sessions/录音）在任何一条路里都不动。
 */

const NOW = "2026-09-25T12:00:00.000Z";

function makeWork(cid: string, title: string, year: number | null = null): WorkRow {
  return {
    cid,
    title,
    titleJa: "",
    romaji: "",
    year,
    coverUrl: "",
    note: "",
    clientUpdatedAt: NOW,
    deletedAt: null,
    rev: 0,
    rowDigest: "",
  };
}

function makeEpisode(cid: string, workCid: string, season: number | null, number: string): EpisodeRow {
  return {
    cid,
    workCid,
    season,
    number,
    title: "",
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

async function seed(db_: VaultDb, ...rows: (WorkRow | EpisodeRow)[]): Promise<void> {
  for (const row of rows) {
    // WorkRow 独有 titleJa
    await db_.put("titleJa" in row ? STORE.works : STORE.episodes, row);
  }
}

const editOf = (overrides: Partial<EpisodeEditValues> = {}): EpisodeEditValues => ({
  workTitle: "MyGO",
  year: null,
  season: null,
  number: "1",
  episodeTitle: "",
  ...overrides,
});

// ── findEditClash ────────────────────────────────────────────────────────────

describe("findEditClash", () => {
  it("同作品兄弟集占了同样的季集号（改名后才会撞上的也算）", async () => {
    const work = makeWork("work:a", "MyGO");
    await seed(
      db,
      work,
      makeEpisode("ep:1", "work:a", null, "1"),
      makeEpisode("ep:2", "work:a", null, "2"),
    );
    // 把 ep1 编辑成第 2 集 → 和 ep2 撞
    const clash = await findEditClash(
      db,
      { episodeCid: "ep:1", workCid: "work:a" },
      { workTitle: "MyGO", season: null, number: "2" },
    );
    expect(clash).toBe("MyGO");
  });

  it("别的作品同名同季集也拦（两部片子摆在一起就分不清了）", async () => {
    await seed(
      db,
      makeWork("work:a", "MyGO"),
      makeWork("work:b", "孤独摇滚"),
      makeEpisode("ep:a1", "work:a", null, "1"),
      makeEpisode("ep:b1", "work:b", null, "1"),
    );
    const clash = await findEditClash(
      db,
      { episodeCid: "ep:a1", workCid: "work:a" },
      { workTitle: "孤独摇滚", season: null, number: "1" },
    );
    expect(clash).toBe("孤独摇滚");
  });

  it("自己不算撞；没撞上返回 null", async () => {
    await seed(
      db,
      makeWork("work:a", "MyGO"),
      makeEpisode("ep:1", "work:a", null, "1"),
    );
    const clash = await findEditClash(
      db,
      { episodeCid: "ep:1", workCid: "work:a" },
      { workTitle: "MyGO", season: null, number: "1" },
    );
    expect(clash).toBeNull();
  });
});

// ── saveEpisodeEdit ──────────────────────────────────────────────────────────

describe("saveEpisodeEdit", () => {
  it("改名：作品行更新，cid 不动、摘要重算", async () => {
    const work = makeWork("work:a", "MyGO", 2023);
    const episode = makeEpisode("ep:1", "work:a", null, "1");
    await seed(db, work, episode);

    const outcome = await saveEpisodeEdit(db, { work, episode }, editOf({ workTitle: "新名字", year: 2024 }));

    expect(outcome.ok).toBe(true);
    const workRow = await db.get<WorkRow>(STORE.works, "work:a");
    expect(workRow?.title).toBe("新名字");
    expect(workRow?.year).toBe(2024);
    expect(workRow?.rowDigest).not.toBe("");
    // cid 没动 —— 本地所有引用照旧
    expect(workRow?.cid).toBe("work:a");
    expect(episode.cid).toBe("ep:1");
  });

  it("改季集号：集行更新，集号沿用导入的归一化", async () => {
    const work = makeWork("work:a", "MyGO");
    const episode = makeEpisode("ep:1", "work:a", null, "1");
    await seed(db, work, episode);

    const outcome = await saveEpisodeEdit(db, { work, episode }, editOf({ season: 2, number: "5.0" }));

    expect(outcome.ok).toBe(true);
    const episodeRow = await db.get<EpisodeRow>(STORE.episodes, "ep:1");
    expect(episodeRow?.season).toBe(2);
    expect(episodeRow?.number).toBe("5");
  });

  it("什么都没改：空操作，不写库", async () => {
    const work = makeWork("work:a", "MyGO");
    const episode = makeEpisode("ep:1", "work:a", null, "1");
    await seed(db, work, episode);

    const outcome = await saveEpisodeEdit(db, { work, episode }, editOf());

    expect(outcome.ok).toBe(true);
    const workRow = await db.get<WorkRow>(STORE.works, "work:a");
    expect(workRow?.clientUpdatedAt).toBe(NOW);
    expect(workRow?.rowDigest).toBe("");
  });

  it("撞名：返回 ok:false，什么都没写", async () => {
    const work = makeWork("work:a", "MyGO");
    await seed(db, work, makeEpisode("ep:1", "work:a", null, "1"), makeEpisode("ep:2", "work:a", null, "2"));
    const episodesBefore = await db.getAll<EpisodeRow>(STORE.episodes);

    const outcome = await saveEpisodeEdit(
      db,
      { work, episode: (await db.get<EpisodeRow>(STORE.episodes, "ep:1"))! },
      editOf({ number: "2" }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("MyGO");
    const episodesAfter = await db.getAll<EpisodeRow>(STORE.episodes);
    expect(episodesAfter.map((row) => row.clientUpdatedAt)).toEqual(
      episodesBefore.map((row) => row.clientUpdatedAt),
    );
  });
});

// ── 与移除的边界 ─────────────────────────────────────────────────────────────

describe("移除只动这一集，学习记录一律不动（钉住既有口径）", () => {
  it("removeEpisode 不碰 progress", async () => {
    const work = makeWork("work:a", "MyGO");
    const episode = makeEpisode("ep:1", "work:a", null, "1");
    await seed(db, work, episode);
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

    await removeEpisode(db, "ep:1");

    const progress = await db.get<{ completedAt: string | null }>(STORE.progress, "P:slice:1");
    expect(progress?.completedAt).toBe(NOW);
    expect((await db.get<EpisodeRow>(STORE.episodes, "ep:1"))?.deletedAt).not.toBeNull();
  });
});
