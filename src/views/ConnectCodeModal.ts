/**
 * 「连接账号」授权码弹窗 —— 插件里连接的第二条路。
 *
 * 背景（2026-10-05）：连接页深链 `obsidian://` 会被部分浏览器拦掉，拉不起
 * Obsidian。所以个人中心点「连接账号」时**两边同时开**：网页（登录 / 注册 +
 * 摆着 6 位授权码的那页）开新标签页，这边开这张小弹窗 —— 用户在网页登录完、
 * 复制授权码，回来粘进弹窗就完成连接，全程不依赖跳转。
 *
 * 弹窗里就两样东西：一个输入框、一颗「确定」（用户拍板的口径）。
 * 粘贴是主要用法，所以输入框只认数字、超 6 位截断、**填满即提交**；
 * 回车等价于点确定。失败的原因写在底栏状态行上（不关窗，改完能直接重试）。
 */

import { Notice, type App } from "obsidian";

import type YoungLookPlugin from "../main";
import { DialogModal } from "../ui/dialog";

export class ConnectCodeModal extends DialogModal {
  private busy = false;
  private inputEl: HTMLInputElement | null = null;
  private footEl: HTMLElement | null = null;
  /** 底栏状态行：失败原因放这儿，不关窗、不弹 Notice 打断输入 */
  private note = "";
  /** 连接已经办完（弹窗自己提交的，或深链先到的广播）：只关一次窗 */
  private resolved = false;
  /** 退订「连接成功」广播，onBeforeClose 里解绑 */
  private unsubscribe: (() => void) | null = null;

  constructor(
    app: App,
    private readonly plugin: YoungLookPlugin,
    private readonly options: { onDone?: () => void } = {},
  ) {
    super(app);
  }

  onOpen(): void {
    const { body, foot } = this.buildShell({
      icon: "link",
      title: "连接账号",
      subtitle: "网页已在新标签页打开，登录后复制那串 6 位授权码",
    });
    body.createEl("p", {
      text: "把授权码粘到下面，点确定就连接完成。码 5 分钟内有效、只能用一次。",
      cls: "yl-lead",
    });
    this.inputEl = body.createEl("input", {
      type: "text",
      // 复用「弹窗里的全宽输入框」这一档（EditModal 同款），不为 6 位码单开样式
      cls: "yl-name-input",
      attr: {
        placeholder: "6 位授权码",
        inputmode: "numeric",
        maxlength: "6",
        autocomplete: "off",
        spellcheck: "false",
      },
    });
    this.footEl = foot;
    this.renderFoot();

    // 用户可能不听弹窗这套、直接在网页点深链把连接办完 —— 那声广播一到，
    // 弹窗就地消失（不用人回来关）。深链路径的 Notice 由协议处理器发，这里不重复。
    this.unsubscribe = this.plugin.onConnectSuccess(() => {
      this.resolved = true;
      this.close();
    });

    this.inputEl.addEventListener("input", () => {
      // 粘进来的常常是「482 917」「code: 482917」这类形状 —— 只留数字，剩下的别管
      const digits = this.inputEl!.value.replace(/\D/gu, "").slice(0, 6);
      if (digits !== this.inputEl!.value) this.inputEl!.value = digits;
      if (digits.length === 6) void this.submit();
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void this.submit();
    });
    window.setTimeout(() => this.inputEl?.focus(), 0);
  }

  /** 弹窗关了就退订广播，别让闭包把已关的弹窗拽回来 */
  protected onBeforeClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private renderFoot(): void {
    if (!this.footEl) return;
    this.fillFoot(
      this.footEl,
      {
        text: this.busy ? "连接中…" : "确定",
        disabled: this.busy,
        onClick: () => void this.submit(),
      },
      // 用户拍板「就是一个输入框 + 一颗确定」—— 不放取消钮，Esc / 点外面就能关
      { cancel: null, note: this.note, noteOk: false },
    );
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const code = (this.inputEl?.value ?? "").trim();
    if (code.length !== 6) {
      this.note = "授权码是 6 位数字";
      this.renderFoot();
      this.inputEl?.focus();
      return;
    }

    this.busy = true;
    this.note = "";
    this.renderFoot();
    const result = await this.plugin.exchangeConnectCode(code);

    if (result.ok) {
      // 广播可能已把窗关了（深链先到）：别再关一次，Notice 与刷新照做
      if (!this.resolved) {
        this.resolved = true;
        this.close();
      }
      new Notice("已连接账号，充值后可用内置模型与云同步。");
      this.options.onDone?.();
      return;
    }
    this.busy = false;
    this.note = result.message;
    this.renderFoot();
    this.inputEl?.focus();
    this.inputEl?.select();
  }
}
