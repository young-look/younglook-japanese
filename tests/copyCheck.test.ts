import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareCopy,
  diffCharacters,
  hasKanji,
  kanaView,
  normalizeForCopy,
  normalizeForLiteral,
  readingsLineUp,
} from "../src/services/copyCheck";
import { tokenize } from "../src/services/jaTokenize";

/**
 * 抄写判定的本地版。
 *
 * 期望值对齐服务端 `core/learning/tests/test_services.py::CopyComparisonTests`
 * 与 `test_copy_check.py`（那边查 Dictionary 表，这边用本地分词器顶）。
 *
 * 读音宽容那几条**真拿 kuromoji 跑**（词典就在 node_modules 里，不用 mock）：
 * 放宽的额度全靠分词读音，用假的分词器测等于没测。
 */

const DICT = join(__dirname, "..", "node_modules", "kuromoji", "dict");
const hasDict = existsSync(join(DICT, "base.dat.gz"));

describe("normalizeForCopy", () => {
  it("去掉标点与空白，全角折成半角", () => {
    expect(normalizeForCopy("本当、だよ。")).toBe("本当だよ");
    expect(normalizeForCopy("ＡＢＣ １２３")).toBe("ABC123");
    // 长音符是假名的一部分，不清理
    expect(normalizeForCopy("バンドー")).toBe("バンドー");
  });
});

describe("normalizeForLiteral（数字写法宽容）", () => {
  it("单个数字的汉字写法与阿拉伯数字算同一个字", () => {
    expect(normalizeForLiteral("一日")).toBe("1日");
    expect(normalizeForLiteral("三日")).toBe("3日");
    expect(normalizeForLiteral("零")).toBe("0");
    // 全角数字先被 NFKC 折成半角，再跟汉字写法汇合到同一个串
    expect(normalizeForLiteral("１日")).toBe(normalizeForLiteral("1日"));
  });

  it("位值不做换算：十一 不会变成 101", () => {
    // 逐字折「十 → 10」会把「十一」折成「101」，所以十百千万一个都不折
    expect(normalizeForLiteral("十一")).toBe("十1");
    expect(normalizeForLiteral("十一")).not.toBe(normalizeForLiteral("10"));
  });

  it("折写法只发生在字面层：喂给分词器的串保持原样", () => {
    // 分词器要靠「一人」这种原样写法才知道怎么读，折成「1人」它就给不出读音了
    expect(normalizeForCopy("一人")).toBe("一人");
    expect(normalizeForLiteral("一人")).toBe("1人");
  });
});

describe("diffCharacters（LCS 逐字对照）", () => {
  it("少敲一个字只标那一处，后面不连坐", () => {
    const ops = diffCharacters("ABCDEF", "ABCDF");
    const missing = ops.filter((op) => op.op === "missing");
    expect(missing.map((op) => op.expected)).toEqual(["E"]);
  });

  it("多敲一个字标成 extra", () => {
    const ops = diffCharacters("ありがとう", "ありがとうう");
    expect(ops.filter((op) => op.op === "extra").map((op) => op.actual)).toEqual(["う"]);
  });
});

describe("kanaView / readingsLineUp（纯函数）", () => {
  it("没有读音的词素用字面占位（它得占住位置）", () => {
    const view = kanaView([
      { surface: "1", lemma: "1", reading: "", romaji: "", pos: "other" },
      { surface: "日", lemma: "日", reading: "にち", romaji: "nichi", pos: "suffix" },
    ]);
    expect(view.kana).toBe("1にち");
    expect(view.pieces).toEqual([
      ["1", "1"],
      ["日", "にち"],
    ]);
  });

  it("逐词读音要贴着原句走到底才算过", () => {
    const pieces = [
      ["オラ", "おら"],
      ["は", "は"],
      ["人気", "にんき"],
      ["者", "しゃ"],
    ] as const;
    // 「者」在句子里读 しゃ，跟原句的「もの」对不上；靠词典背书 もの 才走到底
    const backed = (surface: string) => (surface === "者" ? ["もの"] : []);
    expect(readingsLineUp(pieces, "おらはにんきもの", backed)).toBe(true);
    // 没有背书就不认 —— 否则就成了"读音差不多就算对"
    expect(readingsLineUp(pieces, "おらはにんきもの", () => [])).toBe(false);
    // 少一个词走不到底：词典只能证明某个字读某个音，补不回缺失的词
    expect(readingsLineUp(pieces.slice(0, 3), "おらはにんきもの", backed)).toBe(false);
  });
});

