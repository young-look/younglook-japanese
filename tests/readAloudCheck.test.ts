import { describe, expect, it } from "vitest";
import {
  LOCAL_OK_LINK,
  LOCAL_OK_MESSAGE,
  READ_ALMOST_OK_MESSAGE,
  READ_OK_MESSAGE,
  alignVerdict,
  encodeWav16kMono,
  readAloudPraise,
  toWav16kMono,
  type ReadAloudWord,
} from "../src/services/readAloudCheck";

/**
 * 跟读核对的硬规则。
 *
 * 钉这两条是因为它们坏了**不报错、只是静默判错/静默少东西**：
 *  · 通过时那句话里少了可点词 → 界面上就是一句干提示，"想评估得配内置模型"
 *    这句话等于没说（点了没反应）；
 *  · 对账被去掉 → 服务端词序一漂，红字标到隔壁词头上，用户照着改一个读对的词。
 *
 * ⚠️ 本地**只查有没有出声**（时长判定 2026-10-03 已按用户口径撤掉，见
 * src/services/readAloudCheck.ts 文件头），所以这里不再有区间用例。
 */
describe("跟读 · 本地核对的那句话", () => {
  it("提示语里必须含可点的那四个字，否则那个入口点不出来", () => {
    // renderHintLink 靠 indexOf(keyword) 找位置；找不到就整句变纯文本
    expect(LOCAL_OK_MESSAGE).toContain(LOCAL_OK_LINK);
    expect(LOCAL_OK_LINK).toBe("内置模型");
  });

  it("这句话要同时说清「只查了声音」和「评估得用内置模型」", () => {
    // 括号里那句是防误会的关键：不说清"只判断有没有声音"，用户会以为"录音正常"= 读对了
    expect(LOCAL_OK_MESSAGE).toContain("录音正常");
    expect(LOCAL_OK_MESSAGE).toContain("仅判断是否有声音");
    expect(LOCAL_OK_MESSAGE).toContain("评估发音正确性");
  });
});

describe("跟读 · 服务端结果对账", () => {
  const words: ReadAloudWord[] = [
    { index: 0, surface: "明日", reading: "あした" },
    { index: 1, surface: "また", reading: "また" },
    { index: 2, surface: "会おう", reading: "あおう" },
  ];

  it("逐词按 index 落位，错的那个标出来", () => {
    const verdict = alignVerdict(
      [
        { index: 0, surface: "明日", correct: true },
        { index: 1, surface: "また", correct: false },
        { index: 2, surface: "会おう", correct: true },
      ],
      words,
    );
    expect(verdict.marks.get(0)).toBe("ok");
    expect(verdict.marks.get(1)).toBe("bad");
    expect(verdict.marks.get(2)).toBe("ok");
    expect(verdict.allCorrect).toBe(false);
    expect(verdict.hasWarn).toBe(false);
  });

  it("词面对不上就整条丢弃 —— 宁可少标，不可标错位", () => {
    // 服务端把「また」认成了「待」，这是两端分词口径漂了
    const verdict = alignVerdict([{ index: 1, surface: "待", correct: false }], words);
    expect(verdict.marks.size).toBe(0);
    // 丢弃的那条不算"读错"，否则一句会因为对不上账而永远过不了
    expect(verdict.allCorrect).toBe(true);
  });

  it("下标不是数字 / 本地没这个词，都跳过", () => {
    const verdict = alignVerdict(
      [
        { surface: "明日", correct: false }, // 没 index
        { index: 99, surface: "不存在", correct: false }, // 本地没这个下标
      ],
      words,
    );
    expect(verdict.marks.size).toBe(0);
  });

  it("缺 correct 字段按读对处理（拿不准算对）", () => {
    const verdict = alignVerdict([{ index: 0, surface: "明日" }], words);
    expect(verdict.marks.get(0)).toBe("ok");
    expect(verdict.allCorrect).toBe(true);
  });
});

/**
 * 黄档（2026-10-19 用户口径）：**整句分够高 → 这一遍判过**，没读准的词降级成
 * 黄色提醒，既不判未通过、也不骗人说"每个词都读对了"。
 *
 * 钉这几条是因为它们坏了是**静默的**：分是对的、过也过了，只有一个词的颜色
 * 不对 —— 用户照着红字去改一个本来读对的词，正是这个功能最贵的那种错。
 */
