/**
 * 账单接口：个人中心「消费」页的余额与流水。
 *
 * 走 `/api/v1/billing/wallet/`（网页端账户页同一份数据源）。
 * 认证/401 重试与 `ai/hosted.ts` 同一套语义：先用手头令牌，401 就强制
 * 换一次令牌重试；再失败按"登录态在不在"给不同的人话。
 */
import { AiUnavailableError } from "./ai/client";
import { hostedBase, resolveToken } from "./ai/hosted";
import type { PluginSettings } from "../settings/types";

export interface WalletTransactionRow {
  /** 流水 id —— 窗口内滚动加载的游标就是它（before_id） */
  id: number;
  type: string;
  delta_millis: number;
  balance_after_millis: number;
  scene: string;
  charged_millis: number;
  note: string;
  created_at: string;
}

export interface WalletPayload {
  balance_millis: number;
  transactions: WalletTransactionRow[];
  /** 当前窗口内还有没有更早的（滚动加载只看它） */
  has_more?: boolean;
  /** 最早一笔流水的时间（北京时间口径）：范围下拉列到它所在那一档为止 */
  oldest_created_at?: string | null;
  /** 服务端实际生效的窗口（YYYY-MM-DD） */
  window_start?: string;
  window_end?: string;
}

/**
 * 明细查询：**一个窗口最多 3 个自然月**（服务端钉死）—— 无限滚动只发生在这个
 * 窗口内，往更早看要换窗口（`month`），不是一路往下滚。
 */
export interface WalletQuery {
  /** 起始月 YYYY-MM。**null / 不给 = 最近 3 个自然月**（由服务端按北京时间算） */
  month?: string | null;
  /** 游标：只回 id 小于它的（时间更早的）流水 */
  before_id?: number | null;
  /** 每页条数，服务端夹在 1..100 */
  limit?: number;
}

interface ApiEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

/**
 * ══ 消费明细「条目名称」的唯一真源 ═══════════════════════════════════
 *
 * 网页账户页（web/src/api/billing.ts）**逐字镜像这一份**：两个前端是两个独立
 * 工程，没法互相 import，所以靠 web/src/api/__tests__/billing-labels.spec.ts
 * 的契约测试把两份钉在一起 —— 谁只改一边，那边立刻红。
 *
 * 改这里 = 改那边。别只改一个地方（2026-10-11 之前就是各写各的，
 * 同一笔「解析」在插件叫「AI 解析」、在网页叫「单句解析」，用户直接看出来了）。
 */
export const SCENE_TEXT: Record<string, string> = {
  analyze: "AI 解析",
  imitation: "仿写核对",
  ask: "助手问答",
  read_aloud: "跟读核对",
};

/** 流水类型 → 界面文案（认不出的类型一律「其他」，绝不把英文原值摆给用户） */
export const TXN_TYPE_TEXT: Record<string, string> = {
  recharge: "充值",
  consume: "消费",
  refund: "退款",
  gift: "赠送",
  manual_adjust: "人工调整",
  revoke: "冲正",
  // 已废除（2026-10-06 计费定稿后不再产生），留着只为历史账单可读。
  // ⚠️ 别写带「到期」二字的文案 —— 账户页有护栏断言全页不含「到期」「天数」。
  starter_credit: "注册赠送（已废除）",
  starter_expire: "赠送作废（已废除）",
  service_fee: "服务费（已废除）",
};

/** 一笔流水的界面名称：场景名 > 类型名 > 备注 > 「其他」。 */
export function txnName(tx: { scene: string; note: string; type: string }): string {
  if (tx.scene && SCENE_TEXT[tx.scene]) return SCENE_TEXT[tx.scene];
  if (TXN_TYPE_TEXT[tx.type]) return TXN_TYPE_TEXT[tx.type];
  return (tx.note || "").trim() || "其他";
}

/**
 * 名称底下还要不要补一行小字 —— **只在名称来自场景时**才补。
 *
 * 那种情形备注确实是额外信息（跟读那笔：名称「跟读核对」+ 备注「语音评估 2.7 秒」）。
 * 名称来自类型/备注时就不补了：备注要么是同一件事的重复（充值那笔的默认备注
 * 「内置模型额度充值」），要么是给运营看的内部说明（人工退款的去向），
 * 摆到用户面前只是噪音。
 */
export function txnSubNote(tx: { scene: string; note: string; type: string }): string {
  if (!(tx.scene && SCENE_TEXT[tx.scene])) return "";
  const note = (tx.note || "").trim();
  return note && note !== txnName(tx) ? note : "";
}

/** 场景标识 → 界面文案；未识别的回落到调用方给的兜底（本机 BYOK 流水用）。 */
export function sceneText(scene: string, fallback: string): string {
  return SCENE_TEXT[scene] ?? (fallback || scene);
}


export async function fetchWallet(
  settings: PluginSettings,
  query?: WalletQuery,
): Promise<WalletPayload> {
  const base = hostedBase(settings);
  if (!base) throw new AiUnavailableError("服务端地址是空的，到设置里补上。");

  // 窗口 + 游标都走 query：不给 month 就是「最近 3 个月」，给了就是那一个历史窗口。
  // （网页端 api/billing.ts 的 fetchWallet(query) 是同一份契约的两头。）
  const qs = new URLSearchParams();
  if (query?.month) qs.set("month", query.month);
  if (query?.before_id != null) qs.set("before_id", String(query.before_id));
  if (query?.limit) qs.set("limit", String(query.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";

  const call = async (token: string) =>
    fetch(`${base}/api/v1/billing/wallet/${suffix}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

  let token = await resolveToken(settings, false);
  if (!token) {
    throw new AiUnavailableError(
      settings.refreshToken.trim()
        ? "暂时连不上服务端，稍后再试。"
        : "登录后才能看消费明细。登录或注册在个人中心里。",
    );
  }

  let response = await call(token);
  if (response.status === 401) {
    const fresh = await resolveToken(settings, true);
    if (fresh && fresh !== token) {
      token = fresh;
      response = await call(token);
    }
  }

  const text = await response.text().catch(() => "");
  let body: ApiEnvelope<WalletPayload> | null = null;
  try {
    body = text ? (JSON.parse(text) as ApiEnvelope<WalletPayload>) : null;
  } catch {
    body = null;
  }

  if (!response.ok || (body?.code !== undefined && body.code !== 0)) {
    const message = body?.message || "";
    if (response.status === 401) {
      throw new AiUnavailableError(
        settings.refreshToken.trim() ? "暂时连不上服务端，稍后再试。" : "登录状态过期了，到个人中心重新登录一次。",
      );
    }
    throw new AiUnavailableError(message || "消费明细暂时拿不到，稍后再试。");
  }

  const payload = body?.data;
  if (!payload || !Array.isArray(payload.transactions)) {
    throw new AiUnavailableError("消费明细暂时拿不到，稍后再试。");
  }
  return payload;
}
