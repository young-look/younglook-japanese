import type { ServerEnv } from "../config/env";
import type { AiConfigBundle } from "./aiSpace";

export type AiMode = "off" | "byok" | "hosted";
/**
 * BYOK 配置。
 *
 * ⚠️ `apiKey` 只落在本机的 data.json：
 *  - 导出 JSON 备份时必须剔除（见 services/export/backup.ts 的白名单）
 *  - 日志里只许出现 `sha256(key)` 的前 8 位，不许出现原文
 */
export interface ByokConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * 账号快照。只在首页的头像悬停卡里用，**不含余额** ——
 * 余额的唯一显示源是 `PluginSettings.aiBalanceMillis`（扣费后由 billing sink 刷新），
 * 两个地方各存一份迟早对不上。
 */
export interface AccountProfile {
  uid: string;
  nickname: string;
  email: string;
  /** 服务端给的是 /storage/… 相对路径，用的时候要拼 serverUrl（见 main.ts 的 accountAvatarUrl） */
  avatarUrl: string;
  /** 抓取时间（ISO）。离线时用缓存，界面按这个标注「数据可能过期」 */
  fetchedAt: string;
  // 昵称审核三件套（nicknamePending / nicknameStatus / nicknameNextChangeAt）
  // 已随 2026-10-16「提交即生效」口径退役 —— 没有审核与冷却可解释了。
}

/**
 * 一个「本机空间」—— 一份完整的本地学习数据（一个独立数据库）。
 *
 * 为什么要有它（2026-10-09）：本地库原来只按 vault 隔离、**完全不认账号**，
 * 于是同一台机器上 A 登出、B 登录之后，下一次同步会把含 A 全部记录的整库推给 B。
 * 现在每份数据有自己的主人：`owner` 空 = 从未认领（匿名在用），否则 = 某账号的 uid。
 *
 * 🔥 硬规则：**一份空间只同步给一个账号**（闸门在 main.ts 的 syncStats 里）。
 */
export interface LocalSpace {
  /** 库标识，直接进库名（`younglook-${id}`）。定下就别改 —— 改了等于换一个空库 */
  id: string;
  /** 归属账号的 uid；空串 = 匿名（还没被任何账号认领） */
  owner: string;
  /**
   * 归属是哪台**服务器**上的那个账号。
   *
   * 🔥 判定归属时它必须参与比对：dev 与线上是两个独立的库，各自的 uid 都从 1
   * 开始 —— **同一个 uid 在两台服务器上是两个人**。只比 uid 会把 dev 的数据
   * 推给线上账号（`docs/feature/account_sync.md` 3.9 记的就是这个坑）。
   */
  ownerServer: string;
  /**
   * 归属账号的昵称**快照**。登出后页面要显示「这份数据最近跟谁绑定过」，
   * 那时拿不到账号快照（accountProfile 已清），所以绑定时顺手记一份。
   */
  ownerName: string;
}

