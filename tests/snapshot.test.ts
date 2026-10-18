import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { STORE, VaultDb } from "../src/storage/db";
import { pushSnapshot } from "../src/services/sync/client";
import {
  applySnapshotPull,
  buildSnapshotPayload,
  diffManifest,
  rowHash,
  splitSnapshotPayload,
  type SnapshotCollection,
  type SnapshotRow,
} from "../src/services/sync/snapshot";
import type { PluginSettings } from "../src/settings/types";
import type { AssetRow, ProgressRow, RecordLineRow, SentenceRow } from "../src/types/entities";

const NOW = "2026-10-06T12:00:00.000Z";
const NOW2 = "2026-10-06T13:00:00.000Z";
const NOW3 = "2026-10-06T14:00:00.000Z";

function settings(over: Partial<PluginSettings> = {}): PluginSettings {
  return {
    vaultFolder: "young_look",
    mediaDir: "",
    aiMode: "hosted",
    byok: { baseUrl: "", apiKey: "sk-secret", model: "" },
    serverEnv: "auto",
    customServerUrl: "",
    serverUrl: "http://127.0.0.1:8060",
    authServerUrl: "",
    authToken: "",
    refreshToken: "r",
    lastStatsSyncAt: 0,
    aiBalanceMillis: 0,
    accountProfile: null,
    autoSyncMinutes: 15,
    vaultLocalId: "testvault",
    autoOpenPage: true,
    lastView: "",
    prefsUpdatedAt: "",
    ...over,
  } as PluginSettings;
}

async function seed(): Promise<VaultDb> {
  const db = await VaultDb.open("snapshot-test");
  const base = { rev: 3, rowDigest: "d" };
  await db.bulkPut(STORE.records, [{
    ...base, cid: "r:a", videoSha256: "vsha", jaSubSha256: "jsha", zhSubSha256: null,
    title: "MyGO", titleJa: "", romaji: "", year: 2023, coverUrl: "https://a/c.jpg",
    note: "", season: 1, number: "1", episodeTitle: "", durationMs: null,
    clientUpdatedAt: NOW, deletedAt: null,
  }]);
  await db.bulkPut(STORE.assets, [{
    ...base, cid: "asset:a1", kind: "video", sha256: "vsha",
    filename: "demo.mkv", sizeBytes: 1, language: "ja", subtitleFormat: "",
    localPath: "/Users/you/secret/demo.mkv", offsetMs: 250, available: true,
    clientUpdatedAt: NOW, deletedAt: null,
  }]);
  // 台词层（本机 only）：原文与时间轴；句子层（三句哈希）：解析与覆盖层
  await db.bulkPut(STORE.lines, [{
    recordCid: "r:a", index: 0, sentenceCid: "S:1",
    startMs: 0, endMs: 100, ja: "明日また", zh: "明天见", speaker: "",
  } as RecordLineRow]);
  await db.bulkPut(STORE.sentences, [{
    ...base, cid: "S:1", ja: "明日また", textHash: "th1",
    analysis: {
      engine: "plugin-ai-v1", text: "明日また", romaji: "", tokens: [{ surface: "明日", lemma: "明日", reading: "あした", romaji: "ashita", aiReading: "あした", pos: "noun" }],
      grammar: null, missingDefinitions: [], definitionsComplete: true, done: true, translation: "明天见",
    },
    readingFixes: { "0": { surface: "明日", reading: "みょうにち" } },
    textFixes: { ja: "明日またね" },
    correctionsUpdatedAt: NOW2,
    clientUpdatedAt: NOW,
  } as SentenceRow]);
  await db.bulkPut(STORE.progress, [{
    ...base, cid: "P:S:1", sliceCid: "S:1", copyAttempts: 1, copyDoneAt: NOW, copyEpoch: 0,
    readAloudAt: NOW, readAloudSeconds: 3, readEpoch: 0,
    imitationText: "また明日", imitationCorrect: true, imitationVerifiedAt: NOW, imitationEpoch: 0,
    imitationChat: [{ role: "user", content: "为什么这样", ts: NOW }],
    completedAt: NOW,
    clientUpdatedAt: NOW, deletedAt: null,
  }]);
  return db;
}

