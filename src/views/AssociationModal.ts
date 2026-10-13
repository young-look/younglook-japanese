/**
 * 换机后「接回云端学习记录」的确认框。
 *
 * 为什么一定要问一次：位置锚定是启发式，错绑会把别句的进度挂到当前句上 —— 而且
 * 因为旧行打过墓碑、新行直接显示「已完成」，用户自己看不出来。所以**不静默合并**：
 * 只有规划过闸（锚点足够多 / 命中率够高 / 偏移够集中）才弹这个窗，把可核对的数字
 * 摆出来让用户自己判断；默认动作是「先不接」，记录会留在历史里。
 *
 * 壳由 DialogModal 统一给（样板见 `NoteDeleteModal`）。
 */

import { type App } from "obsidian";
import { DialogModal } from "../ui/dialog";
import type { CrossDevicePlan } from "../services/crossDeviceRebind";

export class AssociationModal extends DialogModal {
  private busy = false;
  private confirmButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly options: {
      plan: CrossDevicePlan;
      /** 出处（作品名），给用户核对"这是不是同一集" */
      workTitle: string;
      /** 集号标签（「第 3 集」/「这一集」） */
      episodeLabel: string;
      /** 执行接回。resolve true = 成功（关窗）、false = 失败（留着窗重试） */
      onConfirm: () => Promise<boolean>;
      /** 不论用户接不接，窗关掉之后都会叫一次（调用方用它继续跳页） */
      onSettled?: () => void;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    const { plan, workTitle, episodeLabel } = this.options;
    const stats = plan.stats;
    const { body, foot } = this.buildShell({
      icon: "link",
      title: "接回云端的学习记录",
      subtitle: "只改这些记录挂在哪句上，不改句子本身。",
      width: "wide",
    });

    body.createEl("p", {
      text: `云端记着《${workTitle}》${episodeLabel} 的 ${stats.cloudRows} 条学习记录，和这次导入的字幕对了一下：`,
      cls: "yl-lead",
    });

    const list = body.createEl("ul");
    list.createEl("li", { text: `逐字一样、已经自动接上了：${stats.matched} 条` });
    if (stats.aligned > 0) {
      list.createEl("li", { text: `句序能对上、可以接回：${stats.aligned} 条` });
    }
    if (stats.orphans > 0) {
      list.createEl("li", {
        text: `对不上、留成历史记录（看得到、点不开，不会丢）：${stats.orphans} 条`,
      });
    }

    body.createEl("p", {
      text: "判断依据：这一集里逐字相同的句子占多数，剩下的句子在句序上能连成一串。"
        + "拿不准就选「先不接」—— 记录会留在历史里，之后还能再看。",
      cls: "yl-lead",
    });

    const { primaryBtn } = this.fillFoot(
      foot,
      {
        text: "接回",
        disabled: this.busy,
        onClick: () => void this.run(),
      },
      { cancel: { text: "先不接" } },
    );
    this.confirmButton = primaryBtn;
  }

  private async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    if (this.confirmButton) this.confirmButton.disabled = true;
    const ok = await this.options.onConfirm();
    this.busy = false;
    if (ok) {
      this.close();
    } else if (this.confirmButton) {
      this.confirmButton.disabled = false;
    }
  }

  protected onBeforeClose(): void {
    this.options.onSettled?.();
  }
}
