/**
 * 构建环境：**分支即环境——dev 分支连本机，master 分支连线上**。
 *
 * 这个区别必须在**构建时**定死，不能靠用户去设置里手填：
 * 只要还有"忘了改"的可能，就一定会有人在调试时把测试数据和真金白银
 * 的余额写到线上库里。所以 dev 分支出来的产物天然指向
 * `127.0.0.1`，master 分支（发版）出来的天然指向 `younglook.cc`。
 * 想提前出线上包：`npm run build:prod`（不受分支影响，见 esbuild.config.mjs）。
 *
 * 地址分两套，别混着用：
 *  · `api` —— 接口、内置模型、统计上报，插件自己发请求用的；
 *  · `web` —— 网页端地址，只在**打开浏览器**时用（登录连接页、充值页）。
 *    ⚠️ 本机这两者端口不同：前端是 vite（5173），Django（8060）**只提供
 *    /api、/admin、/storage**，直接开 8060 的 /plugin/connect 是 404。
 */

/** 用户在设置里能选的服务端。auto = 跟着构建环境走。 */
export type ServerEnv = "auto" | "dev" | "prod" | "custom";

export type BuildEnv = "dev" | "prod";

export interface ServerTargets {
  api: string;
  web: string;
}

export const PRESETS: Record<"dev" | "prod", ServerTargets> = {
  dev: { api: "http://127.0.0.1:8060", web: "http://127.0.0.1:5173" },
  prod: { api: "https://younglook.cc", web: "https://younglook.cc" },
};

/** 由 esbuild 的 `define` 注入（见 esbuild.config.mjs / vitest.config.mts）。 */
declare const __YL_ENV__: string | undefined;
declare const __YL_BRANCH__: string | undefined;

export const BUILD_ENV: BuildEnv = readBuildEnv();

/** 构建时所在的 git 分支；拿不到（脱离 git 构建等）就是空串。设置页会显示，排查问题用。 */
export const BUILD_BRANCH: string = readBranch();

/** 开发构建：界面上要一直把这个事实摆在用户眼前。 */
export const IS_DEV_BUILD = BUILD_ENV === "dev";

function readBuildEnv(): BuildEnv {
  try {
    return __YL_ENV__ === "prod" ? "prod" : "dev";
  } catch {
    // 没注入（比如拿裸 ts 直接跑）：退回 dev，宁可连本机也不能连线上
    return "dev";
  }
}

function readBranch(): string {
  try {
    return __YL_BRANCH__ ?? "";
  } catch {
    return "";
  }
}

function normalize(url: string): string {
  return url.trim().replace(/\/+$/u, "");
}

/**
 * 算出真正要连的地址。
 *
 * @param env 用户的选择；auto = 跟着构建环境。
 * @param customUrl env = custom 时的自定义地址。
 * @param buildEnv 构建环境，默认取当前构建注入的那个（测试里可以显式传）。
 */
export function resolveTargets(
  env: ServerEnv,
  customUrl: string,
  buildEnv: BuildEnv = BUILD_ENV,
): ServerTargets {
  if (env === "dev") return { ...PRESETS.dev };
  if (env === "prod") return { ...PRESETS.prod };
  if (env === "custom") {
    const api = normalize(customUrl) || PRESETS[buildEnv].api;
    // 自定义地址一般前后端同一个域名（线上就是这样）；
    // 唯独手工填成"本机的 8060"时，网页端还得是 vite 的 5173。
    const web = api === PRESETS.dev.api ? PRESETS.dev.web : api;
    return { api, web };
  }
  return { ...PRESETS[buildEnv] };
}

/** 老配置里没这个字段时的兜底（脏数据一律当 auto）。 */
export function normalizeServerEnv(value: unknown): ServerEnv {
  return value === "dev" || value === "prod" || value === "custom" ? value : "auto";
}
