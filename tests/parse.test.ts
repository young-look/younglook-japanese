import { describe, expect, it } from "vitest";
import {
  containsLanguages,
  buildCues,
  cueStats,
  detectFormat,
  hasCjk,
  hasKana,
  extractCuesFromText,
  isKaraokeStyle,
  looksLikeText,
  parseAss,
  parseLrc,
  parseSrt,
  parseTimestamp,
  splitBilingual,
  stripTags,
  type Cue,
} from "../src/services/subtitle/parse";

/**
 * 这些用例盯的是**移植过程中最容易偷偷改坏的规则**。
 *
 * （跨端对照工具 tools/parity/run.mjs 已删：服务端解析器随服务端学习管线
 * 下线，解析现在只在插件端跑，跨端一致性问题不复存在。每条规则在 Python
 * 侧的「实测」注释都在 git 历史里，改行为前先翻历史看那一段。）
 */

const ASS_HEADER = [
  "[Script Info]",
  "ScriptType: v4.00+",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  "Style: DefaultJP,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1",
  "Style: DefaultZH,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
].join("\n");

function ass(...dialogues: string[]): string {
  return [ASS_HEADER, ...dialogues, ""].join("\n");
}

/** 把 cue 压成便于断言的元组。 */
function brief(cues: Cue[]): Array<[string, string, number, number]> {
  return cues.map((cue) => [cue.ja, cue.zh, cue.startMs, cue.endMs]);
}

describe("时间戳", () => {
  it("两位小数按百分秒、三位按毫秒，不能统一乘", () => {
    expect(parseTimestamp("0:00:01.34")).toBe(1340);
    expect(parseTimestamp("0:00:01.345")).toBe(1345);
    expect(parseTimestamp("1:02:03.00")).toBe(3723000);
  });

  it("一位小数补成百毫秒", () => {
    expect(parseTimestamp("0:00:01.3")).toBe(1300);
  });

  it(".srt 的逗号分隔也要认", () => {
    expect(parseTimestamp("00:00:02,500")).toBe(2500);
  });

  it("拿不到就给 0，不抛异常", () => {
    expect(parseTimestamp("")).toBe(0);
    expect(parseTimestamp("不是时间")).toBe(0);
  });
});

describe("卡拉OK样式排除", () => {
  it("OP_JP、ED2、带数字的 OP1 都要排除", () => {
    expect(isKaraokeStyle("OP_JP")).toBe(true);
    expect(isKaraokeStyle("OP1")).toBe(true);
    expect(isKaraokeStyle("ED2")).toBe(true);
    expect(isKaraokeStyle("OP1_JP")).toBe(true);
    expect(isKaraokeStyle("karaoke")).toBe(true);
    expect(isKaraokeStyle("Staff")).toBe(true);
  });

  it("关键字后面直接跟字母的不算 —— Opening_Line / Ending / Insert 都是正经台词样式", () => {
    expect(isKaraokeStyle("Opening_Line")).toBe(false);
    expect(isKaraokeStyle("Ending")).toBe(false);
    expect(isKaraokeStyle("Insert")).toBe(false);
    expect(isKaraokeStyle("Default")).toBe(false);
  });
});

describe("覆盖标签清理", () => {
  it("去掉花括号标签", () => {
    expect(stripTags("{\\an8}これは")).toBe("これは");
  });

  it("绘图块整体去掉（p1 到 p0 之间不是文字）", () => {
    const cleaned = stripTags("{\\p1}m 0 0 l 100 0{\\p0}台词");
    expect(cleaned).toBe("台词");
  });

  it("只写了 p1 没写 p0 时，到结尾都算绘图内容", () => {
    expect(stripTags("{\\p1}m 0 0 l 100 0")).toBe("");
  });

  it("换行与不换行空格还原", () => {
    expect(stripTags("上\\N下")).toBe("上\n下");
    expect(stripTags("中\\h間")).toBe("中 間");
  });

  it("全角空格统一成半角，连续空白折叠", () => {
    expect(stripTags("あ　\u3000　い")).toBe("あ い");
  });
});

