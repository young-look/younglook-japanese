/**
 * 删除笔记的确认框（2026-10-09 用户拍板：删除不可恢复，必须弹窗二次确认）。
 *
 * 从笔记抽屉的「删除」钮进（锁态/编辑态都走这里）。壳由 DialogModal 统一给
 * （同 RemoveModal 的样板）；确认后回调用方（抽屉的 removeMine），**返回是否
 * 成功** —— 失败时抽屉已经 Notice 过了，这里只负责不关窗、让用户能重试。
 */

import { type App } from "obsidian";
import { DialogModal } from "../ui/dialog";

export class NoteDeleteModal extends DialogModal {
  private busy = false;
  private confirmButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly options: {
      /** 登录态删的是云端 + 本机缓存；未登录删的是本机 —— 文案要分开说 */
      loggedIn: boolean;
      /** 执行删除。resolve true = 成功（关窗）；false = 失败（留着窗重试） */
      onDelete: () => Promise<boolean>;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    const { body, foot } = this.buildShell({
      icon: "trash-2",
      title: "删除这条笔记",
    });

    body.createEl("p", {
      text: this.options.loggedIn
        ? "删除后无法恢复，云端和本机保存的这份都会被删掉。"
        : "删除后无法恢复，本机保存的这份会消失。",
      cls: "yl-lead",
    });

    const { primaryBtn } = this.fillFoot(
      foot,
      {
        role: "danger",
        text: "删除",
        disabled: this.busy,
        onClick: () => void this.run(),
      },
      { cancel: { text: "取消" } },
    );
    this.confirmButton = primaryBtn;
  }

  private async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    if (this.confirmButton) this.confirmButton.disabled = true;
    const ok = await this.options.onDelete();
    this.busy = false;
    if (ok) {
      this.close();
    } else if (this.confirmButton) {
      this.confirmButton.disabled = false;
    }
  }
}
