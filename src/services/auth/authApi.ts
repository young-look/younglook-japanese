/**
 * 账号资料接口 —— 全部**令牌认证**（`Authorization: Bearer <access>`）。
 *
 * ⚠️ 登录 / 注册不在这里：2026-10-02 登录机制改造后，插件**不再有任何登录表单**，
 * 登录 / 注册在网页完成，插件拿一次性连接码换令牌（`main.ts exchangeConnectCode`，
 * 服务端 `POST /api/v1/auth/plugin-exchange/`）。这里只管「连上之后」的事：
 * 改昵称、改邮箱。
 *
 * 错误统一翻成人话抛 Error，调用方（个人中心的资料编辑）直接展示。
 */
import type { PluginSettings } from "../../settings/types";

interface ApiEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

function base(settings: PluginSettings): string {
  return settings.serverUrl.trim().replace(/\/+$/u, "");
}

/** 带令牌的 POST；失败抛带人话的 Error。 */
async function postProfile<T>(
  settings: PluginSettings,
  path: string,
  body: Record<string, unknown>,
  fallbackError: string,
): Promise<T | null> {
  const token = settings.authToken.trim();
  if (!token) throw new Error("连接账号后才能改资料。");
  const response = await fetch(`${base(settings)}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  let payload: ApiEnvelope<T> | null = null;
  try {
    payload = (await response.json()) as ApiEnvelope<T>;
  } catch {
    payload = null;
  }
  if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
    throw new Error(payload?.message || fallbackError);
  }
  return payload?.data ?? null;
}

// ── 资料编辑（个人中心「学习」页的身份头，接口见 core/users/views.py） ──────────────

/** 改昵称。 */
export async function updateNickname(settings: PluginSettings, nickname: string): Promise<void> {
  await postProfile(settings, "/api/v1/users/me/profile/", { nickname }, "昵称没改成，稍后再试。");
}

/**
 * 更换头像：multipart 传图片文件，服务端居中裁方存成 200×200 WEBP。
 * 返回新头像地址（/storage/… 相对路径，文件名每次都是新的，不用操心缓存）。
 */
export async function updateAvatar(settings: PluginSettings, file: File): Promise<string> {
  const token = settings.authToken.trim();
  if (!token) throw new Error("连接账号后才能改资料。");
  const form = new FormData();
  form.append("avatar", file);
  const response = await fetch(`${base(settings)}/api/v1/users/me/avatar/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  let payload: ApiEnvelope<{ avatar?: string }> | null = null;
  try {
    payload = (await response.json()) as ApiEnvelope<{ avatar?: string }>;
  } catch {
    payload = null;
  }
  if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
    throw new Error(payload?.message || "头像没换成，稍后再试。");
  }
  return payload?.data?.avatar ?? "";
}

/** 修改邮箱·第一步：向新邮箱发验证码。 */
export async function requestEmailChange(settings: PluginSettings, newEmail: string): Promise<void> {
  await postProfile(
    settings,
    "/api/v1/users/me/email/request/",
    { email: newEmail.trim().toLowerCase() },
    "验证码没发出去，稍后再试。",
  );
}

/** 修改邮箱·第二步：新邮箱 + 验证码一起提交，通过即改绑。 */
export async function confirmEmailChange(
  settings: PluginSettings,
  newEmail: string,
  code: string,
): Promise<string> {
  const data = await postProfile<{ email?: string }>(
    settings,
    "/api/v1/users/me/email/confirm/",
    { email: newEmail.trim().toLowerCase(), code: code.trim() },
    "邮箱没改成，请核对验证码。",
  );
  return data?.email ?? newEmail;
}
