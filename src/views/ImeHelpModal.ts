import type { App } from "obsidian";
import type YoungLookPlugin from "../main";
import { DialogModal } from "../ui/dialog";

/**
 * 日语输入法帮助弹窗 —— 抄写卡头部「日语输入法」可点词的出口。
 *
 * 版式与文案完全对齐 ModelSetupModal 那种一句话问询（2026-10-07 用户拍板：
 * 别铺步骤说明，直接引导下载）：`variant: "center"` + 主按钮 `role: "primary"`
 * —— 全站唯一的实心按钮皮，主操作撑满、「取消」降为灰字。
 *
 * 平台差异只收在这一层，判定用 `process.platform`（appData.ts 同款口径：
 * 不 import obsidian 的 Platform，单测环境解析不了）：
 *   · Windows：直接引导下载谷歌日语输入法 —— 跳 younglook.cc/download 网页、
 *     浏览器下载（用户拍板：不做插件内下载，自更新三件套也带不动 exe）。
 *   · macOS：自带输入法（Kotoeri）启用即能用，一句话指路，无需下载。
 */
export class ImeHelpModal extends DialogModal {
  constructor(
    app: App,
    private readonly plugin: YoungLookPlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    if (process.platform === "win32") this.renderDownload();
    else if (process.platform === "darwin") this.renderMac();
    else this.renderOther();
  }

  private renderDownload(): void {
    const { body, foot } = this.buildShell({
      icon: "keyboard",
      title: "日语输入法",
      variant: "center",
    });
    body.createEl("p", {
      text: "您需要日语输入法才能打日语。建议安装谷歌日语输入法，装好后用 Win+空格 切换即可。",
      cls: "yl-lead",
    });
    this.fillFoot(foot, {
      role: "primary",
      text: "下载谷歌日语输入法",
      onClick: () => {
        window.open(`${this.plugin.webBase()}/download`, "_blank");
        this.close();
      },
    });
  }

  private renderMac(): void {
    const { body, foot } = this.buildShell({
      icon: "keyboard",
      title: "日语输入法",
      variant: "center",
    });
    body.createEl("p", {
      text: "您需要日语输入法才能打日语。macOS 自带的就能用：系统设置 → 键盘 → 输入法 → 添加「日语 → 罗马字」即可。",
      cls: "yl-lead",
    });
    this.fillFoot(
      foot,
      { role: "primary", text: "知道了", onClick: () => this.close() },
      { cancel: null },
    );
  }

  private renderOther(): void {
    const { body, foot } = this.buildShell({
      icon: "keyboard",
      title: "日语输入法",
      variant: "center",
    });
    body.createEl("p", {
      text: "您需要日语输入法才能打日语。请在系统设置中启用日语输入法。",
      cls: "yl-lead",
    });
    this.fillFoot(
      foot,
      { role: "primary", text: "知道了", onClick: () => this.close() },
      { cancel: null },
    );
  }
}
