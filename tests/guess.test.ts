import { describe, expect, it } from "vitest";
import { guessFromFilename } from "../src/services/guess";

/**
 * 文件名猜元数据的口径。
 *
 * 规则与后端 core/library/services/parsing.py 同源，用例取自真实发布命名
 * （字幕组方括号风、场景点分隔风、BT 下划线风）。这是「导入弹窗预填」的
 * 底座：猜错用户能改，但猜对率直接决定表单要不要动手 —— 所以每条实测
 * 教训都用测试钉死，改正则前先看这里。
 */

describe("字幕组方括号命名（最常见的番剧命名）", () => {
  it("发布组让位、元数据段丢弃、集号归一化", () => {
    expect(guessFromFilename("[Nekomoe kissaten] BanG Dream! It's MyGO!!!!! [04][BDRip][1080p]")).toEqual({
      workTitle: "BanG Dream! It's MyGO!!!!!",
      number: "4",
      season: null,
      year: null,
    });
  });

  it("日文标题原样保留（不小写、不动假名）", () => {
    expect(guessFromFilename("[喵萌Production&VCB-Studio] 葬送のフリーレン [05][WebRip][1080p][HEVC]")).toEqual({
      workTitle: "葬送のフリーレン",
      number: "5",
      season: null,
      year: null,
    });
  });

  it("简繁内封这类字幕规格段也是元数据", () => {
    expect(guessFromFilename("[B-Global] 憂国のモリアーティ [03][Baha][WEB-DL][1080p][简繁内封]")).toMatchObject({
      workTitle: "憂国のモリアーティ",
      number: "3",
    });
  });
});

describe("季与集", () => {
  it("S01E04 同时给出季和集", () => {
    expect(guessFromFilename("Under Ninja S01E04 1080p WEB-DL AAC2.0 H.264-NTb.mkv")).toEqual({
      workTitle: "Under Ninja",
      number: "4",
      season: 1,
      year: null,
    });
  });

  it("第N话 / 第N集", () => {
    expect(guessFromFilename("孤独摇滚！ 第4话 [1080p].mkv")).toMatchObject({
      workTitle: "孤独摇滚！",
      number: "4",
      season: null,
    });
  });

  it("第2季的季号认中文上下文，标题里两截都摘掉", () => {
    expect(guessFromFilename("Re:ゼロから始める異世界生活 第2季 第8话 [Baha][WEB-DL][1080p]")).toEqual({
      workTitle: "Re:ゼロから始める異世界生活",
      number: "8",
      season: 2,
      year: null,
    });
  });

  it("独立的 S2 也是季号", () => {
    expect(guessFromFilename("某动画 S2 [1080p].mkv")).toMatchObject({ number: "", season: 2, workTitle: "某动画" });
  });

  it("1.5 这种特别篇保住小数", () => {
    expect(guessFromFilename("某动画 第13.5话.mkv")).toMatchObject({ number: "13.5", workTitle: "某动画" });
  });
});

describe("整季合集：说不清是哪一集，宁空勿错", () => {
  it("区间 [01-12]", () => {
    expect(guessFromFilename("[VCB-Studio] 某动画 [01-12][BDRip]")).toMatchObject({
      number: "",
      workTitle: "某动画",
    });
  });

  it("Fin / 全集 / Complete", () => {
    expect(guessFromFilename("[VCB-Studio] Kolibri [Fin][BDRip]").number).toBe("");
    expect(guessFromFilename("某动画 全12话 [1080p]").number).toBe("");
    expect(guessFromFilename("某动画 Complete Batch [1080p]").number).toBe("");
  });
});

describe("年份", () => {
  it("括号里的年份进预填", () => {
    expect(guessFromFilename("[Group] 某剧场版 [2023][1080p].mkv")).toMatchObject({
      workTitle: "某剧场版",
      year: 2023,
      number: "",
    });
  });

  it("分辨率和编码里的数字不算年份也不算集号", () => {
    expect(guessFromFilename("某纪录片 1920x1080 H.264.mkv")).toMatchObject({ year: null, number: "" });
  });
});

describe("下划线当空格的 BT 命名", () => {
  it("下划线还原成空格再解析", () => {
    expect(guessFromFilename("BanG_Dream!_It's_MyGO!!!!!_04_[BDRip][1080p].mkv")).toEqual({
      workTitle: "BanG Dream! It's MyGO!!!!!",
      number: "4",
      season: null,
      year: null,
    });
  });
});

describe("实测教训：这些数字都不是集号", () => {
  it("位深标记 10-bit 不污染集号识别", () => {
    expect(guessFromFilename("[VCB-Studio] 某动画 [04][10-bit 1080p][BDRip]").number).toBe("4");
    expect(guessFromFilename("某动画 10-bit 1080p 04.mkv").number).toBe("4");
  });

  it("音频参数 5.1 / 2.0 不算集号", () => {
    expect(guessFromFilename("某电影 5.1 AAC 1080p.mkv").number).toBe("");
    expect(guessFromFilename("某电影 2023 1080p.mkv").number).toBe("");
  });

  it("作品名以数字开头时（如《86》）拿不准就留空，标题保住", () => {
    const guess = guessFromFilename("86 Eighty-Six - 04 [1080p][BDRip].mkv");
    expect(guess.number).toBe("");
    expect(guess.workTitle).toContain("86 Eighty-Six");
  });
});

describe("守住底线", () => {
  it("空名、纯扩展名不炸", () => {
    expect(guessFromFilename("")).toEqual({ workTitle: "", number: "", season: null, year: null });
    expect(guessFromFilename(".mkv")).toEqual({ workTitle: "", number: "", season: null, year: null });
  });

  it("没有可识别的标题时留空字符串，不让垃圾进笔记名", () => {
    expect(guessFromFilename("[04][1080p][BDRip].mkv").workTitle).toBe("");
  });

  it("剧场版没有集号：标题干净、其余留空", () => {
    expect(guessFromFilename("剧场版 某某之歌 [BDRip][1080p].mkv")).toMatchObject({
      number: "",
      season: null,
      year: null,
    });
    expect(guessFromFilename("剧场版 某某之歌 [BDRip][1080p].mkv").workTitle).toBe("剧场版 某某之歌");
  });
});
