/**
 * 本地实体定义。
 *
 * 这里是服务端 `core/psync` 模型的本地镜像，字段口径刻意保持一致，
 * 这样将来无论哪一边做数据迁移，都能一一对应。
 *
 * 两处刻意的不一致：
 *  1. `AssetRow.localPath` —— 只存在于本地，**永不上行**。绝对路径跨设备必失效，
 *     而且会泄漏用户名和盘符。
 *  2. `rev` —— 服务端的逻辑版本号，本地保存它只是为了下次 push 时带上 `base_rev`
 *     做乐观并发；本地自己写不抬它。
 */

export type IsoDate = string;

export type AssetKind = "video" | "subtitle";

export type PartOfSpeech =
  | "noun"
  | "proper"
  | "pron"
  | "suffix"
  | "verb"
  | "adj"
  | "adv"
  | "particle"
  | "aux"
  | "conj"
  | "prefix"
  | "punct"
  | "other";

/**
 * 实词集合。必须与 `core/notes/services/ja_morph.py::CONTENT_POS` 完全一致：
 * 排除 particle / aux / punct，其余都是实词，参与生词提取。
 */
export const CONTENT_POS: ReadonlySet<PartOfSpeech> = new Set<PartOfSpeech>([
  "noun",
  "proper",
  "pron",
  "suffix",
  "verb",
  "adj",
  "adv",
  "conj",
  "prefix",
  "other",
]);

export type MeaningSource = "" | "llm" | "memory" | "dictionary";

/** 一个词条的形态素结果。字段逐一对齐 `ja_morph.tokenize()` 的输出。 */
export interface Token {
  surface: string;
  lemma: string;
  /** 平假名读音 */
  reading: string;
  romaji: string;
  /** AI 解析给的句内读音（假名）。比词典 reading 准——人名/缩约/连浊按句内来。
   *  抄写提示优先用它；词典没这词或注音不对时它就是唯一的正确读音。
   *  机器产物，不进纠正集合；但整份解析结果随统一快照的 analysis 集合上云（2026-10-06 拍板，换机免重解析）。旧分析没有它就回退 reading。 */
  aiReading?: string;
  pos: PartOfSpeech;
  def?: string;
  meaningSource?: MeaningSource;
  /** 英语外来语的词源（如 ビデオ → video）。**只有英语借词才有**：
   *  和语、汉语词、其他语种的外来语一律不给 —— 别去编它们的语源。
   *  句子卡上点词弹卡时显示；机器产物，与 aiReading 同源同寿命（随 analysis 上云）。 */
  origin?: string;
  /** 来自剧集词条记忆的纠错结果 */
  corrected?: boolean;
  /** 命中自定义词典被整块认出（人名之类） */
  protected?: boolean;
}

/**
 * 一句解读的两个分段 —— 与 `hosted_prompts.ANALYZE_SYSTEM` 要求的
 * `sections` 逐字段对应（服务端按同一份键做长度截断）。
 *
 * 为什么不是一段自由文本：界面上这两块各有小标题（用户 2026-10-07 拍板），
 * 结构化回来才能稳妥地分节渲染；靠模型在长文本里写标记再切分，
 * 模型一不听话整段就退化成大白话，而且**不报错**。
 *
 * 🔥 2026-10-08 用户拍板：由**四段收敛为三段**（去掉「口语与书面语」）；
 * 🔥 2026-10-09 用户拍板：再由三段收敛为**两段**（去掉「使用场景」，
 * 例句并入「核心语法」）（见 ANALYZE_SYSTEM）。
 */
export interface ExplanationSections {
  /** 核心单词：讲清这几个词在本句里的意思（**只讲词义，不讲语法**） */
  words: string;
  /** 核心语法：挑最值得学的几个讲透，不罗列一般用法大全；例句也在这段里 */
  grammar: string;
}

/**
 * 两段解读的键与中文小标题，**顺序就是界面与笔记里的顺序**。
 *
 * 放这里而不是放在 AI 层：卡片（views/study/analysis.ts）与笔记渲染
 * （markdown/studyNote.ts）都要用它，而后者不该依赖 AI 调用层 ——
 * 两处各写一份标题，改文案时必然漏一处（表现是卡片叫「核心语法」、
 * 笔记里叫「语法点」，而且不报错）。
 */
export const EXPLANATION_SECTIONS: ReadonlyArray<readonly [keyof ExplanationSections, string]> = [
  ["words", "核心单词"],
  ["grammar", "核心语法"],
];

/** 两段全空的初值 —— 别在多处各写一份字面量，漏一个键就成了 undefined。 */
export const EMPTY_EXPLANATION_SECTIONS: ExplanationSections = {
  words: "",
  grammar: "",
};

