import { describe, expect, it } from "vitest";
import { looseQuery, normalizeForMatch, pickBestSubject, similarity, yearFromDate } from "../src/services/bangumi";

/**
 * Bangumi 匹配的纯函数口径（网络层不在单测范围 —— 它的契约是「任何失败都
 * 返回 null」，由弹窗那边降级处理）。
 *
 * 相似度的职责是「够像才敢自动填」：阈值定的(strict) —— 文件名标题和
 * Bangumi 收录名对不上就宁可不填，绝不拿错误年份污染 workCid。
 */

describe("normalizeForMatch：把影响比对的杂质清掉", () => {
  it("直撇号弯撇号等价、下划线等价于空格、标点全清", () => {
    expect(normalizeForMatch("BanG Dream! It's MyGO!!!!!")).toBe(normalizeForMatch("BanG Dream! It’s MyGO!!!!!"));
    expect(normalizeForMatch("BanG_Dream_MyGO")).toBe(normalizeForMatch("BanG Dream MyGO"));
    expect(normalizeForMatch("孤独摇滚！")).toBe(normalizeForMatch("孤独摇滚!"));
  });

  it("日文假名汉字原样保留参与比对", () => {
    expect(normalizeForMatch("葬送のフリーレン")).toBe("葬送のフリーレン");
  });
});

describe("similarity：够像才敢自动填", () => {
  it("归一化后相同 → 100", () => {
    expect(similarity("孤独摇滚！", "孤独摇滚!")).toBe(100);
    expect(similarity("BanG Dream! It's MyGO!!!!!", "BanG Dream! It’s MyGO!!!!!")).toBe(100);
  });

  it("子串占够比例才算同一部（严格版，防短别名蹭分）", () => {
    expect(similarity("MyGO!!!!!", "BanG Dream! It's MyGO!!!!!")).toBeLessThan(60);
    const longSentence = "某一部毫不相干的作品里某一句台词里提到了迷途之子这个词";
    expect(similarity("迷途之子", longSentence)).toBeLessThan(60);
  });

  it("完全不相干的两个标题分数低", () => {
    expect(similarity("葬送のフリーレン", "孤独摇滚！")).toBeLessThan(40);
  });
});

describe("looseQuery：压成只留信息量的词", () => {
  it("撇号、重复标点、停用词都不挡路", () => {
    expect(looseQuery("BanG Dream! It's MyGO!!!!!")).toBe("BanG Dream MyGO");
  });

  it("太短压不出两个词就放弃（宁可原样搜）", () => {
    expect(looseQuery("MyGO")).toBe("");
  });
});

describe("yearFromDate：放送日期 → 年份", () => {
  it("取日期头四位", () => {
    expect(yearFromDate("2023-06-14")).toBe(2023);
    expect(yearFromDate(undefined)).toBeNull();
    expect(yearFromDate("")).toBeNull();
    expect(yearFromDate("TBD")).toBeNull();
  });
});

describe("pickBestSubject：挑最像的，够不上阈值宁缺毋滥", () => {
  const items = [
    { id: 1, name: "孤独摇滚！", name_cn: "", date: "2022-10-08" },
    { id: 2, name: "孤独のグルメ", name_cn: "孤独的美食家", date: "2012-07-12" },
    { id: 3, name: "葬送のフリーレン", name_cn: "葬送的芙莉莲", date: "2023-09-29" },
  ];

  it("日文查询命中日文名，带上年份", () => {
    expect(pickBestSubject(items, "葬送のフリーレン")).toEqual({
      id: 3,
      name: "葬送のフリーレン",
      nameCn: "葬送的芙莉莲",
      year: 2023,
      score: 100,
    });
  });

  it("中文查询命中中文名", () => {
    expect(pickBestSubject(items, "孤独摇滚!")?.id).toBe(1);
  });

  it("全都够不上阈值 → null（自动填退回文件名识别）", () => {
    expect(pickBestSubject(items, "夏日重现")).toBeNull();
  });

  it("空结果/畸形条目不炸", () => {
    expect(pickBestSubject([], " anything ")).toBeNull();
    expect(pickBestSubject([{ id: undefined as unknown as number, name: "x" }], "x")).toBeNull();
  });
});
