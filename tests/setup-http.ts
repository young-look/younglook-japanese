/**
 * 单测的 HTTP 实现：转发到全局 `fetch`。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 插件里非流式请求统一走 `requestUrl`（`src/services/http.ts`），而 `obsidian`
 * 在单测里被 alias 到 `tests/obsidianStub.ts`、它的 requestUrl **故意抛异常**
 * （怕有人偷偷在单测里发真请求）。但业务代码确实会走到这一层 —— 于是由装配
 * 文件把 http 实现换成"转发到全局 fetch"，现有那些 `vi.stubGlobal("fetch", …)`
 * 的用例一个都不用改，真 requestUrl 那条路也永远不会被单测碰到。
 *
 * 流式请求不经过这里：它们直接用 `fetch`（requestUrl 不支持流式），照旧被
 * 同一批 stubGlobal 拦住。
 */
import { setHttpImpl } from "../src/services/http";

setHttpImpl(async (input, init) => {
  const { timeoutMs, ...rest } = init ?? {};
  // requestUrl 没有 signal，超时是 http.ts 自己做的；这里还原成 fetch 的超时
  const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  return await fetch(input, { ...rest, signal });
});