/**
 * 整句解析结果。结构对齐 `learning.Slice.analysis_json`。
 *
 * 🔥 落地口径（2026-09-27 用户拍板）：**点过「AI 解析」就存下来**。
 * 在这之前它是纯内存的 —— 翻页即失、翻回来再点再扣一次钱。
 * 现在存进 `StudySentence.analysis`，本机命中就不再发请求，服务端那份
 * 缓存（`learning.AnalysisCache`）负责跨用户省。
 *
 * ⚠️ 2026-10-07 起这一份是**两次请求拼出来的**：解读（explanation）
 * 与逐词释义（tokens[].def / .aiReading / .origin）分开要。两块都回来
 * 才落库 —— 只回来一半的话翻回这句时会显示成"解析过了"，但词点不开。
 */
export interface SentenceAnalysis {
  /** 产出方式标记（含版本）。对不上就当作没解析过，重新来一次 */
  engine: string;
  text: string;
  romaji: string;
  tokens: Token[];
  /** 这一句的解读，分两段（核心单词 / 核心语法）。
   *  没跑过 AI 就是 undefined */
  explanation?: ExplanationSections;
  missingDefinitions: string[];
  definitionsComplete: boolean;
  done: boolean;
  /** 整句中文翻译（AI 给的那份）。没跑过 AI 就是空 */
  translation?: string;
}

/**
 * 和助手的一轮问答。
 *
 * 存进 `ProgressRow.imitationChat`，翻走再翻回来还在；插件重载后也能读回来。
 * 在此之前它只活在一个内存 Map 里（`dispose()` 就没了）。
 */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  /** 这一轮发生的时刻（ISO）。助手气泡下面那句"本次扣了多少"靠它排序 */
  ts: string;
  /** 助手那一轮的扣费（厘）。BYOK 不花钱、旧数据也没有，所以可空 */
  billing?: { charged_millis: number; balance_millis: number } | null;
}

export type WordStatus = "new" | "learning" | "known" | "ignored" | "suspended";

/** 所有参与同步的实体的公共字段。 */
export interface SyncFields {
  /** 服务端逻辑版本；下次 push 时作为 base_rev 带上做乐观并发 */
  rev: number;
  /** 行内容的规范化摘要，用于 unchanged 短路 */
  rowDigest: string;
}

export interface RecordRow extends SyncFields {
  /** `R:` + sha256(视频 sha256 ⟨US⟩ 日文字幕 sha256) —— 文件对即身份（见 core/ids.ts） */
  cid: string;
  videoSha256: string;
  jaSubSha256: string;
  /** 可选的中文翻译字幕；换中文翻译**不产生新记录** */
  zhSubSha256: string | null;
  // ── 以下全部是**纯展示字段**：改名/改集号零身份后果（2026-10-14 拍板）──
  title: string;
  titleJa: string;
  romaji: string;
  year: number | null;
  coverUrl: string;
  note: string;
  season: number | null;
  /** 归一化后的整数或小数字符串，支持 1.5 这种特别篇（仅用于展示/笔记命名） */
  number: string;
  episodeTitle: string;
  durationMs: number | null;
  /**
   * 首次写笔记时定下的笔记文件名（可选）。同展示元数据的多条记录靠它 +
   * 哈希短后缀保证 vault 里笔记文件不撞名；没写过笔记就是 undefined。
   */
  noteName?: string;
  clientUpdatedAt: IsoDate;
  deletedAt: IsoDate | null;
}

/**
 * 素材行 = 一份本机文件。键 = `A:` + 文件 sha256，**跨记录共享**：
 * 同一个视频配两份不同字幕，是两条记录、同一个视频素材行——
 * 时间轴校准（offsetMs）因此自动跟过去。
 */
export interface AssetRow extends SyncFields {
  cid: string;
  kind: AssetKind;
  /** 64-hex 整文件 sha256（身份本体，cid 由它派生） */
  sha256: string;
  filename: string;
  sizeBytes: number;
  /** 仅字幕有意义：ja / zh */
  language: string;
  subtitleFormat: string;
  /** 本机绝对路径，只存在于本地，永不上行 */
  localPath: string;
  /** 上次核对时文件是否还在 */
  available: boolean;
  /**
   * 时间校准偏移（毫秒）：字幕整体比视频早/晚多少。
   * 只对视频素材有意义；没存过 = 0。整个视频共用这一个值（见 services/clipOffset.ts）。
   */
  offsetMs?: number;
  clientUpdatedAt: IsoDate;
  deletedAt: IsoDate | null;
}