describe("文本是否值得做成卡片", () => {
  it("只剩音符和标点的行丢掉", () => {
    expect(looksLikeText("♪♫♪")).toBe(false);
    expect(looksLikeText("……")).toBe(false);
    expect(looksLikeText("   ")).toBe(false);
  });

  it("有假名或汉字就留下", () => {
    expect(looksLikeText("これは")).toBe(true);
    expect(looksLikeText("大丈夫")).toBe(true);
    expect(hasKana("これは")).toBe(true);
    expect(hasCjk("大丈夫")).toBe(true);
  });

  it("纯拉丁字母的注音行不进切片", () => {
    expect(looksLikeText("Oh!")).toBe(false);
  });

  it("日文不会被误判成垃圾行（JS 的 \\W 是 ASCII 口径，这里必须自己对齐 Python 语义）", () => {
    // 假名单独一行时也必须算「有内容」，否则整集都会为空
    expect(looksLikeText("あ")).toBe(true);
    expect(looksLikeText("あー")).toBe(true);
  });
});

describe("双语拆分", () => {
  it("上下两行：一边假名一边汉字", () => {
    expect(splitBilingual("ゾーさん\n大象")).toEqual({ ja: "ゾーさん", zh: "大象" });
  });

  it("同一行用空格包住的半角斜杠", () => {
    expect(splitBilingual("ゾーさん / 大象")).toEqual({ ja: "ゾーさん", zh: "大象" });
  });

  it("不带空格的半角斜杠不当分隔符（100人/日 是真台词）", () => {
    expect(splitBilingual("100人/日")).toBeNull();
    expect(splitBilingual("12/25")).toBeNull();
  });

  it("全角斜杠和竖线不需要空格", () => {
    expect(splitBilingual("ゾーさん／大象")).toEqual({ ja: "ゾーさん", zh: "大象" });
    expect(splitBilingual("ゾーさん｜大象")).toEqual({ ja: "ゾーさん", zh: "大象" });
  });

  it("两边都是日文时不算双语", () => {
    expect(splitBilingual("これは\nそれは")).toBeNull();
  });
});

