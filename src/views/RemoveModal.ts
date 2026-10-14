import { Notice, type App } from "obsidian";
import { episodeLabel } from "../markdown/templates";
import { log } from "../core/logger";
import {
  insideMediaRoot,
  removeMediaFiles,
  resolveMediaDir,
} from "../services/mediaStore";
import { removeRecord, type RecordListItem } from "../services/study";
import { assetShaCid } from "../core/ids";
import { STORE } from "../storage/db";
import type { AssetRow } from "../types/entities";
import type YoungLookPlugin from "../main";
import { DialogModal } from "../ui/dialog";

/**
 * 移除确认框（2026-10-02 用户定：取代列表行上的两段式内联确认）。
 *
 * 口径：**默认只移除本条记录** —— 那是软删，列表里消失、学习记录和文件都留着，
 * 重新导入同一集就全回来（与旧的「移除」行为完全一致）。两个**默认不勾**的复选框
 * 才是真删的选项：删素材库里的视频/字幕副本。
 * 弹窗里必须把「学习记录不会被删除」说在明面上 —— 这是用户最怕误伤的东西。
 *
 * 复选框按现状出现：素材没收进库（落在用户原位置的兜底情况）就没有「删文件」
 * 这一项 —— 用户自己的原文件永远不由我们删（素材库的硬边界，见 mediaStore.ts）。
 *
 * 执行顺序：先 `removeRecord`（主操作），再尽力清理勾选的文件 ——
 * 清理失败只提示一句，不把「移除」整个算失败。
 *
 * 🔥 壳（宽度/圆角/标题行/底栏）由 `DialogModal` 统一给 —— 2026-10-02 用户拍板
 * 全站弹窗采用 v2 那一版。从前这个弹窗**一个类都没加**，整个走宿主默认
 * （560px / 24px 圆角 / 按钮右对齐），跟「配置模型」那套完全不是一回事。
 */
export class RemoveModal extends DialogModal {
  private busy = false;
  private deleteFiles = false;

  /** 打开时查一次的现状；没查完前选项区先不渲染（renderFacts 会补） */
  private facts: {
    /** 素材库里的副本（库外路径一律不在内 —— 那是用户自己的文件） */
    mediaPaths: string[];
    mediaSize: number;
  } | null = null;

