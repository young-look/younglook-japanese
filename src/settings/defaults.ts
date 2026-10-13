import { randomUuid } from "../core/ids";
import {
  BUILD_ENV,
  PRESETS,
  type BuildEnv,
  type ServerEnv,
  normalizeServerEnv,
  resolveTargets,
} from "../config/env";
import type { LocalSpace, PluginSettings } from "./types";
import { nextSpaceId } from "../services/localSpace";

/** vault 里放学习资料的目录名。笔记、截图、数据都在它下面（见 markdown/studyNote.ts）。 */
export const DEFAULT_VAULT_FOLDER = "young_look";

/** 上一版的默认值。存的值正好等于它 = 用户从没自己改过 → 可以跟着新默认走。 */
export const LEGACY_DEFAULT_VAULT_FOLDER = "看动漫学日语";

export function defaultSettings(): PluginSettings {
  return {
    vaultFolder: DEFAULT_VAULT_FOLDER,
    // 留空 = 默认位置（vault 外的系统应用数据目录 media/，见 services/mediaStore.ts）。
    // 不在这里算成绝对路径：换台机器默认位置也不同，硬编进 data.json 就再也不跟着走了。
    mediaDir: "",
    // 默认「内置模型」（2026-10-12 拍板：从未选择过 = 内置）。老配置里存的旧默认
    // "off" 由 fillDefaults 里的 migrateAiMode 升级，见那边注释。
    aiMode: "hosted",
    byok: {
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "",
      model: "qwen-plus",
    },
    // 「已保存生效」的自定义模型配置快照：新用户从没保存过 = null。
    // 草稿在 byok 里，只有快照参与生效判定（见 services/ai/gate.ts）。
    byokSaved: null,
    byokLocked: false,
    // 默认跟着构建环境走：开发构建连本机，生产构建连线上
    serverEnv: "auto",
    customServerUrl: "",
    serverUrl: resolveTargets("auto", "", BUILD_ENV).api,
    authServerUrl: "",
    authToken: "",
    refreshToken: "",
    lastStatsSyncAt: 0,
    aiBalanceMillis: 0,
    accountProfile: null,
    autoSyncMinutes: 15,
    // 首次安装时生成一次，之后随 settings 持久化，保证库名稳定。
    // ⚠️ 生成之后必须立刻落盘（见 main.ts 的 ensureStableVaultKey），
    // 否则每次重载都换新库 = 用户看到"数据全没了"。
    vaultLocalId: randomUuid().replace(/-/g, "").slice(0, 16),
    // 本机空间表由 fillDefaults 的 migrateSpaces 补齐，这里只给空表 ——
    // vaultLocalId 在老配置里已经定住了，空间表得按它算，不能各写一份。
    spaces: [],
    activeSpaceId: "",
    autoOpenPage: true,
    lastView: "",
    // 第一次进学习页的「装词典」提醒还没出现过
    dictPromptSeen: false,
    lastUpdateCheckAt: 0,
    prefsUpdatedAt: "",
    // 每日校验跑到哪天了（"YYYY-MM-DD"）；空串 = 从没校验过
    lastVerifyDay: "",
  };
}

/**
 * 从老配置里推「该连哪台」。
 *
 * 老版本只有 `serverUrl` 一个字段，值多半已经落盘成线上地址。只改默认值
 * 对**已装好的插件**完全无效（有值就不会被覆盖），所以这里要显式迁移：
 * 存的正好是**另一个环境**的预设地址时，换成当前构建环境的那个 —— 这样
 * 重建一次、重载插件就切换了，不用手改 data.json。
 *
 * 用户自己填过的地址（两个预设都不是）保留，当作 custom。
 */
