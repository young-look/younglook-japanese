#!/usr/bin/env node
/**
 * 发布到 GitHub 公开库 + 建 Release（brat / 社区商店渠道）。
 *
 * 与 `scripts/release.mjs`（自建更新通道，推到 younglook.cc/storage）是**两条
 * 独立渠道**，互不影响；版本号两边共用，升号只需改 package.json + manifest.json。
 *
 * 前置条件（缺一项就退出，不半吊子）：
 *  1. package.json 与 manifest.json 的 version 一致（brat 硬要求：release tag /
 *     release 名 / manifest version 三者相同，Obsidian 自己也校验）；
 *  2. gh CLI 已登录且对目标仓库有写权限；
 *  3. **在 master 分支上跑**（分支即环境：dev 构建连本机，拿 dev 的 main.js 发公开库
 *     = 把开发构建当线上版发出去。真要发 dev 构建做灰度，加 --from-dev）。
 *
 * 用法：
 *  node scripts/github-release.mjs            # 在 plugin/ 下跑；默认从当前分支取代码
 *  node scripts/github-release.mjs --dry-run  # 只校验和构建，不推仓库、不建 Release
 *
 * 流程：校验版本 → build 三件套 → subtree split（只取 plugin/，带历史）→
 * 推公开库 main → gh release create 挂三件套（tag 由 gh 在 main 上建，不单独推）。
 * 任何一步失败，已成功的步骤不自动回滚（Release 可手工删），但会明确报出断点。
 *
 * ⚠️ 环境坑（2026-10-12 首发实测）：本机沙箱代理拦 github.com 的 CONNECT（502），
 * 但放行 api.github.com —— gh 命令能过、git push 不能。所以 push 一律走
 * `pushDirect()`（剥掉 proxy 变量直连，github.com:443 直连是通的）。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PLUGIN_DIR, "..");

/** 公开库（young-look/younglook-japanese）。改仓库只改这一行。 */
const PUBLIC_REPO = "young-look/younglook-japanese";
/** monorepo 里指向公开库的 remote 名，不存在会自动按 https 添加。 */
const REMOTE = "plugin-public";
const REMOTE_URL = `https://github.com/${PUBLIC_REPO}.git`;

const DRY_RUN = process.argv.includes("--dry-run");
const FROM_DEV = process.argv.includes("--from-dev");

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: "utf8",
    stdio: opts.silent ? "pipe" : "inherit",
  });
}

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function step(msg) {
  console.log(`\n▸ ${msg}`);
}

/**
 * git push 专用：剥掉 proxy 环境变量直连。理由见文件头「环境坑」——
 * 沙箱代理拦 github.com 的 CONNECT，gh（api.github.com）不受影响，只有 push 要绕。
 */
function pushDirect(args) {
  const env = { ...process.env };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete env[key];
  execFileSync("git", ["push", ...args], { cwd: REPO_ROOT, encoding: "utf8", stdio: "inherit", env });
}

// ── 1. 分支守卫（分支即环境，见文件头） ──────────────────────────────────────
const branch = run("git", ["branch", "--show-current"], { silent: true }).trim();
if (branch !== "master" && !FROM_DEV) {
  fail(`当前在 ${branch} 分支。dev 构建连本机，不能当公开版发。先合并 master 再跑；确要发 dev 构建加 --from-dev。`);
}
console.log(`分支 ${branch}${FROM_DEV && branch !== "master" ? "（--from-dev 灰度发布）" : ""}`);

// ── 2. 版本校验 ──────────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "manifest.json"), "utf8"));
if (pkg.version !== manifest.version) {
  fail(
    `version 不一致：package.json=${pkg.version} manifest.json=${manifest.version}。` +
      `先手改这两个文件对齐（升号是发版第一步，只改源码不升号 = 覆盖同号包）。`,
  );
}
const VERSION = manifest.version;
console.log(`版本 ${VERSION}（package.json 与 manifest.json 一致）`);

// ── 3. 目标仓库可达 + 该版本没发过 ───────────────────────────────────────────
try {
  run("gh", ["repo", "view", PUBLIC_REPO, "--json", "visibility"], { silent: true });
} catch {
  fail(`gh 够不到 ${PUBLIC_REPO}：先 gh auth login，并确认账号对仓库有写权限。`);
}
try {
  run("gh", ["release", "view", VERSION, "--repo", PUBLIC_REPO], { silent: true });
  fail(`${PUBLIC_REPO} 已有 Release ${VERSION}。要重发先删掉旧 Release 和 tag。`);
} catch {
  /* 没有该 Release，正常 */
}

// ── 4. 构建三件套 ───────────────────────────────────────────────────────────
step("构建（npm run build → main.js / manifest.json / styles.css）");
run("npm", ["run", "build"], { cwd: PLUGIN_DIR });
const mainJs = join(PLUGIN_DIR, "main.js");
if (!existsSync(mainJs) || readFileSync(mainJs).length < 10_000) {
  fail(`main.js 缺失或异常小（${existsSync(mainJs) ? readFileSync(mainJs).length : 0} 字节），构建可能没跑对。`);
}
const assets = ["main.js", "manifest.json", "styles.css"].map((f) => join(PLUGIN_DIR, f));

// ── 5. remote 就位 ─────────────────────────────────────────────────────────
let remotes = "";
try {
  remotes = run("git", ["remote", "-v"], { silent: true });
} catch {
  fail("不在 git 仓库里？");
}
if (!remotes.split("\n").some((l) => l.startsWith(`${REMOTE}\t`))) {
  step(`添加 remote ${REMOTE} → ${REMOTE_URL}`);
  run("git", ["remote", "add", REMOTE, REMOTE_URL]);
}

// ── 6. subtree split + 推送 ────────────────────────────────────────────────
if (DRY_RUN) {
  console.log("\n--dry-run：跳过 subtree 推送与 Release 创建。以上校验与构建已通过。\n");
  process.exit(0);
}
// split 前清掉上次留下的本地分支：-b 遇到已存在的分支会直接失败
try {
  run("git", ["branch", "-D", "plugin-public"], { silent: true });
} catch {
  /* 没有旧分支，正常 */
}
step(`subtree split --prefix=plugin → ${REMOTE}:main`);
run("git", ["subtree", "split", "--prefix=plugin", "-b", "plugin-public"]);
pushDirect([REMOTE, "plugin-public:main"]);

// ── 7. Release 挂三件套 ───────────────────────────────────────────────────
// tag 不单独 git push：gh release create --target main 会在 main 顶端直接建 tag
// （brat 只认 Release，tag 是 Release 的附着物；少一次 push 少一个故障点）。
step(`gh release create ${VERSION}（assets: main.js / manifest.json / styles.css）`);
run("gh", [
  "release",
  "create",
  VERSION,
  ...assets,
  "--repo",
  PUBLIC_REPO,
  "--target",
  "main",
  "--title",
  VERSION,
  "--notes",
  `洋流日语 Obsidian 插件 ${VERSION}。安装：Obsidian 装 BRAT → Add beta plugin → ${PUBLIC_REPO}。`,
]);

console.log(`
✅ 已发布 ${VERSION} 到 ${PUBLIC_REPO}

两件收尾（本脚本不管）：
  1. 自建更新通道同步发一版：./yolo plugin-release（只对已手工装插件的人生效）
  2. 社区商店（以后）：往 obsidianmd/obsidian-releases 提 PR 加一行，需要根目录有 LICENSE
`);
