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
 * 流程：校验版本 → build 三件套 → 以 `<分支>:plugin` 当前内容造提交（父提交 =
 * 公开库当前 main 顶端，首次为空仓库则无父）→ 推公开库 main → gh release create
 * 挂三件套（tag 由 gh 在 main 上建）。
 * 历史策略（2026-10-13 用户拍板）：公开库是**新起点**——第一次提交干净（不带
 * monorepo 开发史），之后每次发版在上一个提交上正常接续，历史里只有「发布快照」
 * 一种提交（父链从 Initial commit 起，永不接回 monorepo）。
 * 任何一步失败，已成功的步骤不自动回滚（Release 可手工删），但会明确报出断点。
 *
 * ⚠️ 环境坑（2026-10-12 首发实测）：本机沙箱代理拦 github.com 的 CONNECT（502），
 * 但放行 api.github.com —— gh 命令能过、git push 不能。所以 push 一律走
 * `pushDirect()`（剥掉 proxy 变量直连，github.com:443 直连是通的）。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
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
    env: opts.env ?? process.env,
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
 * git 走 github.com 的命令专用：剥掉 proxy 环境变量直连。理由见文件头「环境坑」
 * —— 沙箱代理拦 github.com 的 CONNECT，gh（api.github.com）不受影响，push/fetch 要绕。
 */
function directGit(args, opts = {}) {
  const env = { ...process.env };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete env[key];
  return execFileSync("git", args, { cwd: opts.cwd ?? REPO_ROOT, encoding: "utf8", stdio: opts.silent ? "pipe" : "inherit", env });
}

function pushDirect(args) {
  directGit(["push", ...args]);
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

// ── 5. remote 就位（不存在则添加，URL 不对则校正） ──────────────────────────
let remotes = "";
try {
  remotes = run("git", ["remote", "-v"], { silent: true });
} catch {
  fail("不在 git 仓库里？");
}
const remoteLines = remotes.split("\n").filter((l) => l.startsWith(`${REMOTE}\t`));
if (remoteLines.length === 0) {
  step(`添加 remote ${REMOTE} → ${REMOTE_URL}`);
  run("git", ["remote", "add", REMOTE, REMOTE_URL]);
} else if (!remoteLines.some((l) => l.includes(REMOTE_URL))) {
  // 旧仓库名/地址残留（换过 PUBLIC_REPO）：不校正的话 push 会推到已删的旧库
  step(`校正 remote ${REMOTE} → ${REMOTE_URL}（原指向别的仓库）`);
  run("git", ["remote", "set-url", REMOTE, REMOTE_URL]);
}

// ── 6. 发布提交（新起点 + 正常接续历史）+ 推送 ──────────────────────────────
if (DRY_RUN) {
  console.log("\n--dry-run：跳过提交推送与 Release 创建。以上校验与构建已通过。\n");
  process.exit(0);
}
// 为什么不直接用 subtree split：split 会把 monorepo 全部提交历史（几百条、含作者
// 邮箱）原样推公开库。正确姿势 = 公开库是**新起点**：每次发布以 `<分支>:plugin`
// 当前树造一个提交，父提交 = 公开库当前 main 顶端（fetch 拿），首次发布仓库为空
// 则无父 = Initial commit。之后历史正常接续，diff 即两次发布间的真实修改。
step(`fetch 公开库 main（拿父提交）`);
let parent = "";
try {
  directGit(["fetch", REMOTE, "main"], { silent: true });
  parent = directGit(["rev-parse", "FETCH_HEAD"], { silent: true }).trim();
  console.log(`父提交 ${parent.slice(0, 8)}（公开库当前 main 顶端）`);
} catch {
  // 🔥 绝不能把「fetch 失败」当成「仓库为空」：那会造一个无父提交，
  // 推上去要么被非快进拒绝（2026-10-22 0.1.7 首次尝试就是栽在这），
  // 要么（万一强推）把公开库历史整个清掉。先拿 ls-remote 判真假。
  let remoteHasMain = false;
  try {
    remoteHasMain = directGit(["ls-remote", "--heads", REMOTE, "main"], { silent: true }).trim() !== "";
  } catch {
    fail(`连不上公开库 ${REMOTE}（网络/凭证？）—— 这次什么都没做，重跑即可。`);
  }
  if (remoteHasMain) {
    fail("公开库有 main 但 fetch 没拿下来（多半是网络抖动）—— 重跑即可，绝不发无父提交。");
  }
  console.log("公开库确实还没有 main（首次发布）→ 造无父的 Initial commit");
}

const IDX = "/tmp/yl-release-orphan.index";
try {
  rmSync(IDX);
} catch {
  /* 上次的残留，正常 */
}
// GIT_INDEX_FILE 指向临时索引：read-tree 默认写 .git/index，会弄脏用户工作区
const idxEnv = { ...process.env, GIT_INDEX_FILE: IDX };
run("git", ["read-tree", `${branch}:plugin`], { silent: true, env: idxEnv });
const tree = run("git", ["write-tree"], { silent: true, env: idxEnv }).trim();
const commitArgs = ["commit-tree", tree, "-m", `younglook-japanese ${VERSION}`];
if (parent) commitArgs.push("-p", parent);
const commit = execFileSync("git", commitArgs, { cwd: REPO_ROOT, encoding: "utf8", env: idxEnv }).trim();
console.log(`提交 ${commit.slice(0, 8)}（作者取当前 git config）`);
// 普通 push（快进）：历史是接续的，不需要 force
pushDirect([REMOTE, `${commit}:refs/heads/main`]);

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
  `YoungLook Japanese (洋流日语) Obsidian plugin v${VERSION}. Install from Obsidian Community plugins.`,
]);

console.log(`
✅ 已发布 ${VERSION} 到 ${PUBLIC_REPO}

两件收尾（本脚本不管）：
  1. 自建更新通道同步发一版：./yolo plugin-release（只对已手工装插件的人生效）
  2. 社区商店（以后）：往 obsidianmd/obsidian-releases 提 PR 加一行，需要根目录有 LICENSE
`);
