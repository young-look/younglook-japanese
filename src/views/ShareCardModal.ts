/**
 * 「生成学习卡片」弹窗 —— 个人中心那颗「生成」钮的落点。
 *
 * 弹窗里就三样东西：**二维码** + 「复制链接」+ 「在浏览器打开」。
 * 扫码（或在浏览器打开）都是同一个链接，网页端照着链接里的数据现场画一张
 * 图；手机上长按就能保存、转发。
 *
 * ⚠️ 卡片**不落服务端**：链接本身就是数据，所以这里没有网络请求、不需要登录，
 *    也没有"生成中…"的长等待 —— 唯一的异步是本地画二维码。
 */
import { Notice, type App } from "obsidian";

import type YoungLookPlugin from "../main";
import { buildShareUrl, qrCodeSvg, type ShareCardPayload } from "../services/shareCard";
import { DialogModal } from "../ui/dialog";

export class ShareCardModal extends DialogModal {
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
      subtitle: "用手机扫码，长按图片就能保存分享",
    });

    const qr = body.createDiv({ cls: "yl-share-qr" });
    qr.createDiv({ cls: "yl-share-qr-slot", text: "正在生成…" });

    body.createEl("p", {
      cls: "yl-lead",
      text: "扫出来的卡片上有你的连续天数、等级，还有洋流的名字和链接。",
    });

    const link = body.createEl("a", { cls: "yl-share-link", href: url, text: "在浏览器打开 ↗" });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      window.open(url, "_blank");
    });

    this.fillFoot(
      foot,
      {
        text: "复制链接",
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(url);
            new Notice("链接已复制，粘到聊天里就能打开这张卡。");
          } catch {
            new Notice("复制失败，可以手动选中上面的链接。");
          }
        },
      },
      { cancel: { text: "关闭" } },
    );

    void qrCodeSvg(url)
      .then((svg) => {
        const slot = qr.querySelector(".yl-share-qr-slot");
        if (slot) slot.remove();
        const box = qr.createDiv({ cls: "yl-share-qr-box" });
        box.innerHTML = svg;
      })
      .catch(() => {
        const slot = qr.querySelector(".yl-share-qr-slot");
        if (slot) slot.setText("二维码生成失败，用上面的链接也一样能打开。");
      });
  }
}
