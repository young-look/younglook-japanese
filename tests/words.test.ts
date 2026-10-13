// @vitest-environment node
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { STORE, VaultDb } from "../src/storage/db";
import { wordCid } from "../src/core/ids";
import {
  EXPOSURE_FULL,
  KNOWN_REVIEW_COUNT,
  masteryFrom,
  recordWordExposure,
  statusFrom,
} from "../src/services/words";
import { CONTENT_POS, type Token, type WordRow } from "../src/types/entities";

/**
 * 单词熟练度埋点。
 *
 * 守的是两条容易被改坏的口径：
 *  1. 同一句只算一次曝光 —— 来回翻目录不该把熟练度刷满；
 *  2. 按 (lemma, pos) 去重 —— 一句里出现两次的同一个词只算一个词。
 */

function token(surface: string, lemma: string, pos: Token["pos"], def = ""): Token {
  return { surface, lemma, reading: "よみ", romaji: "yomi", pos, def };
}

async function openDb(): Promise<VaultDb> {
  return VaultDb.open(`test-words-${Math.random().toString(36).slice(2)}`);
}

describe("熟练度规则", () => {
  it("曝光次数 → mastery（0~1 之间，4 位小数）", () => {
    expect(masteryFrom(0)).toBe(0);
    expect(masteryFrom(EXPOSURE_FULL)).toBe(1);
    expect(masteryFrom(EXPOSURE_FULL * 2)).toBe(1);
    expect(masteryFrom(-5)).toBe(0);
    expect(masteryFrom(2)).toBeCloseTo(0.25, 4);
  });

  it("status 由曝光与复习次数推导", () => {
    expect(statusFrom(0, 0)).toBe("new");
    expect(statusFrom(1, 0)).toBe("learning");
    expect(statusFrom(1, KNOWN_REVIEW_COUNT)).toBe("known");
  });
});

describe("recordWordExposure", () => {
  it("只收实词，虚词/标点不算词", async () => {
    const db = await openDb();
    const tokens = [
      token("連れて", "連れる", "verb", "带"),
      token("は", "は", "particle"),
      token("。", "。", "punct"),
    ];
    const fresh = await recordWordExposure(db, "S:1", tokens);
    expect(fresh).toBe(1);
    const cid = await wordCid("連れる", "verb");
    const row = await db.get<WordRow>(STORE.words, cid);
    expect(row?.exposureCount).toBe(1);
    expect(row?.status).toBe("learning");
    expect(row?.definition).toBe("带");
    db.close();
  });

  it("同一句第二次调用不再计数", async () => {
    const db = await openDb();
    const tokens = [token("連れて", "連れる", "verb")];
    expect(await recordWordExposure(db, "S:1", tokens)).toBe(1);
    // 翻回来看第二遍不该再涨
    expect(await recordWordExposure(db, "S:1", tokens)).toBe(0);

    const cid = await wordCid("連れる", "verb");
    expect((await db.get<WordRow>(STORE.words, cid))?.exposureCount).toBe(1);
    db.close();
  });

  it("不同句子各记一次曝光", async () => {
    const db = await openDb();
    const tokens = [token("行く", "行く", "verb")];
    await recordWordExposure(db, "S:1", tokens);
    await recordWordExposure(db, "S:2", tokens);
    const cid = await wordCid("行く", "verb");
    expect((await db.get<WordRow>(STORE.words, cid))?.exposureCount).toBe(2);
    db.close();
  });

  it("一句里重复出现的同一个词只算一次", async () => {
    const db = await openDb();
    const tokens = [
      token("行って", "行く", "verb"),
      token("行った", "行く", "verb"),
    ];
    expect(await recordWordExposure(db, "S:1", tokens)).toBe(1);
    const cid = await wordCid("行く", "verb");
    expect((await db.get<WordRow>(STORE.words, cid))?.exposureCount).toBe(1);
    db.close();
  });

  it("同一个 lemma 不同词性算两个词", async () => {
    const db = await openDb();
    await recordWordExposure(db, "S:1", [token("多い", "多い", "adj"), token("多く", "多い", "adv")]);
    expect(await db.count(STORE.words)).toBe(2);
    db.close();
  });

  it("多次曝光推进 mastery 与 status", async () => {
    const db = await openDb();
    for (let i = 1; i <= 3; i += 1) {
      await recordWordExposure(db, `S:${i}`, [token("行く", "行く", "verb")]);
    }
    const cid = await wordCid("行く", "verb");
    const row = await db.get<WordRow>(STORE.words, cid);
    expect(row?.exposureCount).toBe(3);
    expect(row?.mastery).toBeCloseTo(3 / EXPOSURE_FULL, 4);
    expect(row?.status).toBe("learning");
    expect(row?.firstSeenAt).toBeTruthy();
    db.close();
  });

  it("写上 meta 标记，标记存在时直接短路", async () => {
    const db = await openDb();
    await recordWordExposure(db, "S:1", [token("行く", "行く", "verb")]);
    const marker = await db.get<{ key: string; value: boolean }>(STORE.meta, "exposed:S:1");
    expect(marker?.value).toBe(true);
    db.close();
  });

  it("开卡顺带给日活加 newWords / openedSlices", async () => {
    const db = await openDb();
    await recordWordExposure(db, "S:1", [token("行く", "行く", "verb"), token("猫", "猫", "noun")]);
    const rows = await db.getAll<{ newWords: number; openedSlices: number }>(STORE.studyDays);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ newWords: 2, openedSlices: 1 });
    db.close();
  });

  it("空 token 列表不写任何东西", async () => {
    const db = await openDb();
    expect(await recordWordExposure(db, "S:1", [])).toBe(0);
    expect(await db.count(STORE.words)).toBe(0);
    expect(await db.count(STORE.studyDays)).toBe(0);
    db.close();
  });

  it("CONTENT_POS 与实词判定一致（助词/助动词不算词）", () => {
    expect(CONTENT_POS.has("particle")).toBe(false);
    expect(CONTENT_POS.has("aux")).toBe(false);
    expect(CONTENT_POS.has("punct")).toBe(false);
    expect(CONTENT_POS.has("verb")).toBe(true);
    expect(CONTENT_POS.has("noun")).toBe(true);
  });
});