function col(rows: SnapshotRow[]): Record<string, SnapshotRow[]> {
  return rows.length ? Object.fromEntries([["progress", rows]]) : {};
}

describe("buildSnapshotPayload（白名单之外全上云）", () => {
  it("progress 行内嵌出处（join 进 works/episodes），簿记字段剥掉", async () => {
    const db = await seed();
    const { collections } = await buildSnapshotPayload(db, settings());
    const row = collections.progress?.find((r) => r.cid === "P:S:1");
    expect(row).toBeDefined();
    expect(row?.data.rev).toBeUndefined();
    expect(row?.data.rowDigest).toBeUndefined();
    expect(row?.data.provenance).toEqual({
      record_cid: "r:a", record_title: "MyGO",
      episode_number: "1", slice_index: 0,
    });
    await db.close();
  });

  it("assets 剔掉 localPath（本机路径永不上云），offsetMs 照传", async () => {
    const db = await seed();
    const { collections } = await buildSnapshotPayload(db, settings());
    const row = collections.assets?.find((r) => r.cid === "asset:a1");
    expect(row?.data.localPath).toBeUndefined();
    expect(row?.data.offsetMs).toBe(250);
    await db.close();
  });

  it("corrections 从覆盖层推导（含撤销墓碑：全空），analysis 剔整句 text", async () => {
    const db = await seed();
    const { collections } = await buildSnapshotPayload(db, settings());
    const fix = collections.corrections?.find((r) => r.cid === "S:1");
    expect(fix?.data).toMatchObject({ ja: "明日またね", readingFixes: { "0": { reading: "みょうにち" } } });
    expect(fix?.client_updated_at).toBe(NOW2);

    const ana = collections.analysis?.find((r) => r.cid === "S:1");
    expect(ana?.data.text).toBeUndefined();
    expect((ana?.data as { tokens?: unknown[] }).tokens).toHaveLength(1);
    expect((ana?.data as { translation?: string }).translation).toBe("明天见");
    await db.close();
  });

  it("settings 只带偏好白名单（凭据/指向/余额不在列）", async () => {
    const db = await seed();
    const { collections } = await buildSnapshotPayload(db, settings({ lastView: "study" }));
    const row = collections.settings?.find((r) => r.cid === "settings");
    expect(row?.data).toEqual({
      vaultFolder: "young_look", aiMode: "hosted", autoSyncMinutes: 15, autoOpenPage: true, lastView: "study",
    });
    await db.close();
  });
});

