/**
 * 「笔记」抽屉（2026-10-09 改版）：像目录一样从右侧整幅展开，大小同目录弹窗。
 *
 * 上半区 = 自己的纯文本笔记（登录存服务端、未登录落本地，见 notes/mine.ts）；
 * 下半区 = 其他登录用户的共享笔记（服务端口径：点赞前 3 置顶、其余随机、
 * 最多 10 条）。未登录看不到下半区 —— 纯单机，自己的笔记也不会被别人看到。
 *
 * 结构沿用目录抽屉（openToc）的「每次打开现建、关闭即拆」：没有长驻状态
 * 要维护，也永远不会把上一句的残留带给下一句。
 */

import { Notice, type App } from "obsidian";
import type { VaultDb } from "../storage/db";
import type { PluginSettings } from "../settings/types";
import { AiUnavailableError } from "../services/ai/client";
import * as api from "../services/notes/api";
import { isLoggedIn, saveMyNote, deleteMyNote, peekMyNotes, loadMyNotes } from "../services/notes/mine";
import { createButton } from "../ui/button";
import { NoteDeleteModal } from "./NoteDeleteModal";
import { log } from "../core/logger";

export interface NotesDrawerDeps {
  /** 浮层挂哪（学习页 contentEl，与目录抽屉同参照物） */
  parent: HTMLElement;
  /** 宿主 App：删除要走确认弹窗（Modal 需要 App 才能开） */
  app: App;
  settings: PluginSettings;
  db: VaultDb;
  /** 当前句的切片 cid（`S:<hash>`） */
  sliceCid: string;
  /** 原句中文（`effectiveZh`，用户改过的版本）—— 锚点条第二行 */
  zh: string;
  /**
   * 取 hero 已渲染好的原句 DOM（`heroJaEl`，含 ruby 注音）。
   * 锚点条克隆它做只读展示：注音的三层优先级（手改 > AI > 词典）只有
   * hero 一处实现，抽屉不另养一份口径。注音是异步的 —— 打开时还没算完
   * 就先显示纯文本，算完由 StudyView 调 `refreshSentence()` 补上。
   */
  sentenceEl: () => HTMLElement | null;
  /** 锚点条的小喇叭：重播当前切片（与原句卡的喇叭同一套） */
  onReplay: () => void;
  /** 这句的未保存草稿：上次关抽屉留下的（同句内重开不丢；换句即作废，见 StudyView.noteDraft） */
  draft: string;
  /**
   * 抽屉关掉时回调。参数 = 没保存的草稿（与已保存内容一致时是空串）；
   * StudyView 存下它供本次会话内重开抽屉用，换句即作废。
   */
  onClose: (draft: string) => void;
  /** 自己的笔记保存 / 删除成功后回调（学习页拿来刷按钮虚线） */
  onMineChanged: (sliceCid: string, text: string) => void;
}

/** 抽屉开着时的句柄：StudyView 拿它在注音算完后续刷锚点条 */
export interface NotesDrawerHandle {
  sliceCid: string;
  /** 用 hero 当前这份句子 DOM（含 ruby 注音）重铺锚点条 */
  refreshSentence: () => void;
}

/** 我的笔记区开抽屉那一瞬间的形态 */
export interface NoteViewState {
  /** edit = 可写（有草稿或还没写过）；locked = 只读展示已保存内容（保存即锁定） */
  mode: "edit" | "locked";
  /** 初始文本（草稿盖过已保存内容） */
  text: string;
}

/**
 * 开抽屉时显示什么 —— 纯函数（tests/notesDrawer.test.ts 钉着）。
 *
 * 口径：**草稿优先**（没保存的改动是用户最新意图，盖过已保存内容，回编辑态）；
 * 没草稿但已保存过 → 锁态看内容；两头都空 → 编辑态空框。
 */
export function resolveNoteView(input: { draft: string; baseline: string }): NoteViewState {
  const draft = input.draft.replace(/\r\n/g, "\n");
  if (draft.trim() !== "") return { mode: "edit", text: draft };
  const baseline = input.baseline.replace(/\r\n/g, "\n");
  if (baseline.trim() !== "") return { mode: "locked", text: baseline };
  return { mode: "edit", text: "" };
}