describe("compareCopy（字面层，不带分词器）", () => {
  const JA = "明日また会おう";

  it("一模一样 → correct", async () => {
    const out = await compareCopy(JA, JA);
    expect(out.ok).toBe(true);
    expect(out.level).toBe("correct");
    expect(out.accuracy).toBe(1);
  });

  it("标点和空格不参与比对", async () => {
    expect((await compareCopy("本当、だよ。", "本当だよ")).ok).toBe(true);
  });

  it("全角数字敲成半角也算对（用户报的那句）", async () => {
    const out = await compareCopy("おバカな１日元気だぞー", "おバカな1日元気だぞー");
    expect(out.ok).toBe(true);
    expect(out.level).toBe("correct");
  });

  it("汉字数字敲成阿拉伯数字也算对", async () => {
    const out = await compareCopy("おバカな１日元気だぞー", "おバカな一日元気だぞー");
    expect(out.ok).toBe(true);
    expect(out.level).toBe("correct");
  });

  it("判过的写法差异不留在对照里 —— 没法再标红、也没法再说「漏了/多敲了」", async () => {
    // 用户报的那句：原句是全角「１」，敲成半角「1」或汉字「一」都算对。
    // 以前这里返回的是逐字对照，界面上于是出现「顶着 100% 准确率的一处红字 +
    // 漏了 1 / 多敲了 一」，看着像敲错了。判定说对，ops 就得是空的。
    for (const typed of ["おバカな1日元気だぞー", "おバカな一日元気だぞー"]) {
      const out = await compareCopy("おバカな１日元気だぞー", typed);
      expect(out.ok).toBe(true);
      expect(out.accuracy).toBe(1);
      expect(out.ops).toEqual([]);
    }
  });

  it("一字不差时也不给对照（与准确率 100% 不会打架）", async () => {
    const out = await compareCopy(JA, JA);
    expect(out.ok).toBe(true);
    expect(out.ops).toEqual([]);
  });

  it("空输入不算尝试", async () => {
    expect((await compareCopy(JA, "   ")).level).toBe("empty");
  });

  it("漏字 → wrong，提示漏了几个字", async () => {
    const out = await compareCopy(JA, "明日また会");
    expect(out.ok).toBe(false);
    expect(out.level).toBe("wrong");
    expect(out.hint).toBe("漏了 2 个字");
  });

  it("多字 → wrong，提示多敲了几个字", async () => {
    const out = await compareCopy(JA, "明日また会おうう");
    expect(out.ok).toBe(false);
    expect(out.hint).toBe("多了 1 个字");
  });

  it("少敲一个音 → wrong，LCS 把它标成漏一处", async () => {
    // 「会おう」敲成「会う」：对齐结果是漏一个「お」，而不是全句连坐
    const out = await compareCopy(JA, "明日また会う");
    expect(out.ok).toBe(false);
    expect(out.hint).toBe("漏了 1 个字");
    expect(out.accuracy).toBeCloseTo(6 / 7, 2);
  });

  it("敲错的假名绝不能被放过去", async () => {
    expect((await compareCopy("オラはにんきもの", "オラはにんきしゃ")).ok).toBe(false);
  });

  it("词典没装上（没有分词器）时退回字面层：读音对也不放过，但不炸", async () => {
    const out = await compareCopy(JA, "あしたまたあおう");
    expect(out.ok).toBe(false);
    expect(out.level).toBe("wrong");
  });
});

describe.skipIf(!hasDict)("compareCopy（读音宽容层，真跑 kuromoji）", () => {
  const judge = (expected: string, typed: string) =>
    compareCopy(expected, typed, (text) => tokenize(DICT, text));

  it("原句是汉字、敲成假名 → 过，并提醒练汉字", async () => {
    const out = await judge("明日また会おう", "あしたまたあおう");
    expect(out.ok).toBe(true);
    expect(out.level).toBe("kana");
    expect(out.accuracy).toBe(1);
    expect(out.hint).toContain("汉字");
  });

  it("原句是假名、敲成同音汉字 → 过，并提醒照着字幕敲", async () => {
    // 「者」在句子里读 しゃ，但「にんきもの」这个词的写法就是「人気者」
    const out = await judge("オラはにんきもの", "オラは人気者");
    expect(out.ok).toBe(true);
    expect(out.level).toBe("kana");
    expect(out.hint).toContain("假名");
  });

  it("只把最后一个词敲成汉字、读音完全一致 → 过", async () => {
    // 「者」单切读 もの，正好跟原句的「もの」对得上（这一条以前被漏判）
    expect((await judge("オラはにんきもの", "オラはにんき者")).ok).toBe(true);
  });

  it("片假名敲成平假名也算同一个词", async () => {
    expect((await judge("オラはにんきもの", "おらは人気者")).ok).toBe(true);
  });

  it("读音放过的写法差异同样不给对照（提示已经说清了该怎么写）", async () => {
    // 汉字 ↔ 假名这种差异画成逐字对照是整行红的，而判定是「过」
    const out = await judge("明日また会おう", "あしたまたあおう");
    expect(out.ok).toBe(true);
    expect(out.level).toBe("kana");
    expect(out.ops).toEqual([]);
    expect(out.hint).toContain("汉字");
  });

  it("敲错的假名仍然判错", async () => {
    const out = await judge("オラはにんきもの", "オラはにんきしゃ");
    expect(out.ok).toBe(false);
    expect(out.level).toBe("wrong");
  });

  it("少敲一个词仍然判错", async () => {
    expect((await judge("オラはにんきもの", "人気者")).ok).toBe(false);
  });

  it("无关的汉字仍然判错", async () => {
    expect((await judge("オラはにんきもの", "オラは人間")).ok).toBe(false);
  });

  it("读音少一个音仍然判错", async () => {
    expect((await judge("明日また会おう", "明日また会う")).ok).toBe(false);
  });
});

describe("hasKanji", () => {
  it("区分汉字与假名", () => {
    expect(hasKanji("明日また")).toBe(true);
    expect(hasKanji("あした")).toBe(false);
  });
});