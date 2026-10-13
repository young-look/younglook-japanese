/**
 * 极简 markdown → DOM（2026-10-08，只服务海獭小助手的回答气泡）。
 *
 * 为什么不用宿主的 MarkdownRenderer：要绑 Component、走异步渲染，
 * 还会带进一整套笔记样式和链接行为 —— 一个对话气泡用不着这么重。
 * 模型实际会返回的东西也就是 **加粗**、`行内代码`、有序/无序列表和分段，
 * 这里就只认这几样，其余字符原样输出（全部走 textContent，没有注入面）。
 */

/** 行内渲染：把 **加粗** 和 `代码` 换成对应元素，其余字符原样 */
function renderInline(el: HTMLElement, text: string): void {
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      el.createEl("strong", { text: part.slice(2, -2) });
    } else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      el.createEl("code", { text: part.slice(1, -1) });
    } else {
      el.appendText(part);
    }
  }
}

/** 一行里 `**` 出现的次数 —— 奇数 = 这行有开了没闭合的加粗 */
function boldPairCount(line: string): number {
  return (line.match(/\*\*/g) ?? []).length;
}

/** CJK 字符（汉字/假名/谚文/全角标点）—— 判断折行拼接处要不要补空格用 */
const CJK_CHAR = /[\u2e80-\u9fff\uac00-\ud7ff\uff00-\uffef]/u;

/**
 * 把「跨行的加粗」拼回一行。
 *
 * 🔥 模型偶尔把 `**…**` 写到换行两侧（长句自动折行，如
 * `- **どれだけ気持ちよくさせたか分かって\nる？**`）—— 渲染是**逐行**做的，
 * 不先拼回来这对 `**` 就永远配不上，正文里挂着字面的 `*`（2026-10-10 实机截图）。
 *
 * 规则：某行的 `**` 是奇数（开了没闭合）就从下一行起一直吞到闭合行为止；
 * 拼接处两边都是 CJK 就直接接上（日语/中文折行不能塞空格），否则补一个空格
 * （英文单词不能直接粘）。流式半截（闭合行还没来）就把累积到的整行垫回去 ——
 * 下一帧重渲染时自然闭合，与「边流边长」的表现一致。
 */
function mergeCrossLineBold(markdown: string): string {
  const out: string[] = [];
  let pending: string | null = null;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (pending !== null) {
      const joiner = CJK_CHAR.test(pending.slice(-1)) && CJK_CHAR.test(line.slice(0, 1)) ? "" : " ";
      pending += joiner + line;
      if (boldPairCount(pending) % 2 === 0) {
        out.push(pending);
        pending = null;
      }
      continue;
    }
    if (boldPairCount(line) % 2 === 1) {
      pending = line;
      continue;
    }
    out.push(line);
  }
  if (pending !== null) out.push(pending);
  return out.join("\n");
}

/**
 * 把 markdown 文本渲染进 container（会顺带给 container 挂 `.yl-assistant-md`，
 * 样式在 styles.css）。空行只当段间距（间距交给 CSS 的 margin），不生成空元素。
 */
export function renderMiniMarkdown(container: HTMLElement, markdown: string): void {
  container.addClass("yl-assistant-md");
  let list: HTMLUListElement | HTMLOListElement | null = null;

  for (const rawLine of mergeCrossLineBold(markdown).split("\n")) {
    const line = rawLine.trim();
    const ordered = /^\d+[.、]\s*(.+)$/.exec(line);
    // `*` 作列表符号**必须**后跟空白：`**加粗**…` 开头的段落行不能被当成
    // 列表项（否则第一个 `*` 被吃掉，正文里就剩一个孤 `*` —— 截图踩到的另一半）。
    // `-` / `•` 沿用旧口径（不强制空格）。
    const unordered = /^[-•]\s*(.+)$/.exec(line) ?? /^\*\s+(.+)$/.exec(line);

    if (ordered || unordered) {
      const want: "ol" | "ul" = ordered ? "ol" : "ul";
      if (!list || list.tagName.toLowerCase() !== want) {
        list = container.createEl(want);
      }
      renderInline(list.createEl("li"), (ordered ?? unordered)![1]);
      continue;
    }
    list = null;
    if (!line) continue;
    renderInline(container.createEl("p"), line);
  }
}