describe("applySnapshotPull（LWW 合并 + 白名单覆盖）", () => {
  it("本地旧的被云端覆盖，本地新的不动", async () => {
    const db = await seed();
    // 云端版本更新：mastery 抬高
    const applied = await applySnapshotPull(db, settings(), {
      words: [{ cid: "w:1", data: { lemma: "词", mastery: 0.9 }, client_updated_at: NOW2 }],
    });
    expect(applied.applied).toBe(1);
    const won = await db.get<Record<string, unknown>>(STORE.words, "w:1");
    expect(won?.mastery).toBe(0.9);
    expect(won?.clientUpdatedAt).toBe(NOW2);

    // 云端更旧：不覆盖
    const applied2 = await applySnapshotPull(db, settings(), {
      words: [{ cid: "w:1", data: { lemma: "词", mastery: 0.1 }, client_updated_at: NOW }],
    });
    expect(applied2.applied).toBe(0);
    expect((await db.get<Record<string, unknown>>(STORE.words, "w:1"))?.mastery).toBe(0.9);
    await db.close();
  });

  it("progress 拉回保留 provenance（历史页孤儿行兜底要显示出处）", async () => {
    const db = await VaultDb.open("snapshot-pull-empty");
    await applySnapshotPull(db, settings(), {
      progress: [{
        cid: "P:S:9",
        data: { sliceCid: "S:9", copyAttempts: 0, completedAt: NOW, provenance: { work_title: "MyGO", slice_index: 3 } },
        client_updated_at: NOW,
      }],
    });
    const row = await db.get<ProgressRow & { provenance?: unknown }>(STORE.progress, "P:S:9");
    expect(row?.completedAt).toBe(NOW);
    expect(row?.provenance).toEqual({ work_title: "MyGO", slice_index: 3 });
    await db.close();
  });

  it("analysis 只补空：本地没解析过才收，text 用本地原句重建", async () => {
    const db = await seed();
    // 新增一句没有 analysis 的句子行
    await db.put(STORE.sentences, {
      rev: 0, rowDigest: "", cid: "S:2", ja: "こんにちは", textHash: "th2",
      analysis: null, clientUpdatedAt: NOW,
    } as SentenceRow);
    await applySnapshotPull(db, settings(), {
      analysis: [{
        cid: "S:2",
        data: { engine: "plugin-ai-v1", romaji: "", tokens: [], grammar: null, missingDefinitions: [], definitionsComplete: true, done: true },
        client_updated_at: NOW,
      }],
    });
    const row = await db.get<SentenceRow>(STORE.sentences, "S:2");
    expect(row?.analysis?.engine).toBe("plugin-ai-v1");
    expect(row?.analysis?.text).toBe("こんにちは");

    // 本地已有解析的 S:1 不被覆盖
    await applySnapshotPull(db, settings(), {
      analysis: [{ cid: "S:1", data: { engine: "plugin-ai-v1", text: "", romaji: "", tokens: [], grammar: null, missingDefinitions: [], definitionsComplete: false, done: false }, client_updated_at: NOW2 }],
    });
    const keep = await db.get<SentenceRow>(STORE.sentences, "S:1");
    expect(keep?.analysis?.done).toBe(true);

    // 🔥 本地**半份**（只有解读那一块，`done:false`）不算"解析过"：云端那份完整的要收
    //    —— 拿半份当"有"，云端那份就永远进不来，用户在这台机器上只剩半句（2026-10-15）
    await db.put(STORE.sentences, {
      rev: 0, rowDigest: "", cid: "S:3", ja: "おはよう", textHash: "th3",
      analysis: {
        engine: "plugin-ai-v1", text: "おはよう", romaji: "", tokens: [],
        explanation: { words: "本机上次留住的那半句", grammar: "" },
        missingDefinitions: [], definitionsComplete: false, done: false, translation: "",
      },
      clientUpdatedAt: NOW,
    } as SentenceRow);
    await applySnapshotPull(db, settings(), {
      analysis: [{
        cid: "S:3",
        data: { engine: "plugin-ai-v1", romaji: "ohayou", tokens: [{ surface: "おはよう", def: "早上好" }], explanation: { words: "云端的完整解读", grammar: "" }, missingDefinitions: [], definitionsComplete: true, done: true },
        client_updated_at: NOW2,
      }],
    });
    const completed = await db.get<SentenceRow>(STORE.sentences, "S:3");
    expect(completed?.analysis?.done).toBe(true);
    expect(completed?.analysis?.explanation?.words).toBe("云端的完整解读");
    await db.close();
  });

  it("settings 只覆盖白名单键，且比本地旧时不覆盖", async () => {
    const db = await seed();
    const s = settings({ vaultFolder: "本地改过的", prefsUpdatedAt: NOW2, lastView: "" });
    await applySnapshotPull(db, s, {
      settings: [{
        cid: "settings",
        data: { vaultFolder: "云端的", aiMode: "byok", lastView: "history", apiKey: "sk-injected" },
        client_updated_at: NOW,
      }],
    });
    expect(s.vaultFolder).toBe("本地改过的"); // 云端更旧 → 不动

    await applySnapshotPull(db, s, {
      settings: [{
        cid: "settings",
        data: { vaultFolder: "云端的", aiMode: "byok", lastView: "history", apiKey: "sk-injected" },
        client_updated_at: NOW3,
      }],
    });
    expect(s.vaultFolder).toBe("云端的");
    expect(s.aiMode).toBe("byok");
    expect(s.lastView).toBe("history");
    // 🔒 白名单外的键（哪怕云端推过来）永远落不到本地设置
    expect(s.byok.apiKey).toBe("sk-secret");
    await db.close();
  });

  it("corrections 拉回套回切片行（复用纠正合并器）", async () => {
    const db = await VaultDb.open("snapshot-pull-fixes");
    await db.put(STORE.sentences, {
      rev: 0, rowDigest: "", cid: "S:5", ja: "元の文", textHash: "th5",
      analysis: null, clientUpdatedAt: NOW,
    } as SentenceRow);
    const applied = await applySnapshotPull(db, settings(), {
      corrections: [{
        cid: "S:5",
        data: { sliceCid: "S:5", ja: "直した文", zh: "", readingFixes: {} },
        client_updated_at: NOW2,
      }],
    });
    expect(applied.applied).toBe(1);
    const row = await db.get<SentenceRow>(STORE.sentences, "S:5");
    expect(row?.textFixes?.ja).toBe("直した文");
    await db.close();
  });
});

