/**
 * 「下载示例素材」弹窗 —— 用户在首页那条「示例」上点「开始学」时弹出。
 *
 * ══ 为什么要弹它 ══════════════════════════════════════════════════
 * 演示素材（视频 + 字幕）不随发布包分发（内联会把 main.js 撑到近 6MB），
 * 得用户在需要它的那一刻下一趟。首页那条「示例」就是给他一个"先试试"的入口：
 * 点「开始学」→ 先问一句要不要下载 → 下完自动导成一集并进入学习。
 *
 * ⚠️ 关掉它**不阻塞任何东西**：用户自己的素材、导入流程照旧。取消钮是
 *    「以后再说」（不是「取消下载」），不做「锁定」档。
 * ⚠️ 下载中可以关窗（不做锁定）：`installDemoPack` 的暂存目录是断点续传的，
 *    中途关掉、下次再点会跳过已下好的文件。
 */

import { Notice, type App } from "obsidian";
import { DialogModal } from "../ui/dialog";
import { installDemoPack, demoManifestBytes, type DemoManifest, type DemoPackProgress } from "../services/demoPack";
import type { VaultDb } from "../storage/db";

export interface DemoDownloadModalOptions {
  manifest: DemoManifest;
  db: VaultDb;
  /** 素材库目录：演示素材经导入流程收进本机空间的素材库（与用户导入同一个落点） */
  mediaDir: string;
  /** 下载并导入成功：上层刷新列表 + 进这一集（参数是新建那一集的 cid） */
  onImported(episodeCid: string): void;
}

/** 体积文案，与词典弹窗、导入弹窗、存储页同一套口径（只求一眼看出"这是多大的东西"）。 */
function humanSize(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${Math.round(bytes / (1 << 20))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export class DemoDownloadModal extends DialogModal {
  /** 下载导入中：底栏两颗钮都停用，别让用户点了"以后再说"却已经在下 */
  private busy = false;

  constructor(
    app: App,
    private readonly opts: DemoDownloadModalOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { body, foot } = this.buildShell({
      icon: "download",
      title: "下载示例素材",
      subtitle: "示例 · 一小段动画 + 中日对照字幕",
    });

    body.createEl("p", {
      text: "需要先下载示例素材",
      cls: "yl-lead",
    });

    const list = body.createEl("ul", { cls: "yl-dict-points" });
    const total = demoManifestBytes(this.opts.manifest);
    const points = [
      total > 0 ? `约 ${humanSize(total)}，只下载这一次` : "只下载这一次",
      "下载后收进本机素材库，离线也能学",
      "不会上传你的任何内容，只下载这一份样片",
    ];
    for (const point of points) list.createEl("li", { text: point });

    this.renderFoot(foot);
  }

  /** 底栏按状态重画：空闲 → 下载中 → 失败可重试。 */
  private renderFoot(foot: HTMLElement, note = ""): void {
    const total = demoManifestBytes(this.opts.manifest);
    const size = total > 0 ? ` · ${humanSize(total)}` : "";
    this.fillFoot(
      foot,
      {
        text: this.busy ? "下载中…" : note ? "重试" : `下载示例素材${size}`,
        role: "primary",
        disabled: this.busy,
        onClick: () => void this.start(foot),
      },
      {
        // 下载中不给"以后再说"—— 已经在下的事，关掉窗它也还在跑，不如让按钮停用
        cancel: this.busy ? null : { text: "以后再说" },
        note,
      },
    );
  }

  private async start(foot: HTMLElement): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.renderFoot(foot, "正在下载…");
    const result = await installDemoPack({
      db: this.opts.db,
      mediaDir: this.opts.mediaDir,
      manifest: this.opts.manifest,
      onProgress: (progress: DemoPackProgress) => this.reportProgress(foot, progress),
    });
    this.busy = false;
    if (!result.ok) {
      this.renderFoot(foot, `下载失败（${result.reason}），检查网络后再试一次。`);
      return;
    }
    // 关窗交给基类；这里只要把结果说清楚 + 通知上层进这一集
    new Notice("示例素材已就绪，开始学习吧。", 6000);
    this.close();
    this.opts.onImported(result.recordCid);
  }

  private reportProgress(foot: HTMLElement, progress: DemoPackProgress): void {
    const sizeText =
      progress.bytesTotal > 0
        ? `${humanSize(progress.bytes)} / ${humanSize(progress.bytesTotal)}`
        : humanSize(progress.bytes);
    this.renderFoot(foot, `正在下载 ${progress.done}/${progress.total}（${sizeText}）`);
  }
}