/** 卡片上的时间：今天 / 昨天 / M月D日 / 往年带年份。够用就行，不做相对时间。 */
function dayLabel(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const now = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (sameDay(d, now)) return "今天";
  if (sameDay(d, yesterday)) return "昨天";
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

export function openNotesDrawer(deps: NotesDrawerDeps): NotesDrawerHandle {
  const { parent, settings, db, sliceCid } = deps;
  const hash = sliceCid.slice(2);
  const loggedIn = isLoggedIn(settings);

  // 同款抽屉已经开着（连点「笔记」按钮）就先拆旧的，保证看到的总是当前句
  parent.querySelector(".yl-nd-overlay")?.remove();

  const overlay = parent.createDiv({ cls: "yl-nd-overlay" });
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  const panel = overlay.createDiv({ cls: "yl-nd-panel" });

  const header = panel.createDiv({ cls: "yl-nd-header" });
  const titleBox = header.createDiv({ cls: "yl-nd-header-text" });
  titleBox.createSpan({ cls: "yl-nd-title", text: "笔记" });
  titleBox.createSpan({ cls: "yl-nd-sub", text: "这句台词的学习笔记" });
  createButton(header, {
    shape: "icon",
    small: true,
    icon: "x",
    ariaLabel: "关闭",
    onClick: () => close(),
  });

  // ── 锚点条：抽屉盖住了原句卡，把原句（含注音）带进抽屉顶上 ──────────
  // 姿态要"轻到像引用"：小一号、弱底色、最多两行截断（点一下展开），
  // 小喇叭让它同时是"写笔记时再听一遍"的功能入口，不是把句子卡复刻一遍。
  const anchor = panel.createDiv({ cls: "yl-nd-anchor" });
  const anchorMain = anchor.createDiv({ cls: "yl-nd-anchor-main" });
  const anchorJa = anchorMain.createDiv({ cls: "yl-nd-anchor-ja" });
  anchorJa.setAttr("lang", "ja");
  if (deps.zh) anchorMain.createDiv({ cls: "yl-nd-anchor-zh", text: deps.zh });
  createButton(anchor, {
    shape: "icon",
    small: true,
    icon: "volume-2",
    ariaLabel: "再听一遍",
    title: "再听一遍",
    onClick: () => deps.onReplay(),
  });
  let anchorOverflow = false;
  let anchorExpanded = false;
  anchorJa.addEventListener("click", () => {
    if (!anchorOverflow) return;
    anchorExpanded = !anchorExpanded;
    anchorJa.toggleClass("is-clamped", !anchorExpanded);
  });
  /** 克隆 hero 当前这份句子进锚点条，顺手量一次要不要两行截断。 */
  function refreshSentence(): void {
    const source = deps.sentenceEl();
    if (!source) return;
    anchorJa.empty();
    for (const node of Array.from(source.childNodes)) {
      anchorJa.appendChild(node.cloneNode(true));
    }
    // 先放开量真实高度，再按"超两行且没展开"决定收不收 —— 收着量 scrollHeight 不可靠
    anchorJa.removeClass("is-clamped");
    anchorOverflow = anchorJa.scrollHeight > anchorJa.clientHeight + 1;
    anchorExpanded = false;
    anchorJa.toggleClass("is-clamped", anchorOverflow);
    anchorJa.toggleClass("is-expandable", anchorOverflow);
  }
  refreshSentence();

  const body = panel.createDiv({ cls: "yl-nd-body" });

  // ── 上半区：我的笔记（两态：编辑 / 锁定）─────────────────────────────
  // 保存即锁定（2026-10-09 用户拍板）：保存成功就变成只读的文本卡 +
  // 「编辑」「删除」，别让用户总停在编辑状态；「编辑」点完回编辑态、按钮
  // 变回「保存」。两个态共用同一组 DOM，靠 hide/show 切换，不重建抽屉。
  //
  // 编辑态两颗钮的分工（2026-10-09 晚 用户拍板）：
  //   「保存」= 存下并退出编辑 —— **不要求有改动**（没改也要能一键回到锁态，
  //            原先"没改动就禁用保存"会把用户困在编辑态）；
  //   「取消」= 放弃这次所有编辑、回到存稿（没存稿就清空留在编辑态）。
  const mineSection = body.createDiv({ cls: "yl-nd-section" });
  mineSection.createDiv({ cls: "yl-nd-label", text: "我的笔记" });

  const area = mineSection.createEl("textarea", {
    cls: "yl-nd-input",
    attr: {
      placeholder: "记下这句的理解、出处或梗。登录后保存在云端，只有你能看到。",
      "aria-label": "我的笔记内容",
      spellcheck: "false",
    },
  });
  const lockedCard = mineSection.createDiv({ cls: "yl-nd-locked" });

  const actions = mineSection.createDiv({ cls: "yl-nd-actions" });
  const saveButton = createButton(actions, { text: "保存", onClick: () => void persist(area.value) });
  const cancelButton = createButton(actions, {
    text: "取消",
    onClick: () => cancelEdit(),
    hidden: true,
  });
  const editButton = createButton(actions, {
    text: "编辑",
    onClick: () => enterEdit(true),
    hidden: true,
  });
  const deleteButton = createButton(actions, {
    text: "删除",
    onClick: () => {
      // 删除不可恢复：弹窗二次确认（登录删云端+本机、未登录删本机）
      new NoteDeleteModal(deps.app, {
        loggedIn,
        onDelete: () => removeMine(),
      }).open();
    },
    hidden: true,
  });
  const status = actions.createSpan({ cls: "yl-nd-status" });

  // 回填基线：按钮「有没有改动 / 有没有内容」都拿它当参照。
  // 登录 → 先用统一缓存；缓存还没拉过（开插件第一句就开抽屉）→ 异步拉一趟再回填。
  let baseline = peekMyNotes()?.get(hash) ?? "";
  const initial = resolveNoteView({ draft: deps.draft, baseline });
  let mode: NoteViewState["mode"] = initial.mode;
  area.value = initial.text;
  if (mode === "locked") baseline = initial.text;

  /** 编辑态两颗钮的可用态（锁态不归它管）。 */
  function refreshButtons(): void {
    if (mode !== "edit") return;
    const text = area.value.replace(/\r\n/g, "\n").trim();
    // 「保存」只按"有没有内容"禁用，**不再看"有没有改动"** —— 没改动也要能一键
    // 回锁态（原先按 `text === baseline` 禁用，会把只想退出的用户困在编辑态）。
    // 框空着就禁用：清空后按保存等于删笔记，删除有独立的二次确认入口，不走这里。
    saveButton.disabled = text === "";
    deleteButton.hidden = baseline.trim() === "" && text === "";
  }

  /** 按当前 mode 摆好各元素的可见性。 */
  function paintMode(): void {
    if (mode === "locked") {
      lockedCard.setText(area.value);
      area.hide();
      lockedCard.show();
      saveButton.hide();
      cancelButton.hide();
      editButton.show();
      deleteButton.hidden = false; // 锁态必有内容，删除常在（走确认弹窗）
      deleteButton.disabled = false;
    } else {
      lockedCard.hide();
      area.show();
      saveButton.show();
      cancelButton.show();
      editButton.hide();
      refreshButtons();
    }
  }

  /** 进锁态：内容定稿为 text（保存成功 / 打开时就有已保存内容）。 */
  function enterLocked(text: string): void {
    mode = "locked";
    baseline = text;
    area.value = text;
    paintMode();
  }

  /** 回编辑态（点「编辑」/ 删除成功后的空框）。 */
  function enterEdit(focus: boolean): void {
    mode = "edit";
    status.setText("");
    paintMode();
    if (focus) area.focus();
  }

  /**
   * 「取消」：放弃这次所有编辑，回到存稿。
   * 有存稿 → 回锁态看存稿；没存稿（新写、还没存过）→ 清空后留在编辑态空框。
   * 关抽屉时草稿的取舍由 close() 统一按「是否与基线一致」判断，这里不用管。
   */
  function cancelEdit(): void {
    status.setText("");
    const base = baseline;
    area.value = base;
    if (base.trim() !== "") {
      enterLocked(base);
    } else {
      mode = "edit";
      paintMode();
      area.focus();
    }
  }

  area.addEventListener("input", () => {
    status.setText("");
    refreshButtons();
  });
  paintMode();

  if (peekMyNotes() === null) {
    void loadMyNotes(settings, db)
      .then((map) => {
        // 用户已经先打上字了就别盖（只回填还空着的编辑框）
        if (mode !== "edit" || area.value.trim() !== "") return;
        const saved = map.get(hash) ?? "";
        if (saved.trim() === "") return;
        enterLocked(saved);
      })
      .catch((error: unknown) => log.warn("读取笔记失败", error));
  }

  async function persist(raw: string): Promise<void> {
    const text = raw.replace(/\r\n/g, "\n").trim();
    if (!text) return;
    // 和存稿一致（点保存只为退出编辑）：没必要再发一次请求，直接回锁态。
    if (text === baseline.trim()) {
      enterLocked(text);
      return;
    }
    saveButton.disabled = true;
    try {
      await saveMyNote(settings, db, sliceCid, text);
      deps.onMineChanged(sliceCid, text);
      status.setText(loggedIn ? "已保存" : "已保存在本机");
      enterLocked(text);
    } catch (error) {
      log.warn("保存笔记失败", error);
      status.setText("");
      new Notice(
        error instanceof AiUnavailableError ? error.message : "笔记没能存下来，再试一次。",
      );
      saveButton.disabled = false;
    }
  }

  /** 删除（确认弹窗的回调）。返回成功与否，弹窗据此决定关不关自己。 */
  async function removeMine(): Promise<boolean> {
    deleteButton.disabled = true;
    try {
      await deleteMyNote(settings, db, sliceCid);
      deps.onMineChanged(sliceCid, "");
      baseline = "";
      area.value = "";
      enterEdit(false);
      status.setText("已删除");
      return true;
    } catch (error) {
      log.warn("删除笔记失败", error);
      new Notice(
        error instanceof AiUnavailableError ? error.message : "没能删掉，再试一次。",
      );
      return false;
    } finally {
      deleteButton.disabled = false;
      refreshButtons();
      paintMode();
    }
  }

  // ── 下半区：大家的笔记 ─────────────────────────────────────────────
  const sharedSection = body.createDiv({ cls: "yl-nd-section" });
  sharedSection.createDiv({ cls: "yl-nd-label", text: "大家的笔记" });
  const sharedList = sharedSection.createDiv({ cls: "yl-nd-shared" });

  if (!loggedIn) {
    sharedList.createDiv({
      cls: "yl-nd-hint",
      text: "登录后可以看到大家写的笔记，你的笔记也会跟着账号在设备间同步。",
    });
  } else {
    sharedList.createDiv({ cls: "yl-nd-hint", text: "正在加载…" });
    void api
      .fetchSharedNotes(settings, hash)
      .then((result) => renderShared(result.mine?.content ?? null, result.notes))
      .catch((error: unknown) => {
        log.warn("共享笔记加载失败", error);
        sharedList.empty();
        sharedList.createDiv({
          cls: "yl-nd-hint",
          text: error instanceof AiUnavailableError
            ? error.message
            : "大家的笔记暂时加载不出来。",
        });
      });
  }

  /**
   * 画共享列表。顺手做一次「云端回填」：自己在服务端写过、但本地缓存没有的
   * （换了设备、或本机缓存还没拉到），把内容补进编辑框 —— 它本来就是"我的笔记"。
   * ⚠️ 只在编辑框**还空着**时回填，别把用户正在打的字盖掉。
   */
  function renderShared(mineContent: string | null, notes: api.SharedNote[]): void {
    if (mineContent !== null && mineContent.trim() !== "" && mode === "edit" && area.value.trim() === "") {
      enterLocked(mineContent);
    }
    sharedList.empty();
    if (notes.length === 0) {
      sharedList.createDiv({
        cls: "yl-nd-hint",
        text: "还没有人写笔记。写下第一条，帮帮后面的人。",
      });
      return;
    }
    notes.forEach((note, i) => {
      const card = sharedList.createDiv({ cls: "yl-nd-card" });
      const head = card.createDiv({ cls: "yl-nd-card-head" });
      head.createSpan({ cls: "yl-nd-nick", text: note.nickname || "同学" });
      // 前 3 名（服务端按点赞数置顶）且有人点赞才亮标记，别把 0 赞当荣誉发
      if (i < 3 && note.likeCount > 0) {
        head.createSpan({ cls: "yl-nd-top", text: `👍 ${note.likeCount}` });
      }
      const when = dayLabel(note.updatedAt);
      if (when) head.createSpan({ cls: "yl-nd-when", text: when });
      const likeButton = createButton(head, {
        cls: "yl-nd-like",
        shape: "text",
        text: note.liked ? `♥ ${note.likeCount}` : `♡ ${note.likeCount}`,
        ariaLabel: note.liked ? "取消点赞" : "点赞",
        onClick: () => {
          likeButton.disabled = true;
          void api
            .toggleNoteLike(settings, note.id)
            .then((result) => {
              note.liked = result.liked;
              note.likeCount = result.likeCount;
              likeButton.setText(note.liked ? `♥ ${note.likeCount}` : `♡ ${note.likeCount}`);
              likeButton.setAttribute("aria-label", note.liked ? "取消点赞" : "点赞");
            })
            .catch((error: unknown) => {
              log.warn("点赞失败", error);
              new Notice(
                error instanceof AiUnavailableError ? error.message : "点赞没成功，再试一次。",
              );
            })
            .finally(() => {
              likeButton.disabled = false;
            });
        },
      });
      card.createDiv({ cls: "yl-nd-card-body", text: note.content });
    });
  }

  // ── 开与关 ────────────────────────────────────────────────────────────
  // 开：先让 translateX(100%) 的初态生效（强制回流），再加 is-open 播滑入。
  // 关：加 is-closing 播滑出，transitionend + 定时兜底后再拆 DOM。
  let closing = false;
  function close(): void {
    if (closing) return;
    closing = true;
    // 没保存的改动交回 StudyView 存成草稿（同句内重开不丢；换句即作废）
    deps.onClose(area.value.trim() === baseline.trim() ? "" : area.value);
    overlay.addClass("is-closing");
    panel.addEventListener(
      "transitionend",
      (event) => {
        if (event.target === panel && event.propertyName === "transform") overlay.remove();
      },
      { once: true },
    );
    window.setTimeout(() => overlay.remove(), 200); // 兜底：transitionend 偶发不来
  }
  void panel.offsetWidth;
  overlay.addClass("is-open");
  panel.addClass("is-open");

  return { sliceCid, refreshSentence };
}
