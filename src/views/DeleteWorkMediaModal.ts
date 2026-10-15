/**
 * 删掉一组作品素材 —— 按「同一部作品」删（分桶口径见 dataInventory 的
 * MediaGroupRow：归一化标题 + 年份），弹窗先把后果讲清楚。
 *
 * 与「移除一条记录」（`RemoveModal`）同一套口径，三件事必须说明面上：
 *  · **学习进度一律不动**（跟读 / 抄写 / 仿写的进度、录音、笔记都留着，
 *    它们挂在句子哈希上，跟素材不是一个层）；
 *  · 只删**素材库里的副本** —— 落在用户原位置的文件一个都不碰；
 *  · 记录是软删，重新导入同一对文件就能复活。
 *
 * 🔥 顺序不可颠倒：先 `removeRecord`（撤记录），再 `removeMediaFiles`（删文件）。
 *    反过来记录还在、文件没了，列表里就多出一堆「找不到这个文件」的红行。
 *
 * 壳（宽度 / 圆角 / 标题行 / 底栏）由 `DialogModal` 统一给，同 RemoveModal 的样板。
 */

import { Notice, type App } from "obsidian";

import type YoungLookPlugin from "../main";
import { log } from "../core/logger";
import { removeMediaFiles, resolveMediaDir } from "../services/mediaStore";
import { removeRecord } from "../services/study";
import { DialogModal } from "../ui/dialog";

export interface DeleteWorkTarget {
  /** 作品名（挂在弹窗副标题上） */
  title: string;
  /** 这一组名下有多少条素材 */
  recordCount: number;
  /** 素材库里的副本路径 —— 真正会被删掉的那些 */
  inLibraryPaths: string[];
  bytes: number;
  /** 落在用户原位置、不会被删的文件数 */
  outsideCount: number;
  /** 会一并移除的素材 cid（= record 行） */
  recordCids: string[];
}

export class DeleteWorkMediaModal extends DialogModal {
  private busy = false;
  private confirmButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly plugin: YoungLookPlugin,
    private readonly target: DeleteWorkTarget,
    private readonly options: { onDone?: () => void } = {},
  ) {
    super(app);
  }

  onOpen(): void {
    const { body, foot } = this.buildShell({
      icon: "trash-2",
      title: "删除这个作品的素材",
      subtitle: this.target.title,
    });

    // 「素材」在列表语境 = 一条组合（视频 + 字幕）；这个弹窗同时要报文件数，
    // 于是两个粒度各自带量词收口：「N 条素材 · M 个素材文件」（术语表见 docs/concept/cid.md）。
    body.createEl("p", {
      text: "确认后，这个作品名下的每条素材都会从列表移除，素材库里属于它的视频和字幕会一起删掉。",
      cls: "yl-lead",
    });

    // 这次到底动多少东西，说在明面上
    const facts = body.createDiv({ cls: "yl-note" });
    facts.createDiv({
      cls: "yl-note-strong",
      text: `共 ${this.target.recordCount} 条素材 · ${this.target.inLibraryPaths.length} 个素材文件 · 约 ${humanSize(this.target.bytes)}`,
    });
    if (this.target.outsideCount > 0) {
      facts.createDiv({
        cls: "yl-note-sub",
        text: `另有 ${this.target.outsideCount} 个素材文件留在你原来的位置，不会被删。`,
      });
    }

    // 用户最怕误伤的东西，独立一块说清楚
    const guard = body.createDiv({ cls: "yl-note" });
    guard.createDiv({ text: "学习进度不会被删除。", cls: "yl-note-strong" });
    guard.createDiv({
      text: "跟读、抄写、仿写的进度，录音和笔记都留在这里；重新导入同一份视频和字幕就能恢复。",
      cls: "yl-note-sub",
    });

    const { primaryBtn } = this.fillFoot(
      foot,
      {
        role: "danger",
        text: "删除",
        disabled: this.busy || this.target.inLibraryPaths.length === 0,
        onClick: () => void this.run(),
      },
      {
        cancel: { text: "取消" },
        note: "删除的是素材库里的副本，你自己原来的文件不受影响。",
      },
    );
    this.confirmButton = primaryBtn;
  }

  private async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    if (this.confirmButton) this.confirmButton.disabled = true;

    const db = this.plugin.db;
    const mediaDir = resolveMediaDir(this.plugin.settings.mediaDir, this.plugin.settings.activeSpaceId);
    let removed = 0;
    const failed: string[] = [];
    try {
      // 顺序有讲究：先撤记录（软删、可复原），再删素材库的副本
      for (const recordCid of this.target.recordCids) {
        await removeRecord(db, recordCid);
      }
      const result = await removeMediaFiles(this.target.inLibraryPaths, mediaDir);
      removed = result.removed;
      failed.push(...result.failed);

      this.close();
      new Notice(
        failed.length > 0
          ? `删掉了 ${removed} 个文件，另有 ${failed.length} 个没能删掉（可能正被占用）。`
          : `删掉了这个作品的素材，共 ${removed} 个素材文件。`,
        6000,
      );
      this.options.onDone?.();
    } catch (error) {
      log.warn("删除作品素材失败", error);
      new Notice("删除没完成，素材都还在，稍后再试。");
      this.busy = false;
      if (this.confirmButton) this.confirmButton.disabled = false;
    }
  }
}

/** 体积：超过 1GB 给一位小数，其余取整。看得懂就行，不是账单。 */
function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${Math.round(bytes / (1 << 20))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}
