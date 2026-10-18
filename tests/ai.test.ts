import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANALYZE_SYSTEM,
  ANALYZE_WORDS_SYSTEM,
  ASK_SYSTEM,
  AiUnavailableError,
  IMITATION_SYSTEM,
  MAX_SECTION,
  aiConfigOrThrow,
  buildAskMessages,
  buildExplainMessages,
  buildImitationMessages,
  buildWordsMessages,
  explainSentence,
  explainSentenceStream,
  explainWords,
  extractStreamFields,
  extractVerdictFields,
  isUpstreamError,
  noOutputMessage,
  parseJsonLoose,
  renderExplanation,
  verifyImitation,
  watchFirstOutput,
} from "../src/services/ai/client";
import type { PluginSettings } from "../src/settings/types";

/**
 * AI 层的用例。
 *
 * 重点是**模型输出不可信**这件事：拿不到合法 JSON、或字段类型不对时，
 * 仿写核对的结论必须是"没通过"，绝不能因为解析失败把用户答案算对。
 * 另一半是"没配 Key 时要给人话"，不能抛个 401 出去。
 */

function settings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return {
    vaultFolder: "看动漫学日语",
    mediaDir: "",
    aiMode: "byok",
    byok: { baseUrl: "https://example.com/v1/", apiKey: "sk-test", model: "qwen-plus" },
    // 草稿/快照分离（2026-10-10）：生效的是 byokSaved。工厂默认就是"已保存"
    // 的稳态（快照=草稿、锁定），要测别的状态在用例里显式覆盖。
    byokSaved: { baseUrl: "https://example.com/v1/", apiKey: "sk-test", model: "qwen-plus" },
    byokLocked: true,
    // 分桶表只在落盘/切空间时参与；client 只读顶层那份工作副本（2026-10-17）
    byokBySpace: {},
    serverEnv: "prod",
    customServerUrl: "",
    serverUrl: "https://younglook.cc",
    authServerUrl: "",
    authToken: "",
    refreshToken: "",
    lastStatsSyncAt: 0,
    aiBalanceMillis: 0,
    accountProfile: null,
    autoSyncMinutes: 15,
    vaultLocalId: "test",
    spaces: [{ id: "test", owner: "", ownerServer: "", ownerName: "" }],
    activeSpaceId: "test",
    autoOpenPage: true,
    lastView: "",
    dictPromptSeen: false,
    micQualityPromptSeen: false,
  prefsUpdatedAt: "",
    lastVerifyDay: "",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("配置检查", () => {
  it("关闭模式不往下走，并给出人话", () => {
    expect(() => aiConfigOrThrow(settings({ aiMode: "off" }))).toThrow(AiUnavailableError);
  });

  it("内置模型模式不给本地配置（它走服务端，不需要本地 Key）", () => {
    expect(() => aiConfigOrThrow(settings({ aiMode: "hosted" }))).toThrow(/内置模型/);
  });

  it("内置模型没登录时给出能照做的提示，而不是报错堆栈", async () => {
    // 提示必须指向**插件内的登录入口**（个人中心），不是网页、也不是"连接账号"
    await expect(
      verifyImitation({ ja: "a", zh: "", text: "b" }, settings({ aiMode: "hosted", authToken: "" })),
    ).rejects.toThrow(/个人中心/);
  });

  it("没保存过（无快照）不放行 —— 草稿填得再全也只是草稿", () => {
    expect(() =>
      aiConfigOrThrow(
        settings({ byokSaved: null, byok: { baseUrl: "https://x/v1", apiKey: "k", model: "m" } }),
      ),
    ).toThrow(AiUnavailableError);
  });

  it("快照缺项同样不放行（防御：resolveAiRoute 应该已经拦住，这里兜底）", () => {
    expect(() =>
      aiConfigOrThrow(settings({ byokSaved: { baseUrl: "", apiKey: "k", model: "m" } })),
    ).toThrow(AiUnavailableError);
    expect(() =>
      aiConfigOrThrow(settings({ byokSaved: { baseUrl: "https://x/v1", apiKey: " ", model: "m" } })),
    ).toThrow(AiUnavailableError);
  });

  it("生效的是**快照**，不是草稿：编辑中的改动不影响实际调用", () => {
    const config = aiConfigOrThrow(
      settings({
        byok: { baseUrl: "https://draft.example.com/v1", apiKey: "sk-draft", model: "draft-model" },
        byokSaved: { baseUrl: "https://saved.example.com/v1", apiKey: "sk-saved", model: "saved-model" },
        byokLocked: false,
      }),
    );
    expect(config.baseUrl).toBe("https://saved.example.com/v1");
    expect(config.apiKey).toBe("sk-saved");
    expect(config.model).toBe("saved-model");
  });

  it("顺手把地址尾部的斜杠去掉，免得拼出 //chat/completions", () => {
    expect(
      aiConfigOrThrow(
        settings({ byokSaved: { baseUrl: "https://example.com/v1/", apiKey: "sk-test", model: "qwen-plus" } }),
      ).baseUrl,
    ).toBe("https://example.com/v1");
  });
});

describe("模型输出的解析", () => {
  it("裸 JSON、围栏 JSON、前后带话的 JSON 都能抠出来", () => {
    expect(parseJsonLoose<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose<{ a: number }>('好的，结果如下：{"a":1} 以上。')).toEqual({ a: 1 });
  });

  it("解析不出来返回 null（调用方据此判「失败」，而不是当成通过）", () => {
    expect(parseJsonLoose("我看不懂这个问题")).toBeNull();
    expect(parseJsonLoose("")).toBeNull();
    expect(parseJsonLoose("[1,2,3]")).toBeNull();
  });

  it("流式丢尾巴（缺最后的 }）能保守补回来 —— 2026-10-10 BYOK 实机复踩", () => {
    // 真实坏串的形状：所有 JSON 字符串都已闭合、最内层 } 也在，只缺最外层 ——
    // DeepSeek 流式偶发少发最后一个 `}`（见服务端 llm.py 同名逻辑，两边同口径）
    const bad = '{"translation":"不弹了","sections":{"words":"やる：做","grammar":"って言った：说了不"}';
    expect(parseJsonLoose<{ translation: string }>(bad + "}")?.translation).toBe("不弹了");
    expect(parseJsonLoose<{ translation: string }>(bad)?.translation).toBe("不弹了");
    // 内层也缺一个：一次最多补 4 个收尾符
    expect(parseJsonLoose<{ a: { b: string } }>('{"a":{"b":"词"}')).toEqual({ a: { b: "词" } });
  });

  it("「不该补」的情形绝不硬补（硬补 = 把半句话当完整结果缓存）", () => {
    // 截在字符串中间：像 max_tokens 截断，补了也是假完整
    expect(parseJsonLoose('{"translation":"今天天')).toBeNull();
    // 括号不配对（`}` 后面又冒出 `]`）：截取/补尾都救不回，不猜
    expect(parseJsonLoose('{"a":"x"}]}')).toBeNull();
    // 结尾是逗号/冒号：话还没说完，不是尾巴掉了
    expect(parseJsonLoose('{"a":1,')).toBeNull();
    expect(parseJsonLoose('{"a":')).toBeNull();
  });
});

describe("仿写核对", () => {
  it("提示词把「内容可以不同」写清楚，并给出原句", () => {
    const messages = buildImitationMessages({ ja: "明日また会おう", zh: "明天再见吧", text: "今日は行かない" });
    expect(messages[0].content).toContain("内容不同");
    expect(messages[1].content).toContain("明日また会おう");
    expect(messages[1].content).toContain("今日は行かない");
  });

  it("提示词给 suggestion 立了形状：只在确实更自然时给、一句完整日语、配一句区别说明", () => {
    // 这三条是 2026-10-09 改口径的核心 —— 丢了任何一条，界面又会冒出
    // 「更自然的说法：更自然的说法可以是「…」」这种叠出来的怪话。
    expect(IMITATION_SYSTEM).toContain("suggestion_note");
    expect(IMITATION_SYSTEM).toContain("只在这句确实还能说得更自然时");
    expect(IMITATION_SYSTEM).toContain("一句完整的日语");
    expect(IMITATION_SYSTEM).toContain("只改表达方式，不改意思");
    // 值里不许模型自己写引导语（标签由界面加）
    expect(IMITATION_SYSTEM).toContain("不要在前面写「更自然的说法」这类引导语");
  });

  it("正常返回时透传判定（含建议句与它的区别说明）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  '{"correct":true,"reason":"句式一致","suggestion":"今日は行かないんだ。","suggestion_note":"把「行く」换成「行かないんだ」，口语更自然"}',
              },
            },
          ],
        }),
      })),
    );
    const verdict = await verifyImitation({ ja: "a", zh: "", text: "b" }, settings());
    expect(verdict.correct).toBe(true);
    expect(verdict.reason).toBe("句式一致");
    expect(verdict.suggestion).toBe("今日は行かないんだ。");
    expect(verdict.suggestionNote).toContain("口语更自然");
  });

  it("extractVerdictFields：suggestion 与 suggestion_note 分开抽，互不串味", () => {
    const partial = extractVerdictFields('{"reason":"还行","suggestion":"今日は行かない","suggestion_note":"少了终助词');
    expect(partial.suggestion).toBe("今日は行かない");
    // 值还在写：抽到多少算多少，别把它当成 suggestion
    expect(partial.suggestionNote).toBe("少了终助词");
    const full = extractVerdictFields(
      '{"correct":false,"reason":"助词用错","suggestion":"","suggestion_note":"","translation":"我不去"}',
    );
    expect(full.correct).toBe(false);
    expect(full.suggestion).toBe("");
    expect(full.suggestionNote).toBe("");
  });

  it("模型回了非 JSON → 判为未通过（绝不能放水）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "这句没问题" } }] }) })),
    );
    const verdict = await verifyImitation({ ja: "a", zh: "", text: "b" }, settings());
    expect(verdict.correct).toBe(false);
    expect(verdict.reason).toContain("再试");
  });

  it("接口报错时抛 AiUnavailableError，并带上状态码", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, text: async () => "invalid api key" })));
    await expect(verifyImitation({ ja: "a", zh: "", text: "b" }, settings())).rejects.toThrow(
      AiUnavailableError,
    );
  });
});