export function migrateServerEnv(
  given: Partial<PluginSettings>,
  buildEnv: BuildEnv = BUILD_ENV,
): { env: ServerEnv; customUrl: string } {
  if (given.serverEnv !== undefined) {
    return {
      env: normalizeServerEnv(given.serverEnv),
      customUrl: typeof given.customServerUrl === "string" ? given.customServerUrl.trim() : "",
    };
  }

  const stored = typeof given.serverUrl === "string" ? given.serverUrl.trim().replace(/\/+$/u, "") : "";
  const other = buildEnv === "dev" ? "prod" : "dev";
  if (!stored || stored === PRESETS[other].api || stored === PRESETS[buildEnv].api) {
    return { env: "auto", customUrl: "" };
  }
  return { env: "custom", customUrl: stored };
}

/**
 * 资料目录的默认值升级。
 *
 * 和 migrateServerEnv 同一个道理：只改 `defaultSettings` 对**已经装好的插件**完全
 * 无效（存里有值就不会被默认值覆盖）。老用户存的多半正是旧默认「看动漫学日语」——
 * 那是当年的默认、不是他自己挑的，所以可以顺手升级到新默认；自己起过名字的保留。
 */
export function migrateVaultFolder(given: Partial<PluginSettings>): string {
  const stored = typeof given.vaultFolder === "string" ? given.vaultFolder.trim() : "";
  if (!stored || stored === LEGACY_DEFAULT_VAULT_FOLDER) return DEFAULT_VAULT_FOLDER;
  return stored;
}

/** 老配置里带的游标可能是不认识的结构（别的版本写的），坏了就当没有。 */
function isPlainRecord(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (item) => typeof item === "number" && Number.isFinite(item),
  );
}

/**
 * 本机空间表的补齐与自愈。
 *
 * **老配置里没有这一项** —— 补成「就一个空间、用的还是原来那个库、还没被认领」，
 * 于是老用户的库名、数据、行为全都原地不动（零迁移）。
 *
 * 🔥 新不变量（2026-10-10 模型重构）：`spaces` 里**恒有且仅有**一条 `owner === ""`
 * 的**匿名空间**（登录/登出切换的那块"地板"）。老配置（旧模型下认领过、唯一那条
 * 已归某个账号）缺它 → 补一条**新的空匿名空间**，老库原地不动。
 *
 * 坏了就就地修好，判据一律偏向「宁可丢归属，也不能丢库」：
 *  · id 空 / 重复 → 丢掉那一条（没有 id 就没有库，留着也没用）；
 *  · 表为空 → 按 vaultLocalId 建第一条（**只有表真的为空时才补**：
 *    认回旧库会把第一条的 id 换掉，那时不能再按 vaultLocalId 补一条出来）；
 *  · 没有匿名空间 → 补一条新的（id 用 nextSpaceId，与已有条目绝不撞车）；
 *  · activeSpaceId 指向不存在的 id → 落回第一条。
 */
export function migrateSpaces(
  given: Partial<PluginSettings>,
  vaultLocalId: string,
): { spaces: LocalSpace[]; activeSpaceId: string } {
  const raw = Array.isArray(given.spaces) ? given.spaces : [];
  const seen = new Set<string>();
  const spaces: LocalSpace[] = [];
  for (const item of raw) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    spaces.push({
      id,
      owner: typeof item.owner === "string" ? item.owner.trim() : "",
      ownerServer: typeof item.ownerServer === "string" ? item.ownerServer.trim() : "",
      ownerName: typeof item.ownerName === "string" ? item.ownerName.trim() : "",
    });
  }
  if (spaces.length === 0) {
    spaces.push({ id: vaultLocalId, owner: "", ownerServer: "", ownerName: "" });
  }
  // 匿名空间不变量：一条都没有就补一条新的空匿名空间（那个库还不存在，开库时才建）。
  if (!spaces.some((space) => space.owner === "")) {
    spaces.push({
      id: nextSpaceId(spaces, vaultLocalId),
      owner: "",
      ownerServer: "",
      ownerName: "",
    });
  }
  const wanted = typeof given.activeSpaceId === "string" ? given.activeSpaceId.trim() : "";
  const activeSpaceId = spaces.some((space) => space.id === wanted) ? wanted : spaces[0].id;
  return { spaces, activeSpaceId };
}

