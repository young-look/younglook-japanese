/**
 * 日语文本归一化 —— **身份 hash 与比对层共用的唯一实现**。
 *
 * 为什么下沉到 `core/`：`core/ids.ts::sliceCid`（身份）与 `services/jaMatch.ts`
 * （相似度比对）必须用**同一套归一化口径**。曾经两边口径不一致 —— 身份只去空白、
 * 比对去标点折假名 —— 结果是「标点不同 / 全角半角 / 片假名↔平假名写法」这几类
 * **本该由身份直接吃掉**的差异全漏了，换一版字幕就整片变成孤儿。
 *
 * 依赖方向是 `services → core`，所以共享实现必须落在 core，由 services 反向引用，
 * 不能倒过来。服务端的对应实现是 `core/learning/services/ja_text.py`，两边逐字符一致。
 */

/** 比对角度的标点与空白（全角半角都列）。长音符「ー」不在列 —— 它是假名的一部分。
 *
 * ⚠️ **空白必须逐码位显式列出，不许写 `\s`**（2026-10-14）：
 * `\s` 的定义由引擎决定，两端并不一样。实测（全码位扫描）：
 *   · Python 的 `\s` 多认 U+001C–U+001F、U+0085（共 5 个）
 *   · JS 的 `\s` 多认 U+FEFF
 * 同一句在两端的归一化结果会不同。下面这份列表 = **JS `\s` 的确切集合**（25 个码位，
 * 10 段区间），照抄自实测，两端逐字符一致。选它是因为身份只在客户端算，
 * 取客户端现有口径 = 客户端行为零变化。 */

// @fence-start: plugin.ja-text
const PUNCT =
  /[。、，．.,！!？?：:；;「」『』（）()[\]【】〔〕・…‥～〜~"'“”‘’－—―‐\-\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028-\u2029\u202f\u205f\u3000\ufeff]/gu;

/** 片假名 → 平假名（Unicode 码位平移 0x60）。kuromoji 的读音是片假名，用它折平。 */
export function katakanaToHiragana(text: string): string {
  return text.replace(/[\u30a1-\u30f6]/gu, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0x60),
  );
}

/**
 * 引擎 Unicode 数据表版本差的**显式抹平**（2026-10-14）。
 *
 * NFKC 的结果依赖运行时的 Unicode 数据表版本 —— 这不受我们控制：插件运行时
 * （Electron / ICU 78 = Unicode 17.0）比服务端 Python（unicodedata 15.0）
 * 多折叠 37 个码位，全是 Unicode 16 才新增的字符：
 *   · U+A7F1（MODIFIER LETTER CAPITAL S）→ S
 *   · U+1CCD6–U+1CCEF（描边体 A–Z）→ A–Z
 *   · U+1CCF0–U+1CCF9（描边体 0–9）→ 0–9
 * 不抹平的话，同一句在两端的归一化结果不同（身份键只在客户端算，服务端差的是
 * 解析缓存 key = 永远命中不了，静默重复花钱）。
 *
 * 做法是**在 NFKC 之前**把这三段先折算成 ASCII：新引擎之后折叠它们本来就得到
 * 同样的结果（所以客户端行为零变化），老引擎则被这张表补上 —— 两端逐字符一致。
 *
 * 这张表不是"猜"的：`./yolo fence --deep` 会全码位扫两端，出现任何未登记的新差异
 * 都会点名报出来。将来引擎/Unicode 再升级就该靠它发现，然后往这里补 ——
 * 别把那条检查删掉当"误报"。
 */
const PINNED_COMPAT = /\u{A7F1}|[\u{1CCD6}-\u{1CCEF}]|[\u{1CCF0}-\u{1CCF9}]/gu;

function foldPinnedCompat(text: string): string {
  return text.replace(PINNED_COMPAT, (ch) => {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0xa7f1) return "S";
    // 描边字母 A–Z 映射到 U+0041 起，描边数字 0–9 映射到 U+0030 起
    return String.fromCodePoint(cp <= 0x1ccef ? cp - 0x1cc95 : cp - 0x1ccc0);
  });
}

/**
 * 归一化到可比形态：折版本差 → NFKC → 去空白与标点 → 片假名折平假名。
 *
 * 只做这几件事，故意**不**碰汉字↔假名（「分かる」vs「わかる」仍不同）：
 * 那是语义改写，归一化掉会让两句不同的话共用一个身份。它留给相似度/位置锚定层。
 *
 * ⚠️ **没有 `trim()`**（2026-10-14 去掉）：`trim()` 的空白定义也由引擎决定，
 * 会绕过上面那份显式列表（Python 的 `strip()` 连 U+001C–U+001F 都会吃掉）。
 * 显式列表已经覆盖全部要删的空白，再 trim 一次只剩副作用。
 */
export function normalizeJa(text: string): string {
  if (!text) return "";
  return katakanaToHiragana(
    foldPinnedCompat(text).normalize("NFKC").replace(PUNCT, ""),
  );
}
// @fence-end: plugin.ja-text