/**
 * 整句解析（= 用户看到的「释义」）：**两次请求** —— 先解读（两段），再逐词释义。
 *
 * 三条产品口径必须落在这里，不能只写在提示词里：
 *   · 解读 —— 分两段（核心单词 / 核心语法，语法块附一个例句），
 *     **不逐词罗列、不罗列语法大全**；单词只讲词义，语法归「核心语法」
 *   · 单词 —— **每个词都要给释义与读音**（漏词用户一眼就看得出来）
 *   · 词源 —— **只有英语外来语**才有，别的语种不许编
 * 提示词说了不算：出口再做长度硬截，防止模型跑题长篇大论。
 */
describe("整句解析", () => {
  it("解读提示词写明两段，并说清「不用讲全」「单词只讲词义」「语法举一个例子」", () => {
    expect(ANALYZE_SYSTEM).toContain("sections");
    expect(ANALYZE_SYSTEM).toContain("核心单词");
    expect(ANALYZE_SYSTEM).toContain("核心语法");
    expect(ANALYZE_SYSTEM).toContain("不用把每个词都讲一遍");
    // 2026-10-09 用户拍板：去掉「使用场景」这一段，示例并进「核心语法」
    expect(ANALYZE_SYSTEM).not.toContain("使用场景");
    expect(ANALYZE_SYSTEM).not.toContain("scenes");
    // 2026-10-08 用户拍板：去掉「口语与书面语」这一段
    expect(ANALYZE_SYSTEM).not.toContain("口语与书面语");
    expect(ANALYZE_SYSTEM).not.toContain("spoken");
    // 核心单词只讲词义，语法归「核心语法」那一块
    expect(ANALYZE_SYSTEM).toContain("不要讲语法");
    // 语法块里举一个自造的日语例句演示用法
    expect(ANALYZE_SYSTEM).toContain("举一个例子");
    expect(ANALYZE_SYSTEM).toContain("日语例句");
  });

  it("逐词提示词写明「一个词都不能漏」与「只给英语外来语词源」", () => {
    expect(ANALYZE_WORDS_SYSTEM).toContain("一个词都不能漏");
    expect(ANALYZE_WORDS_SYSTEM).toContain("origin");
    // 「只给英语」这条是最容易走样的：模型很爱顺手给德语/法语来源
    expect(ANALYZE_WORDS_SYSTEM).toContain("英语");
    expect(ANALYZE_WORDS_SYSTEM).toContain("一律不给 origin");
  });

  it("解读每段的上限是 300 字，和服务端同一个数", () => {
    expect(MAX_SECTION).toBe(300);
  });

  it("语境与分词参考原样带进去；两块解析用同一份 user 消息", () => {
    const input = { ja: "睦が来た", zh: "睦来了", words: ["睦", "が", "来", "た"] };
    const messages = buildExplainMessages(input);
    expect(messages[1].content).toContain("睦、が、来、た");
    expect(messages[1].content).toContain("睦が来た");
    expect(messages[0].content).toBe(ANALYZE_SYSTEM);
    expect(buildWordsMessages(input)[0].content).toBe(ANALYZE_WORDS_SYSTEM);
    expect(buildWordsMessages(input)[1].content).toBe(messages[1].content);
  });

  it("模型给的段超长时截断；没给的段补空串，旧口径的段一律丢掉", async () => {
    const long = "解".repeat(MAX_SECTION + 50);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  translation: "睦来了",
                  sections: { words: long, grammar: "「〜が」提示主语", spoken: "口语里常省略助词" },
                }),
              },
            },
          ],
        }),
      })),
    );

    const result = await explainSentence({ ja: "睦が来た", zh: "", words: ["睦"] }, settings());
    expect(result?.translation).toBe("睦来了");
    expect(result?.sections.words).toHaveLength(MAX_SECTION);
    expect(result?.sections.grammar).toBe("「〜が」提示主语");
    // 旧口径的段一律丢掉：2026-10-08 起没有 spoken、2026-10-09 起没有 scenes
    const extras = (result?.sections ?? {}) as unknown as Record<string, unknown>;
    expect(extras.spoken).toBeUndefined();
    expect(extras.scenes).toBeUndefined();
  });

  it("逐词释义：没有词形的条目丢掉，词源缺省是空串", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  words: [
                    { surface: "ビデオ", reading: "びでお", meaning: "录像", origin: "video" },
                    { reading: "あ", meaning: "没有词形" },
                  ],
                }),
              },
            },
          ],
        }),
      })),
    );

    const words = await explainWords({ ja: "ビデオを見る", zh: "", words: ["ビデオ"] }, settings());
    expect(words).toEqual([{ surface: "ビデオ", reading: "びでお", meaning: "录像", origin: "video" }]);
  });

  it("逐词释义**开思考**；解读默认（首次解析）不开（2026-10-10 方案 B）", async () => {
    // 逐词释义要为**本句**给读音，专有名词/作品名的整体读法只能靠世界知识：
    // 关思考时模型只会照抄分词参考（『春日影』→ かすがかげ，实测 3/3 全错），
    // 开思考才给得出 はるひかげ（3/3 全对）。**首次解析**的解读仍关着 —— 它是给
    // 用户读的正文，reasoning 阶段不吐字，白让用户对着空卡片干等（「重新解析」
    // 那一次是例外，见下面 `重新解析走 BYOK` 那条）。
    // 「开」的判据 = **两个关思考的开关一个都不传**（传了 thinking:disabled 就等于没开）。
    const bodyOf = (mock: { mock: { calls: unknown[] } }): Record<string, unknown> => {
      const [, init] = mock.mock.calls[0] as unknown as [string, { body: string }];
      return JSON.parse(init.body) as Record<string, unknown>;
    };

    const wordsMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"words":[]}' } }] }),
    }));
    vi.stubGlobal("fetch", wordsMock);
    await explainWords({ ja: "春日影いい曲だったから", zh: "", words: ["春日影"] }, settings());
    const wordsBody = bodyOf(wordsMock);
    expect(wordsBody.enable_thinking).toBeUndefined();
    expect(wordsBody.thinking).toBeUndefined();

    const explainMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"translation":"t","sections":{}}' } }] }),
    }));
    vi.stubGlobal("fetch", explainMock);
    await explainSentence({ ja: "春日影いい曲だったから", zh: "", words: ["春日影"] }, settings());
    const explainBody = bodyOf(explainMock);
    expect(explainBody.enable_thinking).toBe(false);
    expect(explainBody.thinking).toEqual({ type: "disabled" });
  });

  it("拼给助手的纯文本按两段加小标题，空段不出", () => {
    const text = renderExplanation({ words: "「なんで」是质问", grammar: "「の」是领格" });
    expect(text).toBe("【核心单词】「なんで」是质问\n【核心语法】「の」是领格");
  });

  it("模型没给出可用结果时返回 null（调用方据此提示重试，不是弹一个空壳）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "好的" } }] }) })),
    );
    expect(await explainSentence({ ja: "a", zh: "", words: ["a"] }, settings())).toBeNull();
    expect(await explainWords({ ja: "a", zh: "", words: ["a"] }, settings())).toBeNull();
  });
});

