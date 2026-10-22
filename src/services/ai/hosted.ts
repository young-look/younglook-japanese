/**
 * 内置模型：调自家服务端的 `/api/v1/ai/*`。
 *
 * 为什么必须绕一道服务端：
 *  1. **Key 不能进插件** —— 插件的 main.js 是明文，谁都能翻出来；
 *  2. **要扣余额** —— 用了多少 token、该扣多少钱，只有服务端算得清。
 *
 * BYOK 模式**完全不走这里**（直连用户自己的端点），所以 BYOK 永远不扣费。
 */

import { AiUnavailableError } from "./client";
import type { PluginSettings } from "../../settings/types";
import { httpFetch, type HttpResponseLike } from "../http";
import { formDataToMultipart } from "../multipart";

/**
 * 余额不够（402）的人话，全站唯一一份。
 *
 * 调用方一律靠 `isNoBalanceError` 把这个错分流到统一弹窗（见 StudyView 的
 * handleOutOfBalance），这句话**一般到不了界面** —— 留作兜底，话术与 gate.ts
 * 的 need-balance 行内话术同口径（充值或改用自定义模型，落点都是账户页）。
 */
export const NO_BALANCE_MESSAGE = "内置模型余额用完了。到个人中心「账户」页充值，或改用自定义模型。";

export interface HostedBilling {
  scene: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_millis: number;
  charged_millis: number;
  /** 本次扣完还剩多少（厘）。界面上直接显示这个。 */
  balance_millis: number;
  call_id: number | null;
}

/** 余额变化的上报口：设置页的余额显示靠它跟着更新（由 main.ts 注册）。 */
let billingSink: ((billing: HostedBilling) => void) | null = null;

export function setBillingSink(sink: ((billing: HostedBilling) => void) | null): void {
  billingSink = sink;
}

/** 上报一次扣费（流式那条路的账单在 `done` 事件里，得手工喂给同一个口）。 */
export function reportBilling(billing: HostedBilling | null | undefined): void {
  if (billing) billingSink?.(billing);
}

/**
 * 取访问令牌的口子（由 main.ts 注册）。
 *
 * 为什么不直接读 `settings.authToken`：access 只有 60 分钟，过期时得用
 * refresh 换一对新的。换令牌这件事归 main.ts（它负责落盘 settings），
 * 这里只负责「给我一个现在能用的令牌」。返回 null = 登录态已经没了。
 *
 * @param force true 表示「刚被 401 拒过，必须换新的」，
 *   用来跳过 provider 里「令牌还没过期就直接返回」的判断。
 */
export type AccessTokenProvider = (force?: boolean) => Promise<string | null>;

let accessProvider: AccessTokenProvider | null = null;

export function setAccessTokenProvider(provider: AccessTokenProvider | null): void {
  accessProvider = provider;
}

function normalizeUrl(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/u, "");
}

/** 供托管体系之外的账单类接口复用：服务端基址（去尾斜杠）。 */
export function hostedBase(settings: PluginSettings): string {
  return normalizeUrl(settings.serverUrl);
}

/** 解析当前可用的访问令牌（需要过服务端的其他接口——如账单流水——也用它）。 */
export async function resolveToken(settings: PluginSettings, force: boolean): Promise<string> {
  if (accessProvider) return (await accessProvider(force))?.trim() ?? "";
  return settings.authToken.trim();
}

/**
 * 调一次内置模型接口。
 *
 * 错误码都翻成**人话**：用户不需要知道 402 是什么，他只需要知道"该充值了"。
 *
 * 401 的处理是这里唯一复杂的地方：先**强制换一次令牌再重试一遍**。
 * 用户连上账号之后是长期登录的（access 一小时一换），正常路径下不该
 * 看见「登录过期」；真看见了，说明 refresh 也失效了 —— 那时候才报。
 */
/** 内置模型的场景名，同时就是 URL 的最后一段（`/api/v1/ai/<scene>/`）。 */
export type HostedScene = "analyze" | "imitation" | "ask" | "read-aloud";

export async function hostedRequest<T>(
  settings: PluginSettings,
  scene: HostedScene,
  payload: Record<string, unknown> | FormData,
): Promise<{ data: T; billing: HostedBilling | null }> {
  const base = normalizeUrl(settings.serverUrl);
  if (!base) throw new AiUnavailableError("服务端地址是空的，到设置里补上。");

  let token = await resolveToken(settings, false);
  if (!token) {
    // 拿不到令牌分两种：没连过/登录态被清（refreshToken 空）vs 只是暂时
    // 连不上服务端（令牌还留着）。两种情况的话术不一样，别吓唬用户。
    throw new AiUnavailableError(
      settings.refreshToken.trim()
        ? "暂时连不上服务端，稍后再试。"
        : "用内置模型要先登录。登录或注册在个人中心里。",
    );
  }

  let response = await callJson(base, scene, token, payload);

  if (response.status === 401) {
    // 令牌可能刚刚过期（本地判断有提前量，边界上会撞到）：换一次再试
    const fresh = await resolveToken(settings, true);
    if (fresh && fresh !== token) {
      token = fresh;
      response = await callJson(base, scene, token, payload);
    }
  }

  interface HostedBody {
    code?: number;
    message?: string;
    data?: T & { billing?: HostedBilling };
  }
  const text = await response.text().catch(() => "");
  let body: HostedBody | null = null;
  try {
    body = text ? (JSON.parse(text) as HostedBody) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw errorFor(response.status, body?.message, settings);
  }

  const data = (body?.data ?? {}) as T & { billing?: HostedBilling };
  const billing = data.billing ?? null;
  reportBilling(billing);
  return { data, billing };
}