describe("ASS 解析", () => {
  it("列序由 Format 行决定，写死下标会错位", () => {
    const custom = [
      "[Events]",
      "Format: Layer, Start, End, Style, Text, Name",
      "Dialogue: 0,0:00:01.00,0:00:02.00,DefaultJP,これはテストです,",
      "",
    ].join("\n");
    const cues = buildCues(parseAss(custom));
    expect(cues).toHaveLength(1);
    expect(cues[0].ja).toBe("これはテストです");
  });

  it("卡拉OK样式的行被排除", () => {
    const cues = buildCues(
      parseAss(
        ass(
          "Dialogue: 0,0:00:01.00,0:00:03.00,DefaultJP,,0,0,0,,これはテストです",
          "Dialogue: 0,0:00:04.00,0:00:05.00,OP_JP,,0,0,0,,あいうえお",
        ),
      ),
    );
    expect(cues).toHaveLength(1);
    expect(cues[0].ja).toBe("これはテストです");
  });

  it("样式投票：纯汉字的日语句不能被当成中文丢掉", () => {
    // 「大丈夫」一个假名都没有。逐行判语种会把它归入中文いっぽう，
    // 而按样式投票它应该跟着同样式（大部分带假名）判定为日文。
    const cues = buildCues(
      parseAss(
        ass(
          "Dialogue: 0,0:00:01.00,0:00:03.00,DefaultJP,,0,0,0,,これはテストです",
          "Dialogue: 0,0:00:04.00,0:00:06.00,DefaultJP,,0,0,0,,大丈夫",
          "Dialogue: 0,0:00:07.00,0:00:09.00,DefaultJP,,0,0,0,,そうだね",
        ),
      ),
    );
    expect(cues).toHaveLength(3);
    expect(cues.map((cue) => cue.ja)).toContain("大丈夫");
  });

  it("中日双样式按时间轴重叠配对译文", () => {
    const cues = buildCues(
      parseAss(
        ass(
          "Dialogue: 0,0:00:01.00,0:00:03.00,DefaultJP,,0,0,0,,これはテストです",
          "Dialogue: 0,0:00:01.10,0:00:03.00,DefaultZH,,0,0,0,,这是测试",
        ),
      ),
    );
    expect(cues).toHaveLength(1);
    expect(cues[0].ja).toBe("これはテストです");
    expect(cues[0].zh).toBe("这是测试");
  });

  it("时间偏差超过容忍度就不配译文，宁可留空", () => {
    const cues = buildCues(
      parseAss(
        ass(
          "Dialogue: 0,0:00:01.00,0:00:02.00,DefaultJP,,0,0,0,,これは",
          "Dialogue: 0,0:10:01.00,0:10:02.00,DefaultZH,,0,0,0,,这是",
        ),
      ),
    );
    expect(cues).toHaveLength(1);
    expect(cues[0].zh).toBe("");
  });

  it("按时间排序并重新编号", () => {
    const cues = buildCues(
      parseAss(
        ass(
          "Dialogue: 0,0:00:09.00,0:00:10.00,DefaultJP,,0,0,0,,後でね",
          "Dialogue: 0,0:00:01.00,0:00:02.00,DefaultJP,,0,0,0,,前はね",
        ),
      ),
    );
    expect(cues.map((cue) => cue.index)).toEqual([1, 2]);
    expect(cues.map((cue) => cue.ja)).toEqual(["前はね", "後でね"]);
  });

  it("样式里一句假名都没有时，整批都归到中文 —— 这是已知取舍，不是 bug", () => {
    // 「前」「後」都没有假名，样式投票投不出 ja，
    // 于是整批按只有汉字归入中文，日文切片为 0。
    // 真实字幕里同一个样式总有大量带假名的行，所以不会走到这一步；
    // 这里把它记下来，是为了防止有人"顺手优化"掉这个行为却没意识到后果。
    const cues = buildCues(
      parseAss(
        ass(
          "Dialogue: 0,0:00:09.00,0:00:10.00,DefaultJP,,0,0,0,,後",
          "Dialogue: 0,0:00:01.00,0:00:02.00,DefaultJP,,0,0,0,,前",
        ),
      ),
    );
    expect(cues).toEqual([]);
  });
});

describe("SRT 解析", () => {
  it("基本块", () => {
    const text = ["1", "00:00:01,000 --> 00:00:03,000", "こんにちは", ""].join("\n");
    const cues = buildCues(parseSrt(text));
    expect(brief(cues)).toEqual([["こんにちは", "", 1000, 3000]]);
  });

  it("SRT 没有样式概念，所有行共用一个样式名 —— 中日混排时靠样式投票，不会被自动配对", () => {
    // 这是继承下来的行为：SRT 里所有行的 style 都叫 'srt'，
    // 于是「一半以上带假名」时会整批判成日文，中文行也跟着成了日文卡片。
    // 想配译文就用双语 ASS，或者同一行里写成「日文 / 中文」。
    const text = [
      "1",
      "00:00:01,000 --> 00:00:03,000",
      "こんにちは",
      "",
      "2",
      "00:00:04,000 --> 00:00:06,000",
      "你好",
      "",
    ].join("\n");
    const cues = buildCues(parseSrt(text));
    expect(cues.map((cue) => cue.ja)).toEqual(["こんにちは", "你好"]);
    expect(cues.every((cue) => cue.zh === "")).toBe(true);
  });

  it("VTT 风格的时间戳（小数点）也认", () => {
    const text = ["00:00:01.000 --> 00:00:02.500", "ありがとう", ""].join("\n");
    const cues = buildCues(parseSrt(text));
    expect(cues).toHaveLength(1);
    expect(cues[0].endMs - cues[0].startMs).toBe(1500);
  });
});