export interface PluginSettings {
  /** vault 内的学习资料目录名 */
  vaultFolder: string;
  /**
   * 素材库目录（视频、字幕）。**留空 = 用默认位置**（系统应用数据目录下的 media/）。
   *
   * 宗旨是 vault 里只放笔记：素材是 GB 级的大件，进 vault 会被 Sync / iCloud /
   * OneDrive 一起搬走。想放到外接硬盘或 NAS 上，把绝对路径填在这儿就行。
   */
  mediaDir: string;
  /**
   * 每个**本机空间**一份的 AI 配置（2026-10-17 方案 B，见 settings/aiSpace.ts）。
   *
   * 为什么分桶：换账号登录 = 换本机空间，但 AI 配置原来整个 vault 只有一份，
   * 于是新账号看得见、也用得上上一个账号的 Key（费用记在上一个人头上）。
   * 现在匿名空间一份、每个账号一份，切空间自动切配置；Key 仍然只落本机
   * （`PREF_KEYS` 不含它），所以不跨设备。
   *
   * 🔥 **这里才是权威**：下面的 `aiMode` / `byok` / `byokSaved` / `byokLocked`
   * 只是当前 `activeSpaceId` 那份的工作副本，由 `main.ts::saveSettings()`
   * 落盘前 stash、切空间时 load。别直接改桶而忘了同步，也别绕过这两个入口。
   */
  byokBySpace: Record<string, AiConfigBundle>;
  /** 当前空间的 AI 轨道（工作副本，权威见 `byokBySpace`） */
  aiMode: AiMode;
  /** 当前空间的自定义模型草稿（工作副本，权威见 `byokBySpace`） */
  byok: ByokConfig;
  /**
   * 「已保存生效」的自定义模型配置（2026-10-10 用户拍板）。
   *
   * 账户页的保存/编辑机制：`byok` 是**草稿**（输入框随时可改、落盘不生效），
   * 这里存的是最近一次通过「保存」（含测试连接）落定的快照 —— **只有它参与
   * 生效判定**（见 services/ai/gate.ts 的 resolveAiRoute）。null = 从没保存过。
   *
   * 编辑解锁期间改动只进草稿，旧快照继续生效；点保存测通后才把草稿
   * trim 成快照写到这里。跟 `byok` 一样：apiKey 只落本机 data.json，
   * 导出备份剔除、日志只许 sha256 前 8 位。
   */
  byokSaved: ByokConfig | null;
  /**
   * 自定义模型卡片是否处于**锁定态**（2026-10-10 拍板）：锁定 = 输入框只读、
   * 按钮显示「编辑」；点「编辑」置 false 进编辑态，点「保存」（测连通过）置
   * true 并顺手写 `byokSaved` 快照。只有 `byokSaved` 非空时才有意义。
   * 不用「草稿==快照」推导：点「编辑」时草稿还没变，纯推导会解不开锁。
   */
  byokLocked: boolean;
  /**
   * 连哪台服务器。**默认 auto = 跟着构建环境走** —— 开发构建连本机，
   * 生产构建连线上，用户不用记、也不会忘（见 src/config/env.ts）。
   * dev/prod = 强制指定；custom = 用 `customServerUrl`。
   * ⚠️ 生产构建里设置页不渲染这几项，发布出去的插件没有指向本机的入口。
   */
  serverEnv: ServerEnv;
  /** `serverEnv = custom` 时的地址；其余情况不参与计算 */
  customServerUrl: string;
  /**
   * 实际生效的接口地址（`serverEnv` + 构建环境算出来的结果）。
   *
   * ⚠️ 它是**派生值**，每次加载或改 `serverEnv` 时重算并写回，
   * 所有发请求的地方直接读它 —— 别再拿 `serverEnv` 自己拼地址。
   */
  serverUrl: string;
  /**
   * 当前这套令牌是**哪台服务器**发的。
   *
   * 两边的 JWT 用各自的 SECRET_KEY 签，互不认账。地址变了却不换令牌，
   * 表现是"明明连过账号却一直 401"；记下它才能在切环境时主动清掉登录态。
   */
  authServerUrl: string;
  /** 登录后的访问令牌；未登录为空串 */
  authToken: string;
  /**
   * 刷新令牌。**连上账号后长期保持登录**就靠它：access 只有 60 分钟，
   * 过期时用 refresh 自动换一对新的（服务端开了轮换，每次换回新的 refresh）。
   * 只有用户主动「退出登录」才清它。
   */
  refreshToken: string;
  /**
   * 上次把学习记录推到服务端的时间戳（ms）。0 = 从来没同步过。
   * 状态栏和设置页要显示「上次同步 HH:MM」，用户看到看板数字不动时
   * 得有个地方能确认「到底同步过没有」。
   */
  lastStatsSyncAt: number;
  /**
   * 内置模型余额（厘，1 厘 = ¥0.001）。每次调内置模型都会用响应里的余额刷新它，
   * 只为设置页显示用 —— 真正的账在服务端，这个值过期了也不影响扣费。
   */
  aiBalanceMillis: number;
  /** 账号快照；未登录为 null。离线时读缓存，不阻塞界面 */
  accountProfile: AccountProfile | null;
  autoSyncMinutes: number;
  /**
   * vault 唯一短标识，直接参与本地 IndexedDB 库名。
   * 一旦定下就不要改——改了等于换了一个空库，用户会觉得"数据丢了"。
   * ⚠️ 首次加载必须立刻写进 data.json，否则每次重载都会换一个空库（2026-09-25 修）。
   */
  vaultLocalId: string;
  /**
   * 本机空间清单。第一条是老库（`id === vaultLocalId`），老用户零迁移。
   * 同一时刻只打开 `activeSpaceId` 那一个；表里其余的库原样留着不动。
   */
  spaces: LocalSpace[];
  /** 当前打开的空间 id，一定能在 `spaces` 里找到 */
  activeSpaceId: string;
  /** 启动/重载插件后自动把上次的页面开回来（用户要的是"打开即成品页面"） */
  autoOpenPage: boolean;
  /** 上次打开的插件页面；空串表示没开过 */
  lastView: string;
  /**
   * 「第一次进学习页提醒装词典」是不是已经出现过了（2026-10-11）。
   *
   * 那个提醒一辈子只弹一次：用户看过一次就知道"这里本来有读音"了，再弹就是骚扰。
   * 之后他想装，走抄写卡的「提示」（那条路每次都提醒）。
   *
   * ⚠️ 记的是"**提醒过一次**"，不是"装好了没" —— 装没装是磁盘上的事实
   *    （`dictInstall.isDictInstalled`），别在设置里存第二份状态，
   *    否则用户手工删掉 dict/ 之后两边会打架。
   */
  dictPromptSeen: boolean;
  /**
   * 「这个麦克风可能已经提醒过了」（2026-10-16）。
   *
   * 检测到用户**正在用蓝牙耳机录音**时会问一句（音质会差，建议换成本机麦克风）——
   * 这一句**一辈子只问一次**：用户在窗里点过「就用它录」，就等于表态"我接受这个音质"，
   * 之后再问就是骚扰。
   *
   * ⚠️ 记的是"**问过了**"，不是"他后来换没换设备" —— 换没换是每次录音时
   *    `inspectMicInput()` 当场看出来的（现在不是蓝牙就压根不会走到这一窗），
   *    别在这里存第二份状态，否则两边会打架。
   *
   * ⚠️ 只有点了「就用它录」才记；点「先不录」（或直接关窗）**不记** ——
   *    他可能压根没换成，下次录音还得再提醒一次才算负责。
   */
  micQualityPromptSeen: boolean;
  /**
   * 偏好同步（统一快照的 settings 集合）的 LWW 时间戳。
   * 每次落盘都抬——本地永远是最新事实，云端偏好只在换机/重装
   * （本地还没有偏好时间戳）时能落进来。见 services/sync/snapshot.ts。
   */
  prefsUpdatedAt: string;
  /**
   * 每日全库校验跑到哪天了（`dayKey()` 的 "YYYY-MM-DD"）。空串 = 从没校验过。
   *
   * 为什么要有这道校验：增量同步跑久了，客户端会认为「我传过了，没事」，
   * 而合并逻辑自己写错、某字段两端序列化不一致这类问题它一个都发现不了。
   * 每天拉一次云端哈希清单跟本地比一遍，是唯一能兜住这类 bug 的手段。
   *
   * 本地簿记，**不上云**（不在 PREF_KEYS 里）。
   */
  lastVerifyDay: string;
}
