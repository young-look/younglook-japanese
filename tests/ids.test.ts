import { describe, expect, it } from "vitest";
import {
  assetShaCid,
  normalizeEpisodeNumber,
  normalizeTitle,
  progressCid,
  randomUuid,
  recordCid,
  sentenceTextHash,
  shortCid,
  sliceCid,
  wordCid,
} from "../src/core/ids";

/**
 * 这里的期望值来自 docs/11-plugin-sync.md 的共享测试向量，
 * 服务端 `core/psync/tests/test_identity.py` 断言的是同一组值。
 *
 * 任何一条挂了，说明两端实现漂移了 —— 不要改期望值去迁就，去找漂移的那一行。
 *
 * ⚠️ 2026-10-09 起切片身份改由三句 hash 派生（不再有跨端共享的固定向量，
 * 见「切片 cid」那组测试）；2026-10-14 起 work/episode/asset 的元数据派生 cid
 * 全部退役 —— 学习记录 = `R:` + sha256(视频 sha256 ⟨US⟩ 日文字幕 sha256)，
 * 素材 = `A:` + 文件 sha256（纯前缀拼接，无归一化空间，不需要共享向量）。
 */

const JA = "睦、連れて行ってくれた";
const VIDEO_SHA = "a".repeat(64);
const JA_SHA = "b".repeat(64);

const VECTORS = {
  slice: "S:aa687d85c0129ec32326e3733da90d5fa41799db74c82aa00885b051a9a71362",
  word: "w:668e6f15568d75e9cb32046efc8e8e71a1614a519fdf6ab9af9db03b4a442fe6",
  textHash: "0ee437389fd4f7e0f46f8bb6a04971556adfcc1cd74dad8bd993f60ad97e2c1a",
} as const;

describe("cid 共享测试向量", () => {
  it("句子指纹", async () => {
    expect(await sentenceTextHash(JA)).toBe(VECTORS.textHash);
  });

  it("切片 cid：三句 hash，首尾退化两句", async () => {
    // 三句 hash：sha256(prev ⟨US⟩ cur ⟨US⟩ next)，去空白后拼接
    const prev = "何を言ってるの";
    const cur = JA; // 睦、連れて行ってくれた
    const next = "大丈夫";
    const cid = await sliceCid(prev, cur, next);
    expect(cid).toMatch(/^S:[0-9a-f]{64}$/u);
    // 顺序敏感：换个顺序就是另一个 cid
    expect(await sliceCid(next, cur, prev)).not.toBe(cid);
    // 首句：prev 传 null 退化为两句
    const head = await sliceCid(null, cur, next);
    expect(head).toMatch(/^S:[0-9a-f]{64}$/u);
    expect(head).not.toBe(cid);
    // 末句：next 传 null 同样退化
    expect(await sliceCid(prev, cur, null)).not.toBe(cid);
    // 空白不影响身份（去空白归一化）
    expect(await sliceCid(` ${prev} `, cur, ` ${next} `)).toBe(cid);
  });

  it("切片 cid：撞了就合并 —— 相同三句序列得到同一个 cid", async () => {
    const seq = await sliceCid("前", "中", "后");
    expect(await sliceCid("前", "中", "后")).toBe(seq);
    // 前后句不同 → 不同 cid（这是三句 hash 相对纯句子 hash 的意义）
    expect(await sliceCid("别", "中", "后")).not.toBe(seq);
    expect(await sliceCid("前", "中", "别")).not.toBe(seq);
  });

  it("切片 cid：归一化口径 —— 标点/全半角/假名写法不影响身份（跨端共享向量）", async () => {
    // @fence-start: plugin.shared-vector
    // 期望值由服务端同口径（core/learning/services/ja_text.py）算出，
    // test_analysis_cache.py::ThreeSentenceDigestNormalizationTests 断言同一 hex。
    // 两边必须逐字节一致 —— 挂了说明归一化口径漂移，别改期望值去迁就。
    const SHARED = "S:b95c193b23c9280b1ec3c10a2d043cc889067afed17805b42a455ecfa6988a47";
    // @fence-end: plugin.shared-vector
    const prev = "何を言ってるの";
    const cur = "睦、連れて行ってくれた";
    const next = "大丈夫";
    expect(await sliceCid(prev, cur, next)).toBe(SHARED);
    // 去掉标点（「、」）→ 同一个身份
    expect(await sliceCid(prev, "睦連れて行ってくれた", next)).toBe(SHARED);
    // 片假名 ↔ 平假名写法、半角片假名 → 同一身份
    expect(await sliceCid("", "ソウカ", "")).toBe(await sliceCid("", "そうか", ""));
    expect(await sliceCid("", "ｿｳｶ", "")).toBe(await sliceCid("", "そうか", ""));
  });

  it("切片 cid：汉字↔假名 / 长音符差异不被归一化吃掉（钉住边界）", async () => {
    // 汉字↔假名是语义改写，归一化故意不吃它 —— 留给相似度/位置锚定层
    expect(await sliceCid("", "分かる", "")).not.toBe(await sliceCid("", "わかる", ""));
    // 长音符「ー」是假名的一部分，折掉会让「コーヒー」撞上「コヒ」
    expect(await sliceCid("", "コーヒー", "")).not.toBe(await sliceCid("", "コヒ", ""));
  });

  it("生词 cid", async () => {
    expect(await wordCid("連れる", "verb")).toBe(VECTORS.word);
  });
});