describe("LRC 歌词", () => {
  it("没有文字的时间戳行也要当边界 —— 否则上一句会把十几秒空白吃进去", () => {
    const cues = buildCues(
      parseLrc(["[00:01.00]最初の一行", "[00:05.80]", "[00:09.00]次の行", ""].join("\n")),
    );
    const first = cues.find((cue) => cue.ja === "最初の一行");
    expect(first).toBeDefined();
    // 关键断言：结束时间停在 5800 这个空时间戳上，而不是一路延到 9000
    expect(first?.endMs).toBe(5800);
  });

  it("同一时间戳的中日两行共用结尾（互相当边界会算出 0 秒，两边都没了）", () => {
    const cues = buildCues(
      parseLrc(["[00:01.00]次の行", "[00:01.00]下一行", "[00:04.00]その後", ""].join("\n")),
    );
    expect(cues).toHaveLength(2);
    expect(brief(cues)).toEqual([
      ["次の行", "下一行", 1000, 4000],
      ["その後", "", 4000, 12000],
    ]);
  });

  it("短于 800ms 的碎行丢掉（开头的「作詞 / 作曲 / 編曲」署名行）", () => {
    const cues = buildCues(
      parseLrc(
        [
          "[00:00.000] 作詞 : 誰某",
          "[00:00.155] 作曲 : 誰某",
          "[00:00.310]編曲:誰某",
          "[00:00.500]ほんとの歌詞",
          "",
        ].join("\n"),
      ),
    );
    expect(cues).toHaveLength(1);
    expect(cues[0].ja).toBe("ほんとの歌詞");
  });

  it("元数据行不出卡片", () => {
    const cues = buildCues(
      parseLrc(
        ["[ti:歌名]", "[ar:歌手]", "[offset:+500]", "[00:10.00]歌詞だよ", ""].join("\n"),
      ),
    );
    expect(cues).toHaveLength(1);
    expect(cues[0].ja).toBe("歌詞だよ");
  });

  it("一句最长不超过 8 秒（结尾是推算出来的，宁可短一点）", () => {
    const cues = buildCues(parseLrc(["[00:01.00]長い行", ""].join("\n")));
    expect(cues).toHaveLength(1);
    expect(cues[0].endMs - cues[0].startMs).toBe(8000);
  });

  it("整份没有时间戳就返回空 —— 纯文本歌词要被挡住", () => {
    expect(parseLrc("これは歌詞ですが\n時間がありません")).toEqual([]);
  });

  it("增强型 LRC 的逐字时间戳不算句子边界", () => {
    const cues = buildCues(
      parseLrc(["[00:01.00]<00:01.00>こ<00:01.20>ん<00:01.40>にちは", ""].join("\n")),
    );
    expect(cues).toHaveLength(1);
    expect(cues[0].ja).toBe("こんにちは");
  });
});

describe("入口与自检", () => {
  it("按后缀识别格式", () => {
    expect(detectFormat("a.ass")).toBe("ass");
    expect(detectFormat("a.ssa")).toBe("ass");
   expect(detectFormat("a.srt")).toBe("srt");
    expect(detectFormat("a.vtt")).toBe("vtt");
    expect(detectFormat("a.lrc")).toBe("lrc");
    expect(detectFormat("a.txt")).toBeNull();
  });

  it("extractCuesFromText 端到端", () => {
    const cues = extractCuesFromText(
      ass("Dialogue: 0,0:00:01.00,0:00:03.00,DefaultJP,,0,0,0,,これはテストです"),
      "ass",
    );
    expect(brief(cues)).toEqual([["これはテストです", "", 1000, 3000]]);
  });

  it("cueStats 统计时长与译文覆盖率", () => {
    const cues = buildCues(
      parseAss(
        ass(
          "Dialogue: 0,0:00:01.00,0:00:03.00,DefaultJP,,0,0,0,,これは",
          "Dialogue: 0,0:00:01.00,0:00:03.00,DefaultZH,,0,0,0,,这是",
          "Dialogue: 0,0:00:05.00,0:00:09.00,DefaultJP,,0,0,0,,それ",
        ),
      ),
    );
    const stats = cueStats(cues);
    expect(stats.total).toBe(2);
    expect(stats.withoutTranslation).toBe(1);
    expect(stats.shortestMs).toBe(2000);
    expect(stats.longestMs).toBe(4000);
  });

  it("空清单不会崩", () => {
    expect(cueStats([])).toEqual({ total: 0 });
  });
});

