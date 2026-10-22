/**
 * AI 调用层：BYOK 直连 + 内置模型（走自家服务端扣余额）。
 *
 * 三种模式（见 settings/types.ts）：
 *  - `off`     不调 AI；调用方自己判断，别调到这里来；
 *  - `byok`    用用户自己的 Key 直连 OpenAI 兼容端点。**永不经过我们的服务器，永不扣费**；
 *  - `hosted`  调 younglook.cc 的 `/api/v1/ai/*`，按 token 扣余额。
 *              Key 只在服务端，插件这边从头到尾拿不到。
 *
 * 几条纪律：
 *  1. 用户自己的 Key 只存在本机 data.json，**不进日志、不进导出**；
 *  2. 模型输出必须当**不可信输入**解析：拿不到合法 JSON 就当作"判定失败"，
 *     不能因为解析不出就把用户的答案算对（仿写核对尤其如此）；
 *  3. 内置模型的提示词与服务端逐字对齐 —— BYOK 与内置模型的**判定口径必须一致**，
 *     否则用户会看到"用自己的 Key 判对、用内置模型判错"。唯一源头在
 *     `core/learning/services/hosted_prompts.py`，插件这份是构建时生成的
 *     （./prompts.gen.ts，由 scripts/sync-prompts.mjs 产出），不手抄。
 */

import { log } from "../../core/logger";
import type { PluginSettings } from "../../settings/types";
import {
  EMPTY_EXPLANATION_SECTIONS,
  EXPLANATION_SECTIONS,
  type ExplanationSections,
} from "../../types/entities";
import { hostedRequest, hostedStream, reportBilling, type HostedBilling } from "./hosted";
import { resolveAiRoute } from "./gate";
import { httpFetch } from "../http";
// 构建时从服务端 hosted_prompts.py 生成 —— 口径一致靠生成，别手改这份生成物
import { ANALYZE_SYSTEM, ANALYZE_WORDS_SYSTEM, ASK_SYSTEM, IMITATION_SYSTEM } from "./prompts.gen";

export { ANALYZE_SYSTEM, ANALYZE_WORDS_SYSTEM, ASK_SYSTEM, IMITATION_SYSTEM };

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type { HostedBilling };

/** AI 不可用（没配/配错/余额不足/服务端连不上）。消息直接给用户看，要写人话。 */
export class AiUnavailableError extends Error {
  /**
   * 机器可读的原因码（如 "need-balance"）。界面靠它把「没余额」从普通报错里
   * 挑出来单独走统一弹窗；给人看的话在 message，别拿 code 拼句子。
   */
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/**
 * 没余额（服务端 402）的机器判定。界面靠它把这种错单独分流到统一弹窗，
 * 不落行内提示（2026-10-04 用户拍板）。判定只认 code，别拿 message 文案比。
 */
export function isNoBalanceError(error: unknown): boolean {
  return error instanceof AiUnavailableError && error.code === "need-balance";
}

/**
 * 上游（AI 供应商）自己报的错（502/503、上游首输出超时）的机器判定。
 *
 * 界面靠它决定"这次该不该再试一次"：撞的是上游这堵墙，**重试一次只会再撞一次** ——
 * 如实报错收场，别让用户为同一堵墙多等一轮。
 */
export function isUpstreamError(error: unknown): boolean {
  return error instanceof AiUnavailableError && error.code === "upstream";
}

/**
 * SSE `type=error` 帧的 `reason` → 机器判定的错误码（服务端给的就是这几种）。
 *
 * 只有两种需要界面认出来：
 *   · `upstream` —— 含服务端自己判的"模型没给出可用的结果"：**供应商那一趟没成**，
 *     立即报错、不许重试（同一条链路再撞一次只是一样的结果，白花一笔钱、白等一轮）；
 *   · `insufficient` —— 没余额，走统一弹窗。
 * 其余（`busy` 并发锁、`rate_limited` 限流、`disabled` 开关关了、`pricing`/`config`）
 * 都不带码 —— 交给调用方在**剩下的**首输出预算里再试一次（2026-10-15 用户拍板：
 * 502/503 之外的错允许重试，只是总时长不许超过 20 秒）。
 */
function streamErrorCode(reason: string): string | undefined {
  if (reason === "insufficient") return "need-balance";
  if (reason === "upstream") return "upstream";
  return undefined;
}

/**
 * 一次 AI 动作的**首输出**预算（毫秒）。
 *
 * 思考模式等的是**思考块**、非思考模式等的是**正文** —— 两条口径都是"只要还有东西
 * 往回流就算活着"，与文件名同级的服务端 `utils/llm.py::_OutputWatchdog` 是同一套
 * 规矩（2026-10-15 用户拍板：无论发生什么情况，20 秒内没有思考/输出就必须有报错，
 * 不能让用户无限等待）。服务端那份管的是托管链路；这里这份管的是**插件直连 BYOK**
 * （没有服务端兜底）与**中间层把响应攒着不发**这两种情况。
 */
export const AI_FIRST_OUTPUT_MS = 20_000;

/**
 * 首输出预算耗尽时的用户文案，**按实际生效的轨道分叉**（2026-10-15 用户拍板）。
 *
 * 内置模型这条路上"没人说话"就是**我们的上游供应商挂了**（或它只发 keep-alive
 * 心跳、一个 chunk 都不吐 —— 2026-10-15 DeepSeek 过载的形态）：直说"上游服务暂时
 * 不可用"，别写成"太慢" —— 那听着像"再等等就快了"，用户会接着干等下去。
 * BYOK 那条路的"上游"是用户自己配的端点，照"太慢"说才准确。
 *
 * 判定用 `resolveAiRoute`（与按钮下面那句费用提示同一口径）：用户选内置模型时
 * 上游是我们的供应商，选自定义模型时上游是他自己配的端点。
 */
export function noOutputMessage(settings: PluginSettings): string {
  return resolveAiRoute(settings) === "hosted"
    ? "内置模型上游服务暂时不可用。"
    : "模型这次响应太慢，稍后再试。";
}

/**
 * 「首输出」看门狗：到点还没等到任何输出就中断这次请求。
 *
 * 三条用法缺一不可：
 *   · 把 `signal` 传给底层请求（`hostedStream` / `fetch` 都认它）；
 *   · **每收到一段有意义的输出**就 `touch()` 一次，计时归零重来 —— 这是"只要模型
 *     还在写就一直等"与"死等到底"的分别；
 *   · 收尾调 `stop()` 放掉计时器，别让它在已经结束的请求上再响一次。
 *
 * ⚠️ `timedOut()` 只在**这次请求被预算掐断**时为真。用户自己翻页 / 关面板走的是
 * 外部 signal（`outer`），那条路不算超时 —— 调用方照旧按"自己掐的"静默处置。
 */
export function watchFirstOutput(outer: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  let timer: number | null = null;
  const arm = (): void => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(0, timeoutMs));
  };
  const forward = (): void => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", forward, { once: true });
  }
  arm();
  return {
    signal: controller.signal,
    touch: (): void => {
      if (!timedOut) arm();
    },
    timedOut: (): boolean => timedOut,
    stop: (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      outer?.removeEventListener("abort", forward);
    },
  };
}

export function aiConfigOrThrow(settings: PluginSettings): AiConfig {
  const route = resolveAiRoute(settings);
  if (route === "off") {
    throw new AiUnavailableError("还没开启 AI。到个人中心「账户」页选一种方式就能用。");
  }
  if (route === "hosted") {
    throw new AiUnavailableError("现在是内置模型模式，不需要本地配置。");
  }
  // 走到这里 = route === "byok"：余额已经用完（≤ 0），这时才轮到自带 Key。
  // 读**已保存的快照**（byokSaved），不读草稿 —— 账户页上编辑中、未点「保存」
  // 的改动不该被实际调用用到（2026-10-10 拍板：生效的永远是快照）。
  // route === "byok" 蕴含快照必然存在且齐全（resolveAiRoute 已保证）。
  const { baseUrl, apiKey, model } = settings.byokSaved!;
  if (!apiKey.trim()) throw new AiUnavailableError("自定义模型的 Key 还没填，到个人中心「账户」页补上再试。");
  if (!baseUrl.trim() || !model.trim())
    throw new AiUnavailableError("自定义模型的接口地址或模型名还空着，到个人中心「账户」页补上。");
  return { baseUrl: baseUrl.replace(/\/+$/u, ""), apiKey: apiKey.trim(), model: model.trim() };
}

