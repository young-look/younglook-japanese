/**
 * 插件发 HTTP 的**统一出口**：一律走 Obsidian 的 `requestUrl`，不用 `fetch`。
 *
 * ── 为什么 ────────────────────────────────────────────────────────────────
 * 社区目录要求插件里的网络请求走 `requestUrl`（Electron 主进程发出，不受
 * 渲染层 CORS 限制）。这条只适用于**一次性拿到完整响应**的请求 ——
 * 流式（AI 的逐字输出）必须留在 `ai/client.ts` 里用 `fetch`，因为
 * `requestUrl` 没有 ReadableStream、也没有 signal，换过去就丢掉逐字上屏和
 * 用户中断。详见 ai/client.ts 里 readSse 上方的说明。
 *
 * ── 为什么不直接 import obsidian ──────────────────────────────────────────
 * `import type` 会被编译期擦除（不产生 require），运行时再取 —— 静态引入会让
 * node 侧单测直接崩（node 里没有 obsidian 运行时）。取法见 loadRequestUrl：
 * **require 优先**（Obsidian 注入的解析器认 "obsidian"），动态 import 只是
 * ESM 兜底。
 *
 * ── 对外形状为什么还是 Response 那一套 ────────────────────────────────────
 * 各 service 本来就通过 `FetchLike` 参数接收注入的实现，单测里注入的是
 * 假 Response。沿用这套形状（status / ok / json() / text() / arrayBuffer()），
 * 切换实现时调用点一行都不用改，单测也一行都不用改。
 */

import type { RequestUrlParam, RequestUrlResponse } from "obsidian";

type RequestUrlFn = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

/** 与 fetch 的 Response **结构兼容**（真的 Response 也满足它），便于单测注入。 */
export interface HttpResponseLike {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface YlInit extends RequestInit {
  /**
   * requestUrl 没有 signal，超时只能用 Promise.race 自己实现。
   * **不传就是不限时** —— 下载词典/演示素材那种大文件不能设上限。
   */
  timeoutMs?: number;
}

export type FetchLike = (input: string, init?: YlInit) => Promise<HttpResponseLike>;

/** 单测注入口（生产环境永远是 requestUrl 那条路）。 */
let injected: FetchLike | null = null;

export function setHttpImpl(fn: FetchLike | null): void {
  injected = fn;
}

/** 插件里所有非流式请求的默认实现。 */
export function httpFetch(input: string, init?: YlInit): Promise<HttpResponseLike> {
  return (injected ?? requestUrlFetch)(input, init);
}

/**
 * 拿到 requestUrl 本体。
 *
 * 🔥 **必须走 `require`，不能 `await import("obsidian")`**：插件代码被 Obsidian 用
 * `window.eval("(function anonymous(require,module,exports){…})")` 包起来执行，
 * 注入的 `require` 才认 "obsidian"（映射表里 `obsidian` 对应官方 API）；
 * 动态 `import()` 走的是**浏览器模块解析**，裸说明符对着 `app://obsidian.md`
 * 解析必然失败 —— 旧版 bangumi.ts 就是这么静默挂掉的（fail-soft 没人发现）。
 * 动态 import 只留给 ESM 环境（单测里永远走不到这里，有注入桩兜着）。
 */
let cachedRequestUrl: RequestUrlFn | null | undefined;

/** 取 requestUrl 本体（require 优先，import 兜底）。bangumi.ts 的直连请求也用它。 */
export async function loadRequestUrl(): Promise<RequestUrlFn> {
  if (cachedRequestUrl) return cachedRequestUrl;
  if (typeof require === "function") {
    try {
      const mod = require("obsidian") as { requestUrl?: RequestUrlFn };
      if (typeof mod?.requestUrl === "function") {
        cachedRequestUrl = mod.requestUrl;
        return cachedRequestUrl;
      }
    } catch {
      // 拿不到就落到下面的动态 import 再试一次
    }
  }
  const mod = (await import(/* @vite-ignore */ "obsidian")) as { requestUrl?: RequestUrlFn };
  if (typeof mod?.requestUrl !== "function") {
    throw new Error("拿不到 Obsidian 的 requestUrl（当前环境不是 Obsidian？）");
  }
  cachedRequestUrl = mod.requestUrl;
  return cachedRequestUrl;
}

async function requestUrlFetch(input: string, init?: YlInit): Promise<HttpResponseLike> {
  const requestUrl = await loadRequestUrl();
  const request = requestUrl({
    url: input,
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: toHeaderRecord(init?.headers),
    body: init?.body as string | ArrayBuffer | undefined,
    // 非 2xx 一律不抛，由调用点自己判 status（和 fetch 的行为一致）
    throw: false,
  });

  const timeoutMs = init?.timeoutMs ?? 0;
  const settled = timeoutMs
    ? await Promise.race([request, sleep(timeoutMs)])
    : await request;
  if (!settled) throw abortError("请求超时");

  return toResponseLike(settled);
}

function sleep(ms: number): Promise<null> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(null), ms);
  });
}

/** 超时抛的错沿用 AbortError，调用点里判断 `err.name === "AbortError"` 的那套照旧生效。 */
function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value;
    return out;
  }
  return { ...(headers as Record<string, string>) };
}

function toResponseLike(response: RequestUrlResponse): HttpResponseLike {
  const headers = response.headers ?? {};
  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    // requestUrl 已经把响应体读完了，这里只是把它包成本来就约定的形状。
    // 它这三个属性本身是 `any`（服务端给什么就是什么），出这个门一律当 unknown。
    json: async (): Promise<unknown> => response.json as unknown,
    text: async () => response.text,
    arrayBuffer: async () => response.arrayBuffer,
  };
}
