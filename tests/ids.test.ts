import { describe, expect, it } from "vitest";
import {
  assetCid,
  episodeCid,
  normalizeEpisodeNumber,
  normalizeTitle,
  progressCid,
  randomUuid,
  sentenceTextHash,
  shortCid,
  sliceCid,
  wordCid,
  workCid,
} from "../src/core/ids";

/**
 * 这里的期望值来自 docs/11-plugin-sync.md 的共享测试向量，
 * 服务端 `core/psync/tests/test_identity.py` 断言的是同一组值。
 *
 * 任何一条挂了，说明两端实现漂移了 —— 不要改期望值去迁就，去找漂移的那一行。
 *
 * ⚠️ 2026-10-09 起切片身份改由三句 hash 派生（不再有跨端共享的固定向量，
 * 见「切片 cid」那组测试），`slice` 字段只作 `progressCid` 的输入样例。
 */

const TITLE = "BanG Dream! It's MyGO!!!!!";
const YEAR = 2023;
const JA = "睦、連れて行ってくれた";
const FINGERPRINT = "deadbeef".repeat(8);

const VECTORS = {
  work: "W:931c14c130cbd74ed75cc5c64c897aa57f534a5e859b2b6a7a9a35ce6b5da057",
  episode: "E:a49af59fb146aa26dbc09c59043c855f0de47a3b8de781317bc8d93074e1f9f2",
  asset: "A:bf5d5bfce9f86f3e3a60837782eb3329411af93d5bb45fe9f0c5b48b90485db2",
  slice: "S:aa687d85c0129ec32326e3733da90d5fa41799db74c82aa00885b051a9a71362",
  word: "w:668e6f15568d75e9cb32046efc8e8e71a1614a519fdf6ab9af9db03b4a442fe6",
  textHash: "0ee437389fd4f7e0f46f8bb6a04971556adfcc1cd74dad8bd993f60ad97e2c1a",
  episodeSpecial: "E:c1606c375cc7d74cff3318793b9f4975315492f38305e6ee87f3a3278f87a38f",
} as const;

describe("cid 共享测试向量", () => {
  it("作品 cid", async () => {
    expect(await workCid(TITLE, YEAR)).toBe(VECTORS.work);
  });

  it("年份缺失时用空串占位", async () => {
    expect(await workCid(TITLE, null)).not.toBe(VECTORS.work);
    expect(await workCid(TITLE, null)).toBe(await workCid(TITLE, undefined));
  });

  it("集 cid", async () => {
    expect(await episodeCid(VECTORS.work, null, 4.0)).toBe(VECTORS.episode);
  });

  it("特别篇保留小数，不会和整数集的 cid 撞上", async () => {
    expect(await episodeCid(VECTORS.work, 1, 1.5)).toBe(VECTORS.episodeSpecial);
    expect(await episodeCid(VECTORS.work, 1, 1.5)).not.toBe(
      await episodeCid(VECTORS.work, 1, 1),
    );
  });

  it("句子指纹", async () => {
    expect(await sentenceTextHash(JA)).toBe(VECTORS.textHash);
  });

  it("素材 cid", async () => {
    expect(await assetCid("subtitle", FINGERPRINT)).toBe(VECTORS.asset);
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
    // 期望值由服务端同口径（core/learning/services/ja_text.py）算出，
    // test_analysis_cache.py::ThreeSentenceDigestNormalizationTests 断言同一 hex。
    // 两边必须逐字节一致 —— 挂了说明归一化口径漂移，别改期望值去迁就。
    const SHARED = "S:b95c193b23c9280b1ec3c10a2d043cc889067afed17805b42a455ecfa6988a47";
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
    expect(await workCid(TITLE, YEAR)).toBe(await workCid(TITLE, YEAR));
  });

  it("内容不同 → cid 不同", async () => {
    expect(await workCid("MyGO", 2023)).not.toBe(await workCid("Ave Mujica", 2023));
  });

  it("无指纹的素材退化成随机 ID，并且两次不同（避免误合并两个不同的文件）", async () => {
    const a = await assetCid("video", null);
    const b = await assetCid("video", null);
    expect(a).not.toBe(b);
    expect(a.startsWith("A:")).toBe(true);
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

  it("shortCid 保留前缀，便于日志里辨认实体类型", () => {
    expect(shortCid(VECTORS.work).startsWith("W:")).toBe(true);
    expect(shortCid(VECTORS.work).length).toBeLessThan(VECTORS.work.length);
  });
});
