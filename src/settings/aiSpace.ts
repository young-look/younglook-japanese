/**
 * AI 配置的「按本机空间分桶」（2026-10-17 用户拍板，方案 B）。
 *
 * ══ 为什么要有这个文件 ═════════════════════════════════════════════
 * `byok` / `byokSaved` / `byokLocked` / `aiMode` 原先躺在 `PluginSettings` 顶层
 * = 整个 vault 一份，**不认账号、不认空间**。于是换账号登录之后，上一个账号存的
 * 自定义模型配置还留在页面上：不光看得见（眼睛钮能把 Key 点成明文），
 * `resolveAiRoute` 更会直接拿它发请求 —— 费用记在**上一个人**的服务商账户上。
 * 这和 2026-10-10「共用电脑登出必须切回匿名空间」是同一条原则，凭据这块当时漏了。
 *
 * ══ 现在的模型 ═════════════════════════════════════════════════════
 * `byokBySpace[空间 id]` 各存一份（`AiConfigBundle`）。空间与账号是一一对应的
 * （见 `services/localSpace.ts`：匿名空间恒存在，登录/登出/换账号都切空间），
 * 所以「配置跟着空间走」= 配置跟着账号走：
 *   · 匿名空间一份 —— 未登录时用过的那份 Key，登出后回来还在；
 *   · 每个账号一份 —— 换账号看不到、也用不到别人的 Key。
 * 空间 id 是**本机**的（多台机器各不相同），所以 Key 依然不跨设备，换机要重填。
 * 这是刻意的：`PREF_KEYS` 白名单不含它、服务端 psync 也是禁写字段，凭据不上云。
 *
 * ══ 🔥 不变量（改代码前先读这段）═══════════════════════════════════
 * 顶层那四个字段是**当前 `activeSpaceId` 那份的工作副本**，`byokBySpace` 才是权威。
 * 只在两处同步，别再加第三处：
 *   1. `main.ts::saveSettings()` 落盘前 stash（内存 → 桶）—— 账户页/设置页改完
 *      都走这条路，所以它们不需要各自记得归档；
 *   2. 切空间/启动装载时 load（桶 → 内存）。
 * 因此**任何改 `activeSpaceId` 的地方都必须配对**：
 *   · 换到另一个空间 → `switchSpace(settings, fromId, toId)`
 *   · 同一个空间换了 id（认回旧库）→ `renameSpace(settings, oldId, newId)`
 * 目前三处：`main.ts` 的 `openSpace` / `reconcileActiveSpace` / `ensureStableVaultKey`。
 * 漏一处的后果是把 A 的 Key 写进 B 的桶 —— 正是这次要修的那个 bug。
 *
 * ⚠️ 新空间没有桶 = **空配置**（默认供应商 + 空 Key + 内置模型轨），绝不沿用
 * 上一个空间的。用户看到的就是「换了个账号，这里什么都没有」。
 */
import type { AiMode, ByokConfig, PluginSettings } from "./types";

/** 一个本机空间的完整 AI 配置。四个字段同进同出，别拆开来存。 */
export interface AiConfigBundle {
  /** 草稿（输入框里正在编辑的那份，落盘但不生效） */
  byok: ByokConfig;
  /** 已保存生效快照（点过「保存」并测通）；null = 这个空间从没保存过 */
  byokSaved: ByokConfig | null;
  /** 自定义模型卡片是否锁定 */
  byokLocked: boolean;
  /** 这个空间选的轨道 */
  aiMode: AiMode;
}

/**
 * 自定义模型的出厂默认值。
 *
 * 只是**表单的初值**（供应商下拉选中阿里云百炼、模型名占位 qwen-plus、Key 空），
 * 不代表任何配置存在 —— 空 Key + `byokSaved: null` 就等于"没配过"。
 */
export const DEFAULT_BYOK: ByokConfig = {
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: "",
  model: "qwen-plus",
};

/** 从未选择过 = 内置模型（2026-10-12 拍板）。 */
export const DEFAULT_AI_MODE: AiMode = "hosted";