function requireHostedLogin(settings: PluginSettings): void {
  if (!settings.authToken.trim()) {
    throw new AiUnavailableError("用内置模型要先登录。登录或注册在个人中心里。");
  }
}

export interface ChatMessage {
  /** assistant 只在追问的多轮历史里出现（原样回放 AI 的上一轮回答） */
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * 给「只差收尾符号」的 JSON 补上缺失的 `}` / `]`；补不了返回 null。
 *
 * 🔥 与服务端 `core/utils/llm.py::_close_truncated_json` 是同一份逻辑的 TS 镜像
 * （2026-10-10 实机复踩：DeepSeek 流式偶发丢最后一个 `}`，托管链路修在服务端、
 * BYOK 插件直连模型，解析在本地 —— 两边都得有这份容错，改一处必须同步另一处）。
 *
 * 补法很保守，只处理「内容完整、只丢了尾巴」这一种：
 *   · 括号栈必须本来就配对（不配对 = 内容坏了，不猜）；
 *   · 不能截在字符串中间（那更像 max_tokens 截断，硬补会把半句话当完整内容）；
 *   · 结尾不能是 `,` / `:`（那是"话还没说完"，不是"尾巴掉了"）；
 *   · 最多补 4 个收尾符 —— 再多就不像"掉了个尾巴"，宁可不补。
 */
function closeTruncatedJson(text: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return null;
    }
  }
  if (inString || stack.length === 0 || stack.length > 4) return null;
  const lastChar = text.trimEnd().slice(-1);
  if (lastChar === "," || lastChar === ":") return null;
  const repaired = text + stack.reverse().join("");
  try {
    JSON.parse(repaired);
  } catch {
    return null;
  }
  return repaired;
}

