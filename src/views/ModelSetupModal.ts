import { type App } from "obsidian";
import { DialogModal } from "../ui/dialog";

/**
 * 「先配置模型」的小弹窗 —— 学习页三个 AI 入口（AI 解析 / AI 核对 /
 * 小助手）门控不放行时的统一出口，三个入口**同一套话术**（2026-10-02 用户定稿）：
 * 一句话问「现在配置吗」，两颗钮。不提付费、不分原因 —— 缺什么，到了账户页自然看见。
 *
 * 确认 → 进个人中心「账户」页选 自定义模型 / 内置模型；注册/登录只发生在
 * 「内置模型 → 充值」那一步（见 PersonalCenterView 的充值按钮）。
 *
 * 🔥 壳（宽度/圆角/标题行/底栏）由 `DialogModal` 统一给 —— 2026-10-02 用户拍板
 * 全站弹窗采用候选里的 v2 那一版，从前这个弹窗自己写了一套 `.yl-setup`
 * （400px/14px 圆角/居中/圆形徽章），跟「移除这一集」长得完全不一样。
 * 现在壳住在 `ui/dialog.ts` + styles.css 的 `.yl-dialog` 段，这里只管内容和话术。
 */
export interface ModelSetupModalOpts {
  /** 「去配置」→ 打开个人中心「账户」页 */
  onConfirm(): void;
  /**
   * 「暂不」→ 关掉了事。AI 核对用它继续兜底放行（按「未核对」记上）；
   * 解析和小助手不需要 —— 暂不就是什么都不发生。
   */
  onDecline?(): void;
  /**
   * 正文那句话。默认是三个 AI 入口那套通用话术；**发音评估**这类"功能特殊、
   * 只有内置模型能给"的场景要换一句说清原因（见 StudyView::promptHostedModelSetup）；
   * 没余额那档也要换 —— 把两条出路摆出来（充值继续用内置模型 / 改用自定义模型）。
   */
  message?: string;
  /** 标题行那句话。默认「需要先配置模型」；没余额那档换成余额话术。 */
  title?: string;
  /** 主按钮文案。默认「去配置」——没余额那档 2026-10-05 起也用它（出口同为账户页）。 */
  confirmText?: string;
}

export class ModelSetupModal extends DialogModal {
  constructor(
    app: App,
    private readonly opts: ModelSetupModalOpts,
  ) {
    super(app);
  }

  onOpen(): void {
    const { body, foot } = this.buildShell({
      icon: "sliders-horizontal",
      title: this.opts.title ?? "需要先配置模型",
      // 居中竖版 + 实心「去配置」（2026-10-04 用户从 temp/demo/dialog 三版里选了 V1）
      variant: "center",
    });

    body.createEl("p", {
      text: this.opts.message ?? "您需要先配置模型，才可以使用 AI 功能，现在配置吗？",
      cls: "yl-lead",
    });

    this.fillFoot(
      foot,
      {
        text: this.opts.confirmText ?? "去配置",
        role: "primary",
        onClick: () => {
          this.close();
          this.opts.onConfirm();
        },
      },
      {
        // 「暂不」只在点了这颗钮时才算 —— ESC / 点外面就是纯关闭，什么都不发生
        cancel: {
          text: "暂不",
          onClick: () => {
            this.close();
            this.opts.onDecline?.();
          },
        },
      },
    );
  }
}
