/**
 * 常见 OpenAI 兼容服务商目录 —— 账户页「自定义模型」那轨里**供应商下拉框**的选项来源。
 *
 * ══ 为什么要有这份名单（2026-10-09 用户拍板）══════════════════════════
 * 原先这一轨只摆一个空的「接口地址」输入框（2026-10-05 用户点名撤掉了预设 chips）。
 * 问题是普通用户根本不知道自己那家的地址长什么样，得先去官网翻文档、抄一行 URL
 * 回来 —— 抄错一个字符，症状是"测试连接不通"，而且完全看不出错在哪。
 * 现在改成**选一家 = 地址填好**：版面上只出现品牌名，真实地址挂在悬停牌上。
 *
 * ⚠️ 三条纪律：
 *   1. 地址必须是各厂商**公开的 OpenAI 兼容端点**，且拼上 `/chat/completions`
 *      能通 —— 客户端就是这么拼的（见 services/ai/client.ts）。
 *      每家写进来的地址都改不动客户端的拼接方式，别在这儿加"特殊适配"。
 *   2. `modelHint` **只是输入框的占位提示**，不自动填、不当作保证 ——
 *      各家模型名换代快（而且火山方舟那类要填推理接入点 ID），
 *      填错模型名的症状是测试连接报错，比填错地址更难自查。
 *   3. `baseUrl` 只用于**认出用户手上这份配置是哪一家**（反查 + 代填）。
 *      认不出 = 自定义，走输入框，绝不猜。
 *
 * 🔥 改地址前先自己验一遍（curl 该地址 + /chat/completions）。地址错了，
 *    用户看到的现象是"这个下拉框选完连不上"，比手抄还冤。
 */

export interface AiProvider {
  /** 稳定标识，只用于列表与测试，不进设置 */
  id: string;
  /** 显示名（跟官网叫法对齐，别自创简称） */
  name: string;
  /** OpenAI 兼容端点根地址（客户端会在它后面拼 `/chat/completions`） */
  baseUrl: string;
  /** 该家常用的模型名/写法，只当输入框占位提示（见上面纪律 2） */
  modelHint: string;
}

/** 供应商下拉的「其他」那一项不是服务商，单独一个常量，别混进 AI_PROVIDERS。 */
export const CUSTOM_PROVIDER_NAME = "自定义";

/**
 * 国内常用在前，境外在后 —— 这份插件的用户大多在国内。
 * 顺序会直接变成下拉框里的顺序，改顺序 = 改用户第一眼看到什么。
 */
export const AI_PROVIDERS: readonly AiProvider[] = [
  {
    id: "deepseek",
    name: "深度求索 DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    modelHint: "deepseek-chat",
  },
  {
    id: "dashscope",
    name: "阿里云百炼（通义千问）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    modelHint: "qwen-plus",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    modelHint: "glm-4-plus",
  },
  {
    id: "moonshot",
    name: "月之暗面 Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    modelHint: "moonshot-v1-8k",
  },
  {
    id: "volcengine",
    name: "火山方舟（豆包）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    // 火山方舟的 model 字段通常是控制台里的「推理接入点 ID」，不是模型名
    modelHint: "ep-… 或 doubao-…",
  },
  {
    id: "siliconflow",
    name: "硅基流动 SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    modelHint: "deepseek-ai/DeepSeek-V3",
  },
  {
    id: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    modelHint: "MiniMax-Text-01",
  },
  {
    id: "hunyuan",
    name: "腾讯混元",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    modelHint: "hunyuan-turbos-latest",
  },
  {
    id: "qianfan",
    name: "百度千帆（文心）",
    baseUrl: "https://qianfan.baidubce.com/v2",
    modelHint: "ernie-4.5-turbo-128k",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    modelHint: "gpt-4o-mini",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    modelHint: "openai/gpt-4o-mini",
  },
];

/**
 * 去掉尾斜杠并折成小写 —— 比对地址时的唯一归一化口径。
 *
 * 用户手抄时很容易多带一个 `/`（客户端自己也 `replace(/\/+$/u, "")`，所以两种写法
 * 跑起来一模一样）；大小写虽然域名不敏感、路径敏感，但这份名单里没有大小写敏感的
 * 路径，折成小写只是让"手抄回来"的那份也能被认出来。
 */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/u, "").toLowerCase();
}

/**
 * 按地址反查是哪一家；认不出返回 `null`（= 自定义）。
 *
 * 🔥 绝不"猜最近的那家"：认错一家的后果是把用户的地址悄悄改成别家的 ——
 * 这是会在用户完全无感的情况下换掉他 AI 供应商的错误。
 */
export function providerByBaseUrl(baseUrl: string): AiProvider | null {
  const want = normalizeBaseUrl(baseUrl);
  if (!want) return null;
  return AI_PROVIDERS.find((p) => normalizeBaseUrl(p.baseUrl) === want) ?? null;
}

/** 模型名输入框的占位提示：认出来了给这家的例子，认不出只说要填什么（别乱举例子）。 */
export function modelPlaceholder(baseUrl: string): string {
  const provider = providerByBaseUrl(baseUrl);
  return provider ? `如 ${provider.modelHint}` : "填该服务商的模型名";
}