/**
 * 解读的**真流式**：模型吐到哪儿，界面就显示到哪儿。
 *
 * 两块拼出来的东西各自都要钉死：
 *   · `extractStreamFields` —— 缓冲区里多数时刻是**非法 JSON**（字符串还没闭合），
 *     靠它把已经写出来的部分抽出来显示；抽错了只影响过程，结束时会以整份为准。
 *   · `explainSentenceStream` —— 两条链路（内置模型 SSE / BYOK 直连）都要边收边回调，
 *     并且分帧不能被"切在半截"搞坏。
 */
describe("解读的流式", () => {
  const FULL =
    '{"translation":"小祥哭了","sections":{"words":"「祥ちゃん」是昵称",' +
    '"grammar":"〜ていた 表过去进行","scenes":"用在讲述过去的事"}}';

  function encoder(): TextEncoder {
    return new TextEncoder();
  }

  /** 伪造一个带流式 body 的响应（只实现代码真用到的那几处）。 */
  function streamingResponse(chunks: string[], init: { ok?: boolean; status?: number } = {}) {
    const bytes = chunks.map((chunk) => encoder().encode(chunk));
    let at = 0;
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      body: {
        getReader: () => ({
          read: async () =>
            at < bytes.length ? { done: false, value: bytes[at++] } : { done: true, value: undefined },
        }),
      },
    };
  }

  const explainInput = { ja: "祥ちゃん 泣いてた", zh: "小祥哭了", words: ["祥", "ちゃん"] };

  it("半截 JSON 也能把已经写出来的字段抽出来", () => {
    // 字符串还没闭合：值就是当前进度
    expect(extractStreamFields('{"translation":"小祥').translation).toBe("小祥");
    // 值写完了：照常拿到整段
    expect(extractStreamFields('{"translation":"小祥哭了","sections":{"wo').translation).toBe("小祥哭了");
    // 分节里的部分内容
    const partial = extractStreamFields(
      '{"translation":"小祥哭了","sections":{"words":"「祥ちゃん」是昵',
    );
    expect(partial.sections.words).toBe("「祥ちゃん」是昵");
    expect(partial.sections.grammar).toBeUndefined();
    // 围栏 + 转义都处理得对
    const fenced = extractStreamFields('```json\n{"translation":"他说\\"再见\\""}\n```');
    expect(fenced.translation).toBe('他说"再见"');
    // 半截转义不吐（等下一片补齐，否则会闪出一个孤立的反斜杠）
    expect(extractStreamFields('{"translation":"他说\\').translation).toBe("他说");
  });

  it("内置模型：逐帧回调 + 结束时以整份为准（增量拼接不漏字）", () => {
    const frames = [
      'data: {"type":"start"}\n\n',
      `data: ${JSON.stringify({ type: "delta", text: FULL.slice(0, 40) })}\n\n`,
      `data: ${JSON.stringify({ type: "delta", text: FULL.slice(40, 90) })}\n\n`,
      `data: ${JSON.stringify({ type: "delta", text: FULL.slice(90) })}\n\n`,
      `data: ${JSON.stringify({
        type: "done",
        data: { translation: "小祥哭了", sections: { words: "「祥ちゃん」是昵称", grammar: "〜ていた 表过去进行", scenes: "用在讲述过去的事" }, billing: { charged_millis: 3 } },
      })}\n\n`,
    ];
    vi.stubGlobal("fetch", vi.fn(async () => streamingResponse(frames)));

    const seen: string[] = [];
    return explainSentenceStream(
      explainInput,
      settings({ aiMode: "hosted", authToken: "t" }),
      (fields) => seen.push(fields.translation || Object.keys(fields.sections).join(",")),
    ).then((result) => {
      expect(seen.length).toBeGreaterThan(1); // 边收边回调，不是攒完一次性给
      expect(result.explanation?.translation).toBe("小祥哭了");
      expect(result.explanation?.sections.grammar).toBe("〜ていた 表过去进行");
      expect(result.billing?.charged_millis).toBe(3);
    });
  });

  it("一帧被切成两片也能拼回来（分帧不能靠「恰好对齐」）", () => {
    const frame = `data: ${JSON.stringify({ type: "delta", text: FULL })}\n\n` +
      `data: ${JSON.stringify({ type: "done", data: { translation: "小祥哭了", sections: { words: "w" } } })}\n\n`;
    const cut = Math.floor(frame.length / 2);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamingResponse([frame.slice(0, cut), frame.slice(cut)])),
    );

    const seen: string[] = [];
    return explainSentenceStream(
      explainInput,
      settings({ aiMode: "hosted", authToken: "t" }),
      (fields) => seen.push(fields.sections.words ?? ""),
    ).then((result) => {
      expect(seen[seen.length - 1]).toBe("「祥ちゃん」是昵称");
      expect(result.explanation?.translation).toBe("小祥哭了");
    });
  });

  it("流里报「没余额」：翻译成 need-balance（界面据此弹充值窗，不当普通报错）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamingResponse([
          `data: ${JSON.stringify({ type: "error", reason: "insufficient", message: "余额不够了" })}\n\n`,
        ]),
      ),
    );
    await expect(
      explainSentenceStream(explainInput, settings({ aiMode: "hosted", authToken: "t" }), () => {}),
    ).rejects.toMatchObject({ code: "need-balance" });
  });

  it("BYOK 直连：OpenAI 风格的分片照收，结束时解析出整份", () => {
    const chunk = (text: string) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamingResponse([
          chunk(FULL.slice(0, 50)),
          chunk(FULL.slice(50)),
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
          "data: [DONE]\n\n",
        ]),
      ),
    );

    const seen: string[] = [];
    return explainSentenceStream(explainInput, settings(), (fields) =>
      seen.push(fields.sections.words ?? ""),
    ).then((result) => {
      expect(seen.length).toBeGreaterThan(0);
      expect(result.explanation?.translation).toBe("小祥哭了");
      expect(result.billing).toBeNull(); // BYOK 永不扣费
    });
  });

  /** 伪造一个**非流式**的成功响应 —— 服务端命中解析缓存时走的就是这条。
   *  带 body 是故意的：真实响应本来就有 body，不给的话"读不出帧"这个失败形态
   *  会被一个假的 `if (!body) throw` 抢先，就验不到真问题了。 */
  function jsonResponse(body: unknown) {
    const text = JSON.stringify(body);
    return {
      ...streamingResponse([text]),
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => text,
    };
  }

  it("命中服务端缓存（服务端回的是普通 JSON 而不是 SSE）也要拿到解读", () => {
    // 🔥 服务端命中 `AnalysisCache` 时**刻意不流式**：那份结果本来就在手上，整份给才是
    // "点开就有"（见 core/learning/ai_api.py 的缓存分支）。它不是 SSE —— 照流逐帧读会
    // **一帧都读不到**，界面只能报"AI 这次没给回可用的结果"；而且因为命中缓存，
    // 每次「重新解析」都撞同一条路，看着就是"按钮坏了"（2026-10-08 实机踩到）。
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          code: 0,
          message: "success",
          data: {
            translation: "小祥哭了",
            sections: {
              words: "「祥ちゃん」是昵称",
              grammar: "〜ていた 表过去进行",
              scenes: "用在讲述过去的事",
            },
            part: "explain",
            from_cache: true,
            billing: { scene: "analyze", model: "m", charged_millis: 3, balance_millis: 100 },
          },
        }),
      ),
    );

    return explainSentenceStream(
      explainInput,
      settings({ aiMode: "hosted", authToken: "t" }),
      () => {},
    ).then((result) => {
      expect(result.explanation?.translation).toBe("小祥哭了");
      expect(result.explanation?.sections.words).toBe("「祥ちゃん」是昵称");
      // 命中缓存**照常扣费**（扣费不传导缓存折扣）：金额必须照样落到界面上
      expect(result.billing?.charged_millis).toBe(3);
    });
  });

  it("流式请求也带 stream:true（服务端据此切 SSE）", async () => {
    const fetchMock = vi.fn(async () =>
      streamingResponse([
        `data: ${JSON.stringify({ type: "done", data: { translation: "t", sections: {} } })}\n\n`,
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    await explainSentenceStream(explainInput, settings({ aiMode: "hosted", authToken: "t" }), () => {});
    // mock 是零参声明的，calls[0] 的元组类型是 []，得先整体转掉再取第二项
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.stream).toBe(true);
    expect(body.part).toBe("explain");
  });

  // ── 「重新解析」的 refresh（2026-10-08）──────────────────────────────────
  //
  // 用户点「重新解析」的前提就是"我不满意当前这条"。服务端若无条件回解析缓存，
  // 这个按钮就是按一次返回同一份 —— 看着像坏了，其实是这个开关压根没传过去。
  // 传的**地方有三处**（流式请求、非流式退路、以及别把 BYOK 也带上），一处处钉。

  function readBody(fetchMock: { mock: { calls: unknown[] } }): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    return JSON.parse(init.body) as Record<string, unknown>;
  }

  it("重新解析：流式请求带 refresh:true（服务端据此跳过缓存读数、重算）", async () => {
    const fetchMock = vi.fn(async () =>
      streamingResponse([
        `data: ${JSON.stringify({ type: "done", data: { translation: "重讲一遍", sections: {} } })}\n\n`,
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    await explainSentenceStream(
      explainInput,
      settings({ aiMode: "hosted", authToken: "t" }),
      () => {},
      undefined,
      { refresh: true },
    );
    expect(readBody(fetchMock).refresh).toBe(true);
  });

  it("不带 refresh 的普通解析：请求体里没有这个键（默认行为不能看起来像重新解析）", async () => {
    const fetchMock = vi.fn(async () =>
      streamingResponse([
        `data: ${JSON.stringify({ type: "done", data: { translation: "t", sections: {} } })}\n\n`,
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    await explainSentenceStream(explainInput, settings({ aiMode: "hosted", authToken: "t" }), () => {});
    expect("refresh" in readBody(fetchMock)).toBe(false);
  });

  it("非流式那条路（流式坏了之后的退路）也要带 refresh", async () => {
    // 🔥 漏传这一处 = "流式一坏，重新解析又回去读缓存"。同一个 bug 换了触发条件，
    //    而且完全静默 —— 所以它不是"另一条路顺便也改一下"，是这条修复的一半。
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        code: 0,
        message: "success",
        data: {
          translation: "重讲一遍",
          sections: { words: "w", grammar: "g", scenes: "s" },
          part: "explain",
          from_cache: false,
          billing: null,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await explainSentence(
      explainInput,
      settings({ aiMode: "hosted", authToken: "t" }),
      { refresh: true },
    );
    expect(result?.translation).toBe("重讲一遍");
    expect(readBody(fetchMock).refresh).toBe(true);
  });

  it("带了 refresh 却拿到缓存：必须出声（这条链路不报错，只有日志看得出开关没生效）", async () => {
    // 开关没被认（老服务端 / 中间层吃掉）时，拿回来的是一份**合法**解读 —— 不抛错、
    // 界面也照常显示，表现恰好就是"点了重新解析，内容一模一样"。没有这条日志，
    // 下次再遇到只能从"缓存是不是又命中了"从头查一遍。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          code: 0,
          message: "success",
          data: { translation: "旧的", sections: {}, from_cache: true, billing: null },
        }),
      ),
    );
    await explainSentenceStream(
      explainInput,
      settings({ aiMode: "hosted", authToken: "t" }),
      () => {},
      undefined,
      { refresh: true },
    );
    expect(warn.mock.calls.some(([first]) => String(first).includes("refresh"))).toBe(true);
    warn.mockRestore();
  });

  it("不带 refresh 时命中缓存是正常的，不该跟着报一条", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          code: 0,
          message: "success",
          data: { translation: "旧的", sections: {}, from_cache: true, billing: null },
        }),
      ),
    );
    await explainSentenceStream(explainInput, settings({ aiMode: "hosted", authToken: "t" }), () => {});
    expect(
      warn.mock.calls.some(([first]) => String(first).includes("refresh")),
    ).toBe(false);
    warn.mockRestore();
  });

  it("BYOK 没有服务端缓存：refresh 不该被塞进直连请求体（它另有用途，见下一条）", async () => {
    const fetchMock = vi.fn(async () =>
      streamingResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: FULL } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    await explainSentenceStream(explainInput, settings(), () => {}, undefined, { refresh: true });
    expect(readBody(fetchMock).refresh).toBeUndefined();
  });

  it("重新解析在 BYOK 上 = 开思考：两个关思考的开关都不写（流式与非流式退路各钉一处）", async () => {
    // 「重新解析」这一次开思考（2026-10-10 用户拍板）：用户点它的前提就是"不满意
    // 上一版"，值得多花几秒让模型先想。BYOK 没有服务端缓存，所以 refresh 不进请求体，
    // 只用来决定"写不写在关思考的开关"—— 与服务端 `thinking=(part == PART_WORDS or refresh)`
    // 同一条口径。首次解析仍关：上面那条已经钉住了默认方向。
    const streamMock = vi.fn(async () =>
      streamingResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: FULL } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]),
    );
    vi.stubGlobal("fetch", streamMock);
    await explainSentenceStream(explainInput, settings(), () => {}, undefined, { refresh: true });
    const streamBody = readBody(streamMock);
    expect(streamBody.enable_thinking).toBeUndefined();
    expect(streamBody.thinking).toBeUndefined();

    // 非流式退路（流式坏了才走那条）：漏传等于"流式一坏，重新解析又变回不开思考"
    const jsonMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"translation":"重讲一遍","sections":{}}' } }],
      }),
    }));
    vi.stubGlobal("fetch", jsonMock);
    await explainSentence(explainInput, settings(), { refresh: true });
    const jsonBody = readBody(jsonMock);
    expect(jsonBody.enable_thinking).toBeUndefined();
    expect(jsonBody.thinking).toBeUndefined();
  });

  it("只刷词表：逐词释义那条请求也要带 refresh（服务端按块跳缓存，解读那份不受影响）", async () => {
    // 2026-10-15「两块可选重解析」新增的一条路。与服务端 `analysis_cache.lookup(ja, part, …)`
    // 对齐：part=words 时跳过的只有词表那一行 —— 所以这里**只刷词表**不会连解读一起重算。
    // 漏传 = 用户勾「逐词释义」点确认，拿回来的还是旧词表，按一次没反应。
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        code: 0,
        message: "success",
        data: { words: [{ surface: "ビデオ", reading: "びでお", meaning: "录像" }], part: "words", billing: null },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await explainWords(
      { ja: "ビデオを見る", zh: "", words: ["ビデオ"] },
      settings({ aiMode: "hosted", authToken: "t" }),
      { refresh: true },
    );
    const body = readBody(fetchMock);
    expect(body.refresh).toBe(true);
    expect(body.part).toBe("words");
  });

  it("首次解析的逐词释义不带 refresh：请求体里没这个键", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        code: 0,
        message: "success",
        data: { words: [], part: "words", billing: null },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await explainWords(
      { ja: "ビデオを見る", zh: "", words: ["ビデオ"] },
      settings({ aiMode: "hosted", authToken: "t" }),
    );
    expect("refresh" in readBody(fetchMock)).toBe(false);
  });
});

