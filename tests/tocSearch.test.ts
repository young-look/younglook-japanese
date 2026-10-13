import { describe, expect, it } from "vitest";
import { formatHms, nearestIndexByTime, parseTocQuery } from "../src/services/tocSearch";

/**
 * 目录搜索框的两种读法（2026-10-02 用户提：中日文搜台词 / 输入数字搜时间戳）。
 *
 * 这里守的是"安静跳错句"那类缺陷：解析口径偏一格不会抛错，
 * 只会在用户打 `1:30` 时把人送到别处 —— 所以口径必须钉死。
 */

describe("输入数字 = 时间戳", () => {
  it("纯数字按秒读", () => {
    expect(parseTocQuery("90")).toBe(90_000);
    expect(parseTocQuery("0")).toBe(0);
    expect(parseTocQuery("7")).toBe(7_000);
    expect(parseTocQuery("130")).toBe(130_000);
  });

  it("分:秒 / 时:分:秒 跟浮层里显示的格式一致", () => {
    expect(parseTocQuery("1:30")).toBe(90_000);
    expect(parseTocQuery("01:30")).toBe(90_000);
    expect(parseTocQuery("0:07")).toBe(7_000);
    expect(parseTocQuery("01:02:03")).toBe(3_723_000);
    expect(parseTocQuery("1:30.5")).toBe(90_500);
  });

  it("全角冒号、尾部 s/秒 都认（中文输入法下的常见写法）", () => {
    expect(parseTocQuery("1：30")).toBe(90_000);
    expect(parseTocQuery("90s")).toBe(90_000);
    expect(parseTocQuery("90秒")).toBe(90_000);
    expect(parseTocQuery(" 1 : 30 ")).toBe(90_000);
  });

  it("不是时间就交回给台词搜索（返回 null）", () => {
    expect(parseTocQuery("")).toBeNull();
    expect(parseTocQuery("   ")).toBeNull();
    expect(parseTocQuery("女の子")).toBeNull();
    // 含数字的**文本**不能被当成时间戳
    expect(parseTocQuery("1980年")).toBeNull();
    expect(parseTocQuery("12時")).toBeNull();
    expect(parseTocQuery("女生")).toBeNull();
    // 越界写法（没有 75 秒这种时间）宁可当文本，也别硬算成 2:15
    expect(parseTocQuery("1:75")).toBeNull();
    expect(parseTocQuery("1:30:99")).toBeNull();
  });
});

describe("数字定位落到哪一句", () => {
  const rows = [
    { index: 1, startMs: 0 },
    { index: 2, startMs: 3_000 },
    { index: 3, startMs: 6_200 },
    { index: 4, startMs: 12_000 },
  ];

  it("正好落在某句起点 → 就是它", () => {
    expect(nearestIndexByTime(rows, 3_000)).toBe(2);
    expect(nearestIndexByTime(rows, 6_200)).toBe(3);
  });

  it("落在两句中间 → 取更近的那句起点", () => {
    expect(nearestIndexByTime(rows, 4_100)).toBe(2);
    expect(nearestIndexByTime(rows, 5_500)).toBe(3);
  });

  it("句中间的时间点也归到这一句（按起点算，不按区间包含）", () => {
    // 4.5s 落在第 2 句（3.0~6.2s）的**中间**，仍该跳到第 2 句
    expect(nearestIndexByTime(rows, 4_500)).toBe(2);
  });

  it("超出范围 → 贴到首/末句，不给 null", () => {
    expect(nearestIndexByTime(rows, -5_000)).toBe(1);
    expect(nearestIndexByTime(rows, 999_000)).toBe(4);
  });

  it("空目录 → null（调用方不用再判一次）", () => {
    expect(nearestIndexByTime([], 1_000)).toBeNull();
  });
});

describe("悬停气泡上的时间（固定 00:00:00）", () => {
  it("时:分:秒，各两位补零", () => {
    expect(formatHms(0)).toBe("00:00:00");
    expect(formatHms(1_000)).toBe("00:00:01");
    expect(formatHms(90_000)).toBe("00:01:30");
    expect(formatHms(3_723_000)).toBe("01:02:03");
  });

  it("四舍五入到秒（字幕时间是毫秒，气泡只说秒）", () => {
    expect(formatHms(1_499)).toBe("00:00:01");
    expect(formatHms(1_500)).toBe("00:00:02");
    expect(formatHms(59_999)).toBe("00:01:00");
  });

  it("小时不封顶，脏值不写出 NaN", () => {
    expect(formatHms(360_000_000)).toBe("100:00:00");
    expect(formatHms(-5_000)).toBe("00:00:00");
    expect(formatHms(Number.NaN)).toBe("00:00:00");
  });
});
