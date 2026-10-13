/**
 * 「点纠之前先劝一句 AI 解析」提醒窗 —— 学习页上**这一句还没解析过**时，
 * 点「纠」先出它（2026-10-10 用户定）。
 *
 * ══ 它解决什么 ══════════════════════════════════════════════════════
 * 「纠」是手动改字幕/注音的入口。但一句**没跑过 AI 解析**的句子，屏幕上显示的
 * 注音还只是本机词典拼出来的那份 —— 人名、缩约、连浊这类地方本来就常错。用户
 * 看到注音不对，第一反应是点「纠」一个个手改；而他多半不知道：**AI 解析本来
 * 就会把这一句的注音、释义一起补正**，跑一遍往往顺手就改对了，根本不用手改。
 *
 * 所以这里不是拦人，是**先把更省事的那条路摆出来**：主按钮引导先试一次 AI 解析；
 * 手动纠错照样留着（取消位那颗灰字钮），选了就照原来那条路走 —— 用户想手改
 * 永远有这个选择，只是别让他白花力气。
 *
 * 🔥 只在**没解析过**时才出（判定在 StudyView.openHeroFix，用 `isAnalyzed`）。
 * 已经解析过的句子再点「纠」，就是用户真去修 AI 也没弄对的地方，不必再劝。
 *
 * ══ 两个出口 ═══════════════════════════════════════════════════════════
 * · 主按钮「试试 AI 解析」→ 交回 StudyView 触发一次解析（等价于点「AI 解析」）。
 * · 灰字钮「仍然手动纠错」→ 照旧开 `CorrectionModal`。
 * ⚠️ 点哪颗都**先关本窗再回调**：留着两颗窗叠在一起，用户对着两层做同一件事。
 *
 * 壳走 `ui/dialog.ts` 的居中竖版（`variant: "center"`，与「重新解析」确认窗同档）：
 * 全站弹窗长相只有那一处定义，别在这儿另写宽度/圆角。图标 `sparkles` 已核过在
 * 宿主 lucide 里真实存在（grep obsidian.asar 命中）。
 */
import { type App } from "obsidian";

import { DialogModal } from "../../ui/dialog";

export interface CorrectionSuggestOptions {
  /** 「先去试 AI 解析」：交回 StudyView 触发一次解析（与点「AI 解析」按钮同一条链路） */
  onTryAi(): void;
  /** 「仍然手动纠错」：照旧开纠错弹窗 */
  onManual(): void;
}

export class CorrectionSuggestModal extends DialogModal {
  constructor(
    app: App,
    private readonly opts: CorrectionSuggestOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    const { body, foot } = this.buildShell({
      icon: "sparkles",
      title: "先试试 AI 解析？",
      variant: "center",
    });

    body.createEl("p", {
      text: "AI 解析能够自动修正错误；如果仍无法修正，再尝试手动纠错。",
      cls: "yl-lead",
    });

    this.fillFoot(
      foot,
      {
        text: "试试 AI 解析",
        role: "primary",
        onClick: () => {
          this.close();
          this.opts.onTryAi();
        },
      },
      {
        cancel: {
          text: "仍然手动纠错",
          onClick: () => {
            this.close();
            this.opts.onManual();
          },
        },
      },
    );
  }
}