/** 一个空间都没有配置时的样子。全新账号看到的就是它。 */
export function emptyBundle(): AiConfigBundle {
  return { byok: { ...DEFAULT_BYOK }, byokSaved: null, byokLocked: false, aiMode: DEFAULT_AI_MODE };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 非法/老口径的 aiMode 一律归到内置模型（与 2026-10-12 的迁移同一口径）。 */
export function normalizeAiMode(value: unknown): AiMode {
  return value === "byok" || value === "hosted" ? value : DEFAULT_AI_MODE;
}

function pickString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

/** 磁盘上那份（可能被手改、被旧版本写过）清洗成可信结构。 */
function sanitizeByok(value: unknown): ByokConfig | null {
  if (!isRecord(value)) return null;
  return {
    // 地址/模型名缺了就用默认值兜住：空地址会让表单看起来"坏掉了"，
    // 而默认值只是初值，真正能不能用仍由 apiKey 是否为空决定。
    baseUrl: pickString(value, "baseUrl") || DEFAULT_BYOK.baseUrl,
    apiKey: pickString(value, "apiKey"),
    model: pickString(value, "model") || DEFAULT_BYOK.model,
  };
}

function sanitizeBundle(raw: unknown): AiConfigBundle {
  const bundle = emptyBundle();
  if (!isRecord(raw)) return bundle;
  const draft = sanitizeByok(raw.byok);
  if (draft) bundle.byok = draft;
  // "存过没有"看**原始对象**里有没有真值，不能看清洗后的结果 —— 清洗会把空的
  // baseUrl/model 补成默认值，那样 `{}` 也会被当成一份有效快照。
  const savedRaw = isRecord(raw.byokSaved) ? raw.byokSaved : null;
  const hasSaved = savedRaw
    ? ["baseUrl", "apiKey", "model"].some(
        (key) => typeof savedRaw[key] === "string" && (savedRaw[key] as string).trim() !== "",
      )
    : false;
  bundle.byokSaved = hasSaved ? sanitizeByok(savedRaw) : null;
  bundle.byokLocked = raw.byokLocked === true;
  bundle.aiMode = normalizeAiMode(raw.aiMode);
  return bundle;
}

/** 取某个空间那份；没有 = 空配置（**不回落**到别的空间）。 */
export function bundleOf(
  map: Record<string, AiConfigBundle>,
  spaceId: string,
): AiConfigBundle {
  const id = spaceId.trim();
  const found = id ? map[id] : undefined;
  return found ? sanitizeBundle(found) : emptyBundle();
}

/**
 * 内存四字段 → 桶。`saveSettings()` 每次落盘前都调一次，所以草稿改动不会
 * 因为"忘了归档"而在下次切空间时丢掉。
 */
export function stashBundle(settings: PluginSettings, spaceId?: string): void {
  const id = (spaceId ?? settings.activeSpaceId).trim();
  if (!id) return; // 启动极早期还没有活跃空间：先不写，免得落一个空键
  settings.byokBySpace[id] = {
    byok: { ...settings.byok },
    byokSaved: settings.byokSaved ? { ...settings.byokSaved } : null,
    byokLocked: settings.byokLocked === true,
    aiMode: settings.aiMode,
  };
}

/** 桶 → 内存四字段。桶里没有就等于空配置 —— 新账号看到的就是这个。 */
export function loadBundle(settings: PluginSettings, spaceId: string): void {
  const bundle = bundleOf(settings.byokBySpace, spaceId);
  settings.byok = { ...bundle.byok };
  settings.byokSaved = bundle.byokSaved ? { ...bundle.byokSaved } : null;
  settings.byokLocked = bundle.byokLocked;
  settings.aiMode = bundle.aiMode;
}

/** 换空间：先把旧空间的改动归档，再装载新空间那份。 */
export function switchSpace(
  settings: PluginSettings,
  fromId: string,
  toId: string,
): void {
  const from = fromId.trim();
  const to = toId.trim();
  if (!to || from === to) return;
  stashBundle(settings, from);
  loadBundle(settings, to);
}

/** 空间换了 id（认回旧库）：把桶搬到新键上，内存那份不动。 */
export function renameSpace(
  settings: PluginSettings,
  oldId: string,
  newId: string,
): void {
  const from = oldId.trim();
  const to = newId.trim();
  if (!from || !to || from === to) return;
  const bundle = settings.byokBySpace[from];
  if (!bundle) return;
  settings.byokBySpace[to] = bundle;
  delete settings.byokBySpace[from];
}

/**
 * `fillDefaults` 用的迁移：把磁盘上的 AI 配置整理成分桶表。
 *
 * 两条路：
 *  · 已经有 `byokBySpace`（新版写过）→ 逐条清洗后原样用；
 *  · 没有（本次改动之前的配置，只有顶层那一份）→ 归到**当前活跃空间**，
 *    一个字节都不丢。归错空间的风险很低：那时活跃空间正是用户当时在用的那个。
 */
export function migrateAiSpaces(
  given: Partial<PluginSettings>,
  activeSpaceId: string,
): Record<string, AiConfigBundle> {
  const raw: unknown = given.byokBySpace;
  const map: Record<string, AiConfigBundle> = {};

  if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      const id = key.trim();
      if (!id) continue;
      map[id] = sanitizeBundle(value);
    }
    return map;
  }

  const id = activeSpaceId.trim();
  if (!id) return map;
  map[id] = sanitizeBundle({
    byok: given.byok,
    byokSaved: given.byokSaved,
    byokLocked: given.byokLocked,
    aiMode: given.aiMode,
  });
  return map;
}
