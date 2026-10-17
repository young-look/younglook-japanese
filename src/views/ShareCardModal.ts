/**
 * 「生成学习卡片」弹窗 —— 个人中心那颗「生成」钮的落点。
 *
 * ══ 弹窗里有什么（2026-10-15 用户拍板的口径）═══════════════════════
 * 主题是**卡片本身**：最上面就是当场画出来的学习卡（canvas 现画，坐标见
 * `services/shareCard.ts` 的 `drawShareCard`），不是二维码。
 *  · 「下载图片」是电脑端的主路径 —— 弹**系统保存框**让用户自己选位置，
 *    存完把 PNG 文件拖进微信就能发给别人（桌面微信发图片文件即可）；
 *  · 要用手机分享，才看下方那枚二维码 + 说明文字：扫出来是同一张卡。
 *
 * ⚠️ 卡片**不落服务端**：链接本身就是数据，画卡全程在本机（Electron 渲染
 *    进程）完成，没有网络请求、不需要登录，也没有"生成中…"的长等待 ——
 *    唯一的异步是本地画布与二维码。
 */
import { Notice, type App } from "obsidian";

import type YoungLookPlugin from "../main";
import otterBlack from "../assets/otter-black.png";
import { createButton } from "../ui/button";
import {
  buildShareUrl,
  drawShareCard,
  qrCodeSvg,
  savePngViaSystemDialog,
  shareCardFileName,
  type ShareCardPayload,
} from "../services/shareCard";
import { DialogModal } from "../ui/dialog";

export class ShareCardModal extends DialogModal {
  /** 画好的卡片 PNG（data URL）—— 下载钮指着它。没画好就是 null（钮禁掉）。 */
  private cardUrl: string | null = null;

  constructor(
    app: App,
    private readonly plugin: YoungLookPlugin,
    private readonly payload: ShareCardPayload,
  ) {
    super(app);
  }

  onOpen(): void {
    const url = buildShareUrl(this.plugin.webBase(), this.payload);
    const { body, foot } = this.buildShell({
      icon: "share-2",
      title: "学习卡片",
      subtitle: "保存图片发到微信，或用手机扫码分享",
      cls: "yl-share-modal",
    });

    // ① 卡片本体（弹窗的主题）：先摆占位，画好了换成 <img>
    const cardBox = body.createDiv({ cls: "yl-share-cardbox" });
    const cardHint = cardBox.createDiv({ cls: "yl-share-cardhint", text: "正在画卡片…" });

    // ② 「分享到手机」：左小二维码 + 右说明（2026-10-17 用户定：左右结构，
    //    整个弹窗要矮、一屏装得下 —— 别再回到竖排大二维码那版）
    const phone = body.createDiv({ cls: "yl-share-phone" });
    const qr = phone.createDiv({ cls: "yl-share-qr" });
    qr.createDiv({ cls: "yl-share-qr-slot", text: "正在生成…" });
    const info = phone.createDiv({ cls: "yl-share-info" });
    info.createDiv({ cls: "yl-share-phone-t", text: "分享到手机" });
    info.createEl("p", {
      cls: "yl-lead yl-share-phone-d",
      text: "用微信「扫一扫」打开这张卡，长按图片就能保存或转发。",
    });
    createButton(info, {
      shape: "text",
      text: "复制链接",
      onClick: () => void this.copyLink(url),
    });

    // 底栏：主操作 = 下载图片（卡片画好才亮）
    const { primaryBtn } = this.fillFoot(
      foot,
      {
        text: "下载图片",
        disabled: true,
        onClick: () => void this.downloadCard(),
      },
      { cancel: { text: "关闭" } },
    );

    void drawShareCard(this.payload, { otterSrc: otterBlack, qrText: url })
      .then((dataUrl) => {
        this.cardUrl = dataUrl;
        cardHint.remove();
        cardBox.createEl("img", {
          cls: "yl-share-card",
          attr: { src: dataUrl, alt: "学习卡片" },
        });
        primaryBtn.disabled = false;
      })
      .catch(() => {
        // 画不出来不堵死分享：二维码那条路照走
        cardHint.setText("卡片画失败了 —— 用下面的扫码分享也一样。");
      });

    void qrCodeSvg(url)
      .then((svg) => {
        const slot = qr.querySelector(".yl-share-qr-slot");
        if (slot) slot.remove();
        const box = qr.createDiv({ cls: "yl-share-qr-box" });
        box.innerHTML = svg;
      })
      .catch(() => {
        const slot = qr.querySelector(".yl-share-qr-slot");
        if (slot) slot.setText("二维码生成失败，用下面的复制链接也一样能打开。");
      });
  }

  /** 复制链接（桌面微信粘链接发出去的那条路）。 */
  private async copyLink(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      new Notice("链接已复制，粘到聊天里就能打开这张卡。");
    } catch {
      new Notice("复制失败了，换二维码分享也行。");
    }
  }

  /**
   * 下载卡片：弹系统保存框让用户自己选位置，写盘。
   *
   * 三态来自 `savePngViaSystemDialog`：null = 用户取消了保存框（静默，
   * 不算出错）；undefined = 这个环境弹不出保存框（明说没保存成）。
   */
  private async downloadCard(): Promise<void> {
    if (!this.cardUrl) return;
    const saved = await savePngViaSystemDialog(shareCardFileName(this.payload.date), this.cardUrl);
    if (saved === null) return;
    if (saved === undefined) {
      new Notice("这个环境弹不出保存窗口，卡片没保存成。");
      return;
    }
    new Notice(`卡片已保存到 ${saved} —— 在微信里把这张图发给别人就行。`);
  }
}