/**
 * 句子追问：真**多轮 messages**（[system, 语境段, 历史轮..., 当前问题]）。
 *
 * 两条口径必须钉死：
 *   · 语境段在同一句子的会话里逐字不变、历史轮原样回放 —— 第 N 轮与第 N−1 轮
 *     共享整段前缀，DeepSeek 前缀缓存才逐轮命中（拍平成一条 user 消息就废了）；
 *   · 与服务端 `build_ask_messages` 逐字对齐（BYOK/hosted 口径一致）。
 */
describe("句子追问", () => {
  const base = { ja: "明日また会おう", zh: "明天再见" };
  const q1 = "また是什么意思？";
  const a1 = "「また」表示「再次」。";
  const q2 = "那まだ呢？";

  it("无历史：[system, 语境段, 当前问题]，语境段不含问题", () => {
    const messages = buildAskMessages({
      ...base,
      question: q1,
      history: [{ role: "user", content: q1 }],
      analysis: { words: [{ surface: "また", meaning: "再次" }], explanation: "「また」表再次。" },
    });
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect(messages[0].content).toBe(ASK_SYSTEM);
    expect(messages[1].content).toContain("【原句】明日また会おう");
    expect(messages[1].content).toContain("【已经讲给学生的词】また（再次）");
    expect(messages[1].content).toContain("【这一句的解读】「また」表再次。");
    expect(messages[1].content).not.toContain(q1);
    expect(messages[2]).toEqual({ role: "user", content: `【学生的问题】${q1}` });
  });

  it("多轮前缀链：第 2 轮 = 第 1 轮整段 + 新的一问一答（逐字相同，缓存才命中）", () => {
    const first = buildAskMessages({
      ...base,
      question: q1,
      history: [{ role: "user", content: q1 }],
    });
    const second = buildAskMessages({
      ...base,
      question: q2,
      history: [
        { role: "user", content: q1 },
        { role: "assistant", content: a1 },
        { role: "user", content: q2 },
      ],
    });
    expect(second).toEqual([
      ...first,
      { role: "assistant", content: a1 },
      { role: "user", content: `【学生的问题】${q2}` },
    ]);
    // 当前问题只出现一次：history 末尾那条被去重，没有重复追加
    expect(second.filter((m) => m.content === `【学生的问题】${q2}`)).toHaveLength(1);
  });

  it("history 末尾没带当前问题时补一条收口（老客户端兜底）", () => {
    const messages = buildAskMessages({
      ...base,
      question: "还会再见吗？",
      history: [
        { role: "user", content: q1 },
        { role: "assistant", content: a1 },
      ],
    });
    expect(messages[messages.length - 1]).toEqual({ role: "user", content: "【学生的问题】还会再见吗？" });
  });

  it("历史内容截 300 字；user 轮统一用【学生的问题】包裹（发送与回放同形）", () => {
    const long = "あ".repeat(400);
    const messages = buildAskMessages({
      ...base,
      question: "短问题",
      history: [
        { role: "user", content: long },
        { role: "assistant", content: long },
      ],
    });
    expect(messages[2].content).toBe(`【学生的问题】${"あ".repeat(300)}`);
    expect(messages[3].content).toBe("あ".repeat(300));
  });
});

