/**
 * 「AI 现在能不能点」的唯一判定口。
 *
 * 学习页有三个 AI 入口（AI 解析 / AI 核对 / 右下角小助手），以前各自判断
 * `aiMode !== "off"` —— 只区分「开没开 AI」，**完全不知道登录状态**，
 * 于是未登录点内置模型只会拿到一句服务端错误。这里把判定收成一处。
 *
 * 一条不能破的边界（见 docs/13）：**BYOK 永久免费，不该要账号**。
 * 用户自带 Key 时请求直连他自己的端点，一个 token 都不经过我们，
 * 所以 BYOK 只要「已保存」就放行，跟登录状态无关（2026-10-10 起「已保存」
 * = 账户页点过「保存」、留有 byokSaved 快照，见 resolveAiRoute）。
 * （2026-10-12 用户拍板：两条轨**平级自由选**，废除「有余额先扣余额」的自动
 * 顺序 —— aiMode 选谁就用谁；余额多少只影响内置模型那条轨本身能不能用。）
 *
 * 余额也算门（2026-10-04 用户拍板）：内置模型已登录但余额 ≤ 0 → `need-balance`，
 * AI 按钮置灰，点击弹统一弹窗问「现在去配置吗」（2026-10-05 改口径：不再单独劝
 * 充值 —— 用户可能想改用自己的模型，充值和自定义模型都在账户页选）。缓存可能过期：
 * 真去问了才发现 402 的，由 isNoBalanceError 分流接住，仍归同一颗窗。
 */
import type { PluginSettings } from "../../settings/types";

export type AiGateReason = "off" | "need-login" | "need-balance" | "need-key";

export type AiGate =
  | { ok: true }
  | { ok: false; reason: AiGateReason; message: string; canLogin: boolean };

/** 配置 AI 的落点：个人中心的「账户」页（双轨：自定义模型 / 内置模型） */
const AI_SETTINGS = "个人中心「账户」页";

/**
 * 实际该走哪条轨 —— 双轨的**唯一**判定口（门控与调用层共用一份）。
 *
 * 规则（2026-10-12 用户拍板）：**用户选谁就用谁**，没有自动顺序 ——
 * `aiMode` 直接决定轨道。自定义模型仍须「已保存」才生效（`byokSaved` 快照，
 * 见 settings/types.ts）：账户页上填而未保存的草稿不参与判定，编辑期旧快照
 * 继续生效。`off` 是新用户的默认值。
 */
export function resolveAiRoute(settings: PluginSettings): "off" | "byok" | "hosted" {
  if (settings.aiMode === "byok") {
    return byokSavedReady(settings) ? "byok" : "off";
  }
  return settings.aiMode;
}

/** trim 后的 BYOK 三项 —— 齐全判断基于它，别拿原文比。 */
function byokTrimmed(c: PluginSettings["byok"]): { baseUrl: string; apiKey: string; model: string } {
  return { baseUrl: c.baseUrl.trim(), apiKey: c.apiKey.trim(), model: c.model.trim() };
}

/** 「已保存」的自定义模型是否足以生效：快照在且三项齐全。 */
export function byokSavedReady(settings: PluginSettings): boolean {
  const saved = settings.byokSaved;
  if (!saved) return false;
  const t = byokTrimmed(saved);
  return Boolean(t.baseUrl && t.apiKey && t.model);
}

/**
 * 账户页自定义模型那张卡的 UI 状态（2026-10-10 拍板的「保存/编辑」机制）。
 *
 * **锁定**（`byokLocked`，显式标志不走推导）= 输入框只读、按钮显示「编辑」；
 * 点「编辑」解锁进编辑态，此时草稿怎么改都不影响生效 —— 生效的永远是
 * `byokSaved` 快照（resolveAiRoute 只读它），点「保存」测连通过才落新快照。
 */
export function byokUiState(settings: PluginSettings): { locked: boolean; hasSaved: boolean } {
  const hasSaved = byokSavedReady(settings);
  return { locked: hasSaved && settings.byokLocked, hasSaved };
}

export function resolveAiGate(settings: PluginSettings): AiGate {
  const route = resolveAiRoute(settings);
  if (route === "off") {
    // 「选了自定义模型但没配好」单独说清出路：草稿在 byok 里、生效要快照
    // （byokSaved），对这类用户说"还没开启 AI"会把人绕晕 —— 他明明已经选了。
    if (settings.aiMode === "byok") {
      return {
        ok: false,
        reason: "off",
        message: `自定义模型还没配好：接口地址、API Key、模型名要填全并保存。到${AI_SETTINGS}补全。`,
        canLogin: false,
      };
    }
    return {
      ok: false,
      reason: "off",
      message: `还没开启 AI，AI 解析这一类功能都还用不了。到${AI_SETTINGS}选一种方式就能用。`,
      canLogin: false,
    };
  }

  if (route === "hosted") {
    if (!settings.authToken.trim()) {
      return {
        ok: false,
        reason: "need-login",
        // 说清"为什么内置模型要账号"，而不是干巴巴一句"请登录"
        message: "内置模型按用量扣费，余额记在账号上，所以要先用邮箱登录。登录或注册都在个人中心里。",
        canLogin: true,
      };
    }
    // 余额 ≤ 0 就别让请求白跑一趟了（判据与 canUseAiReadAloud 同一条：
    // 2026-10-02 拍板「只有一条钱」，`ai_balance_millis > 0` 即算充过）
    if (settings.aiBalanceMillis <= 0) {
      return {
        ok: false,
        reason: "need-balance",
        message: "内置模型余额用完了，充值或改用自定义模型后才能继续用。",
        canLogin: false,
      };
    }
    return { ok: true };
  }

  // 走到这里 = route === "byok"：用户选了自定义模型，用的是**已保存**的快照。
  // 判定读 byokSaved 快照（route 为 byok 时它必然齐全），不读草稿 ——
  // 编辑中的改动没保存前不该被使用。
  const { baseUrl, apiKey, model } = settings.byokSaved!;
  if (!apiKey.trim() || !baseUrl.trim() || !model.trim()) {
    return {
      ok: false,
      reason: "need-key",
      message: `自定义模型的配置还没填全。到${AI_SETTINGS}补全。`,
      canLogin: false,
    };
  }

  return { ok: true };
}