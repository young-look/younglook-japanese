/**
 * 「安装日语词典」弹窗 —— 学习页上唯一一处引导下载词典的地方。
 *
 * ══ 为什么要弹它 ══════════════════════════════════════════════════
 * 词典（kuromoji 的 IPADIC，约 17MB）不随发布包分发，得用户自己下一趟。
 * 没装的时候功能不会坏，只是**悄悄缺一块**：句子卡上没有振假名、抄写提示
 * 点开是空的、跟读核对没有参考读音。用户不会知道"要去装个东西"，只会觉得
 * "这软件怎么不注音"。所以这件事必须在**他正需要它的那一刻**说清楚。
 *
 * ══ 只出现在两个时刻（2026-10-11 用户拍板，别再加第三个）══════════
 *  · `reason: "first-run"` —— 第一次进学习页：还没见过任何东西，先把"这里
 *    本来会有读音"这件事讲明白，否则后面全是"我以为它就没有这个功能"；
 *  · `reason: "hint"` —— 之后每次点抄写的「提示」：那是用户**主动要读音**的
 *    动作，此刻没有比"词典还没装"更该说的话。点一次说一次（他会忘）。
 * 两处的正文完全一样，只有标题下面那行小字按场景换 —— 一份文案、两处触发，
 * 别写成两个弹窗（同一件事的两个入口，长相必须一致）。
 *
 * ⚠️ 关掉它**不阻塞任何东西**：句子、翻译、视频照常，只是没有本机读音。
 *    所以取消钮是"以后再说"（不是"取消下载"），也不做「锁定」档。
 */

import { Notice, type App } from "obsidian";
import { DialogModal } from "../ui/dialog";
import {
  installDict,
  manifestBytes,
  type DictManifest,
  type DictProgress,
} from "../services/dictInstall";

export interface DictInstallModalOptions {
  manifest: DictManifest;
  /** 插件目录（词典落在 `<插件目录>/dict`） */
  pluginDir: string;
  /** 从哪来的 —— 只改标题下那行小字 */
  reason: "first-run" | "hint";
  /** 装好了：上层清掉词典路径缓存、把当前这句的注音/罗马音补上 */
  onInstalled(): void;
}

/** 体积文案，与导入弹窗、存储页同一套口径（只求一眼看出"这是多大的东西"）。 */
function humanSize(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${Math.round(bytes / (1 << 20))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const SUBTITLE: Record<DictInstallModalOptions["reason"], string> = {
  "first-run": "装好之后才能自动给单词注音",
  hint: "抄写提示要用它才出得来",
};

export class DictInstallModal extends DialogModal {
  /** 下载中：底栏两颗钮都停用，别让用户点了"以后再说"却已经在下 */
  private busy = false;

  constructor(
    app: App,
    private readonly opts: DictInstallModalOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { body, foot } = this.buildShell({
      icon: "download",
      title: "安装日语词典",
      subtitle: SUBTITLE[this.opts.reason],
    });

    body.createEl("p", {
      text: "本机词典负责给日语单词标读音：句子卡上的振假名、抄写提示的罗马音、跟读的参考读音都靠它。没装的话这几个位置会一直是空的。",
      cls: "yl-lead",
    });

    const list = body.createEl("ul", { cls: "yl-dict-points" });
    const total = manifestBytes(this.opts.manifest);
    const points = [
      total > 0 ? `约 ${humanSize(total)}，只下载这一次` : "只下载这一次",
      "装好之后离线也能用，不用再联网",
      "词典只装在这台电脑上，你的学习内容不会被上传",
    ];
    for (const point of points) list.createEl("li", { text: point });

    this.renderFoot(foot);
  }

  /** 底栏按状态重画：空闲 → 下载中 → 失败可重试。 */
  private renderFoot(foot: HTMLElement, note = ""): void {
    const total = manifestBytes(this.opts.manifest);
    const size = total > 0 ? ` · ${humanSize(total)}` : "";
    this.fillFoot(
      foot,
      {
        text: this.busy ? "下载中…" : note ? "重试" : `下载词典${size}`,
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
    try {
      await installDict(this.opts.pluginDir, this.opts.manifest, {
        onProgress: (progress: DictProgress) => this.reportProgress(foot, progress),
      });
      this.busy = false;
      // 关窗交给基类：这里只要把结果说清楚 + 通知上层就地生效
      new Notice("日语词典已装好，注音和抄写提示现在可以用了。", 8000);
      this.close();
      this.opts.onInstalled();
    } catch (error) {
      this.busy = false;
      const reason = error instanceof Error ? error.message : "";
      this.renderFoot(foot, `下载失败${reason ? `（${reason}）` : ""}，检查网络后再试一次。`);
    }
  }

  private reportProgress(foot: HTMLElement, progress: DictProgress): void {
    const sizeText =
      progress.bytesTotal > 0
        ? `${humanSize(progress.bytes)} / ${humanSize(progress.bytesTotal)}`
        : humanSize(progress.bytes);
    this.renderFoot(foot, `正在下载 ${progress.done}/${progress.total}（${sizeText}）`);
  }
}
