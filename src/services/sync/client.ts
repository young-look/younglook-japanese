/**
 * 统一快照通道的传输层（`pushSnapshot` / `pullSnapshot`）。
 *
 * 2026-10-06 起这是插件唯一的同步通道：一个请求吃下全部集合
 * （集合清单与白名单政策见 `snapshot.ts`）。服务端的老三条通道
 * （stats/notes/corrections 端点）为旧版插件保留，但本文件不再有它们的函数。
 *
 * 服务端按行 LWW 落库、只增不删（细节见 `core/psync/services/snapshot.py`）；
 * 这里负责把 HTTP 状态码翻成人话 —— 插件是后台跑的，用户看不到状态码。
 */

import { httpFetch, type FetchLike, type HttpResponseLike } from "../http";
import type { ManifestEntry, SnapshotPayload, SnapshotRow } from "./snapshot";

function normalizeUrl(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/u, "");
}

// ── 统一快照通道（sync/push + sync/pull，2026-10-06 大改造）──────────

export interface SnapshotPushResult {
  ok: boolean;
  /** 各集合实际落库行数；ok 为 false 时为 null */
  applied: Record<string, number> | null;
  skipped: number;
  message: string;
  /** 401（令牌失效，交给 ensureAccessToken 决定是否清登录态） */
  unauthorized: boolean;
  /** 403 need=recharge：余额用尽，同步暂停（数据不丢，充值自动恢复） */
  needRecharge: boolean;
  /**
   * 413：包太大（撞服务端或网关的上限）。**这是重试信号，不是失败** ——
   * 调用方应当按更小的预算重建 payload 再推一次。以前只当普通错误处理，
   * 结果是下个 tick 用同样的包再撞一次，同步从此永久停摆。
   */
  tooLarge: boolean;
}

export interface SnapshotPullResult {
  ok: boolean;
  collections: Record<string, SnapshotRow[]>;
  message: string;
  unauthorized: boolean;
  needRecharge: boolean;
}

function failSnapshotPush(message: string, flags: { unauthorized?: boolean; needRecharge?: boolean; tooLarge?: boolean } = {}): SnapshotPushResult {
  return { ok: false, applied: null, skipped: 0, message, unauthorized: flags.unauthorized ?? false, needRecharge: flags.needRecharge ?? false, tooLarge: flags.tooLarge ?? false };
}

function failSnapshotPull(message: string, flags: { unauthorized?: boolean; needRecharge?: boolean } = {}): SnapshotPullResult {
  return { ok: false, collections: {}, message, unauthorized: flags.unauthorized ?? false, needRecharge: flags.needRecharge ?? false };
}

export interface PushSnapshotOptions {
  serverUrl: string;
  accessToken: string;
  payload: SnapshotPayload;
  fetchImpl?: FetchLike;
}

export async function pushSnapshot(options: PushSnapshotOptions): Promise<SnapshotPushResult> {
  const base = normalizeUrl(options.serverUrl);
  if (!base) return failSnapshotPush("还没填服务端地址，到设置里补上。");
  if (!options.accessToken) return failSnapshotPush("还没登录。");

  let response: HttpResponseLike;
  try {
    response = await (options.fetchImpl ?? httpFetch)(
      `${base}/api/v1/plugin/sync/push/`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.accessToken}`,
        },
        body: JSON.stringify(options.payload),
        // 全量快照（进度+词库+解析…）有几 MB，超时给宽一点
        timeoutMs: 60_000,
      },
    );
  } catch {
    return failSnapshotPush("连不上服务器，看看网络。");
  }

  if (response.status === 401) return failSnapshotPush("登录状态失效了。", { unauthorized: true });
  if (response.status === 403) return failSnapshotPush("云同步需要账户有余额，充值后自动恢复。", { needRecharge: true });
  if (response.status === 413) return failSnapshotPush("这一趟太大了，正在分批重传。", { tooLarge: true });
  if (!response.ok) {
    return failSnapshotPush(`服务器这边出了点问题（HTTP ${response.status}），稍后再试。`);
  }

  interface Body {
    data?: { applied?: Record<string, number>; skipped?: number };
  }
  let body: Body | null = null;
  try {
    body = (await response.json()) as Body;
  } catch {
    body = null;
  }
  return {
    ok: true,
    applied: body?.data?.applied ?? {},
    skipped: body?.data?.skipped ?? 0,
    message: "",
    unauthorized: false,
    needRecharge: false,
    tooLarge: false,
  };
}

export interface ManifestResult {
  ok: boolean;
  rows: ManifestEntry[];
  message: string;
  unauthorized: boolean;
  needRecharge: boolean;
}

export interface VerifyReportResult {
  ok: boolean;
  message: string;
}

export interface PullSnapshotOptions {
  serverUrl: string;
  accessToken: string;
  fetchImpl?: FetchLike;
}

/**
 * 拉云端行清单（每日校验用）。
 *
 * 只回 `(collection, cid, content_hash)`，不回行内容 —— 几万行的清单也就
 * 80KB 量级，一天一次无所谓。
 */
export async function fetchSnapshotManifest(options: PullSnapshotOptions): Promise<ManifestResult> {
  const base = normalizeUrl(options.serverUrl);
  if (!base) {
    return { ok: false, rows: [], message: "还没填服务端地址，到设置里补上。", unauthorized: false, needRecharge: false };
  }
  if (!options.accessToken) {
    return { ok: false, rows: [], message: "还没登录。", unauthorized: false, needRecharge: false };
  }

  let response: HttpResponseLike;
  try {
    response = await (options.fetchImpl ?? httpFetch)(
      `${base}/api/v1/plugin/sync/manifest/`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${options.accessToken}` },
        body: "{}",
        timeoutMs: 60_000,
      },
    );
  } catch {
    return { ok: false, rows: [], message: "连不上服务器，看看网络。", unauthorized: false, needRecharge: false };
  }

  if (response.status === 401) {
    return { ok: false, rows: [], message: "登录状态失效了。", unauthorized: true, needRecharge: false };
  }
  if (response.status === 403) {
    return { ok: false, rows: [], message: "云同步需要账户有余额，充值后自动恢复。", unauthorized: false, needRecharge: true };
  }
  if (!response.ok) {
    return {
      ok: false, rows: [],
      message: `服务器这边出了点问题（HTTP ${response.status}），稍后再试。`,
      unauthorized: false, needRecharge: false,
    };
  }

  interface Body {
    data?: { rows?: ManifestEntry[] };
  }
  let body: Body | null = null;
  try {
    body = (await response.json()) as Body;
  } catch {
    body = null;
  }
  return {
    ok: true,
    rows: Array.isArray(body?.data?.rows) ? body.data.rows : [],
    message: "",
    unauthorized: false,
    needRecharge: false,
  };
}