describe("上云白名单（不该同步的不上云）", () => {
  it("assets 走允许键白名单：available（本机可用性）也不在列", async () => {
    const db = await seed();
    const { collections } = await buildSnapshotPayload(db, settings());
    const row = collections.assets?.find((r) => r.cid === "asset:a1");
    expect(row?.data.localPath).toBeUndefined();
    expect(row?.data.available).toBeUndefined();
    // 精确等于白名单 ∩ 源行里实际存在的字段：多一个键都算漏了
    expect(row?.data).toEqual({
      cid: "asset:a1", kind: "video", sha256: "vsha", filename: "demo.mkv",
      sizeBytes: 1, language: "ja", subtitleFormat: "", offsetMs: 250,
      clientUpdatedAt: NOW, deletedAt: null,
    });
    // 源行里还带着 available / localPath（未在白名单登记）→ 也不该上云
    expect(row?.data.available).toBeUndefined();
    expect(row?.data.localPath).toBeUndefined();
    await db.close();
  });
});

describe("每趟全量 + 超预算切块（没有游标、没有行数上限）", () => {
  const TOTAL = 20;

  async function seedWords(): Promise<VaultDb> {
    const db = await VaultDb.open("snapshot-chunk");
    const rows = Array.from({ length: TOTAL }, (_, i) => ({
      cid: `w:${i}`, lemma: `word${i}`, reading: "", definition: "あ".repeat(400),
      clientUpdatedAt: new Date(Date.parse(NOW) - i * 60_000).toISOString(),
      deletedAt: null,
    }));
    await db.bulkPut(STORE.words, rows as never);
    return db;
  }

  it("全量打包：本地有多少行就带多少行，不分趟", async () => {
    const db = await seedWords();
    const built = await buildSnapshotPayload(db, settings());
    expect(built.collections.words).toHaveLength(TOTAL);
    await db.close();
  });

  it("超预算切成多块：块与块不重不漏，合起来仍是全量", async () => {
    const db = await seedWords();
    const { collections } = await buildSnapshotPayload(db, settings());
    const chunks = splitSnapshotPayload(collections, 5000);
    expect(chunks.length).toBeGreaterThan(1);
    const all: string[] = [];
    for (const chunk of chunks) {
      for (const row of chunk.collections.words ?? []) all.push(row.cid);
    }
    expect(new Set(all).size).toBe(all.length); // 不重
    expect(all).toHaveLength(TOTAL); // 不漏
    await db.close();
  });

  it("切块以行为单位：一行不会被切开", async () => {
    const db = await seedWords();
    const { collections } = await buildSnapshotPayload(db, settings());
    const chunks = splitSnapshotPayload(collections, 5000);
    for (const chunk of chunks) {
      for (const row of chunk.collections.words ?? []) {
        expect(row.cid).toMatch(/^w:\d+$/u);
        expect(typeof row.data.lemma).toBe("string");
      }
    }
    await db.close();
  });

  it("内容哈希稳定：同一份数据两次打包哈希相同（校验靠它）", async () => {
    const db = await seedWords();
    const a = await buildSnapshotPayload(db, settings());
    const b = await buildSnapshotPayload(db, settings());
    const ha = (a.collections.words ?? []).map((r) => r.content_hash);
    const hb = (b.collections.words ?? []).map((r) => r.content_hash);
    expect(ha).toEqual(hb);
    expect(ha.every((h) => /^[0-9a-f]{64}$/u.test(h))).toBe(true);
    // 键顺序不同不该影响哈希（canonicalJson 的核心保证）
    expect(await rowHash({ a: 1, b: 2 })).toBe(await rowHash({ b: 2, a: 1 }));
    await db.close();
  });

  it("字节按真 UTF-8 计：中日文不再被低估 3 倍（服务端 _row_bytes 同口径）", async () => {
    const db = await VaultDb.open("snapshot-chunk-cjk");
    await db.bulkPut(STORE.words, [{
      cid: "w:cjk", lemma: "日本語の単語", reading: "", definition: "あ".repeat(100),
      clientUpdatedAt: NOW, deletedAt: null,
    }] as never);
    const built = await buildSnapshotPayload(db, settings());
    const allRows = Object.values(built.collections).flat();
    const expected = allRows.reduce(
      (sum, row) => sum + new TextEncoder().encode(JSON.stringify(row)).length,
      0,
    );
    expect(built.bytes).toBe(expected);
    // 汉字/假名在 UTF-8 下是 3 字节 → 真字节必须显著大于 JSON 字符数（UTF-16 码元）
    const cjkRow = built.collections.words?.[0];
    expect(expected).toBeGreaterThan(JSON.stringify(cjkRow).length * 1.5);
    await db.close();
  });

  it("切块预算按真字节：CJK 行不会被切出超预算的块", async () => {
    const db = await VaultDb.open("snapshot-chunk-cjk2");
    const rows = Array.from({ length: 8 }, (_, i) => ({
      cid: `w:c${i}`, lemma: "日本語の単語", reading: "", definition: "あ".repeat(300),
      clientUpdatedAt: new Date(Date.parse(NOW) - i * 60_000).toISOString(), deletedAt: null,
    }));
    await db.bulkPut(STORE.words, rows as never);
    const budget = 2000;
    const { collections } = await buildSnapshotPayload(db, settings());
    const chunks = splitSnapshotPayload(collections, budget);
    for (const chunk of chunks) {
      const bytes = Object.values(chunk.collections).flat().reduce(
        (sum, row) => sum + new TextEncoder().encode(JSON.stringify(row)).length, 0,
      );
      expect(bytes).toBeLessThanOrEqual(budget);
    }
    // 按真字节每行 ~1KB、预算 2KB ⇒ 每块装不下 2 行，块数远多于「按字符数低估」时的 2 块
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    await db.close();
  });
});

