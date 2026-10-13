/**
 * 「重新解析」确认窗 —— 学习页上**唯一一次点击前问一句**的窗。
 *
 * 为什么单独开一颗窗（2026-10-08 用户拍板）：这一句已经解析过了，再点一次
 * 不是"看上次的结果"（那条路走本机缓存、一分钱不花，见 StudyView 的 showCached），
 * 而是**重新发一次请求** —— 内置模型按实际用量从余额扣费。用户点了才知道扣费
 * 不可接受，所以在花钱之前拦一下，由人点头才发。
 *
 * 🔥 重新解析**只管左侧的解读那一块**（2026-10-08 用户拍板）：右侧句子卡上的逐词
 * 释义不重新解析，所以正文必须说清"只有左边会变"，否则用户会以为花了钱连词表一起刷。
 * 真正只发一块的实现在 `StudyView.reparseExplanation`。
 *
 * 壳走 `ui/dialog.ts` 的统一壳（居中竖版 V1，跟「需要先配置模型」同一档）：
 * 全站弹窗长相只有这一处定义，别在这儿另写一套宽度/圆角。
 *
 * ⚠️ 文案按**实际生效的轨道**分叉（`resolveAiRoute`）：双轨自由选（2026-10-12）
 * 之后轨道就是用户自己选的 —— 选内置说"扣余额"，选自定义说"不扣余额"，各说各的实话。
 */
import { type App } from "obsidian";

import { DialogModal } from "../../ui/dialog";

export interface ReparseConfirmOpts {
  /** 实际生效的轨道：决定正文说的是"扣余额"还是"花自己的额度" */
  aiMode: "off" | "byok" | "hosted";
  /** 点「重新解析」→ 真的发请求（关窗后才回调） */
  onConfirm(): void;
}

export class ReparseConfirmModal extends DialogModal {
  constructor(
    app: App,
    private readonly opts: ReparseConfirmOpts,
  ) {
    super(app);
  }

  onOpen(): void {
    const { body, foot } = this.buildShell({
      // refresh-cw 在宿主 lucide 里真实存在（核过 obsidian.asar）—— 别换成
      // "coins"/"wallet" 这类看着更贴题的：它们不在，setIcon 会静默不出图。
      icon: "refresh-cw",
      title: "重新解析这一句吗？",
      variant: "center",
    });

    body.createEl("p", {
      text: this.opts.aiMode === "hosted"
        ? "只重新生成下方的解读，按实际用量从余额扣费。"
        : "只重新生成下方的解读，用你自己的 Key，不扣余额。",
      cls: "yl-lead",
    });
    // 两句都点到：花了钱换回什么（左侧那段文字被新的覆盖），以及不确认的代价（什么都没有）。
    // 右侧句子卡不参与（2026-10-08 用户拍板）：它是上一次的逐词释义，本来就没变，
    // 再跑一遍只是多花一次钱；说出来用户才不会以为"连词表一起刷新了"。
    body.createEl("p", {
      text: "如果需要修改右上方句子卡片的内容，请点击「纠」按钮；点「再想想」就什么都不做，也不扣费。",
      cls: "yl-lead",
    });

    this.fillFoot(
      foot,
      {
        text: "重新解析",
        role: "primary",
        onClick: () => {
          this.close();
          this.opts.onConfirm();
        },
      },
      {
        // 「再想想」不传 onClick = 关窗，什么都不发生（底栏默认行为，见 fillFoot）。
        // 想要"降级成只读缓存"之类的副作用，先问清楚再往这儿加。
        cancel: { text: "再想想" },
      },
    );
  }
}