describe("双轨字幕（日中各一条、同一时间轴）", () => {
  const twoTrackSrt = [
    "1",
    "00:00:01,000 --> 00:00:03,000",
    "本当はバンドやりたいんじゃないの",
    "",
    "2",
    "00:00:01,000 --> 00:00:03,000",
    "你其实很想组乐队吧",
    "",
    "3",
    "00:00:04,000 --> 00:00:06,000",
    "なんで",
    "",
    "4",
    "00:00:04,000 --> 00:00:06,000",
    "为什么这么说",
  ].join("\n");

  it("两轨 SRT 不能整份投成日文（实测曾把中文轨整个塞进 ja）", () => {
    const cues = buildCues(parseSrt(twoTrackSrt));
    expect(brief(cues)).toEqual([
      ["本当はバンドやりたいんじゃないの", "你其实很想组乐队吧", 1000, 3000],
      ["なんで", "为什么这么说", 4000, 6000],
    ]);
  });

  it("containsLanguages：两轨 SRT 算中日都有", () => {
    expect(containsLanguages(parseSrt(twoTrackSrt))).toEqual({ ja: true, zh: true });
  });

  it("containsLanguages：字幕组双语 ASS（两条样式轨）算中日都有", () => {
    // MyGO 双语 ASS 的真实排版：Dial_JP / Dial_CH 各一轨，行数一半一半
    const lines = parseAss(
      ass(
        "Dialogue: 0,0:00:01.00,0:00:03.00,Dial_JP,,0,0,0,,本当はバンドやりたい",
        "Dialogue: 0,0:00:01.00,0:00:03.00,Dial_CH,,0,0,0,,你其实很想组乐队",
        "Dialogue: 0,0:00:04.00,0:00:06.00,Dial_JP,,0,0,0,,なんで",
        "Dialogue: 0,0:00:04.00,0:00:06.00,Dial_CH,,0,0,0,,为什么",
      ),
    );
    expect(containsLanguages(lines)).toEqual({ ja: true, zh: true });
  });

  it("containsLanguages：纯日文不冒充中日（纯汉字短句占比不高）", () => {
    const lines = parseAss(
      ass(
        "Dialogue: 0,0:00:01.00,0:00:03.00,DefaultJP,,0,0,0,,これはテストです",
        "Dialogue: 0,0:00:04.00,0:00:06.00,DefaultJP,,0,0,0,,大丈夫",
        "Dialogue: 0,0:00:07.00,0:00:09.00,DefaultJP,,0,0,0,,そうだね",
        "Dialogue: 0,0:00:10.00,0:00:12.00,DefaultJP,,0,0,0,,一生",
      ),
    );
    expect(containsLanguages(lines)).toEqual({ ja: true, zh: false });
  });

  it("containsLanguages：纯中文字幕", () => {
    const lines = parseAss(
      ass(
        "Dialogue: 0,0:00:01.00,0:00:03.00,DefaultZH,,0,0,0,,这是测试",
        "Dialogue: 0,0:00:04.00,0:00:06.00,DefaultZH,,0,0,0,,没问题",
      ),
    );
    expect(containsLanguages(lines)).toEqual({ ja: false, zh: true });
  });
});