describe("每日校验（本地 vs 云端哈希清单）", () => {
  function cols(
    partial: Partial<Record<SnapshotCollection, SnapshotRow[]>>,
  ): Record<SnapshotCollection, SnapshotRow[]> {
    return {
      progress: [], words: [], study_days: [], records: [], assets: [],
      sessions: [], corrections: [], analysis: [], settings: [],
      ...partial,
    };
  }

  function mk(cid: string, hash: string): SnapshotRow {
    return { cid, data: { v: 1 }, client_updated_at: NOW, content_hash: hash };
  }

  it("完全一致 → 没有漂移", () => {
    const diff = diffManifest(cols({ words: [mk("w:1", "h1")] }), [
      { collection: "words", cid: "w:1", content_hash: "h1" },
    ]);
    expect(diff.missing).toEqual([]);
    expect(diff.mismatched).toEqual([]);
    expect(diff.extra).toBe(0);
  });

  it("云端没有这一行 → 计入缺失（该重推了）", () => {
    const diff = diffManifest(cols({ words: [mk("w:1", "h1")] }), []);
    expect(diff.missing).toEqual(["words w:1"]);
  });

  it("内容被改过 → 计入不一致（行数不变，弱校验抓不到）", () => {
    const diff = diffManifest(cols({ words: [mk("w:1", "新的")] }), [
      { collection: "words", cid: "w:1", content_hash: "旧的" },
    ]);
    expect(diff.mismatched).toEqual(["words w:1"]);
  });

  it("云端多出来的行不算漂移（只增不删，那可能是另一台设备的）", () => {
    const diff = diffManifest(cols({ words: [] }), [
      { collection: "words", cid: "w:9", content_hash: "h9" },
    ]);
    expect(diff.missing).toEqual([]);
    expect(diff.extra).toBe(1);
  });

  it("不同集合的同名 cid 不会互相误判", () => {
    const diff = diffManifest(cols({ words: [mk("x:1", "a")], sessions: [mk("x:1", "b")] }), [
      { collection: "words", cid: "x:1", content_hash: "a" },
      { collection: "sessions", cid: "x:1", content_hash: "b" },
    ]);
    expect(diff.missing).toEqual([]);
    expect(diff.mismatched).toEqual([]);
  });
});