/**
 * 首输出预算（2026-10-15 用户拍板）。
 *
 * 规矩只有一条：**无论发生什么情况，20 秒内没有思考（思考模式）或没有输出
 * （非思考模式），就必须有报错** —— 用户不能对着"解析中…"无限等。这里盯着
 * 看门狗这只手，StudyView 那一侧的接线由 studyAiGate.test.ts 盯。
 *
 * 用例都等"真到点"（await abort 事件 / 远超窗口的等待），不靠 `sleep(精确毫秒)`
 * 去赌机器负载。
 */
describe("首输出看门狗", () => {
  /** 等一段"足够长"的真实时间（比窗口宽得多，避免在慢机器上抖）。 */
  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(() => {
    // 插件跑在 Obsidian（有 window），单测跑在 node（没有）。看门狗只用得上计时器，
    // 给它一个最小 window 就够 —— 生产代码里写 `window.` 是仓库一贯的写法，不为此改。
    vi.stubGlobal("window", { setTimeout, clearTimeout });
  });

  it("窗口内一个字都没来：掐断请求，且认出这是预算耗尽（不是用户自己掐的）", async () => {
    const outer = new AbortController();
    const watchdog = watchFirstOutput(outer.signal, 30);
    const aborted = new Promise<void>((resolve) => {
      watchdog.signal.addEventListener("abort", () => resolve());
    });
    expect(watchdog.timedOut()).toBe(false); // 刚发出去：还在窗口内
    await aborted; // 只有真到点才会走到这儿
    expect(watchdog.timedOut()).toBe(true);
    // 外部 signal 一根汗毛没动 —— 调用方靠这个把"超时"与"翻页/关面板"分开
    expect(outer.signal.aborted).toBe(false);
    watchdog.stop();
  });

  it("有输出就重新计时：模型一直在写，就一直等（不按「开始写」那一刻算总账）", async () => {
    const watchdog = watchFirstOutput(undefined, 200);
    let fired = false;
    void new Promise<void>((resolve) => {
      watchdog.signal.addEventListener("abort", () => resolve());
    }).then(() => {
      fired = true;
    });
    // 每 20ms 来一段输出：连着 5 次，早就超过 200ms 的窗口了，却一次都不该响
    for (let i = 0; i < 5; i++) {
      await settle(20);
      watchdog.touch();
    }
    expect(fired).toBe(false);
    expect(watchdog.timedOut()).toBe(false);
    // 停手（模型不再吐字）：这之后才允许到点
    await settle(400);
    expect(fired).toBe(true);
    expect(watchdog.timedOut()).toBe(true);
    watchdog.stop();
  });

  it("用户自己掐（翻页 / 关面板）：跟着外部 signal 一起断，但不算超时", () => {
    const outer = new AbortController();
    const watchdog = watchFirstOutput(outer.signal, 10_000);
    outer.abort();
    expect(watchdog.signal.aborted).toBe(true);
    // 关键：沉默收场（调用方按"自己掐的"处置），别给已经翻走的人摆超时提示
    expect(watchdog.timedOut()).toBe(false);
    watchdog.stop();
  });

  it("stop 之后计时器不再响（请求已经收尾了）", async () => {
    const watchdog = watchFirstOutput(undefined, 20);
    watchdog.stop();
    await settle(80);
    expect(watchdog.timedOut()).toBe(false);
    expect(watchdog.signal.aborted).toBe(false);
  });
});