export interface VerifyReportOptions {
  serverUrl: string;
  accessToken: string;
  /** 校验发生在哪天（"YYYY-MM-DD"）；服务端按天去重，插件一天同步很多趟也只算一次 */
  day: string;
  drift: boolean;
  missing: string[];
  mismatched: string[];
  fetchImpl?: FetchLike;
}

/**
 * 上报一次每日校验的结果。
 *
 * 服务端靠它数「连续几天不一致」，到阈值就告警 —— 这是留痕之外唯一
 * 能让我们自己知道「同步逻辑写错了」的通道。
 */
export async function reportVerify(options: VerifyReportOptions): Promise<VerifyReportResult> {
  const base = normalizeUrl(options.serverUrl);
  if (!base) return { ok: false, message: "还没填服务端地址，到设置里补上。" };
  if (!options.accessToken) return { ok: false, message: "还没登录。" };

  try {
    const response = await (options.fetchImpl ?? httpFetch)(
      `${base}/api/v1/plugin/sync/verify/`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.accessToken}`,
        },
        body: JSON.stringify({
          day: options.day,
          drift: options.drift,
          missing: options.missing,
          mismatched: options.mismatched,
        }),
        timeoutMs: 60_000,
      },
    );
    if (!response.ok) return { ok: false, message: `HTTP ${response.status}` };
  } catch {
    return { ok: false, message: "连不上服务器，看看网络。" };
  }
  return { ok: true, message: "" };
}

/** 全量拉取（换机恢复 / 多设备合并的数据源），本地按 LWW 合并（见 snapshot.ts）。 */
export async function pullSnapshot(options: PullSnapshotOptions): Promise<SnapshotPullResult> {
  const base = normalizeUrl(options.serverUrl);
  if (!base) return failSnapshotPull("还没填服务端地址，到设置里补上。");
  if (!options.accessToken) return failSnapshotPull("还没登录。");

  let response: HttpResponseLike;
  try {
    response = await (options.fetchImpl ?? httpFetch)(
      `${base}/api/v1/plugin/sync/pull/`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${options.accessToken}` },
        body: "{}",
        timeoutMs: 60_000,
      },
    );
  } catch {
    return failSnapshotPull("连不上服务器，看看网络。");
  }

  if (response.status === 401) return failSnapshotPull("登录状态失效了。", { unauthorized: true });
  if (response.status === 403) return failSnapshotPull("云同步需要账户有余额，充值后自动恢复。", { needRecharge: true });
  if (!response.ok) {
    return failSnapshotPull(`服务器这边出了点问题（HTTP ${response.status}），稍后再试。`);
  }

  interface Body {
    data?: { collections?: Record<string, SnapshotRow[]> };
  }
  let body: Body | null = null;
  try {
    body = (await response.json()) as Body;
  } catch {
    body = null;
  }
  const collections = body?.data?.collections;
  return {
    ok: true,
    collections: collections && typeof collections === "object" ? collections : {},
    message: "",
    unauthorized: false,
    needRecharge: false,
  };
}
