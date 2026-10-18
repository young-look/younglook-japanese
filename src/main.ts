import { FileSystemAdapter, MarkdownView, Modal, Notice, Plugin, Setting, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { rmSync } from "node:fs";
import { fillDefaults } from "./settings/defaults";
import { renameSpace, stashBundle, switchSpace } from "./settings/aiSpace";
import { appDataDir } from "./services/appData";
import { SettingsTab } from "./settings/tab";
import type { AccountProfile, LocalSpace, PluginSettings } from "./settings/types";
import { accountLabel, anonymousSpace, findSpaceForAccount, nextSpaceId, resolveActiveSpaceId, sameServer } from "./services/localSpace";
import { spaceHasUserData } from "./services/spaceData";
import { LocalSpaceModal } from "./views/LocalSpaceModal";
import { IS_DEV_BUILD, resolveTargets } from "./config/env";
import { STORE, VaultDb, listVaultDatabaseKeys, probeVaultDatabase } from "./storage/db";
import { reclaimableKeys, type VaultDbProbe } from "./services/vaultKey";
import { recoverLocalLibrary } from "./services/recover";
import { ImportModal } from "./views/ImportModal";
import { VIEW_TYPE_STUDY, StudyView, type CardOrigin } from "./views/StudyView";
import { VIEW_TYPE_PERSONAL, PersonalCenterView } from "./views/PersonalCenterView";
import { LEGACY_VIEW_TYPES } from "./views/legacy";
import { guessFromFilename, VIDEO_EXTENSIONS } from "./services/guess";
import { detectFormat } from "./services/subtitle/parse";
import { setAccessTokenProvider, setBillingSink } from "./services/ai/hosted";
import { setByokUsageSink } from "./services/ai/client";
import { isAccessExpired } from "./services/auth/tokens";
import { refreshSession } from "./services/auth/session";
import {
  applySnapshotPull,
  buildSnapshotPayload,
  CHUNK_BUDGET_BYTES,
  diffManifest,
  MAX_CHUNK_ROUNDS,
  MIN_CHUNK_BUDGET_BYTES,
  splitSnapshotPayload,
} from "./services/sync/snapshot";
import {
  fetchSnapshotManifest,
  pullSnapshot,
  pushSnapshot,
  reportVerify,
  type SnapshotPushResult,
} from "./services/sync/client";
import { healLegacyImitationRows } from "./services/study";
import { claimLocalNotes, invalidateNoteCache } from "./services/notes/mine";
import { dayKey } from "./services/studyDays";
import { installBrandIcons, markAsBrandIcon } from "./ui/brandIcon";
import { log } from "./core/logger";
import { clockTime } from "./core/clock";

export default class YoungLookPlugin extends Plugin {
  settings: PluginSettings = fillDefaults(undefined);
  db!: VaultDb;
  private statusBar!: HTMLElement;
  /** 上次拉账号快照的时间戳，用来做节流（见 refreshAccountProfile） */
  private lastProfileFetch = 0;
  /** 正在刷新令牌时并发进来的请求挂在这上面，避免同时换两次（重复刷新会让前一个 refresh 作废） */
  private refreshInFlight: Promise<string | null> | null = null;
  /** 统计上报的定时器 id（改同步间隔时要重启） */
  private autoSyncTimer: number | null = null;
  /** 正在跑的上报任务；避免定时器与手动点击撞在一起推两遍 */
  private syncInFlight: Promise<void> | null = null;
  /** 最近一次上报失败的原因；null = 没失败过。状态栏拿它显示"同步失败" */
  private lastSyncError: string | null = null;
  /** 是否有一趟上报正在跑（同步图标转圈的那段，见 updateStatusBar） */
  private syncActive = false;
  /**
   * 「认领」弹窗正在等用户选（存的是账号 uid，null = 没在弹）。
   *
   * 登录流程与 `refreshAccountProfile` 的兜底都会调 `bindSpaceToAccount`，
   * 不留这道闸就会弹第二个认领窗。
   */
  private bindingPrompt: string | null = null;
  /**
   * 云同步是否被「余额用尽」挡住了 —— **服务端 403 `need=recharge` 说的才算数**
   * （不是拿本地余额推的）。没有它的话，余额用尽之后状态栏会一直挂着上一次
   * 成功同步的旧时间，看着像一切正常，实际一个字节都没在传。
   * 只有「被服务端挡回来」置 true、成功同步一趟置 false（充值后下一趟自动清）。
   */
  private syncPaused = false;
  /** 个人中心的来路：退出时按它回到原位（列表页 / 学习页第 N 句）。 */
  private personalOrigin: PersonalOrigin = { from: "list" };
  /**
   * 一次性：这次打开要落在哪个页签（AI 门控弹窗「去配置」→ "wallet"、
   * 学习卡片「返回」回历史页 → "sentences"）。
   * PersonalCenterView.render() 读一次就清，不残留到下一次打开。
   */
  personalInitialTab: "profile" | "wallet" | "vocab" | "sentences" | null = null;

  async onload(): Promise<void> {
    // 视图类型必须在任何 await 之前同步注册（官方要求）：启动时布局恢复可能
    // 和插件加载并行，注册晚了恢复出来的 leaf 会拿不到实例。
    this.registerView(VIEW_TYPE_STUDY, (leaf) => new StudyView(leaf, this));
    this.registerView(VIEW_TYPE_PERSONAL, (leaf) => new PersonalCenterView(leaf, this));

    // data.json 就放在 vault 里的 .obsidian/plugins/<id>/ 下面，
    // 所以 vaultLocalId 天然是每个 vault 一份 —— 本地库也因此按 vault 隔离。
    //
    // ⚠️ 这里的顺序不能动：先定住库名（必要时把历史数据认回来）并**立刻落盘**，
    // 再开库。库名没落盘时每次重载都会换一个新空库，用户看到的是"数据全没了"。
    const raw = (await this.loadData()) as Partial<PluginSettings> | null;
    this.settings = fillDefaults(raw);
    // 空间表被自愈补齐（老配置缺匿名空间）→ 落一次盘让 data.json 跟上，
    // 否则每次启动都会重算（id 稳定，但没必要）。
    if (!Array.isArray(raw?.spaces) || !raw.spaces.some((space) => (space?.owner ?? "").trim() === "")) {
      await this.saveSettings();
    }
    await this.ensureStableVaultKey(raw?.vaultLocalId?.trim() ?? "");

    // 服务端地址：按「用户选择 + 构建环境」算出来写回 settings.serverUrl，
    // 之后所有发请求的地方只读这一个派生值。换过环境就把旧令牌作废
    // （两边的 JWT 各签各的，留着只会一直 401）。
    await this.applyServerEnv();
    await this.dropLoginStateIfServerChanged();

    // 按登录态选对**该打开哪份本机数据**（只选库、不弹窗）：登录了待在"我的空间"、
    // 没登录回匿名空间。这是旧模型"启动复查必答窗"的替代（2026-10-10 模型重构）。
    await this.reconcileActiveSpace();

    // 开的是**当前空间**的库，不是 vaultLocalId 直接拼的那个：
    // 一份本机数据只跟一个账号（2026-10-09），换过账号就可能有多个空间。
    // 老用户的 spaces 只有一条、id 正是 vaultLocalId ⇒ 行为与以前完全一致。
    this.db = await VaultDb.open(this.settings.activeSpaceId);
    // 启动竞态兜底：布局恢复可能比这行先到（视图已建、db 还是 undefined，页面停在
    // "正在初始化"占位上）。库一开好就把已经开着的页面重绘一遍 —— 用户不用自己刷新。
    void this.refreshOpenViews();
    await this.tagVaultPath();

    // 演示素材（首页那条「示例素材」）不再在启动时铺：它改走服务端按需下载，用户在
    // 那一行上点「开始学」时才下载并导入（见 services/demoPack.ts）。启动零网络依赖。

    // 🔧 dev 专属重置入口：./yolo reset-client 经 obsidian://younglook-reset 触发。
    // 只在开发构建注册 —— 线上一律没有这个 handler，社区里一条链接不可能清用户数据。
    if (IS_DEV_BUILD) {
      this.registerObsidianProtocolHandler("younglook-reset", () => this.resetClientData());
    }

    // 修补中间版本漏记 `imitationVerifiedAt` 的历史进度行（AI 判过却标"未核对"）。
    // 几行数据、一次扫描，同步做完再往下走 —— 让用户第一次打开卡片就是对的。
    try {
      const healed = await healLegacyImitationRows(this.db);
      if (healed > 0) log.info("已补记历史仿写的核对状态", { rows: healed });
    } catch (error) {
      log.warn("修补历史仿写记录失败（不影响使用）", error);
    }

    // 老布局的笔记搬到新目录（幂等、后台跑、出错不影响使用）。
    // ⚠️ 挂在 onLayoutReady 上：vault 索引没就绪时列目录会拿到空结果，迁移会把
    // "还没扫到"误判成"没有旧数据"，然后写下完成标记，旧笔记就再也没人管了。
    // 位置也必须在 ensureStableVaultKey 之后 —— 找回旧库时会把旧库里的笔记条目
    // 并进来，那批条目的截图路径同样要跟着搬。

    // 老版本还有第二个入口（「今日练习」侧栏面板）。它已经并进学习页，
    // 但工作区布局里可能还留着那个面板的实例 —— 启动时清掉，别让用户看到半死不活的空壳。
    for (const legacy of LEGACY_VIEW_TYPES) {
      this.app.workspace.detachLeavesOfType(legacy);
    }

    // 图标（ribbon + 学习页标签）换成海獭，细节在 ui/brandIcon.ts。
    // 必须先装样式再建 ribbon，不然按钮会先以 lucide 的模样画一帧。
    installBrandIcons([VIEW_TYPE_STUDY]);

    // 唯一的 ribbon 入口：个人中心从列表页头像点进去（学习卡片
    // 2026-10-02 起不放账号位），不再单独占一个 ribbon 位（2026-09-30 用户定）。
    // 图标名仍是 "book-open"：它被 CSS 换成海獭位图，样式没装上时退回书本。
    markAsBrandIcon(
      this.addRibbonIcon("book-open", "打开洋流日语", () => {
        void this.activateLeaf(VIEW_TYPE_STUDY, true);
      }),
    );

    this.addCommand({
      id: "young-look-open-study",
      name: "打开洋流日语",
      callback: () => void this.activateLeaf(VIEW_TYPE_STUDY, true),
    });

    this.addCommand({
      id: "young-look-refresh",
      name: "刷新本地统计",
      callback: () => void this.refreshOpenViews(),
    });

    this.addCommand({
      id: "young-look-import",
      name: "导入字幕（填写本机路径）",
      callback: () => {
        new ImportModal(this.app, this, "").open();
      },
    });

    this.addCommand({
      id: "young-look-sync-now",
      name: "立即同步学习记录到网页端",
      callback: () => void this.syncStats(true),
    });

    // 字幕、视频文件放进 vault 的话，右键就能直接导入 —— 省掉手填路径。
    // 右键字幕预填字幕路径；右键视频预填视频路径。哪份文件在手边就走哪边。
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) return;
        const absolute = this.absolutePath(file.path);
        if (!absolute) return;

        const isSubtitle = detectFormat(file.name) !== null;
        const isVideo = VIDEO_EXTENSIONS.has(file.extension.toLowerCase());
        if (!isSubtitle && !isVideo) return;

        const guess = guessFromFilename(file.name);
        menu.addItem((item) =>
          item
            .setTitle("用洋流导入这一集")
            .setIcon("languages")
            .onClick(() => {
              new ImportModal(this.app, this, isSubtitle ? absolute : "", {
                title: guess.workTitle,
                number: guess.number,
                season: guess.season,
                year: guess.year,
                videoPath: isVideo ? absolute : undefined,
              }).open();
            }),
        );
      }),
    );

    this.addSettingTab(new SettingsTab(this.app, this));

    this.registerObsidianProtocolHandler("young-look", (params) => {
      // 网页端登录完成后跳回来的连接码：换成正经的登录令牌存下来。
      // 这里没有别的界面可依靠，成败都用 Notice 说一声。
      const connectCode = typeof params.code === "string" ? params.code : "";
      if (connectCode) {
        void this.exchangeConnectCode(connectCode).then((result) => {
          new Notice(result.ok ? "已连接账号，充值后可用内置模型与云同步。" : result.message);
        });
      }
    });

    // 余额上报：内置模型每次扣费后，把最新余额写到设置里（设置页要显示）
    setBillingSink((billing) => {
      this.settings.aiBalanceMillis = billing.balance_millis;
      void this.saveSettings();
    });

    // BYOK 每次调用的 token 用量 → 本地 IndexedDB（账户页「消费」的 BYOK 流水）。
    // BYOK 不过服务器，这笔账只存在本机、不跨设备。
    setByokUsageSink((usage) => {
      void this.db
        .put(STORE.aiUsage, { ts: new Date().toISOString(), ...usage })
        .catch((error: unknown) => console.warn("[洋流] BYOK 用量没能记下来", error));
    });

    // 内置模型要用访问令牌时从这里拿 —— 过期了就自动换一对新的
    setAccessTokenProvider((force) => this.ensureAccessToken(force === true));

    this.statusBar = this.addStatusBarItem();
    void this.updateStatusBar();
    // 点这颗胶囊 = 立即同步（与设置页的「立即同步」同一趟）。
    // ⚠️ 未登录时这颗只是「本地数据」纯状态、不可点 —— 没有可同步的目标，
    //    以前会白跑一趟（syncStats 拿不到令牌、直接失败）。
    this.registerDomEvent(this.statusBar, "click", () => {
      if (!this.hasAccountNow()) return;
      void this.syncStats(true);
    });

    // Obsidian 自带的 Sync 核心插件连不上官方服务就挂一个红色"已断开"图标，
    // 离洋流的状态栏就一格远，用户误以为是洋流同步出了问题（2026-09-30 反馈）。
    // 洋流的同步走自己的服务端，跟官方 Sync 毫无关系 —— 加载时顺手关掉它，
    // 状态栏里关于"同步"的提示就只剩洋流自己那一颗（见 updateStatusBar）。
    this.disableObsidianSync();

    // 开发构建必须一直把这件事摆在用户眼前 —— "点了一下不知道连的是哪台"
    // 就是这么发生的。状态栏是唯一常驻可见的地方。
    if (IS_DEV_BUILD) {
      new Notice(`洋流：开发构建，连的是 ${this.settings.serverUrl}（与线上互不相通）。`, 9000);
    }

    // 学习记录上报：连上账号之后按间隔推（插件在后台跑，用户不该被弹窗打扰）。
    // 延迟 10 秒再跑第一次 —— 启动时先把界面渲染出来，别抢在前面。
    this.startAutoSync();
    window.setTimeout(() => void this.syncStats(), 10_000);

    // 插件更新**不在插件里做**：Obsidian 社区目录明确禁止「Install or update
    // themselves」，用户走 BRAT / 社区商店自己更新（见 README「联网与数据」）。

    // 「打开插件就是完整的工作台页面」：启动时把上次的页面开回来。
    // 布局本身也会被 Obsidian 恢复（restore 过的实例已存在，这里会跳过）；
    // 而**插件重载**（改代码后重载、开关插件）不会恢复布局 —— 那条路由就靠这里兜住。
    this.app.workspace.onLayoutReady(() => void this.reopenLastView());
    if (this.app.workspace.layoutReady) void this.reopenLastView();
  }

  onunload(): void {
    if (this.autoSyncTimer !== null) window.clearInterval(this.autoSyncTimer);
    this.db?.close();
  }

  /**
   * 关掉 Obsidian 自带的 Sync 核心插件（见 onload 里的说明）。
   *
   * ⚠️ internalPlugins 是未公开 API，Obsidian 升级可能变卦：整段包死，
   * 失败只记日志 —— 为了一个红图标把插件加载搞挂就本末倒置了。
   * 每次加载都会执行：官方 Sync 再被手动打开，洋流下次加载还会关掉；
   * 真要用官方 Sync 的场合不该装着这段（当前口径如此，要改口径再提）。
   */
  private disableObsidianSync(): void {
    try {
      const internal = (
        this.app as unknown as {
          internalPlugins?: {
            plugins?: Record<string, { enabled?: boolean; disable?: () => unknown }>;
            disablePlugin?: (id: string) => unknown;
          };
        }
      ).internalPlugins;
      const sync = internal?.plugins?.sync;
      if (!sync?.enabled) return;
      if (typeof internal?.disablePlugin === "function") internal.disablePlugin("sync");
      else sync.disable?.();
      log.info("已关闭 Obsidian 自带的 Sync 核心插件：它的红色断连图标总被当成洋流同步出了问题");
    } catch (error) {
      log.warn("关闭 Obsidian Sync 核心插件没成功（不影响其它功能）", error);
    }
  }

  /** 按设置里的间隔启动后台上报。间隔改成 0 = 只在手动点「立即同步」时推。 */
  startAutoSync(): void {
    if (this.autoSyncTimer !== null) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    const minutes = Number(this.settings.autoSyncMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    this.autoSyncTimer = window.setInterval(
      () => void this.syncStats(),
      Math.round(minutes * 60_000),
    );
    this.registerInterval(this.autoSyncTimer);
  }

  /**
   * 统一快照同步（2026-10-06 大改造：白名单之外全上云）。
   *
   * 一趟推+拉：推的是全部集合的快照（进度/词库/日活/作品/偏好…，
   * 台词原文不在其中，见 `sync/snapshot.ts` 的政策注释）；拉是全量下发
   * 合并回本地 —— 换机 / 重装后除了视频字幕，其他都跟人走。
   *
   * 资格由服务端门禁管（登录 + 余额 > 0）：没余额时静默暂停，
   * 数据留本地不丢，充值后下一趟自动接着传。
   *
   * @param manual 用户点的（要给反馈）；后台定时跑的（出错也别弹窗）。
   */
  async syncStats(manual = false): Promise<void> {
    // 没连账号就什么都不做 —— 本地功能是免费的，不该逼着用户登录
    if (!this.settings.refreshToken.trim() && !this.settings.authToken.trim()) return;
    // 🔥 这份本机数据不是当前登录账号的，就一个字节都不许推（见 spaceSyncAllowed）。
    //    换账号的弹窗还开着、或者被 Esc 关掉时，全靠这一条拦住串号。
    if (!this.spaceSyncAllowed()) return;
    if (this.syncInFlight) return this.syncInFlight;

    this.syncInFlight = (async () => {
      // 图标先进"推送中"再干活（转圈那段）；结局由下面各分支改完状态后再刷
      this.syncActive = true;
      try {
        const token = await this.ensureAccessToken();
        if (!token) {
          // 拿不到凭据（网络或登录态问题）：状态栏得说清楚，否则上面还挂着
          // 一个"已同步 HH:MM"，看着像刚推成功
          this.lastSyncError = "拿不到登录凭据，重新登录试试。";
          await this.updateStatusBar();
          return;
        }
        try {
          // 打包 → 切块 → 逐块推。
          //
          // 每趟都读整个库（没有行数上限、没有游标），块数由体量决定：绝大部分
          // 用户一趟只有一块。
          //
          // 413 降档重推：客户端按 6MB 切块，但真字节口径下仍可能撞服务端 8MB
          // 护栏。撞到 `tooLarge` 就砍半预算重新切块再推，否则下个 tick 用同样的
          // 包再撞一次 —— 同步从此永久停摆。
          const built = await buildSnapshotPayload(this.db, this.settings);
          let budget = CHUNK_BUDGET_BYTES;
          let chunks = splitSnapshotPayload(built.collections, budget);
          let push: SnapshotPushResult | null = null;
          let skipped = 0;
          for (let round = 1; ; round += 1) {
            skipped = 0;
            let roundFailed = false;
            for (const [index, chunk] of chunks.entries()) {
              push = await pushSnapshot({
                serverUrl: this.settings.serverUrl,
                accessToken: token,
                payload: chunk,
              });
              skipped += push.skipped;
              if (!push.ok) {
                roundFailed = true;
                break;
              }
              if (index < chunks.length - 1) log.info("同步分块上传", index + 1, "/", chunks.length);
            }
            if (!roundFailed) break;
            // 只有「包太大」才值得降档重推；其余失败（网络/鉴权/服务端错误）原样上抛
            if (push?.tooLarge && budget > MIN_CHUNK_BUDGET_BYTES && round < MAX_CHUNK_ROUNDS) {
              budget = Math.max(MIN_CHUNK_BUDGET_BYTES, Math.floor(budget / 2));
              chunks = splitSnapshotPayload(built.collections, budget);
              log.warn("同步包太大，降到", budget, "字节重新切块再试");
              continue;
            }
            break;
          }
          if (!push) return; // 一块都没有（空库）：没什么可推的，直接结束
          push = { ...push, skipped };
          if (skipped > 0) {
            // 坏行（超 64KB / 缺字段）被服务端丢了：不吵用户，但不能无声无息
            log.warn("同步有行被服务端判成坏行丢掉", push.skipped);
          }
          if (push.unauthorized) {
            // ensureAccessToken 已经换过一轮还 401 → 真的掉线了，它已经清过登录态
            return;
          }
          if (push.needRecharge) {
            // 余额用尽：同步暂停但不报错 —— 数据留本地，充值后自动恢复。
            // 必须记下来，否则状态栏会继续显示上一次成功同步的旧时间（见 syncPaused）
            this.syncPaused = true;
            this.lastSyncError = null;
            if (manual) new Notice("云同步需要账户有余额，充值后会自动接着传。");
            return;
          }
          if (!push.ok) {
            // 这一趟就到这儿，下趟整个库再推一遍（逐行 LWW 幂等，重推无害）
            this.lastSyncError = push.message;
            await this.updateStatusBar();
            if (manual) new Notice(`同步没成功：${push.message}`);
            else log.warn("后台同步失败", push.message);
            return;
          }

          const pull = await pullSnapshot({ serverUrl: this.settings.serverUrl, accessToken: token });
          if (pull.unauthorized) return;
          if (pull.needRecharge) {
            this.syncPaused = true;
            if (manual) new Notice("云同步需要账户有余额，充值后会自动接着传。");
            return;
          }
          if (!pull.ok) {
            this.lastSyncError = pull.message;
            await this.updateStatusBar();
            if (manual) new Notice(`同步没成功：${pull.message}`);
            else log.warn("后台同步拉取失败", pull.message);
            return;
          }
          // 空库恢复提示（2026-10-07 拍板）：本地近空库而云端有整库数据 =
          // 换机/重装/库损坏。恢复本身照常静默（逐行 LWW，谁新谁赢），批量差异
          // 不弹询问框 —— 只在这里补一条告知气泡，让用户知道数据正在回来。
          // 行数直接数刚打包的本地快照：一趟同步本来就读了整库，不再额外扫。
          const localRows = Object.values(built.collections).reduce(
            (sum, rows) => sum + (rows?.length ?? 0),
            0,
          );
          const cloudRows = Object.values(pull.collections).reduce(
            (sum, rows) => sum + (rows?.length ?? 0),
            0,
          );
          const restoring = localRows < 10 && cloudRows >= 20;
          if (restoring) new Notice("本地还没有学习数据，正在从云端恢复…", 8000);
          const { applied, settingsChanged } = await applySnapshotPull(this.db, this.settings, pull.collections);
          if (restoring && applied > 0) new Notice(`已从云端恢复 ${applied} 条数据。`, 8000);
          if (settingsChanged) await this.saveSettings();
          this.lastSyncError = null;
          // 这一趟真的推上去了：余额那道挡住的事了了（充值后就是从这里自动恢复的）
          this.syncPaused = false;
          this.settings.lastStatsSyncAt = Date.now();
          await this.saveSettings();
          await this.updateStatusBar();
          if (manual && !restoring) {
            // 恢复场景已有自己的两条气泡，再报"已同步"就叠了
            const summary = applied > 0 ? `${applied} 条改动` : "数据";
            new Notice(`已同步${summary}。`);
          }

          // 每天一次的「本地 vs 云端」全库校验（推拉都成功之后才做 ——
          // 刚推完就比，比的才是这一趟的结果）
          await this.dailyVerify(token);
        } catch (error) {
          // 后台任务不该把异常抛到未捕获里
          log.warn("同步学习记录出错", error);
          this.lastSyncError = "同步出错，看看网络再试一次。";
          await this.updateStatusBar();
          if (manual) new Notice("同步没成功，看看网络再试一次。");
        }
      } finally {
        // 无论结局如何，"推送中"这段必须退场 —— 哪怕上面有人忘了刷状态栏
        this.syncActive = false;
        await this.updateStatusBar();
      }
    })();

    try {
      await this.syncInFlight;
    } finally {
      this.syncInFlight = null;
    }
  }

  /**
   * 每天一次的「本地 vs 云端」全库校验（2026-10-07）。
   *
   * 拉云端哈希清单 → 本地算一遍比 → 对不上就整库重推（逐行 LWW 幂等，
   * 重推无害）并把结果报给服务端；连续 3 天还不上 ⇒ 服务端告警到运营。
   *
   * 这道校验防的不是「没传上去」（增量已经够了），是**同步逻辑自己写错**：
   * 某次合并写错了、某字段两端序列化不一致，客户端会认为「我传过了，没事」，
   * 只有整库比对能兜住 —— 所以它是对自身逻辑的保险，不是传输保险。
   */
  private async dailyVerify(token: string): Promise<void> {
    const day = dayKey();
    if (this.settings.lastVerifyDay === day) return;

    const manifest = await fetchSnapshotManifest({
      serverUrl: this.settings.serverUrl,
      accessToken: token,
    });
    // 拉不到清单不是漂移（是网络/资格问题），下趟再来 —— 别拿它污染计数
    if (!manifest.ok) return;

    const built = await buildSnapshotPayload(this.db, this.settings);
    const diff = diffManifest(built.collections, manifest.rows);
    const drift = diff.missing.length > 0 || diff.mismatched.length > 0;

    await reportVerify({
      serverUrl: this.settings.serverUrl,
      accessToken: token,
      day,
      drift,
      // 只报前 50 条：够定位问题，别把几万行的键名塞进留痕
      missing: diff.missing.slice(0, 50),
      mismatched: diff.mismatched.slice(0, 50),
    });
    this.settings.lastVerifyDay = day;
    await this.saveSettings();

    if (!drift) return;
    log.warn("云同步校验对不上，整库重推", diff.missing.length, "行缺失 /", diff.mismatched.length, "行不一致");
    for (const chunk of splitSnapshotPayload(built.collections)) {
      const push = await pushSnapshot({
        serverUrl: this.settings.serverUrl,
        accessToken: token,
        payload: chunk,
      });
      if (!push.ok) break;
    }
  }

  async saveSettings(): Promise<void> {
    // AI 配置先归档进**当前空间**的桶再落盘（2026-10-17 方案 B）：账户页/设置页
    // 改完都走这条路，所以它们不必各自记得归档；漏了这一步，下次切空间就会拿
    // 桶里的旧值把改动盖掉（见 settings/aiSpace.ts 顶部的不变量）。
    stashBundle(this.settings);
    // 每次落盘都抬偏好时间戳：本地永远是最新事实，云端偏好只在换机/重装时能落进来
    this.settings.prefsUpdatedAt = new Date().toISOString();
    await this.saveData(this.settings);
  }

  /**
   * 网页端地址（**充值页、插件连接页**都在这上面）。
   * ⚠️ 要登录/连接插件一律走 `openConnectPage()`（`/plugin/connect`），**别自己在这里拼
   *    `/login`** —— 那只是连接页内部未登录时的一个中转，直接过去会丢掉「连完插件」的上下文。
   *
   * ⚠️ 不能拿 `settings.serverUrl` 拼前端路由：本机前后端是两个端口
   * （vite 5173 / Django 8060），8060 只提供 /api、/admin、/storage，
   * 开 `8060/pricing` 是 404。线上恰好同域名才一直没暴露这个耦合。
   */
  webBase(): string {
    return resolveTargets(this.settings.serverEnv, this.settings.customServerUrl).web;
  }

  /** 重算生效的服务端地址并落盘。改了 serverEnv / customServerUrl 之后都要调一次。 */
  async applyServerEnv(): Promise<void> {
    const targets = resolveTargets(this.settings.serverEnv, this.settings.customServerUrl);
    if (this.settings.serverUrl === targets.api) return;
    this.settings.serverUrl = targets.api;
    await this.saveSettings();
  }

  /**
   * 连的服务器换了就清登录态。
   *
   * 两边的 JWT 用各自的 SECRET_KEY 签，dev 的令牌线上不认。不清的话用户看到的是
   * "明明连过账号，却莫名其妙一直掉线" —— 能自愈，但中间那段是纯粹的困惑。
   */
  private async dropLoginStateIfServerChanged(): Promise<void> {
    const before = this.settings.authServerUrl.trim();
    const current = this.settings.serverUrl;
    const loggedIn = Boolean(this.settings.authToken.trim() || this.settings.refreshToken.trim());

    if (before && loggedIn && before !== current) {
      this.settings.authToken = "";
      this.settings.refreshToken = "";
      this.settings.accountProfile = null;
      this.settings.aiBalanceMillis = 0;
      this.lastProfileFetch = 0;
      invalidateNoteCache();
      // 空间归位交给随后启动的 reconcileActiveSpace（此处还没开库）
      new Notice(`已切换到 ${current}，需要重新登录。`);
    }
    if (this.settings.authServerUrl !== current) {
      this.settings.authServerUrl = current;
      await this.saveSettings();
    }
  }

  /** vault 的本机绝对路径（用来给本地库做归属标记）。 */
  private vaultBasePath(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : this.app.vault.getName();
  }

  /**
   * 定住本地库名，必要时把历史数据认回来并合并。
   *
   * 三种情况：
   *  - 当前库里有数据 → 什么都不做（正常路径，零探测开销）；
   *  - 当前库是空的，却存在装着数据的旧库 → 认回来，并把同属这个 vault 的旧库并进去；
   *  - data.json 里连 id 都没有（老版本每次加载都新生成随机 id）→ 同第二条。
   * 最后**立刻写盘**：不写盘，这次认回来的库下次重载又会丢。
   */
  private async ensureStableVaultKey(rawId: string): Promise<void> {
    const current = this.settings.activeSpaceId;
    const currentProbe = await probeVaultDatabase(current);
    if (currentProbe.sentences > 0) return;

    const keys = await listVaultDatabaseKeys();
    if (keys.length === 0) {
      if (!rawId) await this.saveSettings();
      return;
    }
    // 🔥 已登记的空间一律不参与认领与合并（2026-10-09 多账号隔离）——
    //    它们是**别的账号**的数据，不排掉就会在当前空间为空时（例如刚给新账号
    //    开出来那份）被当成孤儿旧库认回来。判据见 vaultKey.ts::reclaimableKeys。
    const candidates = reclaimableKeys(
      keys,
      current,
      this.settings.spaces.map((space) => space.id),
    );
    const probes: VaultDbProbe[] = [{ key: current, ...currentProbe }];
    for (const key of candidates) {
      probes.push({ key, ...(await probeVaultDatabase(key)) });
    }

    const outcome = await recoverLocalLibrary({
      currentKey: current,
      vaultPath: this.vaultBasePath(),
      probes,
    });

    if (outcome.adoptedKey) {
      // 认回来的是**当前这个空间**的库：把空间的 id 指过去即可。
      // ⚠️ 不能改 vaultLocalId —— 那个是"这个 vault 的底号"，还要用来给新空间起名。
      const previousId = this.activeSpace.id;
      this.activeSpace.id = outcome.adoptedKey;
      this.settings.activeSpaceId = outcome.adoptedKey;
      // AI 配置的桶是按空间 id 存的 → id 换了，桶也得搬过去，否则这份配置就丢了
      renameSpace(this.settings, previousId, outcome.adoptedKey);
      log.info("认回本地学习库", {
        key: outcome.adoptedKey,
        merged: outcome.mergedKeys.length,
        skipped: outcome.skippedKeys.length,
        slices: outcome.slices,
      });
      new Notice(
        "已找回你之前导入的学习数据（只在这台机器上，不曾上传）。" +
          (outcome.mergedKeys.length > 0 ? `\n顺带合并了 ${outcome.mergedKeys.length} 份旧记录。` : ""),
        12000,
      );
    } else if (outcome.skippedKeys.length > 0) {
      log.info("存在归属不明的旧本地库，未自动认领", { skipped: outcome.skippedKeys.length });
    }

    // 首次安装 / 认回旧库都要落盘；已经稳定过的就不重复写
    if (!rawId || outcome.adoptedKey) await this.saveSettings();
  }

  /** 给本地库盖一个归属标记，以后认领时才有可靠判据。只在缺失时写。 */
  private async tagVaultPath(): Promise<void> {
    try {
      const existing = await this.db.get<{ key: string; value: string }>(STORE.meta, "vaultPath");
      if (existing?.value) return;
      await this.db.put(STORE.meta, { key: "vaultPath", value: this.vaultBasePath() });
    } catch (error) {
      log.warn("写本地库归属标记失败", error);
    }
  }

  /**
   * 把上次打开的插件页面开回来。
   *
   * 布局里已存在的 leaf 有两种可能：Obsidian 正常恢复出的**真实例**（onOpen
   * 已渲染过，什么都不用做），或者一个**空壳** —— 类型对得上、实例没内容。
   * 空壳的已知来源：插件重载（改代码后重载、开关插件）后旧 leaf 的实例没了，
   * Obsidian 不会自动重建。空壳就地 setViewState 重建（保住标签页的位置），
   * 修不好才关掉；一个真实例都不剩时再新开一页。修空壳不受 autoOpenPage
   * 管辖 —— 那个开关管的是"要不要主动开新页"，布局里已有的页面不该是空白的。
   */
  private async reopenLastView(): Promise<void> {
    const remembered = this.settings.lastView;
    // 老配置里可能记着已经退役的类型，认不出来就回学习页
    const viewType = remembered === VIEW_TYPE_STUDY ? remembered : VIEW_TYPE_STUDY;
    for (const leaf of this.app.workspace.getLeavesOfType(viewType)) {
      // 真实例且已经画出内容才算好；实例在却还没渲染（onOpen 没跑到）的一样重建
      const view = leaf.view;
      if (view instanceof StudyView && view.contentEl.childElementCount > 0) continue;
      try {
        await leaf.setViewState({ type: viewType, active: true });
      } catch (error) {
        log.warn("重建学习页空壳失败，改关掉重开", error);
        leaf.detach();
      }
    }
    if (!this.settings.autoOpenPage) return;
    if (this.app.workspace.getLeavesOfType(viewType).length > 0) return;
    // 头一次装上也直接给用户看成品页面，而不是让他自己去找图标
    try {
      await this.activateLeaf(viewType, true);
    } catch (error) {
      log.warn("自动打开上次的页面失败", error);
    }
  }

  /**
   * 打开（或聚焦）某个插件视图。
   *
   * @param center 学习工作台这类主界面要开在**中间主区**（新标签页），
   *   不能塞进侧边栏 —— 视频加三步练习的布局侧栏装不下（会被压成 0 宽）。
   */
  async activateLeaf(viewType: string, center = false): Promise<void> {
    // 记下"用户最后在用的是哪个页面"，重载之后把它开回来
    if (this.settings.lastView !== viewType) {
      this.settings.lastView = viewType;
      void this.saveSettings().catch(() => undefined);
    }
    const existing = this.app.workspace.getLeavesOfType(viewType);
    const rootSplit = this.app.workspace.rootSplit;
    const inMain = existing.find((leaf) => leaf.getRoot() === rootSplit);
    if (existing.length > 0) {
      if (center && !inMain) {
        // 旧实例挤在侧边栏（工作区布局持久化留下的）：侧栏挪不进主区，关掉重开。
        // 视频加三步练习的布局塞在侧栏里视频区会被压成 0 宽（实测截图 2026-09-25）。
        this.app.workspace.detachLeavesOfType(viewType);
      } else {
        const target = inMain ?? existing[0];
        this.app.workspace.revealLeaf(target);
        const view = target.view;
        if ("render" in view) await (view as unknown as { render(): Promise<void> }).render();
        return;
      }
    }
    const leaf = center
      ? this.app.workspace.getLeaf("tab")
      : this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: viewType, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async refreshOpenViews(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_STUDY)) {
      const view = leaf.view;
      if ("render" in view) await (view as unknown as { render(): Promise<void> }).render();
    }
    // 个人中心也刷：连接 / 退出账号后，开着的那一页要立刻变成新登录态的样子
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PERSONAL)) {
      const view = leaf.view;
      if ("render" in view) await (view as unknown as { render(): Promise<void> }).render();
    }
    await this.updateStatusBar();
  }

  /**
   * 打开个人中心。
   *
   * 所有入口（账号头像 / AI 门控弹窗 / 学习卡片「返回」回历史页）都走这里。
   *
   * @param opts.tab 一次性指定落点页签（AI 门控弹窗「去配置」→ "wallet"、
   *   学习卡片「返回」→ "sentences"），渲染时消费掉。
   */
  openPersonalCenter(
    origin: PersonalOrigin,
    opts: { tab?: "profile" | "wallet" | "vocab" | "sentences" } = {},
  ): void {
    this.personalOrigin = origin;
    this.personalInitialTab = opts.tab ?? null;
    // 从「设置」里点进来的要先关掉设置 —— 设置是盖满整窗的浮层，不关的话
    // 个人中心开在它后面，用户看到的是"点了完全没反应"，登录入口等于白点。
    // `app.setting` 不在公开 typings 里，但运行时一直在（社区插件同款做法）。
    // 整段包在 try 里：将来它变了，最坏也只是"设置没关掉"，不会把登录带崩。
    try {
      (this.app as unknown as { setting?: { close(): void } }).setting?.close();
    } catch {
      /* 关不掉就算了，页面已经开出来了 */
    }
    void this.activateLeaf(VIEW_TYPE_PERSONAL, true);
  }

  /** 个人中心「返回」：关掉自己，回到来路（列表页 / 学习页原句原位）。 */
  async closePersonalCenter(): Promise<void> {
    const origin = this.personalOrigin ?? { from: "list" };
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_PERSONAL);
    await this.activateLeaf(VIEW_TYPE_STUDY, true);
    const leaf = this.app.workspace
      .getLeavesOfType(VIEW_TYPE_STUDY)
      .find((l) => l.getRoot() === this.app.workspace.rootSplit);
    const view = leaf?.view as unknown as {
      restoreTo?(episodeCid: string, index: number, origin?: CardOrigin): Promise<void>;
      showList?(): Promise<void>;
    } | undefined;
    if (!view) return;
    if (origin.from === "study" && origin.recordCid) {
      // 不传 origin = 保持卡片原来路（个人中心只是中途路过，不改变「返回」该退到哪）
      await view.restoreTo?.(origin.recordCid, origin.index);
    } else {
      await view.showList?.();
    }
  }

  /**
   * 历史「复习此句」：**新开一个学习页 tab** 落到该集该句（2026-10-04 用户定：
   * 两个按钮都开新 tab，不劫持当前页、也不动已有的学习页 tab —— 原先会先关掉
   * 个人中心再跳旧 tab，改为并排新开）。
   *
   * 目标句不看来路 —— 由那一行自己指定（episodeCid + 1-based 句子序号，
   * 见 StudySentence.index）。视频不在了这类不可跳的情况由历史页那边藏钮拦下。
   *
   * 来路钉成 `"history"`：这一跳**跳过了选集页**，上一个页面是历史页 —— 卡片上
   * 的「返回」据此把用户送回历史页，而不是回选集页（见 CardOrigin）。
   */
  async jumpToSentence(episodeCid: string, index: number): Promise<void> {
    if (this.settings.lastView !== VIEW_TYPE_STUDY) {
      this.settings.lastView = VIEW_TYPE_STUDY;
      void this.saveSettings().catch(() => undefined);
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_STUDY, active: true });
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view as unknown as {
      restoreTo?(episodeCid: string, index: number, origin?: CardOrigin): Promise<void>;
    } | undefined;
    await view?.restoreTo?.(episodeCid, index, "history");
  }

  /**
   * 学习卡片「返回」回历史页（来路是「打开」的那种卡片，见 `jumpToSentence`）。
   *
   * 上一个页面就是历史页 —— 把个人中心亮出来并落到「历史」页签：
   * · 个人中心**还开着**（「打开」就是从它身上点的，一般都在）→ 聚焦它、切到「历史」
   *   页签，**不动它的来路** —— 它自己那颗「返回」照旧回原位（比如它是从学习卡片
   *   开出来的，就该回到那张卡片的那一句，不该被这一趟串门改掉）。
   * · 被用户手动关了 → 用同一套入口重开一个，落「历史」页签、来路记成学习页列表。
   *
   * 学习页那半边（关掉这次「打开」新开的那张卡片 tab）由 StudyView 自己做 ——
   * 只有它知道自己挂在哪个 leaf 上，这里不去猜。
   */
  revealHistoryPage(): void {
    this.personalInitialTab = "sentences";
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE_PERSONAL).length > 0) {
      void this.activateLeaf(VIEW_TYPE_PERSONAL, true);
      return;
    }
    this.openPersonalCenter({ from: "list" }, { tab: "sentences" });
  }

  /**
   * 状态栏：全局状态，不是面板，所以不占区域。
   *
   * 只说**真同步的进展**（"已同步 HH:MM" / "同步失败"）。这里以前显示过本地
   * outbox 表的行数（「待同步 N」），但那张表 2026-10-06 已随统一快照同步退役——
   * 全量重推不依赖逐行待办，行数没了意义（见 `services/sync/snapshot.ts`）。
   */
  async updateStatusBar(): Promise<void> {
    if (!this.statusBar) return;
    // 开发构建的名字里带「开发」：这是用户判断"我现在连的是哪台"的第一眼
    const name = IS_DEV_BUILD ? "洋流·开发" : "洋流";
    // 没连账号 = 数据只在本机、AI 走自带 Key（必然 BYOK）。状态栏明说「本地数据」——
    // 这是给"我数据在哪儿"一个交代，不是催登录；因此**不可点**（不挂
    // .yl-sync-status：那颗类带 cursor:pointer + hover 底，点了也无所作为）。
    const loggedIn = this.hasAccountNow();
    this.statusBar.toggleClass("yl-sync-status", loggedIn);
    if (!loggedIn) {
      this.statusBar.empty();
      const icon = this.statusBar.createSpan({ cls: "yl-sync-icon yl-sync-icon-idle" });
      setIcon(icon, "hard-drive");
      this.statusBar.createSpan({ text: `${name} · 本地数据` });
      this.statusBar.setAttr(
        "title",
        "还没登录：学习记录只存在这台机器上，不会上传。登录后自动开始同步。",
      );
      return;
    }

    // 洋流专属的同步小提示（Obsidian 自带的那颗红图标在加载时已被关掉，
    // 见 disableObsidianSync —— 状态栏里关于"同步"的灯只剩这一颗）。
    // 颜色只说最近一次推送的结局：绿勾=成功、红=失败、灰=还没推过/推送中；
    // 整颗胶囊可点 = 立即同步，鼠标停一下能看到详细状态。
    this.statusBar.empty();
    const icon = this.statusBar.createSpan({ cls: "yl-sync-icon" });

    // 正在推的这趟优先于上一次的失败显示：重试期间别让旧红字挂着吓人
    if (this.syncActive) {
      setIcon(icon, "refresh-cw");
      icon.addClass("yl-sync-icon-idle", "yl-sync-spin");
      this.statusBar.createSpan({ text: `${name} · 同步中…` });
      this.statusBar.setAttr("title", "正在推送学习记录…");
      return;
    }
    if (this.lastSyncError) {
      setIcon(icon, "cloud-off");
      icon.addClass("yl-sync-icon-bad");
      this.statusBar.createSpan({ text: `${name} · 同步失败` });
      // 鼠标停一下能看到失败原因，不用去翻控制台
      this.statusBar.setAttr("title", `${this.lastSyncError}（点一下立即重试）`);
      return;
    }
    // 余额用尽、被服务端挡回来：必须明说「已暂停」—— 否则上面那条
    // 「已同步 HH:MM」会一直挂着，用户以为一切正常，其实一个字节都没在传。
    // 🔥 文案与存储页那条提醒带成对（见 views/dataSection.ts buildPausedBand）。
    // 用警示黄不用红：这不是故障，是"云端那份停在原地等充值"，学习功能一切照旧。
    if (this.syncPaused) {
      setIcon(icon, "pause-circle");
      icon.addClass("yl-sync-icon-warn");
      this.statusBar.createSpan({ text: `${name} · 云同步已暂停` });
      this.statusBar.setAttr(
        "title",
        "账户余额用尽，云同步已暂停。学习记录都留在本机，充值后自动接着传（点一下立即重试）。",
      );
      return;
    }
    if (this.settings.lastStatsSyncAt > 0) {
      setIcon(icon, "check");
      icon.addClass("yl-sync-icon-ok");
      this.statusBar.createSpan({
        text: `${name} · 最近同步 ${clockTime(this.settings.lastStatsSyncAt)}`,
      });
      this.statusBar.setAttr(
        "title",
        `学习记录最近一次推送：${clockTime(this.settings.lastStatsSyncAt)}（点一下立即同步）`,
      );
    } else {
      setIcon(icon, "refresh-cw");
      icon.addClass("yl-sync-icon-idle");
      this.statusBar.createSpan({ text: `${name} · 等待首次同步` });
      this.statusBar.setAttr("title", "还没推送过学习记录（点一下立即同步）");
    }
  }

  /**
   * vault 内的相对路径 → 本机绝对路径。
   *
   * 字幕和视频都留在用户原来的位置，插件只记路径，所以读文件时必须拿绝对路径。
   * 插件是 desktop-only，这里可以直接走 FileSystemAdapter。
   */
  absolutePath(vaultPath: string): string | null {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getFullPath(vaultPath);
    }
    return null;
  }

  /**
   * 🔧 dev 专属（./yolo reset-client 经 obsidian://younglook-reset 触发）：
   * 把客户端恢复到刚安装好的状态。URI 谁都能发，所以落点仍是一颗确认弹窗
   * —— 不会因为一条链接就静默清库。
   */
  private resetClientData(): void {
    const modal = new Modal(this.app);
    modal.titleEl.setText("重置客户端");
    modal.contentEl.createEl("p", { text: "将清空本插件的全部本地数据，恢复到刚安装好的状态：" });
    const list = modal.contentEl.createEl("ul");
    for (const item of [
      "本地学习库（素材清单、进度、词库、录音、本地笔记）",
      "插件设置（登录状态、空间、服务器地址 → 恢复出厂默认）",
      "应用数据目录（素材库副本、demo 暂存、词典）",
    ]) {
      list.createEl("li", { text: item });
    }
    modal.contentEl.createEl("p", {
      text: "服务端/云端数据、你原始的视频字幕文件、vault 里的笔记都不受影响。此操作不可恢复。",
    });
    const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "取消" }).onclick = () => modal.close();
    buttons.createEl("button", { text: "确认清空", cls: "mod-warning" }).onclick = () => {
      modal.close();
      void this.wipeClientData();
    };
    modal.open();
  }

  private async wipeClientData(): Promise<void> {
    // 素材库基准目录若被指到默认位置之外，那是用户自己选的文件夹，不归我们删
    const customMediaRoot = this.settings.mediaDir.trim();
    // 1) 关掉连接 → 删掉全部 younglook-* 库（含找回历史数据留下的孤儿库）
    this.db?.close();
    const names = (await indexedDB.databases())
      .map((entry) => entry.name ?? "")
      .filter((name) => name.startsWith("younglook-"));
    await Promise.all(names.map((name) => deleteYounglookDatabase(name)));
    // 2) 设置回出厂：data.json 写 null，下次加载走 fillDefaults(null)
    await this.saveData(null);
    this.settings = fillDefaults(null);
    // 3) 应用数据目录整个删掉（默认素材库、demo.staging、词典都在里面）
    if (!customMediaRoot) {
      rmSync(appDataDir(), { recursive: true, force: true });
    }
    new Notice("本地数据已清空，正在重启…");
    window.setTimeout(() => window.location.reload(), 800);
  }

  /**
   * 给设置页用：显示当前登录状态。
   *
   * 「登录 / 注册」= 打开「连接账号」弹窗：登录 / 注册在网页完成，插件只收
   * 一次性连接码（2026-10-02 起插件不再内置登录表单）。
   *
   * ⚠️ 「算不算登录」的口径要跟 `PersonalCenterView.isLoggedIn()` 一致：
   * **有 refreshToken 也算登录**。只认 authToken 的话，access 过期的那段时间
   * 设置页显示"未登录"、个人中心却显示"已登录"，自相矛盾。
   */
  async refreshAccountSetting(setting: Setting): Promise<void> {
    const loggedIn = Boolean(this.settings.authToken.trim() || this.settings.refreshToken.trim());
    if (!loggedIn) {
      setting.setDesc("未登录。不登录也能用本机功能，只是没有内置模型和跨设备同步。");
      setting.addButton((button) =>
        button.setButtonText("登录 / 注册").onClick(() => {
          this.openConnectPage();
        }),
      );
      return;
    }
    const profile = this.settings.accountProfile;
    const who = profile?.nickname ? `${profile.nickname}（UID ${profile.uid.slice(0, 8)}）` : "已登录";
    const synced =
      this.settings.lastStatsSyncAt > 0 ? `上次同步：${clockTime(this.settings.lastStatsSyncAt)}。` : "";
    setting.setDesc(`${who}。学习记录会在后台自动同步到网页端。${synced}`);
    setting.addButton((button) =>
      button.setButtonText("立即同步").onClick(() => void this.syncStats(true)),
    );
    setting.addButton((button) =>
      button.setButtonText("退出登录").onClick(() => void this.logoutAccount()),
    );
  }

  /**
   * 退出登录：清令牌与账号快照，**本地学习数据一个字节都不动**，但**切回匿名空间**。
   *
   * refreshToken 也一起清 —— 它是「长期保持登录」的凭据，留着就等于没退出。
   * 🔥 2026-10-10 模型重构：登出后不再停在刚才那个账号的空间（共用电脑上会把前
   *    一个人的数据暴露给下一个人），而是切回恒存在的匿名空间。
   */
  async logoutAccount(): Promise<void> {
    const anon = anonymousSpace(this.settings.spaces);
    const who = this.settings.accountProfile?.nickname?.trim() ?? "";
    this.settings.authToken = "";
    this.settings.refreshToken = "";
    this.settings.aiBalanceMillis = 0;
    this.settings.accountProfile = null;
    this.settings.authServerUrl = "";
    this.lastProfileFetch = 0;
    invalidateNoteCache();
    // 退出后状态栏只剩名字，别把上一账号的失败原因挂在上面
    this.lastSyncError = null;
    // 「云同步已暂停」同理：没有账号就没有"暂停"这回事，等下一趟同步重新判定
    this.syncPaused = false;
    await this.saveSettings();
    // 切回匿名空间（登出后不该再看着上一个账号的数据）
    if (anon && this.settings.activeSpaceId !== anon.id) await this.openSpace(anon.id);
    new Notice(
      who
        ? `已退出登录，回到匿名数据；${who} 的学习记录已归属该账号，重新登录才能再看到。`
        : "已退出登录，回到匿名数据。",
    );
    await this.updateStatusBar();
    await this.refreshOpenViews();
  }

  // ── 本机空间：一份本机数据只跟一个账号（2026-10-09） ──────────────────────

  /**
   * 当前打开的那份本机数据。
   *
   * 未登录 → 匿名空间；登录 → 当前账号在本机的空间（登录/登出都会切，见 openSpace）。
   * 2026-10-10 模型重构：登出**切回匿名空间** —— 登出后看到的是匿名数据，不是刚
   * 才那个账号的（旧模型"登出不换空间"会让共用电脑上的人互相看到彼此的库）。
   */
  get activeSpace(): LocalSpace {
    const found = this.settings.spaces.find((space) => space.id === this.settings.activeSpaceId);
    // 表是 fillDefaults 补过、openSpace 校验过的，理论上一定有；兜底回第一条
    return found ?? this.settings.spaces[0];
  }

  /**
   * 启动时按登录态选对**该打开哪份本机数据**（只改 `activeSpaceId`，不弹窗、不开库 ——
   * 真正的开库由 onload 随后照着它做）。替代旧模型"启动复查必答窗"的职责。
   */
  private async reconcileActiveSpace(): Promise<void> {
    const wantId = resolveActiveSpaceId(this.settings.spaces, {
      hasAccount: this.hasAccountNow(),
      uid: this.settings.accountProfile?.uid?.trim() ?? "",
      serverUrl: this.settings.serverUrl,
      currentId: this.settings.activeSpaceId,
    });
    if (wantId === this.settings.activeSpaceId) return;
    // 换空间之前先把 AI 配置换过来：它跟着空间走（见 settings/aiSpace.ts）。
    // 不切的话，新账号会继续拿着上一个账号的 Key 发请求、付费。
    switchSpace(this.settings, this.settings.activeSpaceId, wantId);
    this.settings.activeSpaceId = wantId;
    await this.saveSettings();
  }

  /**
   * 换一份本机数据来用：关旧库 → 开新库 → 补归属标记 → 刷新已打开的页面。
   *
   * ⚠️ 必须先等在途的同步落地再关库：同步正拿着旧库逐块推，中途换库会让它
   * 推到别人的空间上，或者在已关闭的连接上抛异常。
   */
  async openSpace(id: string): Promise<void> {
    if (!this.settings.spaces.some((space) => space.id === id)) return;
    if (id === this.settings.activeSpaceId) return;
    if (this.syncInFlight) await this.syncInFlight.catch(() => undefined);

    // 🔥 先把新库开出来再关旧的：新库开不出来（配额、被别的标签页占着升级）
    //    时，旧库还好好开着，用户最多是"切不过去"，而不是插件整个瘫掉。
    const next = await VaultDb.open(id);
    const previous = this.db;
    this.db = next;
    previous?.close();
    // AI 配置跟着空间换（2026-10-17 方案 B）：新空间的桶是空的，页面上那份
    // 自定义模型配置就跟着空掉 —— 换账号不会再看到/用到上一个人的 Key。
    switchSpace(this.settings, this.settings.activeSpaceId, id);
    this.settings.activeSpaceId = id;
    await this.saveSettings();
    await this.tagVaultPath();
    invalidateNoteCache(); // 换了空间，笔记缓存按新空间重拉
    log.info("切换到本机空间", { id, owner: accountLabel(this.activeSpace.ownerName, this.activeSpace.owner) });
    await this.updateStatusBar();
    await this.refreshOpenViews();
  }

  /**
   * 现在有没有账号（登录态的唯一口径）—— 状态栏、点击守卫共用这一份。
   *
   * 与 `services/dataInventory.ts::hasAccount` 同口径（access / refresh 有一个就算）。
   * ⚠️ 别跟 `notes/mine.ts::isLoggedIn` 混：那个只看 `refreshToken`，是另一回事。
   */
  private hasAccountNow(): boolean {
    return Boolean(this.settings.authToken.trim() || this.settings.refreshToken.trim());
  }

  /**
   * 同步前必过的一道闸门：**这份本机数据是不是归当前登录的账号**。
   *
   * 🔥 新模型（2026-10-10）下**匿名库一律不放行** —— 匿名空间恒存在，若还按旧口径
   *    放行空 owner，登录瞬态（令牌已落盘、活跃库仍是匿名库）就会把整个匿名库推给账号。
   *    现在只认「`owner === uid` 且同服务器」；拿不到 uid（快照还没拉到）也不放行。
   *
   * 已认领则必须**账号 + 服务器**都对上 —— 只比 uid 会把 dev 的数据推给线上账号。
   * 这是防串号的最后一道防线。
   */
  private spaceMatchesAccount(): boolean {
    const space = this.activeSpace;
    const uid = this.settings.accountProfile?.uid.trim() ?? "";
    if (!uid || uid !== space.owner.trim()) return false;
    return sameServer(space.ownerServer, this.settings.serverUrl);
  }

  /** 同一件事 + 一条日志。同步入口用这个，状态栏用上面那个纯判断。 */
  private spaceSyncAllowed(): boolean {
    if (this.spaceMatchesAccount()) return true;
    const space = this.activeSpace;
    log.warn("本机数据不属于当前登录的账号，本次同步取消", {
      owner: `${space.owner}@${space.ownerServer}`,
      account: `${this.settings.accountProfile?.uid ?? ""}@${this.settings.serverUrl}`,
    });
    return false;
  }

  /**
   * 登录成功后，按**判定树**把这份本机数据跟账号对齐（规则见 services/localSpace.ts）。
   *
   *  1. 本机已有该账号的空间 → 进入它（拉云端数据由后续同步负责）；
   *  2. 没有 → 匿名空间为空则新建空账号空间；非空则弹「认领」窗让用户选。
   *
   * ⚠️ 两条路都会**立刻给该账号建出空间** ⇒ 之后登录走分支 1，永不再问。
   * ⚠️ `refreshAccountProfile` 会兜底再调一次 → `promptClaim` 里的在途字段挡住重复弹窗。
   */
  async bindSpaceToAccount(uid: string, nickname: string): Promise<void> {
    const account = uid.trim();
    if (!account) return; // 账号身份还没拿到（快照未拉）→ 什么都不做，等下一趟兜底

    // ① 本机已经有这个账号的空间 → 直接切过去（顺手刷新昵称快照）
    const existing = findSpaceForAccount(this.settings.spaces, {
      uid: account,
      serverUrl: this.settings.serverUrl,
    });
    if (existing) {
      if (nickname && existing.ownerName !== nickname) {
        existing.ownerName = nickname;
        await this.saveSettings();
      }
      if (this.settings.activeSpaceId !== existing.id) await this.openSpace(existing.id);
      return;
    }

    // ② 本机没有这个账号的空间：匿名空间空 → 直接新建；非空 → 问认领
    const anon = anonymousSpace(this.settings.spaces);
    if (!anon) {
      await this.openNewSpaceFor(account, nickname);
      return;
    }
    // 🔥 判空读的必须是**匿名库本身**。正常路径（未登录 → 登录）活跃库就是匿名库，
    //    但深链连接（`obsidian://young-look?code=…`）能在「已登录成另一个人」的
    //    状态下直接换身份 —— 那时 `this.db` 还是**上一个人的库**：读它会把别人的数据
    //    当成匿名空间的数据（误弹认领窗），而且认领不改 `activeSpaceId`，认领完
    //    用户仍停在别人的空间里。所以先按模型把活跃库拨回匿名空间（用户此刻本来就
    //    只该看匿名数据），再判空。正常路径下这里 id 相同，是一次空转。
    if (this.settings.activeSpaceId !== anon.id) await this.openSpace(anon.id);
    const anonHasData = await spaceHasUserData(this.db);
    if (!anonHasData) {
      await this.openNewSpaceFor(account, nickname);
      return;
    }
    this.promptClaim(account, nickname);
  }

  /**
   * 弹「匿名空间里还有学习数据，要不要认领」的选择窗。
   *
   * 三条出路（见 `views/LocalSpaceModal.ts`）：
   *  · 认领 → 匿名库原地变成这个账号的；
   *  · 不认领 → 给它另开一份空空间（匿名数据原样留下）；
   *  · **放弃登录** → 丢掉刚换到的令牌，回到未登录 + 匿名空间。
   * 前两条都会**立刻给该账号建出空间** ⇒ 之后再登录走判定树分支 ①，永不再问；
   * 所以第三条（退出）是必须给的 —— 不认领这个动作不可逆，得让人有机会反悔。
   *
   * ⚠️ `refreshAccountProfile` 的兜底会再调一次 `bindSpaceToAccount` → 用 `bindingPrompt`
   *    在途字段挡住第二个窗（同一个账号只处理一次）。
   */
  private promptClaim(uid: string, nickname: string): void {
    if (this.bindingPrompt) return;
    this.bindingPrompt = uid;
    new LocalSpaceModal(this.app, {
      account: { name: nickname, uid },
      onClaim: () => {
        this.bindingPrompt = null;
        void this.claimAnonymousSpace(uid, nickname);
      },
      onSkip: () => {
        this.bindingPrompt = null;
        void this.openNewSpaceFor(uid, nickname);
      },
      onAbort: () => {
        this.bindingPrompt = null;
        void this.dropLoginState("已放弃登录，学习数据还在匿名空间里。");
      },
    }).open();
  }

  /**
   * 认领：把**匿名库原地变成这个账号的空间**（改 owner，不搬库、零拷贝），
   * 再补一条新的空匿名空间 —— 匿名空间这个"地板"必须恒存在。
   *
   * ⚠️ **不调 `openSpace`**：此刻活跃的正是这份匿名库，认领后它就是账号空间、库不用换；
   *    另开一条空匿名空间是给"下次登出"预备的。
   */
  async claimAnonymousSpace(uid: string, nickname: string): Promise<void> {
    const anon = anonymousSpace(this.settings.spaces);
    if (!anon) return;
    anon.owner = uid;
    anon.ownerServer = this.settings.serverUrl;
    anon.ownerName = nickname;
    this.settings.spaces.push({
      id: nextSpaceId(this.settings.spaces, this.settings.vaultLocalId),
      owner: "",
      ownerServer: "",
      ownerName: "",
    });
    await this.saveSettings();
    // 未登录期间写的笔记属于这个匿名空间，认领时一起交给账号（失败的行留在本机）
    const moved = await claimLocalNotes(this.settings, this.db);
    if (moved > 0) log.info("已把未登录时写的笔记交给账号", { rows: moved });
    await this.updateStatusBar();
    await this.refreshOpenViews();
  }

  /** 给账号**另开一份空的本机空间**并切过去（匿名空间不受影响）。 */
  async openNewSpaceFor(uid: string, nickname: string): Promise<void> {
    const id = nextSpaceId(this.settings.spaces, this.settings.vaultLocalId);
    this.settings.spaces.push({
      id,
      owner: uid,
      ownerServer: this.settings.serverUrl,
      ownerName: nickname,
    });
    await this.saveSettings();
    await this.openSpace(id);
    new Notice(`已给 ${accountLabel(nickname, uid)} 开了一份新的本机数据。`);
  }

  /**
   * 拿一个现在能用的访问令牌，没有就返回 null。
   *
   * 连上账号之后是**长期保持登录**的：access 只有 60 分钟，过期时用
   * refresh 换一对新的（服务端开了轮换，旧的 refresh 立刻作废，所以**必须**
   * 把响应里那个新的存回去）。refresh 也失效了才算真掉线 —— 那时清掉登录态，
   * 让用户重新连一次，而不是每次请求都白撞 401。
   *
   * 🔒 只有服务端**明确拒绝**这个 refresh（invalid）才清登录态；网络断、
   * 超时、5xx 这类临时故障（transient）令牌多半还活着，必须保留 ——
   * 否则一次网络抖动就把用户踢下线，表现为"无缘无故掉线"。
   *
   * @param force 刚被服务端 401 拒过，跳过「还没过期」的判断直接换。
   */
  async ensureAccessToken(force = false): Promise<string | null> {
    const access = this.settings.authToken.trim();
    if (!force && access && !isAccessExpired(access)) return access;

    const refresh = this.settings.refreshToken.trim();
    if (!refresh) {
      if (access) void this.dropLoginState();
      return null;
    }

    // 并发保护：同时来了三个请求时只换一次，否则第一个换回来的 refresh
    // 会被第二个请求用的旧 refresh 顶掉（服务端轮换后旧的立刻作废）。
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      const outcome = await refreshSession(this.settings.serverUrl, refresh);
      if (outcome.kind === "invalid") {
        void this.dropLoginState();
        return null;
      }
      if (outcome.kind === "transient") {
        log.warn("暂时连不上服务端，保留登录态，本次请求放弃");
        return null;
      }
      // 刷新期间用户可能已退出登录（或切环境清了登录态）：别把新令牌写回去
      // 把会话"复活"。比对刷新前捕获的旧 refresh —— 没被人动过才继续写。
      if (this.settings.refreshToken.trim() !== refresh) return null;
      this.settings.authToken = outcome.session.access;
      this.settings.refreshToken = outcome.session.refresh;
      this.settings.authServerUrl = this.settings.serverUrl;
      await this.saveSettings();
      return outcome.session.access;
    })();

    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  /**
   * 清掉登录态、切回匿名空间。
   *
   * 两个来路共用：① 刷新令牌也失效了（被动掉线）；② 认领窗上点了「放弃登录」
   * （用户主动反悔）。清理动作完全一样，只有告诉用户的那句话不同 —— 所以文案
   * 走参数，别为此写第二份实现（三处复制的清态逻辑迟早会漏掉一格）。
   */
  private async dropLoginState(notice = "登录已失效，已回到匿名数据，请重新登录。"): Promise<void> {
    const anon = anonymousSpace(this.settings.spaces);
    this.settings.authToken = "";
    this.settings.refreshToken = "";
    this.settings.accountProfile = null;
    this.settings.aiBalanceMillis = 0;
    this.lastProfileFetch = 0;
    this.syncPaused = false;
    invalidateNoteCache();
    await this.saveSettings();
    // 被动登出同样切回匿名空间（不然停在账号空间、状态栏却显示「本地数据」）
    if (anon && this.settings.activeSpaceId !== anon.id) await this.openSpace(anon.id);
    new Notice(notice);
    await this.updateStatusBar();
    await this.refreshOpenViews();
  }

  /**
   * 账号头像的完整地址。
   *
   * 服务端给的是 `/storage/…` 相对路径（`STORAGE_URL`），必须拼上 serverUrl；
   * 已经带协议的（以后换 CDN）就直接用。拿不到返回 null，界面退回人形图标。
   */
  accountAvatarUrl(): string | null {
    const path = this.settings.accountProfile?.avatarUrl?.trim();
    if (!path) return null;
    if (/^https?:\/\//iu.test(path)) return path;
    const base = this.settings.serverUrl.trim().replace(/\/+$/u, "");
    return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
  }

  /**
   * 拉一次账号快照（头像 / 昵称 / 余额）。
   *
   * 60 秒节流：首页每次渲染都会喊一次，但真正打网络的只该是第一次。
   * 失败**静默** —— 离线时继续用上次的快照，不能因为一个后台请求把界面搞成报错。
   */
  async refreshAccountProfile(force = false): Promise<void> {
    if (!this.settings.authToken.trim() && !this.settings.refreshToken.trim()) return;
    const now = Date.now();
    if (!force && now - this.lastProfileFetch < PROFILE_TTL_MS) return;
    this.lastProfileFetch = now;
    try {
      // 走 ensureAccessToken：令牌过期时先换再拉，别拿过期的令牌去撞 401
      const token = await this.ensureAccessToken();
      if (!token) return;
      const base = this.settings.serverUrl.trim().replace(/\/+$/u, "");
      const response = await fetch(`${base}/api/v1/users/me/`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return;
      const body = (await response.json()) as { data?: MePayload };
      const data = body.data;
      if (!data) return;
      this.settings.accountProfile = profileFromMe(data);
      if (typeof data.ai_balance_millis === "number") this.settings.aiBalanceMillis = data.ai_balance_millis;
      await this.saveSettings();
      // 兜底对齐一次：连接码响应里万一没带 uid，认领/建空间会落到这里。
      // 已经对齐时它什么都不做（见 bindSpaceToAccount 的判定树）。
      await this.bindSpaceToAccount(
        this.settings.accountProfile?.uid ?? "",
        this.settings.accountProfile?.nickname ?? "",
      );
    } catch {
      // 离线 / 超时：留着上次的快照，不打扰用户
    }
  }

  /**
   * 连接成功的广播：授权码弹窗开着的时候，用户可能不走弹窗、直接在网页点
   * 深链把连接办完 —— 弹窗得听到这声自己消失，不能留个空壳等人关。
   * 返回退订函数，弹窗关闭时解绑。
   */
  onConnectSuccess(handler: () => void): () => void {
    this.connectSuccessHandlers.add(handler);
    return () => {
      this.connectSuccessHandlers.delete(handler);
    };
  }

  private connectSuccessHandlers = new Set<() => void>();

  /**
   * 拿网页端给的一次性连接码换登录令牌。
   *
   * 为什么不直接把令牌贴在 obsidian:// 链接里：链接会留在浏览器历史里，
   * 一次性码 5 分钟失效，换到的令牌只进本机 data.json。
   *
   * 成败由返回值说明，**不弹 Notice** —— 提示由调用方各自负责（协议处理器
   * 用 Notice，授权码弹窗把失败原因写在自己底栏上）。成功时广播
   * `onConnectSuccess`，开着的授权码弹窗听到就自己关。
   */
  async exchangeConnectCode(code: string): Promise<{ ok: boolean; message: string }> {
    const base = this.settings.serverUrl.trim().replace(/\/+$/u, "");
    try {
      const response = await fetch(`${base}/api/v1/auth/plugin-exchange/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.json().catch(() => null)) as {
        data?: ExchangePayload;
        message?: string;
      } | null;
      const data = body?.data ?? {};
      if (!response.ok || !data.access) {
        return {
          ok: false,
          message: body?.message?.trim() || "连接码不对或者过期了，去网页重新生成一个。",
        };
      }
      this.settings.authToken = data.access;
      // 🔑 refresh 必须存下来 —— 它是「长期保持登录」的凭据。
      // 只存 access 的话 60 分钟后用户就被踢下线了，得重新连接一遍。
      if (typeof data.refresh === "string" && data.refresh) {
        this.settings.refreshToken = data.refresh;
      }
      // 记下令牌是谁发的：以后换了服务器要凭这个把旧令牌作废
      this.settings.authServerUrl = this.settings.serverUrl;
      if (typeof data.balance_millis === "number") {
        this.settings.aiBalanceMillis = data.balance_millis;
      }
      // 换码响应里就带着账号快照，先写进去 —— 首页头像不用再等一次 /users/me/
      this.settings.accountProfile = profileFromMe(data);
      this.lastProfileFetch = Date.now();
      // 换了身份：「暂停」是上一个账号（或没账号时）的判定，作废等下一趟同步重算
      this.syncPaused = false;
      invalidateNoteCache(); // 换了身份，笔记缓存按新账号重拉
      await this.saveSettings();
      // 把这份本机数据跟新账号对齐（同账号什么都不做 / 首次登录静默认领 /
      // 换了个人则弹窗问，见 bindSpaceToAccount）。**排在广播之前** ——
      // 广播一响，开着的页面就按新身份重画了，归属得先定下来。
      await this.bindSpaceToAccount(
        this.settings.accountProfile?.uid ?? "",
        this.settings.accountProfile?.nickname ?? "",
      );
      await this.updateStatusBar();
      // 关键：让已经渲染出来的学习卡片按钮**立刻**变可点，不用重开页面
      await this.refreshOpenViews();
      // 广播一声：开着授权码弹窗的话让它自己关（深链把连接先办完了）
      for (const handler of [...this.connectSuccessHandlers]) handler();
      return { ok: true, message: "已连接" };
    } catch {
      return { ok: false, message: "连不上服务器，看看网络再试一次。" };
    }
  }

  /**
   * 打开网页连接页（/plugin/connect）：登录 / 注册、生成一次性码、
   * 「打开 Obsidian 并完成连接」深链跳回 —— 全在网页完成，插件不做第二个界面。
   * 所有要登录的入口（悬浮卡、插件设置、个人中心学习页）都走这里。
   */
  openConnectPage(): void {
    window.open(`${this.webBase()}/plugin/connect`, "_blank");
  }
}

/** 拉账号快照的节流窗口 */
const PROFILE_TTL_MS = 60_000;

/** `/api/v1/users/me/` 与换码响应里我们真正用到的字段 */
/** 个人中心的来路：退出时按它回到原位。 */
export type PersonalOrigin =
  | { from: "list" }
  | { from: "study"; recordCid: string; index: number };

interface MePayload {
  uid?: string;
  username?: string;
  nickname?: string;
  avatar?: string;
  email?: string;
  ai_balance_millis?: number;
}

interface ExchangePayload extends MePayload {
  access?: string;
  refresh?: string;
  balance_millis?: number;
  welcome_bonus?: { granted?: boolean } | null;
}

/** 服务端响应 → 本地账号快照（两个接口的字段形状一致，共用一份映射） */
function profileFromMe(data: MePayload): AccountProfile {
  return {
    uid: String(data.uid ?? ""),
    nickname: data.nickname || data.username || "",
    email: data.email ?? "",
    avatarUrl: data.avatar ?? "",
    fetchedAt: new Date().toISOString(),
  };
}

/** indexedDB.deleteDatabase 的 Promise 包装；失败/被占也继续（反正马上整窗重启）。 */
function deleteYounglookDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