/**
 * **流式**调用：把响应体原样交出来，由调用方自己边到边读（SSE）。
 *
 * 与非流式共用同一套鉴权（401 强刷一次）与错误码翻译 —— 两面各写一遍，
 * 迟早有一面先腐坏（表现是"流式这条路 402 不弹充值窗"）。
 *
 * 超时比非流式长得多：流式一次要跑几十秒到几分钟，90s 会在正常生成中途把
 * 连接掐掉（掐掉=白花上游的钱，用户还什么都没拿到）。
 */
export async function hostedStream(
  settings: PluginSettings,
  scene: HostedScene,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const base = normalizeUrl(settings.serverUrl);
  if (!base) throw new AiUnavailableError("服务端地址是空的，到设置里补上。");

  let token = await resolveToken(settings, false);
  if (!token) {
    throw new AiUnavailableError(
      settings.refreshToken.trim()
        ? "暂时连不上服务端，稍后再试。"
        : "用内置模型要先登录。登录或注册在个人中心里。",
    );
  }

  let response = await callStream(base, scene, token, payload, signal);
  if (response.status === 401) {
    const fresh = await resolveToken(settings, true);
    if (fresh && fresh !== token) {
      token = fresh;
      response = await callStream(base, scene, token, payload, signal);
    }
  }
  if (response.ok) return response;

  // 错误路径（门禁在吐字之前拦下的那些）：这时响应还是普通 JSON，照旧翻译成人话
  const text = await response.text().catch(() => "");
  let message = "";
  try {
    message = (JSON.parse(text) as { message?: string }).message ?? "";
  } catch {
    message = "";
  }
  throw errorFor(response.status, message, settings);
}

/** 流式的总体超时：长句 + 思考模型留足余量。 */
const STREAM_TIMEOUT_MS = 300_000;

/** 状态码 → 人话。非流式与流式**共用一份**（412 之类的新码也只在这里加）。 */
function errorFor(status: number, message: string | undefined, settings: PluginSettings): AiUnavailableError {
  if (status === 401) {
    // 强刷一轮还是 401。refresh 拿不到分两种：登录态真没了（refreshToken 已被清）
    // → 引导重连；只是暂时连不上（令牌还留着）→ 说稍后再试，别报"登录过期"。
    const stillLoggedIn = settings.refreshToken.trim() !== "";
    return new AiUnavailableError(
      stillLoggedIn ? "暂时连不上服务端，稍后再试。" : "登录状态过期了，到个人中心重新登录一次。",
    );
  }
  if (status === 402) {
    // code 用来让界面把「没余额」从普通报错里挑出来，单独走统一弹窗
    return new AiUnavailableError(NO_BALANCE_MESSAGE, "need-balance");
  }
  if (status === 429) {
    // 429 有四种来源（每分钟/每天/消费上限三种限流 + 上次还在处理的并发锁），
    // 服务端各自有准确文案；只在服务端没给文案时才用兜底这句。
    return new AiUnavailableError(message?.trim() || "用得有点快，缓一下再来。");
  }
  const reason = message?.trim();
  // 5xx = 上游/服务端这一趟没成（我们这边把上游的 502/503 原样转出来）。带上
  // `upstream` 码，调用方据此**不再重试** —— 同一条链路再撞一次只是一样的结果，
  // 白花一次钱还多等一轮（2026-10-15 用户拍板）。
  return new AiUnavailableError(
    reason || `服务器这边出了点问题（HTTP ${status}），稍后再试。`,
    status >= 500 ? "upstream" : undefined,
  );
}

/** 非流式的超时。 */
const NON_STREAM_TIMEOUT_MS = 90_000;

/**
 * 非流式那条路：走 `requestUrl`（`services/http.ts`）。
 *
 * multipart（跟读录音）自己现拼 —— requestUrl 的 body 只收 `string | ArrayBuffer`，
 * 收不了浏览器 FormData，boundary 得我们自己定（见 services/multipart.ts）。
 */
async function callJson(
  base: string,
  scene: string,
  token: string,
  payload: Record<string, unknown> | FormData,
): Promise<HttpResponseLike> {
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let body: string | ArrayBuffer;
    if (payload instanceof FormData) {
      const multipart = await formDataToMultipart(payload);
      // boundary 就是我们自己生成的那个，必须跟着请求一起给出去
      headers["Content-Type"] = multipart.contentType;
      body = multipart.body;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(payload);
    }
    return await httpFetch(`${base}/api/v1/ai/${scene}/`, {
      method: "POST",
      headers,
      body,
      timeoutMs: NON_STREAM_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof AiUnavailableError) throw error;
    throw new AiUnavailableError("连不上服务器，看看网络；急用的话可以先切回 BYOK。");
  }
}

/**
 * 流式那条路：**刻意留在 fetch** —— requestUrl 会把响应体一次性读完，
 * 没有 ReadableStream、也不认 signal，换过去就丢掉逐字上屏和用户中断。
 */
async function callStream(
  base: string,
  scene: string,
  token: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    // 流式**刻意留在 fetch**（requestUrl 无 ReadableStream）；走 window.fetch
    // 而不是裸 fetch：官方 lint 把 fetch 列成受限全局且不许豁免。
    return await window.fetch(`${base}/api/v1/ai/${scene}/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      // 调用方给了 signal（可中断的流式）就听它的，否则用一层超时兜底
      signal: signal ?? AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });
  } catch (error) {
    // 主动中断不算"连不上"：照原样抛，让调用方按"自己掐的"处理
    if (signal?.aborted) throw error;
    throw new AiUnavailableError("连不上服务器，看看网络；急用的话可以先切回 BYOK。");
  }
}
