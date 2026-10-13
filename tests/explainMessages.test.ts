import { describe, expect, it } from "vitest";
import { buildExplainMessages, buildWordsMessages } from "../src/services/ai/client";

/**
 * 解析 user 消息的拼装。
 *
 * 两条纪律都在这里有用例盯着：
 *  · 目标句必须有「【需要解析的句子】」标签 —— system 提示词靠它圈定解析对象；
 *  · 语境行（作品/前后句/中文参考）缺就整行不放，空标签会诱导模型围绕它编内容。
 * 与服务端 `analyze_user_prompt` 的拼装逻辑逐行对齐，两块解析共用同一份。
 */
describe("解析消息拼装", () => {
  it("语境齐全：作品、前后句、目标句、参考中文、分词参考各占一行", () => {
    const messages = buildExplainMessages({
      ja: "明日また会おう",
      zh: "明天再见",
      words: ["明日", "また"],
      work: "某番剧",
      prevJa: "じゃあ、また明日",
      nextJa: "うん、約束。",
    });
    expect(messages[0].role).toBe("system");
    expect(messages[1].content).toBe(
      [
        "【作品】某番剧",
        "【上一句】じゃあ、また明日",
        "【需要解析的句子】明日また会おう",
        "【中文参考（可能为空或不准，按日语为准）】明天再见",
        "【下一句】うん、約束。",
        "【本句分词参考】明日、また",
      ].join("\n"),
    );
  });

  it("语境缺哪行就不放哪行，不留空标签", () => {
    const messages = buildExplainMessages({ ja: "はい", zh: "", words: ["はい"] });
    expect(messages[1].content).toBe("【需要解析的句子】はい\n【本句分词参考】はい");
  });

  it("逐词释义那一块用同一份 user 消息，只有 system 不同", () => {
    const input = { ja: "はい", zh: "", words: ["はい"] };
    expect(buildWordsMessages(input)[1].content).toBe(buildExplainMessages(input)[1].content);
    expect(buildWordsMessages(input)[0].content).not.toBe(buildExplainMessages(input)[0].content);
  });
});