/**
 * 句子行 = 三句哈希寻址的**共享内容层**（跨记录）。
 *
 * 它只承载「这个内容哈希上沉淀的东西」：AI 解析、读音/文本纠错覆盖层。
 * 原片文本的**展示**一律读记录自己的 `RecordLineRow`（每条记录的时间轴与
 * 原文可以不同），这里不存展示文本——规范化哈希相同但原文写法不同的两个
 * 变体各归各的 line，互不覆盖。
 */
export interface SentenceRow extends SyncFields {
  /** `S:` 三句哈希（算法见 core/ids.ts::sliceCid，口径与服务端一致，禁改） */
  cid: string;
  /** 首次写入者的原片日文。仅作参考/兜底，展示读 lines */
  ja: string;
  /** sha256(去掉空白的 ja)，纯句子去重索引（不参与身份派生） */
  textHash: string;
  analysis: SentenceAnalysis | null;
  /**
   * 注音纠错：用户手改的读音，键 = 分词序号。
   * 用户主动编辑的内容，走**私有同步**上云（存整句，见 sync/snapshot.ts 的 corrections 集合）。
   * AI 解析的读音（`analysis` 里的 `aiReading`）不是用户写的，**只落本机、永不上行**。
   * 应用时校验 surface 跟当前分词一致，分词口径变了就自动失效回默认注音。
   *
   * 🔥 **读音优先级第一档**（用户手改 > AI 解析 > 本机词典，全站唯一口径）：
   * 纠过的词就是最终答案，AI 重新解析也不许盖回去。
   */
  readingFixes?: Record<string, { surface: string; reading: string }>;
  /**
   * 日文 / 中文字幕的修正（用户在纠错弹窗里改的）。
   * 走**私有同步**上云（快照的 corrections 集合只带这句的覆盖层）。
   */
  textFixes?: { ja?: string; zh?: string };
  /**
   * 纠正同步的簿记时间戳：最后一次纠正变化（**含撤销**）的时刻。
   * 不能复用 `clientUpdatedAt`：AI 解析落库也会抬它，会把纠正的 LWW 时序搅乱。
   */
  correctionsUpdatedAt?: string;
  clientUpdatedAt: IsoDate;
}

/**
 * 学习视图用的合成句：记录层台词（原文/时间轴）+ 句子共享层（解析/纠错覆盖层）。
 * 定义在 entities 只是为了让视图层统一从这里 import；拼接逻辑在 services/study.ts。
 */
export interface StudySentence {
  /** `S:` 三句哈希 —— 进度/笔记/录音/解析全挂它（跨记录共享） */
  cid: string;
  /** 集内序号（1 起） */
  index: number;
  startMs: number;
  endMs: number;
  ja: string;
  zh: string;
  speaker: string;
  /** sha256(去掉空白的 ja)，纯句子去重索引 */
  textHash: string;
  analysis: SentenceAnalysis | null;
  textFixes?: { ja?: string; zh?: string };
  readingFixes?: Record<string, { surface: string; reading: string }>;
  correctionsUpdatedAt?: string;
}

/**
 * 台词行 = 学习记录自己的**时间轴层**（本地 only，永不上云——原文红线）。
 *
 * 同一个句子（三句哈希相同）在不同记录里可以有不同的原文变体、时间戳和
 * 集内序号，各自落各自的行。重建（重导/换字幕）时整段重写，无同步负担。
 */
export interface RecordLineRow {
  recordCid: string;
  /** 集内序号（1 起） */
  index: number;
  /** → SentenceRow.cid */
  sentenceCid: string;
  startMs: number;
  endMs: number;
  ja: string;
  zh: string;
  speaker: string;
}

/**
 * 三步进度。
 *
 * 每一步都带一个 `epoch`：用户点「重做」时自增。
 * 同步合并靠 epoch 判断"这一步是不是真的被清掉了"，而不是靠时间戳——
 * 否则会出现"手机上完成的跟读被桌面的旧数据抹掉"。
 */