describe("跟读 · 整句够高时的黄档（过了，但词照标）", () => {
  const words: ReadAloudWord[] = [
    { index: 0, surface: "やら", reading: "やら" },
    { index: 1, surface: "ない", reading: "ない" },
  ];

  it("整句够高 + 一个词没读准 → 判过、那个词标**黄**不是标红", () => {
    const verdict = alignVerdict(
      [
        { index: 0, surface: "やら", correct: false, warn: true, score: 0.34 },
        { index: 1, surface: "ない", correct: true, score: 0.95 },
      ],
      words,
      true, // 服务端说这一遍过了
    );
    // 整句 88 分却判未通过 —— 那是自相矛盾的结论
    expect(verdict.allCorrect).toBe(true);
    expect(verdict.hasWarn).toBe(true);
    expect(verdict.marks.get(0)).toBe("warn");
    expect(verdict.marks.get(1)).toBe("ok");
    // 黄词的分照记，但不进夸奖档的最低分（根本走不到夸奖那句）
    expect(verdict.minScore).toBe(0.95);
  });

  it("服务端说过了却漏给 warn → 仍然降级成黄：通过就不许再标红", () => {
    const verdict = alignVerdict(
      [{ index: 0, surface: "やら", correct: false, score: 0.34 }],
      words,
      true,
    );
    expect(verdict.marks.get(0)).toBe("warn");
    expect(verdict.allCorrect).toBe(true);
  });

  it("整句不够高 → 照旧红字、判未通过", () => {
    const verdict = alignVerdict(
      [
        { index: 0, surface: "やら", correct: false, score: 0.34 },
        { index: 1, surface: "ない", correct: true, score: 0.95 },
      ],
      words,
      false,
    );
    expect(verdict.marks.get(0)).toBe("bad");
    expect(verdict.allCorrect).toBe(false);
    expect(verdict.hasWarn).toBe(false);
  });

  it("老服务端不给 all_correct 时退回「一个红词都没有」", () => {
    const passed = alignVerdict(
      [{ index: 0, surface: "やら", correct: true, score: 0.95 }],
      words,
    );
    expect(passed.allCorrect).toBe(true);
    const failed = alignVerdict(
      [{ index: 0, surface: "やら", correct: false, score: 0.34 }],
      words,
    );
    expect(failed.allCorrect).toBe(false);
    expect(failed.marks.get(0)).toBe("bad");
  });

  it("有黄词时那句话是「基本都读对了。」—— 不能说成「每个词都读对了」", () => {
    expect(READ_ALMOST_OK_MESSAGE).toBe("基本都读对了。");
    expect(READ_ALMOST_OK_MESSAGE).not.toBe(READ_OK_MESSAGE);
  });
});

describe("跟读 · 逐词最低分与夸奖档位（2026-10-11 三档拍板）", () => {
  const words: ReadAloudWord[] = [
    { index: 0, surface: "明日", reading: "あした" },
    { index: 1, surface: "また", reading: "また" },
  ];

  it("minScore 取对上账且带分词里的最低分", () => {
    const verdict = alignVerdict(
      [
        { index: 0, surface: "明日", correct: true, score: 0.93 },
        { index: 1, surface: "また", correct: true, score: 0.71 },
      ],
      words,
    );
    expect(verdict.allCorrect).toBe(true);
    expect(verdict.minScore).toBe(0.71);
    expect(readAloudPraise(verdict.minScore)).toBe("读得非常准了。");
  });

  it("标红的词分数再低也不进 minScore（那条路走不到夸奖档）", () => {
    const verdict = alignVerdict(
      [
        { index: 0, surface: "明日", correct: false, score: 0.1 },
        { index: 1, surface: "また", correct: true, score: 0.95 },
      ],
      words,
    );
    expect(verdict.allCorrect).toBe(false);
    expect(verdict.minScore).toBe(0.95);
  });

  it("没分的词不拉低档位；一个带分的都没有 → null → 默认档", () => {
    const none = alignVerdict(
      [
        { index: 0, surface: "明日", correct: true },
        { index: 1, surface: "また", correct: true },
      ],
      words,
    );
    expect(none.minScore).toBeNull();
    expect(readAloudPraise(none.minScore)).toBe(READ_OK_MESSAGE);

    const partial = alignVerdict(
      [
        { index: 0, surface: "明日", correct: true, score: 0.95 },
        { index: 1, surface: "また", correct: true }, // 没分：不参与
      ],
      words,
    );
    expect(partial.minScore).toBe(0.95);
    expect(readAloudPraise(partial.minScore)).toBe("你的发音非常标准！");
  });

  it("三档分界：0.89 次档、0.9 最高档、0.7 次档、0.69 默认档", () => {
    expect(readAloudPraise(0.89)).toBe("读得非常准了。");
    expect(readAloudPraise(0.9)).toBe("你的发音非常标准！");
    expect(readAloudPraise(0.7)).toBe("读得非常准了。");
    expect(readAloudPraise(0.69)).toBe(READ_OK_MESSAGE);
    expect(readAloudPraise(null)).toBe(READ_OK_MESSAGE);
  });
});

describe("跟读 · WAV 转码", () => {
  it("头部字段：16k 单声道 PCM16，块长与数据吻合", () => {
    const view = new DataView(encodeWav16kMono(new Float32Array(160)));
    const str = (offset: number, len: number) =>
      Array.from({ length: len }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join("");
    expect(str(0, 4)).toBe("RIFF");
    expect(str(8, 4)).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1); // 单声道
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16); // 位深
    expect(view.getUint32(40, true)).toBe(320); // 160 样本 × 2 字节
    expect(view.getUint32(4, true)).toBe(44 + 320 - 8);
  });

  it("PCM16 量化：0.5 → 半幅、-1 → 下限、超 1 削波", () => {
    const view = new DataView(encodeWav16kMono(new Float32Array([0.5, -1, 2, -2])));
    expect(view.getInt16(44 + 0 * 2, true)).toBe(16383); // 0.5×0x7fff 截断
    expect(view.getInt16(44 + 1 * 2, true)).toBe(-32768);
    expect(view.getInt16(44 + 2 * 2, true)).toBe(32767);
    expect(view.getInt16(44 + 3 * 2, true)).toBe(-32768);
  });

  it("没有 AudioContext 的环境（node/解不开码）返回 null，走原始容器兜底", async () => {
    const blob = await toWav16kMono(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }));
    expect(blob).toBeNull();
  });
});