/**
 * 上游（AI 供应商）自己报的错：带 `upstream` 码 → 调用方**不再重试**。
 *
 * 502/503 那种是供应商那一趟没成，同一条链路再撞一次只是一样的结果：白花一笔
 * 钱、还多等一轮。用户要的"立即报错、别等 20 秒"就是这条。
 */
describe("上游错误码", () => {
  const input = { ja: "祥ちゃん 泣いてた", zh: "小祥哭了", words: [] };

  it("5xx（502/503）带 upstream 码", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, text: async () => "Service Unavailable" })),
    );
    for (const call of [explainSentence, explainWords]) {
      const error = await call(input, settings()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AiUnavailableError);
      expect((error as AiUnavailableError).code).toBe("upstream");
      expect(isUpstreamError(error)).toBe(true);
    }
  });

  it("4xx 不带 upstream 码：该重试的重试、该分流的照旧", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, text: async () => "bad request" })),
    );
    const error = await explainSentence(input, settings()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiUnavailableError);
    expect((error as AiUnavailableError).code).toBeUndefined();
    expect(isUpstreamError(error)).toBe(false);
  });

  it("isUpstreamError 只认 upstream：没余额是另一条路（弹充值窗，不是重试）", () => {
    expect(isUpstreamError(new AiUnavailableError("x", "upstream"))).toBe(true);
    expect(isUpstreamError(new AiUnavailableError("x", "need-balance"))).toBe(false);
    expect(isUpstreamError(new Error("x"))).toBe(false);
  });

  it("SSE 的 error 帧：upstream 带码（不许重试），busy 这类不带码（允许在剩下预算里重试）", async () => {
    // 🔥 不能"只要不是 insufficient 就一律当上游" —— 那样 busy（并发锁）这类
    //    抖一下的错也被判成不许重试，正好违反"其他原因允许重试"。
    const frame = (reason: string): string =>
      `data: ${JSON.stringify({ type: "error", reason, message: "这次不行" })}\n\n`;
    /** 只实现代码真用到的那一处：一个能读出这一帧的 body。 */
    const oneFrame = (chunk: string) => {
      const bytes = new TextEncoder().encode(chunk);
      let sent = false;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () =>
              sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes }),
          }),
        },
      };
    };
    const run = async (reason: string): Promise<unknown> => {
      vi.stubGlobal("fetch", vi.fn(async () => oneFrame(frame(reason))));
      return explainSentenceStream(
        { ja: "祥ちゃん 泣いてた", zh: "小祥哭了", words: [] },
        settings({ aiMode: "hosted", authToken: "t" }),
        () => {},
      ).catch((error: unknown) => error);
    };

    const upstream = await run("upstream");
    expect((upstream as AiUnavailableError).code).toBe("upstream");
    expect(isUpstreamError(upstream)).toBe(true);

    const busy = await run("busy");
    expect(busy).toBeInstanceOf(AiUnavailableError);
    expect((busy as AiUnavailableError).code).toBeUndefined();
    expect(isUpstreamError(busy)).toBe(false);
  });
});

