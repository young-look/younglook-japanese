/**
 * 问题反馈接口 —— 个人中心「我的」页底部那颗「问题反馈」的落点。
 *
 * 服务端就一个接口：`POST /api/v1/feedback/create/`（multipart：正文 + 截图一起走），
 * 写完直接进 ops 的「用户反馈」队列（`core/feedback/views.py`）。
 *
 * ⚠️ 令牌由调用方先 `plugin.ensureAccessToken()` 拿好再传进来 —— 这个文件不认识
 *    plugin 实例，也不该自己去做换令牌那种事（换令牌是 `main.ts` 的职责）。
 *    提交是一次性的短动作，拿不到令牌就别发（门外的人写不了信）。
 *
 * 错误统一翻成人话抛 Error，弹窗直接展示。
 */
import type { PluginSettings } from "../settings/types";

/** 反馈分类 —— 与服务端 `UserFeedback.KIND_*` 一一对应，改这里要同步改服务端 */
export type FeedbackKind = "bug" | "idea" | "other";

export const FEEDBACK_KINDS: { key: FeedbackKind; label: string; hint: string }[] = [
  { key: "bug", label: "功能异常", hint: "哪坏了、点了什么、本来应该怎样" },
  { key: "idea", label: "产品建议", hint: "想要什么、现在缺什么" },
  { key: "other", label: "其他", hint: "说不清楚的都放这儿" },
];

/** 正文上限（服务端同款数字，改一处要改两处） */
export const FEEDBACK_MAX_LEN = 2000;
/** 一次最多带几张截图 */
export const FEEDBACK_MAX_IMAGES = 3;
/** 单张截图上限（字节） */
export const FEEDBACK_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface ApiEnvelope {
  code?: number;
  message?: string;
}

/**
 * 提交一条反馈。
 *
 * @param token 有效的 access token（`ensureAccessToken()` 的产物）
 */
export async function submitFeedback(
  settings: PluginSettings,
  token: string,
  input: { kind: FeedbackKind; content: string; files: File[]; clientVersion?: string },
): Promise<void> {
  const form = new FormData();
  form.append("kind", input.kind);
  form.append("content", input.content);
  if (input.clientVersion) form.append("client_version", input.clientVersion);
  for (const file of input.files) form.append("images", file, file.name || "shot.png");

  const base = settings.serverUrl.trim().replace(/\/+$/u, "");
  // 60 秒：三张截图 + 服务端压缩可能走几秒，15 秒那档在弱网下会先超时
  const response = await fetch(`${base}/api/v1/feedback/create/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });

  let payload: ApiEnvelope | null = null;
  try {
    payload = (await response.json()) as ApiEnvelope;
  } catch {
    payload = null;
  }
  if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
    throw new Error(payload?.message || "没提交成功，稍后再试。");
  }
}
