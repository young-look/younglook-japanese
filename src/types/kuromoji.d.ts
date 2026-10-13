/**
 * kuromoji 只有 JS 没有类型。
 *
 * 我们只用到 `builder({dicPath}).build(cb)` 和 `tokenize(text)`，
 * 自己声明这两个就够了 —— 装 @types/kuromoji 会把整个包的类型拖进来，
 * 而它和我们实际调用的 API 版本并不一致。
 *
 * 原始 token 的字段名以 kuromoji 实际输出为准（IPADIC 的口径）。
 */
declare module "kuromoji" {
  interface KuromojiToken {
    surface_form: string;
    basic_form: string;
    reading: string;
    pronunciation: string;
    pos: string;
    pos_detail_1: string;
    pos_detail_2: string;
    pos_detail_3: string;
    conjugated_type: string;
    conjugated_form: string;
    word_position: number;
  }

  interface KuromojiTokenizer {
    tokenize(text: string): KuromojiToken[];
  }

  interface KuromojiBuilder {
    build(callback: (error: Error | null, tokenizer: KuromojiTokenizer) => void): void;
  }

  export function builder(options: { dicPath: string }): KuromojiBuilder;

  const kuromoji: { builder: typeof builder };
  export default kuromoji;
}