describe("413 是重试信号，不是失败", () => {
  it("push 收到 413 → tooLarge=true（调用方据此降档重推）", async () => {
    const res = await pushSnapshot({
      serverUrl: "http://127.0.0.1:8060",
      accessToken: "t",
      payload: { collections: {} },
      fetchImpl: async () => new Response("{}", { status: 413 }),
    });
    expect(res.ok).toBe(false);
    expect(res.tooLarge).toBe(true);
  });
});

describe("孤儿补丁暂存（换机：云端纠正/解析先存着，确认接回时再套）", () => {
  const suffix = () => Math.random().toString(36).slice(2, 8);

  it("本地没有切片、但有该句的 progress 行 → corrections/analysis 暂存进 meta", async () => {
    const db = await VaultDb.open(`snapshot-orphan-${suffix()}`);
    // 换机后拉回的进度行（本地没切片）—— 孤儿补丁只在确有这条时暂存
    await db.put(STORE.progress, {
      rev: 0, rowDigest: "", cid: "P:S:ghost", sliceCid: "S:ghost",
      copyAttempts: 1, copyDoneAt: null, copyEpoch: 0, copyText: "",
      readAloudAt: null, readAloudSeconds: 0, readEpoch: 0,
      imitationText: "", imitationCorrect: null, completedAt: NOW,
      clientUpdatedAt: NOW, deletedAt: null,
    } as never);

    await applySnapshotPull(db, settings(), {
      corrections: [{
        cid: "S:ghost",
        data: { sliceCid: "S:ghost", ja: "直した", zh: "改好了", readingFixes: {} },
        client_updated_at: NOW,
      }],
      analysis: [{
        cid: "S:ghost",
        data: { engine: "plugin-ai-v1", tokens: [], done: true },
        client_updated_at: NOW,
      }],
    });

    const patch = await db.get<{ value: { correction?: unknown; analysis?: unknown } }>(
      STORE.meta, "orphanPatch:S:ghost",
    );
    expect(patch?.value.correction).toBeTruthy();
    expect(patch?.value.analysis).toBeTruthy();
    await db.close();
  });

  it("没有 progress 行的孤儿 → 不暂存（稳态不写 meta）", async () => {
    const db = await VaultDb.open(`snapshot-orphan-${suffix()}`);
    await applySnapshotPull(db, settings(), {
      corrections: [{
        cid: "S:nobody",
        data: { sliceCid: "S:nobody", ja: "x", zh: "y", readingFixes: {} },
        client_updated_at: NOW,
      }],
    });
    expect(await db.get(STORE.meta, "orphanPatch:S:nobody")).toBeUndefined();
    await db.close();
  });
});
