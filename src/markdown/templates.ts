/**
 * vault 里的命名与时间码。
 *
 * 这里只管**名字**（笔记名、截图名、句锚点、时间码），不管内容怎么写 ——
 * 内容形态在 markdown/studyNote.ts。
 *
 * 命名分两套，别混用：
 *  · `safeName` / `pad2` / `episodeTag` / `seasonTag` —— **新布局**，用户可见的
 *    文件名走这套：保留用户输入的原貌（大小写、空格都不动）。
 *  · `slugify` / `episodeFileName` —— **旧布局**（`works/` 时代）的命名规则，
 *    现在只剩"迁移时按它拼回老路径"一个用途。它们会小写化、把空格换成 `-`，
 *    再拿它们给用户可见的东西命名就会出现"我填的名字和文件名不一样"。
 *
 * 纯函数，不含任何 Obsidian API。
 */

/**
 * cid 转成能当文件名/块引用锚点用的短标识。
 *
 * cid 里的冒号在文件名和块名里都不合法，所以取前缀字母 + 十六进制尾巴。
 * 12 位十六进制（48 bit）在本地素材这个量级上撞的概率可以忽略。
 */
export function blockAnchor(cid: string): string {
  const colon = cid.indexOf(":");
  const prefix = colon > 0 ? cid.slice(0, colon) : "x";
  const rest = colon > 0 ? cid.slice(colon + 1) : cid;
  return `${prefix.toLowerCase()}-${rest.slice(-12)}`;
}

/** 毫秒转 `mm:ss`，句序号旁边的行内时间码。 */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minute = Math.floor(total / 60);
  const second = total % 60;
  return `${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

/**
 * 目录 / 文件名里能安全使用的短名。
 *
 * ⚠️ **旧布局用**（迁移时按它拼回 `works/<slug>/`）。会小写化、把空白换成 `-`，
 * 所以在"用户填的名字要和文件名一致"的地方**不要**用它 —— 那是 `safeName` 的活。
 */
export function slugify(title: string): string {
  const cleaned = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\\/:*?"<>|#^[\]]+/gu, "")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  return cleaned.slice(0, 60) || "work";
}

/**
 * 用户可见的文件名：**保留输入原貌**。
 *
 * 只做四件事：清掉文件系统不认的字符、把连续空白压成一个空格、去掉首尾空白、
 * 超长截断。刻意不小写化、不把空格换成 `-` —— 「视频名和笔记名同名」是给用户的
 * 承诺，用户在资源管理器里看到的应当就是他填进去的那串字。
 */
export function safeName(title: string, maxLen = 60): string {
  const cleaned = (title ?? "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|#^[\]]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    // 结尾的点和空格在部分平台会被系统悄悄吞掉，留着会变成"文件名对不上"
    .replace(/[. ]+$/gu, "");
  return cleaned.slice(0, maxLen).trim() || "未命名";
}

/**
 * 序号补零两位：`1 → 01`、`12 → 12`。
 *
 * 空值返回空串（调用方据此判断"这一项没填"）；小数只补整数部分：`1.5 → 01.5`
 * —— 特别篇的集号要保住小数，否则它就和平行于正片的另一集撞车了。
 */
export function pad2(value: string | number | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const dot = raw.indexOf(".");
  if (dot < 0) return raw.padStart(2, "0");
  return `${raw.slice(0, dot).padStart(2, "0")}${raw.slice(dot)}`;
}

/** 集号标签：`E01`。集号为空（非番剧的单集视频）返回空串。 */
export function episodeTag(number: string | number | null | undefined): string {
  const safe = String(number ?? "")
    .replace(/[\\/:*?"<>|#^[\]]+/gu, "")
    .trim();
  return safe ? `E${pad2(safe)}` : "";
}

/** 季号标签：`S01`。没填返回空串 —— 调用方自己决定要不要补默认季。 */
export function seasonTag(season: string | number | null | undefined): string {
  if (season == null) return "";
  const raw = String(season).trim();
  if (!raw || !Number.isFinite(Number(raw))) return "";
  return `S${pad2(raw)}`;
}

/**
 * 给人读的季集标签：`第 2 季 第 3 集` / `第 3 集` / `第 2 季` / `""`（都没填）。
 *
 * ⚠️ 只写用户**真的填过**的东西。文件名为了同一部作品排得整齐，会把没填的季补成
 * `S01`；界面上不要跟着补 —— 用户从没说过那是第一季，界面上凭空多出来一句
 * "第 1 季"会让人怀疑自己是不是填错过什么。
 */
export function episodeLabel(
  season: string | number | null | undefined,
  number: string | number | null | undefined,
): string {
  const bits: string[] = [];
  if (seasonTag(season)) bits.push(`第 ${String(season).trim()} 季`);
  if (episodeTag(number)) bits.push(`第 ${String(number).trim()} 集`);
  return bits.join(" ");
}

/**
 * 一集的**稳定短名**：`作品名-S01-E01`。
 *
 * 两种用法：给文件命名（旧笔记布局），以及**重名校验** —— 两集算出同一个短名
 * 就是"名字 + 季 + 集号"完全撞车，列表里会出现两条长得一模一样的集，
 * 导入与编辑都会拦下来（见 services/importer.ts、services/episodeEdit.ts）。
 *
 * 三种形态：
 *   `孤独摇滚-S01-E01`（有集号 —— 季没填也补 01，因为"第 N 集"本身就隐含第一季）
 *   `孤独摇滚-S02`（只有季、没有集号）
 *   `孤独摇滚`（季集都没填：非番剧的单集视频）
 *
 * ⚠️ 名字保留用户输入的原貌（大小写、空格都不动）—— 这是给用户的承诺，
 * 跟旧布局的 `slugify`（会小写化）相反，别拿 slugify 来这儿复用。
 */
export function episodeStem(
  workTitle: string,
  season: number | null | undefined,
  number: string,
): string {
  const name = safeName(workTitle);
  const episode = episodeTag(number);
  // 有集号 = 这是个"第 N 集"，季号没填就按第一季算，免得同一部作品里
  // 旧集（补了 S01）和新集（不带 S）两种风格并存。没集号时季号照用户填的原样。
  const seasonPart = episode ? seasonTag(season) || "S01" : seasonTag(season);
  return [name, seasonPart, episode].filter(Boolean).join("-");
}

/**
 * 旧布局的集文件名（`E1.md`，不补零）。
 *
 * ⚠️ **只给迁移用**。
 */
export function episodeFileName(number: string): string {
  const safe = number.replace(/[\\/:*?"<>|#^[\]]+/gu, "").trim() || "1";
  return `E${safe}`;
}