/**
 * AI 模式的默认值升级（2026-10-12 拍板：**从未选择过 = 默认内置模型**）。
 *
 * settings 是整包落盘的 —— 从没碰过模式选择的存量用户，data.json 里躺着的
 * 也是旧默认 "off"。跟 migrateVaultFolder 同一个判据：存的正好是**旧默认**
 * = 没自己挑过 → 升到新默认「内置模型」；显式选过 byok / hosted 的不动。
 * （旧口径下 off + 有余额本来就在跑内置模型，这次迁移对他们只是名正言顺；
 *  off + 没余额的用户则从"什么都用不了"变成"选了内置、差余额"，弹窗会给出路。）
 */
export function migrateAiMode(given: Partial<PluginSettings>): PluginSettings["aiMode"] {
  return given.aiMode === "byok" || given.aiMode === "hosted" ? given.aiMode : "hosted";
}

/** 旧版本缺字段时的补齐。settings 只增不删，这里统一补默认。 */
export function fillDefaults(raw: unknown, buildEnv: BuildEnv = BUILD_ENV): PluginSettings {
  const base = defaultSettings();
  const given = (raw ?? {}) as Partial<PluginSettings>;
  const { env, customUrl } = migrateServerEnv(given, buildEnv);
  const vaultLocalId = given.vaultLocalId?.trim() ? given.vaultLocalId : base.vaultLocalId;
  const { spaces, activeSpaceId } = migrateSpaces(given, vaultLocalId);
  return {
    ...base,
    ...given,
    vaultLocalId,
    spaces,
    activeSpaceId,
    // AI 模式：存的正好是旧默认 "off"（= 从没自己挑过）升到「内置模型」
    aiMode: migrateAiMode(given),
    // 资料目录：存的值正好是老默认值时当作"没自定义过"，升到新默认
    vaultFolder: migrateVaultFolder(given),
    byok: { ...base.byok, ...(given.byok ?? {}) },
    // 老版本没有这几个字段（草稿/快照分离是 2026-10-10 才引入的），补成
    // "从没保存过 / 编辑态" —— 老用户在账户页点一次「保存」就进入新机制
    byokSaved: given.byokSaved ?? null,
    byokLocked: given.byokLocked ?? false,
    aiBalanceMillis: Number.isFinite(given.aiBalanceMillis) ? Number(given.aiBalanceMillis) : 0,
    accountProfile: given.accountProfile ?? null,
    // 老版本没有这几个字段，补成"未登录 / 没同步过"
    refreshToken: typeof given.refreshToken === "string" ? given.refreshToken : "",
    lastStatsSyncAt: Number.isFinite(given.lastStatsSyncAt) ? Number(given.lastStatsSyncAt) : 0,
    lastUpdateCheckAt: Number.isFinite(given.lastUpdateCheckAt) ? Number(given.lastUpdateCheckAt) : 0,
    // 老版本没有这一项：补成"还没提醒过"。老用户第一次进学习页会看到一次
    // —— 他们多半本来就有 dict/（软链装法），弹窗前会先判磁盘，有就不弹。
    dictPromptSeen: given.dictPromptSeen === true,
    authServerUrl: typeof given.authServerUrl === "string" ? given.authServerUrl : "",
    // 偏好同步的 LWW 时间戳：老版本没有，补成空串（= 0，云端偏好因此能落进来）
    prefsUpdatedAt: typeof given.prefsUpdatedAt === "string" ? given.prefsUpdatedAt : "",
    lastVerifyDay: typeof given.lastVerifyDay === "string" ? given.lastVerifyDay : "",
    // serverUrl 是派生值：每次加载都按当前环境重算，别信存下来的那份
    serverEnv: env,
    customServerUrl: customUrl,
    serverUrl: resolveTargets(env, customUrl, buildEnv).api,
  };
}