/**
 * 「没人说话」的文案（2026-10-15 实机报的）。
 *
 * 内置模型下上游是我们的供应商，20 秒没吐字就**是它挂了** —— 要直说"上游服务
 * 暂时不可用"，写成"太慢"用户会以为再等等就快了，接着干等下去。
 * 自定义模型那条路上游是用户自己配的端点，照"太慢"说才准确。
 */
describe("没输出的文案按轨道分叉", () => {
  const HOSTED_TEXT = "内置模型上游服务暂时不可用。";
  const BYOK_TEXT = "模型这次响应太慢，稍后再试。";

  it("内置模型（用户选了谁就是谁，见 resolveAiRoute）", () => {
    expect(noOutputMessage(settings({ aiMode: "hosted" }))).toBe(HOSTED_TEXT);
  });

  it("自定义模型：说他自己的端点没响应", () => {
    const byok = settings({
      aiMode: "byok",
      byokSaved: { baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m" },
    });
    expect(noOutputMessage(byok)).toBe(BYOK_TEXT);
  });

  it("选了自定义模型但没配好（route = off）：也不能甩锅给内置模型的上游", () => {
    // 门控本来就会拦下这种配置，这条钉的是"兜底文案别串轨"
    expect(noOutputMessage(settings({ aiMode: "byok" }))).toBe(BYOK_TEXT);
  });
});