/** 纯函数：从模型回复里抠 JSON **对象**。抠不出来返回 null —— 由调用方当"判定失败"处理。 */
export function parseJsonLoose<T>(raw: string): T | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/iu, "").replace(/```$/u, "").trim();
  const attempts = [trimmed];
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) attempts.push(trimmed.slice(first, last + 1));
  for (const attempt of attempts) {
    // 严格解析失败后再试一次「补收尾符」：模型流式偶发丢尾巴，补出来的内容
    // 与它实际给的一致，不会凭空多出东西（同服务端口径）。
    for (const candidate of new Set([attempt, closeTruncatedJson(attempt)])) {
      try {
        const parsed = JSON.parse(candidate as string) as unknown;
        // 数组/标量都算"没按约定的形状回"：我们要的是带字段的对象，宁可判失败
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as T;
      } catch {
        // 继续试下一种截法
      }
    }
  }
  return null;
}

/** 调一次 chat completions，要求返回 JSON 对象。 */
/** BYOK 每次调用的 token 用量回传（个人中心「账户」页的本地流水）。 */
export interface ByokUsage {
  scene: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
}

let byokUsageSink: ((usage: ByokUsage) => void) | null = null;

/** 注册 BYOK 用量收集器（main.ts 启动时接 IndexedDB）。hosted 模式不走这里。 */
export function setByokUsageSink(sink: ((usage: ByokUsage) => void) | null): void {
  byokUsageSink = sink;
}

function reportUsage(
  scene: string,
  config: AiConfig,
  body: { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null,
): void {
  const usage = body?.usage;
  if (!usage || !byokUsageSink) return;
  byokUsageSink({
    scene,
    model: config.model,
    prompt_tokens: Number(usage.prompt_tokens ?? 0),
    completion_tokens: Number(usage.completion_tokens ?? 0),
  });
}

/** `chatJson` 的可选开关。 */
export interface ChatJsonOptions {
  /** 请求超时（毫秒），默认 60s。 */
  timeoutMs?: number;
  /**
   * 允许模型**先思考再作答**。默认 **关**。
   *
   * 关掉是因为思考阶段不吐任何正文，等用户看的交互里那 3~5 秒是纯等待。
   * **要开的两处**（服务端 `_scene_kwargs` 同一条口径）：
   *  · 「逐词释义」（`explainWords`）：它要给**本句读音**，其中「专有名词/
   *    作品名的整体读法」得靠世界知识 —— 模型得先认出『春日影』是曲名，
   *    才给得出 `はるひかげ`，否则只会照抄分词参考里的 `春日=かすが`。
   *    同一句实测：关思考 3/3 全错、开思考 3/3 全对（2026-10-10 方案 B）。
   *  · 「重新解析」（`ExplainOptions.refresh`）：用户点它的前提就是不满意
   *    上一版，值得多等几秒。首次解析不开。
   */
  thinking?: boolean;
}

export async function chatJson<T>(
  config: AiConfig,
  messages: ChatMessage[],
  scene = "",
  options: ChatJsonOptions = {},
): Promise<T | null> {
  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: 0.2,
    response_format: { type: "json_object" },
  };
  if (!options.thinking) {
    // 关思考（2026-10-10 与内置模式对齐）：DeepSeek 系端点认 `thinking:{type:"disabled"}`，
    // `enable_thinking:false` 会被它**静默忽略**（思考照跑，首字白等 3~5 秒——
    // 同服务端 `_scene_kwargs` 的实测结论）；Qwen/DashScope 系则相反。两个都带，各认各的。
    // thinking=true 时**一个开关都不传** = 用端点默认（会先推理）。
    requestBody.enable_thinking = false;
    requestBody.thinking = { type: "disabled" };
  }
  const response = await httpFetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(requestBody),
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AiUnavailableError(
      `AI 接口报错（HTTP ${response.status}）${text ? `：${text.slice(0, 200)}` : ""}`,
      // 5xx = 供应商那一趟没成（502/503 最常见）：重试只会再撞一次
      response.status >= 500 ? "upstream" : undefined,
    );
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  reportUsage(scene, config, body);
  const content = body.choices?.[0]?.message?.content ?? "";
  return parseJsonLoose<T>(content);
}

/** 调一次 chat completions，要纯文本（追问助手用，不强制 JSON）。 */
export async function chat(
  config: AiConfig,
  messages: ChatMessage[],
  scene = "",
  timeoutMs = 90_000,
): Promise<string> {
  const response = await httpFetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.2,
      // 关思考（2026-10-10 与内置模式对齐）：DeepSeek 系认 `thinking:{type:"disabled"}`,
      // `enable_thinking:false` 会被它静默忽略；Qwen/DashScope 系相反。两个都带，各认各的。
      enable_thinking: false,
      thinking: { type: "disabled" },
    }),
    timeoutMs,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AiUnavailableError(
      `AI 接口报错（HTTP ${response.status}）${text ? `：${text.slice(0, 200)}` : ""}`,
      // 5xx = 供应商那一趟没成（502/503 最常见）：重试只会再撞一次
      response.status >= 500 ? "upstream" : undefined,
    );
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  reportUsage(scene, config, body);
  return (body.choices?.[0]?.message?.content ?? "").trim();
}

// ── 仿写核对 ─────────────────────────────────────────────────────────────

export interface ImitationVerdict {
  correct: boolean;
  reason: string;
  /**
   * 改写建议：**一句完整的日语**。只在学生那句确实还能更自然时才有值，
   * 否则空串（口径写在 `IMITATION_SYSTEM` 里 —— 别在这里自己判断）。
   *
   * ⚠️ 值里**不含**「更自然的说法：」这类引导语，标签由展示侧自己加
   * （见 views/study/practices.ts::renderSuggestion）。
   */
  suggestion: string;
  /** suggestion 到底改了哪里的一句中文说明；没有建议时为空串。两个一起看 —— 缺哪个都不显示。 */
  suggestionNote: string;
  /** 学生仿写句的中文意思（模型照实直译，写错也照翻 —— 让用户看见自己表达出的意思） */
  translation: string;
}

/** 提示词本体在 ./prompts.gen.ts（构建时从服务端 hosted_prompts.py 生成）。 */

/**
 * 模型 / 服务端回来的**原始判定**：键名与提示词里那份 JSON 逐字一致，
 * 所以建议说明是 `suggestion_note`（下划线），与 `ImitationVerdict.suggestionNote`
 * 只差这一处命名 —— **两条链路都是它**（内置模型的信封、BYOK 直连的模型输出），
 * `normalizeVerdictData` 是唯一的收口，别在别处再手解一遍。
 */
type RawVerdict = {
  correct?: boolean;
  reason?: string;
  suggestion?: string;
  suggestion_note?: string;
  translation?: string;
};

export function buildImitationMessages(input: { ja: string; zh: string; text: string }): ChatMessage[] {
  return [
    { role: "system", content: IMITATION_SYSTEM },
    {
      role: "user",
      content: [
        `原句（日语）：${input.ja}`,
        input.zh ? `原句（中文）：${input.zh}` : "",
        `学生的仿写：${input.text}`,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}

/**
 * 核对一句仿写。**内置模型与 BYOK 的判定口径一致**（同一份提示词在服务端）。
 *
 * 模型输出不可用时**判为未通过**，绝不放水。
 */
export async function verifyImitation(
  input: { ja: string; zh: string; text: string },
  settings: PluginSettings,
): Promise<ImitationVerdict> {
  const route = resolveAiRoute(settings);
  if (route === "off") {
    throw new AiUnavailableError("还没开启 AI。到个人中心「账户」页选一种方式就能用。");
  }
  if (route === "hosted") {
    requireHostedLogin(settings);
    const { data } = await hostedRequest<RawVerdict>(settings, "imitation", input);
    return {
      correct: data.correct === true,
      reason: typeof data.reason === "string" ? data.reason : "",
      suggestion: typeof data.suggestion === "string" ? data.suggestion : "",
      suggestionNote: typeof data.suggestion_note === "string" ? data.suggestion_note : "",
      translation: typeof data.translation === "string" ? data.translation : "",
    };
  }
  const config = aiConfigOrThrow(settings);
  const parsed = await chatJson<RawVerdict>(config, buildImitationMessages(input), "imitation");
  if (!parsed || typeof parsed.correct !== "boolean") {
    return { correct: false, reason: "AI 这次没给出可用的判定，再试一次吧。", suggestion: "", suggestionNote: "", translation: "" };
  }
  return {
    correct: parsed.correct,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    suggestion: typeof parsed.suggestion === "string" ? parsed.suggestion : "",
    suggestionNote: typeof parsed.suggestion_note === "string" ? parsed.suggestion_note : "",
    translation: typeof parsed.translation === "string" ? parsed.translation : "",
  };
}

/**
 * 仿写判定的**真流式**（2026-10-09）：模型的输出是 `{"correct":…,"reason":"…",
 * "suggestion":"…","suggestion_note":"…","translation":"…"}` 这份 JSON —— 判定框
 * 里的文字（为什么 / 你写的是什么 / 建议）边生成边回调 `onFields`，界面因此可以
 * 边生成边显示；返回时给的是**解析完的整份判定**（以它为准，落库也认这份）。
 *
 * `correct` 是布尔，往往第一个到 —— 但**只有它不能收尾**：界面在它到之前
 * 不显示「可以了/再改一下」那个头，等整份回来才由调用方拍板。
 *
 * 两条链路都流式（内置模型 SSE / BYOK OpenAI 兼容流式），口径与
 * `verifyImitation` 逐字一致：模型没给出可用结论时**判不通过**，绝不放水。
 */
export interface StreamVerdict {
  /** 还没吐到这个键就是 null —— 期间界面不能摆出判定头 */
  correct: boolean | null;
  reason: string;
  suggestion: string;
  /** suggestion 的区别说明；两个都到齐才有得显示（见 ImitationVerdict.suggestionNote） */
  suggestionNote: string;
  translation: string;
}

/**
 * 从**还没写完**的判定 JSON 里把要显示的字段抽出来（增量）。
 *
 * 与 `extractStreamFields` 同一个思路、不同的形状：判定是扁平 JSON，
 * 值有字符串也有布尔 —— 布尔只有写全了才认（`tru` 不算 true）。
 * 最终那份依然由 `parseJsonLoose` 出（并以它为准），这里只管让**显示**跟上生成。
 */
export function extractVerdictFields(raw: string): StreamVerdict {
  const src = stripFences(raw);
  const fields: StreamVerdict = { correct: null, reason: "", suggestion: "", suggestionNote: "", translation: "" };
  let key: string | null = null;
  let depth = 0;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {
      const str = readJsonString(src, i);
      let after = str.next;
      while (after < src.length && /\s/u.test(src[after])) after += 1;
      if (str.complete && src[after] === ":") {
        key = str.text;
        i = after + 1;
        continue;
      }
      if (key === "reason") fields.reason = str.text;
      else if (key === "suggestion") fields.suggestion = str.text;
      else if (key === "suggestion_note") fields.suggestionNote = str.text;
      else if (key === "translation") fields.translation = str.text;
      if (!str.complete) break; // 值还在写 —— 吐出去的就是当前进度
      key = null;
      i = str.next;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      key = null;
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      key = null;
      i += 1;
      continue;
    }
    if (key === "correct" && depth === 1) {
      if (src.startsWith("true", i)) {
        fields.correct = true;
        key = null;
        i += 4;
        continue;
      }
      if (src.startsWith("false", i)) {
        fields.correct = false;
        key = null;
        i += 5;
        continue;
      }
    }
    i += 1;
  }
  return fields;
}

/** 模型回来的判定是不可信输入：逐字段取值，correct 缺失按判不通过。 */
function normalizeVerdictData(data: RawVerdict | null | undefined): ImitationVerdict {
  if (!data || typeof data.correct !== "boolean") {
    return {
      correct: false,
      reason: "AI 这次没给出可用的判定，再试一次吧。",
      suggestion: "",
      suggestionNote: "",
      translation: "",
    };
  }
  return {
    correct: data.correct,
    reason: typeof data.reason === "string" ? data.reason : "",
    suggestion: typeof data.suggestion === "string" ? data.suggestion : "",
    suggestionNote: typeof data.suggestion_note === "string" ? data.suggestion_note : "",
    translation: typeof data.translation === "string" ? data.translation : "",
  };
}

/**
 * 核对一句仿写（**流式版**）。失败语义与 `verifyImitation` 一致：抛
 * `AiUnavailableError`；`signal` 用于中断（用户换句/重置时不再花后面的钱）。
 *
 * ⚠️ 非流式版**保留**：它是流式链路失败的退路（调用方自己决定要不要退）。
 */
export async function verifyImitationStream(
  input: { ja: string; zh: string; text: string },
  settings: PluginSettings,
  onFields: (fields: StreamVerdict) => void,
  signal?: AbortSignal,
): Promise<ImitationVerdict> {
  const route = resolveAiRoute(settings);
  if (route === "off") {
    throw new AiUnavailableError("还没开启 AI。到个人中心「账户」页选一种方式就能用。");
  }

  if (route === "hosted") {
    requireHostedLogin(settings);
    const response = await hostedStream(
      settings,
      "imitation",
      { ja: input.ja, zh: input.zh, text: input.text, stream: true },
      signal,
    );
    if (!isEventStream(response)) {
      // 老服务端 / 中间层不认 stream：回的是整份 JSON，照旧读信封
      const data = await readEnvelope<RawVerdict & { billing?: HostedBilling | null }>(response);
      reportBilling(data?.billing ?? null);
      return normalizeVerdictData(data);
    }
    let raw = "";
    let done: (RawVerdict & { billing?: HostedBilling | null }) | null = null;
    let failure: AiUnavailableError | null = null;
    const readDone = (): typeof done => done;
    const readFailure = (): AiUnavailableError | null => failure;
    await readSse(response, (event) => {
      const type = event.type;
      if (type === "delta") {
        raw += typeof event.text === "string" ? event.text : "";
        onFields(extractVerdictFields(raw));
      } else if (type === "done") {
        done = event.data ?? null;
      } else if (type === "error") {
        const reason = typeof event.reason === "string" ? event.reason : "";
        const message = typeof event.message === "string" ? event.message : "";
        failure = new AiUnavailableError(
          message || "模型这次没给出可用的判定，再试一次。",
          // reason → 码：上游自己报的错（含"一个字都没给"的那次）带 upstream 码，
          // 调用方据此**不再重试** —— 见 client.ts::isUpstreamError
          streamErrorCode(reason),
        );
      }
    });
    const failed = readFailure();
    if (failed) throw failed;
    const final = readDone();
    reportBilling(final?.billing ?? null);
    if (final) return normalizeVerdictData(final);
    // 没等到 done（连接断了但没报错）：拿手上的半截自己判一次 ——
    // 判不出就按"没给出可用判定"处理，绝不放水
    return normalizeVerdictData(parseJsonLoose<RawVerdict>(raw) ?? undefined);
  }

  // BYOK：直连用户自己的端点，OpenAI 兼容的流式格式
  const config = aiConfigOrThrow(settings);
  let response: Response;
  try {
    // 流式**刻意留在 fetch**：requestUrl 会把响应体一次性读完，没有
    // ReadableStream、也不认 signal —— 换过去就丢掉逐字上屏和用户中断。
    // 走 window.fetch 而不是裸 fetch：官方 lint 把 fetch 列成受限全局且不许豁免。
    response = await window.fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: buildImitationMessages(input),
        temperature: 0.2,
        // 关思考（2026-10-10 与内置模式对齐）：DeepSeek 系认 `thinking:{type:"disabled"}`，
        // `enable_thinking:false` 会被它静默忽略；Qwen/DashScope 系相反。两个都带，各认各的。
        enable_thinking: false,
        thinking: { type: "disabled" },
        stream: true,
        stream_options: { include_usage: true },
        response_format: { type: "json_object" },
      }),
      signal: signal ?? AbortSignal.timeout(300_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AiUnavailableError("连不上你配置的模型端点，检查一下地址和网络。");
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AiUnavailableError(
      `AI 接口报错（HTTP ${response.status}）${text ? `：${text.slice(0, 200)}` : ""}`,
      // 5xx = 供应商那一趟没成（502/503 最常见）：重试只会再撞一次
      response.status >= 500 ? "upstream" : undefined,
    );
  }
  let raw = "";
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  await readSse(response, (chunk) => {
    const choices = chunk.choices as Array<{ delta?: { content?: string } }> | undefined;
    const delta = choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) {
      raw += delta;
      onFields(extractVerdictFields(raw));
    }
    if (chunk.usage) usage = chunk.usage;
  });
  reportUsage("imitation", config, usage ? { usage } : null);
  return normalizeVerdictData(parseJsonLoose<RawVerdict>(raw) ?? undefined);
}

// ── 整句解析：解读 + 逐词释义（**两次请求**）───────────────────────────────
//
// 2026-10-07 用户拍板拆成两次：先只要「解读」，回来就立刻上屏；再要「逐词
// 释义」喂句子卡上的点词弹卡。原先一次要点齐两块，模型写完一大串词表第一段
// 解读才吐出来，长句要等很久。
//
// 两块都**默认不出内容** —— 都要花 token（内置模型扣余额、BYOK 花用户自己的
// 额度），点「AI 解析」才跑。
//
// 产品口径（提示词 + 前端都要对齐，改一处就得改全部）：
//   · 解读：分两段 —— 核心单词 / 核心语法（含一个自造的日语例句）。
//     **不用把每个词、每条语法都讲一遍**，只挑这句里最值得学的；
//     单词那一块**只讲词义**，语法归「核心语法」。
//     （2026-10-09 用户拍板：不再单独出「使用场景」。）
//   · 单词：结构化 {surface, reading, meaning, origin?}，**只在弹卡里展示，
//     不在卡片上渲染**；origin 只有英语外来语才有。
//   · 标点不给：没有可解释的内容，列出来只是噪音
//   · 语境：作品名 + 前后句一并给模型当参考（番剧特殊词汇单句看不懂），
//     但**只解析标为「需要解析的句子」的那一句**

/** 解读**每一段**最多留多少字 —— 与服务端 `MAX_SECTION` 同一个数 */
export const MAX_SECTION = 300;

/** 两段里有没有内容 —— 全空就等于"这次没给出解读" */
export function hasSections(sections: ExplanationSections | null | undefined): boolean {
  if (!sections) return false;
  return EXPLANATION_SECTIONS.some(([key]) => (sections[key] ?? "").trim() !== "");
}

/**
 * 拼成一段纯文本（`【小标题】正文` 逐段连排）。
 *
 * 只给**不需要分节样式**的地方用：喂给助手当上下文、写进笔记的快照。
 * 界面上那块走分节渲染（见 views/study/analysis.ts），不要用它。
 */
export function renderExplanation(sections: ExplanationSections | null | undefined): string {
  if (!sections) return "";
  return EXPLANATION_SECTIONS
    .map(([key, title]) => {
      const text = (sections[key] ?? "").trim();
      return text ? `【${title}】${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** 模型回来的 sections 是不可信输入：逐段取字符串、超长的截断，缺的补空串。 */
function normalizeSections(raw: unknown): ExplanationSections {
  const source = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const sections = { ...EMPTY_EXPLANATION_SECTIONS };
  for (const [key] of EXPLANATION_SECTIONS) {
    const value = source[key];
    sections[key] = typeof value === "string" ? value.trim().slice(0, MAX_SECTION) : "";
  }
  return sections;
}

/** 一个词条：弹卡要显示的东西。四层来源见 StudyView 的 heroWordInfo。 */
export interface WordEntry {
  surface: string;
  /** 本句里的假名读音（AI 按实际念法给）；模型没给就是空串 */
  reading: string;
  meaning: string;
  /** 英语外来语的英文原词；不是英语借词就是空串 */
  origin: string;
}

export interface SentenceExplanation {
  translation: string;
  /** 分两段的解读 */
  sections: ExplanationSections;
}

export interface ExplainInput {
  ja: string;
  zh: string;
  /** 本机分词给的词表：两块解析都拿它当参考 */
  words: string[];
  /** 语境三件套：作品名 + 前后句原文（字幕里的邻居）。都没有也行 ——
   *  提示词里缺了哪个就整行不放，模型只解析目标句的口径不变。 */
  work?: string;
  prevJa?: string;
  nextJa?: string;
  /**
   * 这一句的日文是不是**用户纠错过**的版本（`ja` 已是 effectiveJa）。
   *
   * 纠错句的解析结果**不进共享缓存**、只落该用户私有缓存，并登记原片三句 hash
   * （`originHash`）供服务端人工复盘。未纠错句不传这两个键（默认 false）。
   */
  corrected?: boolean;
  /** 原片三句 hash（= 这句 sliceCid 去掉 `S:` 前缀），纠错句复盘用。 */
  originHash?: string;
}

/**
 * 解析请求的开关。
 *
 * ⚠️ 别把它当成"只有内置模型读得懂"：`refresh` **两条链路都认**，只是用法不同 ——
 * 内置模型拿它去跳过服务端缓存，BYOK 没有缓存这回事，拿它当**开思考**的信号。
 */
export interface ExplainOptions {
  /**
   * 「重新解析」：内置模型那条路要求服务端**跳过解析缓存**重算一遍，并把新结果
   * 覆盖写回缓存（之后再有人命中这一句，拿到的就是最新那一版）。
   *
   * ⚠️ **解读与逐词释义两块共用这个开关**（2026-10-15）：服务端的缓存按块存
   * （`lookup(ja, part, …)`），所以"只刷词表"带它只跳词表那一行，解读不受影响。
   *
   * 为什么必须有这个开关：用户点「重新解析」的前提就是"我不满意当前这条"——
   * 服务端若无条件回缓存，这个按钮就是按一次返回同一份、按多少次都一样
   * （2026-10-08 实机报的就是这个）。代价是这一次按真实调用扣费，用户已在
   * 确认弹窗上点头。
   *
   * 🔥 它还兼着**开思考**（2026-10-10 用户拍板）：点这个按钮就是"不满意上一版"，
   * 那这一次值得多花几秒让模型先推理。**两条链路都开** —— 内置模型侧由服务端
   * 按 `refresh` 决定（`ai_api.py` 的 `thinking=(part == PART_WORDS or refresh)`），
   * BYOK 侧在这里直接不写那两个关思考的开关。首次解析仍关（首字延迟更值钱）。
   */
  refresh?: boolean;
}

/**
 * user 消息。与服务端 `analyze_user_prompt` **逐行对齐**（两条链路要给模型看同样的东西）：
 * 语境行缺就整行不放 —— 空标签会诱导模型围绕它编内容。
 * 两块解析共用它（同一个语境、同一份分词参考），只有 system 提示词不同。
 */
export function buildExplainMessages(input: ExplainInput): ChatMessage[] {
  return [
    { role: "system", content: ANALYZE_SYSTEM },
    { role: "user", content: buildAnalyzeUserPrompt(input) },
  ];
}

export function buildWordsMessages(input: ExplainInput): ChatMessage[] {
  return [
    { role: "system", content: ANALYZE_WORDS_SYSTEM },
    { role: "user", content: buildAnalyzeUserPrompt(input) },
  ];
}

function buildAnalyzeUserPrompt(input: ExplainInput): string {
  const lines = [
    input.work ? `【作品】${input.work}` : "",
    input.prevJa ? `【上一句】${input.prevJa}` : "",
    `【需要解析的句子】${input.ja}`,
    input.zh ? `【中文参考（可能为空或不准，按日语为准）】${input.zh}` : "",
    input.nextJa ? `【下一句】${input.nextJa}` : "",
    input.words.length ? `【本句分词参考】${input.words.join("、")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** 解析要带的入参（两块共用）。 */
function analyzePayload(
  input: ExplainInput,
  part: "explain" | "words",
  refresh = false,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ja: input.ja,
    zh: input.zh,
    words: input.words,
    work: input.work ?? "",
    prev_ja: input.prevJa ?? "",
    next_ja: input.nextJa ?? "",
    part,
  };
  // 只有真值才带上这个键：老服务端多收一个字段无害，但别让它看起来像默认行为
  if (refresh) payload.refresh = true;
  // 纠错句：显式标记 + 原片三句 hash，让服务端走私有缓存并留复盘痕迹
  if (input.corrected) {
    payload.corrected = true;
    payload.origin_hash = input.originHash ?? "";
  }
  return payload;
}

/**
 * 第一块：这一句的解读（整句翻译 + 两段）。
 *
 * ⚠️ 这一块**只管解读**，逐词释义走 `explainWords` —— 调用方拿到它应该
 * 立刻上屏，不要等第二块（等的话就白拆了）。
 *
 * ⚠️ `options.refresh` 必须在**每一条出口**上都传下去：这条路是流式失败后的
 * 非流式退路，漏传就等于"流式一坏，重新解析又变回读缓存"（见 `ExplainOptions`）。
 */
export async function explainSentence(
  input: ExplainInput,
  settings: PluginSettings,
  options: ExplainOptions = {},
): Promise<SentenceExplanation | null> {
  const route = resolveAiRoute(settings);
  if (route === "off") {
    throw new AiUnavailableError("还没开启 AI。到个人中心「账户」页选一种方式就能用。");
  }
  if (route === "hosted") {
    requireHostedLogin(settings);
    const { data } = await hostedRequest<{ translation?: string; sections?: unknown }>(
      settings,
      "analyze",
      analyzePayload(input, "explain", options.refresh === true),
    );
    return {
      translation: typeof data.translation === "string" ? data.translation : "",
      // 服务端已经截过一遍，这里再走一次 normalize：BYOK 那条路没有服务端兜着
      sections: normalizeSections(data.sections),
    };
  }
  const config = aiConfigOrThrow(settings);
  const parsed = await chatJson<{ translation?: unknown; sections?: unknown }>(
    config,
    buildExplainMessages(input),
    "analyze",
    // 「重新解析」开思考（与内置模型同口径，见 ExplainOptions.refresh）：用户点它的
    // 前提就是"不满意上一版"，值得多等几秒；首次解析仍关 —— 首字延迟更值钱。
    { thinking: options.refresh === true },
  );
  if (!parsed) return null;
  return {
    translation: typeof parsed.translation === "string" ? parsed.translation : "",
    sections: normalizeSections(parsed.sections),
  };
}

/**
 * 第二块：逐词释义 + 句内读音（+ 英语外来语词源）。喂句子卡上的点词弹卡。
 *
 * 返回 null = 模型这次没给出可用结果（调用方据此提示重试）。
 */
export async function explainWords(
  input: ExplainInput,
  settings: PluginSettings,
  options: ExplainOptions = {},
): Promise<WordEntry[] | null> {
  const route = resolveAiRoute(settings);
  if (route === "off") {
    throw new AiUnavailableError("还没开启 AI。到个人中心「账户」页选一种方式就能用。");
  }
  if (route === "hosted") {
    requireHostedLogin(settings);
    const { data } = await hostedRequest<{ words?: unknown }>(
      settings,
      "analyze",
      // `refresh` 与解读那一块同口径（2026-10-15）：服务端的解析缓存是**按块**
      // 存取的（`analysis_cache.lookup(ja, part, …)`），所以只刷词表时带上它，
      // 跳过的只有词表那一行 —— 解读的缓存不受影响。不带 = 无条件回缓存里那份，
      // 用户点「重新解析」就是按了没反应（解读那边 2026-10-08 实机报过同一个坑）。
      analyzePayload(input, "words", options.refresh === true),
    );
    return normalizeWords(data.words);
  }
  const config = aiConfigOrThrow(settings);
  // 🔥 这一块**开思考**（2026-10-10 方案 B）：它要给本句读音，专有名词/作品名
  // 的整体读法得靠世界知识（『春日影』→ はるひかげ，不是 春日=かすが + 影=かげ）。
  // 解读那一块仍关着（首字延迟更值钱）—— 见 ChatJsonOptions.thinking。
  const parsed = await chatJson<{ words?: unknown }>(
    config,
    buildWordsMessages(input),
    "analyze",
    { thinking: true },
  );
  if (!parsed) return null;
  return normalizeWords(parsed.words);
}

/** 词条是不可信输入：丢没有 surface 的、逐字段取字符串（reading/origin 缺就空串）。 */
function normalizeWords(raw: unknown): WordEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((word) => word && typeof word === "object" && typeof (word as WordEntry).surface === "string")
    .map((word) => {
      const entry = word as Partial<WordEntry>;
      return {
        surface: String(entry.surface ?? ""),
        reading: typeof entry.reading === "string" ? entry.reading : "",
        meaning: typeof entry.meaning === "string" ? entry.meaning : "",
        // 词源只有英语外来语才有：其他语种/和语/汉语词落成空串，消费侧按空过滤
        origin: typeof entry.origin === "string" ? entry.origin : "",
      };
    });
}

// ── 解读的**真流式**（2026-10-08 用户拍板）─────────────────────────────────
//
// 两条链路都是流式：内置模型走服务端 SSE（`/analyze/` 带 stream=true），
// BYOK 直连用户自己的端点（OpenAI 兼容的 stream:true）。**同一套解析与回调**，
// 因为给模型看的东西、以及模型吐出来的东西都是同一份 JSON。
//
// 为什么值得这么做：解读是几段文字，模型要写好几秒到几十秒；等整份回来再
// 一次性上屏，用户对着空卡片干等。改成边生成边显示之后，"输出完了再打字机"
// 这层假的节奏就没必要了 —— 缓存命中的直接铺开（见 analysis.ts）。

/** 流式中途抽到的字段：值可能还只写了一半（模型正在吐这一句）。 */
export interface StreamFields {
  translation: string;
  sections: Partial<ExplanationSections>;
}

const SECTION_KEYS = EXPLANATION_SECTIONS.map(([key]) => key);

/** 去掉 ```json 围栏（模型爱套一层，增量解析也得先扒掉）。 */
function stripFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?/iu, "").replace(/```$/u, "");
}

/**
 * 读一个 JSON 字符串字面量（`start` 指向开引号）。
 * `complete=false` 表示缓冲区里这个字符串还没写完 —— 调用方拿到的就是当前进度。
 */
function readJsonString(src: string, start: number): { text: string; complete: boolean; next: number } {
  const simple: Record<string, string> = {
    '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
  };
  let out = "";
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      const next = src[i + 1];
      // 半截转义（缓冲区刚好切在反斜杠后）：先不吐，等下一片
      if (next === undefined) return { text: out, complete: false, next: i };
      if (next in simple) {
        out += simple[next];
        i += 2;
        continue;
      }
      if (next === "u") {
        const hex = src.slice(i + 2, i + 6);
        if (hex.length < 4) return { text: out, complete: false, next: i };
        const code = Number.parseInt(hex, 16);
        if (Number.isNaN(code)) {
          i += 2;
          continue;
        }
        out += String.fromCharCode(code);
        i += 6;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === '"') return { text: out, complete: true, next: i + 1 };
    out += ch;
    i += 1;
  }
  return { text: out, complete: false, next: i };
}

/**
 * 从**还没写完**的 JSON 文本里把要显示的字段抽出来（增量）。
 *
 * 模型吐的是 `{"translation":"…","sections":{"words":"…",…}}`，逐片到达时
 * 缓冲区里的东西多数时刻是非法 JSON —— `JSON.parse` 直接抛。所以这里自己
 * 扫一遍：只认字符串键值，字符串没闭合就返回当前进度。
 *
 * ⚠️ 这不是"容错解析"：最终那份依然由 `parseJsonLoose` 出（并以它为准），
 * 这里只负责让**显示**跟得上生成。抽错了顶多是过程中抖一下，结束时会被覆盖。
 */
export function extractStreamFields(raw: string): StreamFields {
  const src = stripFences(raw);
  const fields: StreamFields = { translation: "", sections: {} };
  let key: string | null = null;
  let depth = 0;
  let sectionsDepth = -1;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {
      const str = readJsonString(src, i);
      let after = str.next;
      while (after < src.length && /\s/u.test(src[after])) after += 1;
      if (str.complete && src[after] === ":") {
        // 是键
        key = str.text;
        i = after + 1;
        continue;
      }
      // 是值
      if (key !== null) {
        if (sectionsDepth >= 0 && depth >= sectionsDepth && (SECTION_KEYS as string[]).includes(key)) {
          fields.sections[key as keyof ExplanationSections] = str.text;
        } else if (key === "translation") {
          fields.translation = str.text;
        }
      }
      if (!str.complete) break; // 值还在写 —— 吐出去的就是当前进度
      i = str.next;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      if (key === "sections") sectionsDepth = depth;
      key = null;
      i += 1;
      continue;
    }
    if (ch === "}") {
      if (sectionsDepth >= 0 && depth <= sectionsDepth) sectionsDepth = -1;
      depth = Math.max(0, depth - 1);
      key = null;
      i += 1;
      continue;
    }
    if (ch === "[" || ch === "]") {
      key = null;
      i += 1;
      continue;
    }
    i += 1;
  }
  return fields;
}

/** SSE 分帧：空行分隔（`\n\n` 与 `\r\n\r\n` 都认，两种实现的习惯不一样）。 */
function findFrameEnd(buffer: string): { start: number; end: number } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { start: crlf, end: crlf + 4 };
  return { start: lf, end: lf + 2 };
}

/**
 * 这次的响应是不是 SSE 流。
 *
 * 🔥 不能想当然认定流式请求的响应就是流：**服务端命中解析缓存时不流式** ——
 * 那份结果本来就在手上，整份给才是"点开就有"（见 `core/learning/ai_api.py` 的
 * 缓存分支）。它回的是普通 JSON。
 *
 * 判据取 content-type，且**认不出类型就按流处理**：老服务端 / 中间层可能不带
 * 这个头，而"把流当 JSON 读"会让每一次调用都失败，比反过来严重得多。
 */
function isEventStream(response: Response): boolean {
  const type = response.headers?.get("content-type") ?? "";
  return !type.toLowerCase().includes("json");
}

/**
 * 读一次**非流式**的成功响应：解出 `{code, message, data}` 里的 data。
 * 与 `hostedRequest` 同一层信封（同一份 `success_response`），读不出来给 null。
 */
async function readEnvelope<T>(response: Response): Promise<T | null> {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    const body = JSON.parse(text) as { data?: T };
    return body?.data ?? null;
  } catch {
    return null;
  }
}

/** 逐帧读 SSE，把每个 `data:` 的 JSON 交给回调；`[DONE]` 与非 data 行跳过。 */
async function readSse(
  response: Response,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<void> {
  const body = response.body;
  if (!body) throw new AiUnavailableError("服务端没返回内容，稍后再试。");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleFrame = (frame: string): void => {
    for (const rawLine of frame.split("\n")) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue; // event: / id: / 注释行都不管
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        onEvent(JSON.parse(payload) as Record<string, unknown>);
      } catch {
        // 半截 JSON 不会出现在这里（分帧保证整帧），真出现就跳过这一帧
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let frame = findFrameEnd(buffer);
    while (frame) {
      handleFrame(buffer.slice(0, frame.start));
      buffer = buffer.slice(frame.end);
      frame = findFrameEnd(buffer);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleFrame(buffer);
}

/**
 * 第一块（解读）的**流式**版本：模型每吐一段就回调一次 `onFields`，
 * 界面因此可以边生成边显示；返回时给的是**解析完的整份结果**（以它为准）。
 *
 * 失败语义与 `explainSentence` 一致：抛 `AiUnavailableError`。
 * `signal` 用于用户翻页/关面板时中断 —— 中断了就不再花后面的钱。
 *
 * `options.refresh` = 「重新解析」：要求服务端跳过缓存重算（见 `ExplainOptions`）。
 * 带上传出去之后服务端就会走"真调模型"那条路，不会再有整份 JSON 的缓存响应；
 * 但**下游每一条出口都得带上它** —— 尤其是 `streamExplanation` 里那条非流式
 * 退路（`explainSentence`），漏一处就等于"流式一坏，重新解析又变回读缓存"。
 */
export async function explainSentenceStream(
  input: ExplainInput,
  settings: PluginSettings,
  onFields: (fields: StreamFields) => void,
  signal?: AbortSignal,
  options: ExplainOptions = {},
): Promise<{ explanation: SentenceExplanation | null; billing: HostedBilling | null }> {
  const route = resolveAiRoute(settings);
  if (route === "off") {
    throw new AiUnavailableError("还没开启 AI。到个人中心「账户」页选一种方式就能用。");
  }

  const feed = (raw: string): void => onFields(extractStreamFields(raw));

  if (route === "hosted") {
    requireHostedLogin(settings);
    const response = await hostedStream(
      settings,
      "analyze",
      { ...analyzePayload(input, "explain", options.refresh === true), stream: true },
      signal,
    );

    // 🔥 命中服务端缓存时，服务端**回的是普通 JSON 而不是流**（那份结果本来就在手上，
    // 整份给才是"点开就有"）。照流逐帧读会**一帧都读不到** → 解读落到 null →
    // 界面只能报"AI 这次没给回可用的结果"；而且因为命中缓存，每次「重新解析」都撞
    // 同一条路 —— 看着就是"按钮坏了"，其实是这条路根本没修过（2026-10-08 实机踩到）。
    if (!isEventStream(response)) {
      const cached = await readEnvelope<{
        translation?: unknown;
        sections?: unknown;
        from_cache?: unknown;
        billing?: HostedBilling | null;
      }>(response);
      const billing = cached?.billing ?? null;
      reportBilling(billing);
      // 我们要的是"重算"，服务端却回了缓存 ⇒ 这个开关没被认（老服务端 / 中间层把它吃了）。
      // 这条链路本身不报错（拿到的也是一份合法解读），**只有日志能看出它没生效** ——
      // 而表现恰好是"点了重新解析，内容一模一样"，最难查。所以这里必须出声。
      if (options.refresh === true && cached?.from_cache === true) {
        log.warn("[analyze] 带了 refresh 但服务端回的是缓存（开关没生效，解析结果没有被重新生成）");
      }
      return {
        explanation: {
          translation: typeof cached?.translation === "string" ? cached.translation : "",
          // 服务端已经截过一遍，这里再走一次 normalize：缓存命中那条路也共用它
          sections: normalizeSections(cached?.sections),
        },
        billing,
      };
    }

    interface DoneEvent {
      translation?: unknown;
      sections?: unknown;
      billing?: HostedBilling;
    }
    let raw = "";
    let done: DoneEvent | null = null;
    let failure: AiUnavailableError | null = null;
    // 读成函数：赋值发生在回调里，TS 的控制流分析看不见它（会把变量窄化成 null，
    // 后面读属性直接报 never）—— 函数调用是它唯一认的"这里可能已经变了"。
    const readDone = (): DoneEvent | null => done;
    const readFailure = (): AiUnavailableError | null => failure;

    await readSse(response, (event) => {
      const type = event.type;
      if (type === "delta") {
        raw += typeof event.text === "string" ? event.text : "";
        feed(raw);
      } else if (type === "done") {
        done = event.data ?? null;
      } else if (type === "error") {
        const reason = typeof event.reason === "string" ? event.reason : "";
        const message = typeof event.message === "string" ? event.message : "";
        failure = new AiUnavailableError(
          message || "模型这次没给出可用的结果，再试一次。",
          // reason → 码：上游自己报的错（含"一个字都没给"的那次）带 upstream 码，
          // 调用方据此**不再重试** —— 见 client.ts::isUpstreamError
          streamErrorCode(reason),
        );
      }
    });

    const failed = readFailure();
    if (failed) throw failed;
    const final = readDone();
    const billing = final?.billing ?? null;
    reportBilling(billing);
    if (!final) return { explanation: null, billing };
    return {
      explanation: {
        translation: typeof final.translation === "string" ? final.translation : "",
        // 服务端已经截过一遍，这里再走一次 normalize：缓存命中那条路也共用它
        sections: normalizeSections(final.sections),
      },
      billing,
    };
  }

  // BYOK：直连用户自己的端点，OpenAI 兼容的流式格式（choices[].delta.content）
  const config = aiConfigOrThrow(settings);
  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages: buildExplainMessages(input),
    temperature: 0.2,
    stream: true,
    stream_options: { include_usage: true },
    response_format: { type: "json_object" },
  };
  if (options.refresh !== true) {
    // 关思考（2026-10-10 与内置模式对齐）：DeepSeek 系认 `thinking:{type:"disabled"}`，
    // `enable_thinking:false` 会被它静默忽略；Qwen/DashScope 系相反。两个都带，各认各的。
    // 不带 refresh 时**两个开关都写**；带了 refresh（「重新解析」）一个都不写 = 开思考。
    requestBody.enable_thinking = false;
    requestBody.thinking = { type: "disabled" };
  }
  let response: Response;
  try {
    // 流式**刻意留在 fetch**：requestUrl 会把响应体一次性读完，没有
    // ReadableStream、也不认 signal —— 换过去就丢掉逐字上屏和用户中断。
    // 走 window.fetch 而不是裸 fetch：官方 lint 把 fetch 列成受限全局且不许豁免。
    response = await window.fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: signal ?? AbortSignal.timeout(300_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AiUnavailableError("连不上你配置的模型端点，检查一下地址和网络。");
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AiUnavailableError(
      `AI 接口报错（HTTP ${response.status}）${text ? `：${text.slice(0, 200)}` : ""}`,
      // 5xx = 供应商那一趟没成（502/503 最常见）：重试只会再撞一次
      response.status >= 500 ? "upstream" : undefined,
    );
  }

  let raw = "";
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  await readSse(response, (chunk) => {
    const choices = chunk.choices as Array<{ delta?: { content?: string } }> | undefined;
    const delta = choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) {
      raw += delta;
      feed(raw);
    }
    if (chunk.usage) usage = chunk.usage;
  });

  reportUsage("analyze", config, usage ? { usage } : null);
  const parsed = parseJsonLoose<{ translation?: unknown; sections?: unknown }>(raw);
  if (!parsed) return { explanation: null, billing: null };
  return {
    explanation: {
      translation: typeof parsed.translation === "string" ? parsed.translation : "",
      sections: normalizeSections(parsed.sections),
    },
    billing: null,
  };
}

// ── 句子追问（右下角的漂流瓶助手） ─────────────────────────────────────────

export interface AskInput {
  ja: string;
  zh: string;
  /** 已经讲过的解析（翻译/词/解读），原样回传，用户不用复述前情 */
  analysis?: { translation?: string; words?: Array<{ surface: string; meaning: string }>; explanation?: string } | null;
  /** 学生的仿写与判定结果。`correct` 不是布尔 = 这一遍**没经过 AI 核对** */
  imitation?: { text?: string; correct?: boolean; reason?: string } | null;
  question: string;
  /** 最近几轮问答（最多 6 轮）。发送前当前问题已在末尾（assistant.ts 先 push 再发） */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** 语境：作品名 + 上一句。都没有也行 —— 语境行缺就整行不放（服务端同口径） */
  work?: string;
  prevJa?: string;
}

/**
 * 问一句关于当前句子的问题。内置模型扣余额；BYOK 走用户自己的 Key。
 *
 * 两条链路的消息形状**逐字一致**（唯一源头在服务端 `hosted_prompts.py`，
 * 这份是它的 TS 镜像）：[system, 语境段, 历史轮..., 当前问题] 的真多轮数组。
 * 语境段在同一句子的会话里逐字不变、历史轮原样回放 —— 下一轮请求与上一轮
 * 共享整段前缀，DeepSeek 前缀缓存逐轮命中。
 *
 * 非流式版本保留作**流式失败后的退路**（调用方决定要不要用）。
 */
export async function askAboutSentence(
  input: AskInput,
  settings: PluginSettings,
): Promise<{ answer: string; billing: HostedBilling | null }> {
  const route = resolveAiRoute(settings);
  if (route === "off") {
    throw new AiUnavailableError("还没开启 AI。到个人中心「账户」页选一种方式，助手就能用了。");
  }
  if (route === "hosted") {
    requireHostedLogin(settings);
    const { data, billing } = await hostedRequest<{ answer: string }>(settings, "ask", {
      ja: input.ja,
      zh: input.zh,
      analysis: input.analysis ?? null,
      imitation: input.imitation ?? null,
      question: input.question,
      history: input.history ?? [],
      work: input.work ?? "",
      prev_ja: input.prevJa ?? "",
    });
    return { answer: typeof data.answer === "string" ? data.answer : "", billing };
  }
  const config = aiConfigOrThrow(settings);
  const content = await chat(config, buildAskMessages(input), "ask");
  return { answer: content, billing: null };
}

/**
 * 追问的**真流式**（2026-10-09）：回答每吐一段就回调一次 `onDelta`，
 * 界面因此可以边生成边显示；返回时给的是**最终整份回答**（以它为准）。
 *
 * 两条链路都流式：内置模型走服务端 SSE（`/ask/` 带 stream=true，`delta` 是
 * 纯文本片段）；BYOK 直连用户自己的端点（OpenAI 兼容的 stream:true）。
 * 服务端命中不了缓存（追问没有缓存），所以正常情况下总是流；
 * `isEventStream` 的判据保留 —— 老服务端/中间层不认 stream 时回的是整份
 * JSON，那条路照样能走（把整份当一次 delta 交给界面）。
 */
export async function askAboutSentenceStream(
  input: AskInput,
  settings: PluginSettings,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<{ answer: string; billing: HostedBilling | null }> {
  const route = resolveAiRoute(settings);
  if (route === "off") {
    throw new AiUnavailableError("还没开启 AI。到个人中心「账户」页选一种方式，助手就能用了。");
  }

  if (route === "hosted") {
    requireHostedLogin(settings);
    const response = await hostedStream(
      settings,
      "ask",
      {
        ja: input.ja,
        zh: input.zh,
        analysis: input.analysis ?? null,
        imitation: input.imitation ?? null,
        question: input.question,
        history: input.history ?? [],
        work: input.work ?? "",
        prev_ja: input.prevJa ?? "",
        stream: true,
      },
      signal,
    );
    if (!isEventStream(response)) {
      const data = await readEnvelope<{ answer?: unknown; billing?: HostedBilling | null }>(response);
      const billing = data?.billing ?? null;
      reportBilling(billing);
      const answer = typeof data?.answer === "string" ? data.answer : "";
      onDelta(answer);
      return { answer, billing };
    }
    let raw = "";
    let done: { answer?: unknown; billing?: HostedBilling } | null = null;
    let failure: AiUnavailableError | null = null;
    // 读成函数：赋值发生在回调里，TS 的控制流分析看不见它（见 explainSentenceStream 同款）
    const readDone = (): typeof done => done;
    const readFailure = (): AiUnavailableError | null => failure;
    await readSse(response, (event) => {
      const type = event.type;
      if (type === "delta") {
        raw += typeof event.text === "string" ? event.text : "";
        onDelta(raw);
      } else if (type === "done") {
        done = event.data ?? null;
      } else if (type === "error") {
        const reason = typeof event.reason === "string" ? event.reason : "";
        const message = typeof event.message === "string" ? event.message : "";
        failure = new AiUnavailableError(
          message || "模型这次没给出可用的结果，再试一次。",
          // reason → 码：上游自己报的错（含"一个字都没给"的那次）带 upstream 码，
          // 调用方据此**不再重试** —— 见 client.ts::isUpstreamError
          streamErrorCode(reason),
        );
      }
    });
    const failed = readFailure();
    if (failed) throw failed;
    const final = readDone();
    const billing = final?.billing ?? null;
    reportBilling(billing);
    if (!final) return { answer: raw.trim(), billing };
    return { answer: typeof final.answer === "string" ? final.answer : raw.trim(), billing };
  }

  // BYOK：直连用户自己的端点，OpenAI 兼容的流式格式（choices[].delta.content）
  const config = aiConfigOrThrow(settings);
  let response: Response;
  try {
    // 流式**刻意留在 fetch**：requestUrl 会把响应体一次性读完，没有
    // ReadableStream、也不认 signal —— 换过去就丢掉逐字上屏和用户中断。
    // 走 window.fetch 而不是裸 fetch：官方 lint 把 fetch 列成受限全局且不许豁免。
    response = await window.fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: buildAskMessages(input),
        temperature: 0.2,
        // 关思考（2026-10-10 与内置模式对齐）：DeepSeek 系认 `thinking:{type:"disabled"}`，
        // `enable_thinking:false` 会被它静默忽略；Qwen/DashScope 系相反。两个都带，各认各的。
        enable_thinking: false,
        thinking: { type: "disabled" },
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: signal ?? AbortSignal.timeout(300_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AiUnavailableError("连不上你配置的模型端点，检查一下地址和网络。");
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AiUnavailableError(
      `AI 接口报错（HTTP ${response.status}）${text ? `：${text.slice(0, 200)}` : ""}`,
      // 5xx = 供应商那一趟没成（502/503 最常见）：重试只会再撞一次
      response.status >= 500 ? "upstream" : undefined,
    );
  }
  let raw = "";
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  await readSse(response, (chunk) => {
    const choices = chunk.choices as Array<{ delta?: { content?: string } }> | undefined;
    const delta = choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) {
      raw += delta;
      onDelta(raw);
    }
    if (chunk.usage) usage = chunk.usage;
  });
  reportUsage("ask", config, usage ? { usage } : null);
  return { answer: raw.trim(), billing: null };
}

/** 与服务端 `MAX_QUESTION` 同一个数。 */
const ASK_QUESTION_MAX = 300;

/** 与服务端 `ASK_QUESTION_LABEL` 逐字一致 —— 发送与历史回放都用它包裹。 */
const ASK_QUESTION_LABEL = "【学生的问题】";

function askQuestionText(question: string): string {
  return `${ASK_QUESTION_LABEL}${question}`;
}

/**
 * 追问的语境段。与服务端 `ask_context_prompt` **逐行对齐**：
 * 语境行缺就整行不放，且**不含问题** —— 同一句子的整个会话里这段
 * 逐字不变，是每一轮都能命中缓存的前缀。
 */
function buildAskContextPrompt(input: AskInput): string {
  const lines: string[] = [];
  if (input.work) lines.push(`【作品】${input.work}`);
  if (input.prevJa) lines.push(`【上一句】${input.prevJa}`);
  lines.push(`【原句】${input.ja}`);
  if (input.zh) lines.push(`【这句的中文】${input.zh}`);
  const words = input.analysis?.words ?? [];
  if (words.length) {
    lines.push(`【已经讲给学生的词】${words.map((item) => `${item.surface}（${item.meaning}）`).join("；")}`);
  }
  if (input.analysis?.explanation) lines.push(`【这一句的解读】${input.analysis.explanation}`);
  if (input.analysis?.translation) lines.push(`【整句翻译】${input.analysis.translation}`);
  if (input.imitation?.text) {
    // 三态：判过是对的 / 判过是不对的 / **压根没核对过**。
    // 最后一种以前会被说成"判定为不对"（`undefined` 是假值），助手就会
    // 拿着一个不存在的判定去回答 —— 与服务端 `ask_context_prompt` 保持一致。
    const judged = typeof input.imitation.correct === "boolean";
    const verdict = judged
      ? input.imitation.correct
        ? "判定为通过"
        : "判定为不对"
      : "还没核对过";
    lines.push(`【学生的仿写】${input.imitation.text}（${verdict}${input.imitation.reason ? `：${input.imitation.reason}` : ""}）`);
  }
  return lines.join("\n");
}

/**
 * 追问的完整 messages。与服务端 `build_ask_messages` **逐字对齐**：
 *  · 历史内容截 300 字（服务端同口径）；user 轮用 `askQuestionText` 包裹，
 *    保证与首次发送字节一致 —— 这是前缀缓存能命中的前提。
 *  · 调用方（assistant.ts）在发请求前就把当前问题 push 进了 history，
 *    末尾判重后不再追加，避免同一问题发两遍。
 */
export function buildAskMessages(input: AskInput): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: ASK_SYSTEM },
    { role: "user", content: buildAskContextPrompt(input) },
  ];
  for (const turn of input.history ?? []) {
    const content = (turn.content ?? "").trim().slice(0, 300);
    if (!content) continue;
    if (turn.role === "user") {
      messages.push({ role: "user", content: askQuestionText(content) });
    } else {
      messages.push({ role: "assistant", content });
    }
  }
  const questionText = askQuestionText(input.question.slice(0, ASK_QUESTION_MAX));
  const last = messages[messages.length - 1];
  if (!(last && last.role === "user" && last.content === questionText)) {
    messages.push({ role: "user", content: questionText });
  }
  return messages;
}