export interface ProgressRow extends SyncFields {
  cid: string;
  sliceCid: string;
  copyAttempts: number;
  copyDoneAt: IsoDate | null;
  copyEpoch: number;
  copyText: string;
  readAloudAt: IsoDate | null;
  /**
   * 这一遍跟读是**真的让 AI 逐词核对过**、并且每个词都读对 —— 存核对通过的时刻。
   *
   * 为什么要单独一个字段，而不是看 `readAloudAt`：跟读有**两条**过关路径 ——
   * AI 逐词核对，以及"AI 用不了时只查有没有出声"的本地检查（还有无麦克风时的
   * 「标记完成」逃生舱）。后两种**没人判过发音**，照样算过，否则没充值的用户
   * 永远学不完一句。那种"过了但没人判过"的状态必须能和"AI 判对了"分开：
   * 卡片上一个写「正解」（青蓝）、一个写「已完成」（灰，2026-10-09 用户拍板）。
   * 本地检查 / 无麦标记完成 / 重做都写 null。
   */
  readAloudVerifiedAt: IsoDate | null;
  readAloudSeconds: number;
  readEpoch: number;
  imitationText: string;
  imitationCorrect: boolean | null;
  /**
   * 这一遍是**真的经过 AI 核对**、并且判过 —— 存的是核对通过的时刻。
   *
   * 为什么要单独一个字段，而不是看 `imitationCorrect`：**AI 不可用时这一步
   * 照样放行**（没开 AI / 没登录 / 没填 Key 时点「AI 核对」，不做任何检查直接算过，
   * 否则离线用户永远学不完一句）。那种"过了但没核对过"的状态必须能和
   * "AI 判对了"区分开 —— 卡片上一个黄一个绿，上行时也只收这个字段有值的那些。
   * 判错、重做、以及兜底放行都写 null。
   */
  imitationVerifiedAt: IsoDate | null;
  /**
   * AI 判定给的理由与建议。
   *
   * ⚠️ `correct` 是**判定当时**的结论，与 `imitationCorrect`、`imitationVerifiedAt`
   * 三者的分工：
   *   · `imitationCorrect`    这一步现在算不算过（判对 = true，判错 = false，没核过 = null）
   *   · `imitationVerifiedAt` 这一遍有没有真的让 AI 核过
   *   · `imitationFeedback`   判过之后**为什么**（理由 / 更自然的说法与它改了哪里 / 仿写句的中文意思 / 判定当时的结论）
   *
   * 兜底放行时整份是空的 —— 没核对过，本来就没有理由可留。
   */
  imitationFeedback: {
    correct?: boolean;
    reason?: string;
    /** 改写建议：一句完整日语（不含「更自然的说法：」标签，标签由展示侧加） */
    suggestion?: string;
    /** suggestion 改了哪里的一句中文说明；与 suggestion 成对，缺一个就不显示 */
    suggestionNote?: string;
    translation?: string;
  };
  imitationHint: Record<string, unknown> | null;
  /** 和助手的问答记录（见 ChatTurn）。翻走再翻回来还在，重载也还在 */
  imitationChat: ChatTurn[];
  imitationEpoch: number;
  /** 三步齐全才有值；由本地的一判定逻辑派生 */
  completedAt: IsoDate | null;
  clientUpdatedAt: IsoDate;
  deletedAt: IsoDate | null;
}

export interface WordRow extends SyncFields {
  cid: string;
  lemma: string;
  pos: PartOfSpeech;
  surface: string;
  reading: string;
  romaji: string;
  definition: string;
  meaningSource: MeaningSource;
  status: WordStatus;
  mastery: number;
  lastReviewedAt: IsoDate | null;
  reviewCount: number;
  lapseCount: number;
  correctCount: number;
  exposureCount: number;
  firstSeenAt: IsoDate;
  lastSeenAt: IsoDate;
  clientUpdatedAt: IsoDate;
  deletedAt: IsoDate | null;
}

/**
 * 本机笔记（「笔记」抽屉，2026-10-09 改版）：**未登录时**的纯单机笔记。
 *
 * 登录用户的笔记存在服务端（`/api/v1/notes/`，三句 hash 寻址、对同句的
 * 其他登录用户可见，按账号走）—— 不落本地这张表。未登录没有身份，笔记
 * 只存这里：不上行、不同步、别人也看不见（docs/me/notes.md 的「纯单机」）。
 *
 * 键 = 三句 hash（`slice.cid` 去掉 `S:` 前缀），与服务端同一套寻址。
 */
export interface MyNoteRow {
  hash: string;
  text: string;
  updatedAt: IsoDate;
}

/** 日活聚合。本地由上面的行重算，也可以接受服务端下发。 */
export interface StudyDayRow {
  day: string;
  tz: string;
  sentencesCompleted: number;
  copyCount: number;
  readCount: number;
  imitationCount: number;
  reviewCount: number;
  newWords: number;
  studySeconds: number;
  openedSlices: number;
  /**
   * 本地最后一次改这一行的时间。统计上报按它做 LWW ——
   * 服务端靠这个判断「重推上来的旧快照该不该覆盖」。
   */
  clientUpdatedAt: IsoDate;
}

export interface SessionRow extends SyncFields {
  cid: string;
  recordCid: string | null;
  startedAt: IsoDate;
  endedAt: IsoDate | null;
  currentIndex: number;
  clientUpdatedAt: IsoDate;
  deletedAt: IsoDate | null;
}