describe("学习记录 cid（文件哈希对）", () => {
  it("R: 前缀 + 64 hex = 66 字符（服务端 cid 列宽 80 天然放行，不用迁移）", async () => {
    const cid = await recordCid(VIDEO_SHA, JA_SHA);
    expect(cid).toMatch(/^R:[0-9a-f]{64}$/u);
    expect(cid.length).toBe(66);
  });

  it("同一对文件 → 同一条记录；任一文件换版 → 另一条记录", async () => {
    expect(await recordCid(VIDEO_SHA, JA_SHA)).toBe(await recordCid(VIDEO_SHA, JA_SHA));
    expect(await recordCid(VIDEO_SHA, "c".repeat(64))).not.toBe(await recordCid(VIDEO_SHA, JA_SHA));
    expect(await recordCid("d".repeat(64), JA_SHA)).not.toBe(await recordCid(VIDEO_SHA, JA_SHA));
  });

  it("顺序敏感：视频和字幕对调不是同一条记录", async () => {
    expect(await recordCid(VIDEO_SHA, JA_SHA)).not.toBe(await recordCid(JA_SHA, VIDEO_SHA));
  });
});

describe("素材 cid（文件 sha256 寻址）", () => {
  it("A: + 文件 sha256 原样拼接，跨记录共享", () => {
    expect(assetShaCid(VIDEO_SHA)).toBe(`A:${VIDEO_SHA}`);
    expect(assetShaCid(VIDEO_SHA)).toBe(assetShaCid(VIDEO_SHA));
    expect(assetShaCid(VIDEO_SHA)).not.toBe(assetShaCid(JA_SHA));
  });
});

describe("归一化", () => {
  it("标题：NFKC + 折叠空白 + 小写", () => {
    expect(normalizeTitle("  ＭＹＧＯ　!!!!! ")).toBe("mygo !!!!!");
    expect(normalizeTitle("MyGO")).toBe(normalizeTitle("mygo"));
  });

  it("集号：4 / 4.0 / 4.00 必须落到同一个字符串", () => {
    expect(normalizeEpisodeNumber(4)).toBe("4");
    expect(normalizeEpisodeNumber(4.0)).toBe("4");
    expect(normalizeEpisodeNumber("4.00")).toBe("4");
    expect(normalizeEpisodeNumber(4)).toBe(normalizeEpisodeNumber("4.0"));
  });

  it("集号：特别篇保留小数", () => {
    expect(normalizeEpisodeNumber(1.5)).toBe("1.5");
    expect(normalizeEpisodeNumber("12.5")).toBe("12.5");
  });

  it("集号：空值落空串", () => {
    expect(normalizeEpisodeNumber("")).toBe("");
    expect(normalizeEpisodeNumber("-")).toBe("");
  });
});

describe("cid 的关键性质", () => {
  it("同一份内容在两次调用得到同一个 cid（内容派生而非随机）", async () => {
    expect(await recordCid(VIDEO_SHA, JA_SHA)).toBe(await recordCid(VIDEO_SHA, JA_SHA));
  });

  it("进度 cid 派生自切片 cid", () => {
    expect(progressCid(VECTORS.slice)).toBe(`P:${VECTORS.slice}`);
  });

  it("复习事件用随机 cid，天然不冲突", () => {
    expect(randomUuid()).not.toBe(randomUuid());
  });

  it("同形不同词性是两条记录", async () => {
    expect(await wordCid("行く", "verb")).not.toBe(await wordCid("行く", "noun"));
  });

  it("shortCid 保留前缀，便于日志里辨认实体类型", async () => {
    const cid = await recordCid(VIDEO_SHA, JA_SHA);
    expect(shortCid(cid).startsWith("R:")).toBe(true);
    expect(shortCid(cid).length).toBeLessThan(cid.length);
  });
});
