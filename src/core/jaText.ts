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

/** 比对角度的标点（含全角与半角）。长音符「ー」不在列 —— 它是假名的一部分。 */
const PUNCT =
  /[。、，．.,！!？?：:；;「」『』（）()[\]【】〔〕・…‥～〜~"'“”‘’－—―‐\-　\s]/gu;

/** 片假名 → 平假名（Unicode 码位平移 0x60）。kuromoji 的读音是片假名，用它折平。 */
export function katakanaToHiragana(text: string): string {
  return text.replace(/[\u30a1-\u30f6]/gu, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0x60),
  );
}

/**
 * 归一化到可比形态：NFKC → 去空白与标点 → 片假名折平假名。
 *
 * 只做这三件事，故意**不**碰汉字↔假名（「分かる」vs「わかる」仍不同）：
 * 那是语义改写，归一化掉会让两句不同的话共用一个身份。它留给相似度/位置锚定层。
 */
export function normalizeJa(text: string): string {
  if (!text) return "";
  return katakanaToHiragana(text.normalize("NFKC").replace(PUNCT, "").trim());
}