  private optionsEl: HTMLElement | null = null;
  private footEl: HTMLElement | null = null;
  private confirmButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly plugin: YoungLookPlugin,
    private readonly entry: RecordListItem,
    private readonly options: { onRemoved?: () => void | Promise<void> } = {},
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
    void this.loadFacts();
  }

  // ── 现状盘点 ─────────────────────────────────────────────────────────────

  private async loadFacts(): Promise<void> {
    const record = this.entry.record;
    const mediaDir = resolveMediaDir(this.plugin.settings.mediaDir, this.plugin.settings.activeSpaceId);
    // 这条记录引用到的素材（视频 + 日文字幕 + 可选中文字幕），按 sha256 寻址
    const assetCids = [record.videoSha256, record.jaSubSha256, record.zhSubSha256 ?? ""]
      .filter(Boolean)
      .map((sha) => assetShaCid(sha));
    const assets = (
      await Promise.all(assetCids.map((cid) => this.plugin.db.get<AssetRow>(STORE.assets, cid)))
    ).filter((row): row is AssetRow => Boolean(row && !row.deletedAt && row.localPath));
    // 只有收进了素材库的副本可删；落在用户原位置的（兜底路径）一律不算进来
    const inLibrary = assets.filter((row) => insideMediaRoot(row.localPath, mediaDir));
    const mediaPaths = inLibrary.map((row) => row.localPath);
    const mediaSize = inLibrary.reduce((sum, row) => sum + row.sizeBytes, 0);

    this.facts = { mediaPaths, mediaSize };
    this.renderFacts();
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────

  /** 跟列表行同一套拼法：视频名 · 第 N 季第 N 集 集标题 */
  private targetText(): string {
    const record = this.entry.record;
    const label = episodeLabel(record.season, record.number);
    const head = [record.title || record.titleJa, label].filter(Boolean).join(" · ");
    return `${head}${record.episodeTitle ? ` ${record.episodeTitle}` : ""}`;
  }

  private workTitle(): string {
    return this.entry.record.title || this.entry.record.titleJa || "未命名";
  }

  private render(): void {
    const { body, foot } = this.buildShell({
      icon: "trash-2",
      title: "移除这一集",
      subtitle: this.targetText(),
    });

    body.createEl("p", {
      text: "移除后这一集会从列表消失；学习记录保留，重新导入同一集即可恢复。",
      cls: "yl-lead",
    });

    this.optionsEl = body.createEl("div", { cls: "yl-opts" });
    this.renderFacts();

    // 用户最怕误伤的东西，独立一块说在明面上
    const guard = body.createDiv({ cls: "yl-note" });
    guard.createDiv({ text: "学习记录不会被删除。", cls: "yl-note-strong" });
    guard.createDiv({
      text: "跟读、抄写、仿写的进度和录音都留在这里。",
      cls: "yl-note-sub",
    });

    this.footEl = foot;
    this.renderFoot();
  }

  /** 复选框区：现状查完才渲染（之前留着空位，别让「移除」键跳来跳去）。 */
  private renderFacts(): void {
    const parent = this.optionsEl;
    if (!parent || !this.facts) return;
    parent.empty();

    if (this.facts.mediaPaths.length > 0) {
      this.buildOption(parent, {
        name: "一并删除视频和字幕文件",
        desc: `${this.facts.mediaPaths.length} 个文件 · 约 ${humanSize(this.facts.mediaSize)}，从素材库删除；你自己原来的文件不受影响`,
        checked: this.deleteFiles,
        onChange: (value) => (this.deleteFiles = value),
      });
    }

  }

  private buildOption(
    parent: HTMLElement,
    input: {
      name: string;
      desc: string;
      checked: boolean;
      onChange: (value: boolean) => void;
    },
  ): void {
    const row = parent.createEl("label", { cls: "yl-opt" });
    const box = row.createEl("input", { type: "checkbox" });
    box.checked = input.checked;
    box.addEventListener("change", () => input.onChange(box.checked));
    const text = row.createDiv({ cls: "yl-opt-text" });
    text.createDiv({ text: input.name, cls: "yl-opt-name" });
    text.createDiv({ text: input.desc, cls: "yl-opt-desc" });
  }

  private renderFoot(): void {
    const el = this.footEl;
    if (!el) return;
    const { primaryBtn } = this.fillFoot(
      el,
      {
        role: "danger",
        text: "移除",
        disabled: this.busy,
        onClick: () => void this.run(),
      },
      {
        cancel: { text: "取消", onClick: () => this.close() },
        note: this.deleteFiles ? "勾选项也会一起执行。" : "",
      },
    );
    this.confirmButton = primaryBtn;
  }

  // ── 执行 ────────────────────────────────────────────────────────────────

  private async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    if (this.confirmButton) this.confirmButton.disabled = true;

    const record = this.entry.record;
    try {
      // 主操作先行：它是软删、几乎不会失败。后面的清理尽力而为，
      // 失败只提示 —— 记录已经移除，不该让用户误以为整个动作没生效。
      await removeRecord(this.plugin.db, record.cid);

      if (this.deleteFiles && this.facts && this.facts.mediaPaths.length > 0) {
        const result = await removeMediaFiles(
          this.facts.mediaPaths,
          resolveMediaDir(this.plugin.settings.mediaDir, this.plugin.settings.activeSpaceId),
        );
        if (result.failed.length > 0) {
          log.warn("移除时有素材文件没能删掉", result.failed);
          new Notice(
            `移除完成，但有 ${result.failed.length} 个素材文件没能删掉（可能正被占用）。`,
            8000,
          );
        }
      }

      this.close();
      await this.options.onRemoved?.();
    } catch (error) {
      log.warn("移除这一集失败", error);
      new Notice("移除失败，稍后再试。");
      this.busy = false;
      if (this.confirmButton) this.confirmButton.disabled = false;
    }
  }
}

// ── 常量与纯函数 ────────────────────────────────────────────────────────────

/** 卡片上那句体积。只求一眼看出「这是多大的东西」。与 ImportModal 同一套口径。 */
function humanSize(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${Math.round(bytes / (1 << 20))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 取路径最后一段当文件名。 */
function basenameOf(path: string): string {
  return path.split(/[\\/]/u).pop() ?? path;
}
