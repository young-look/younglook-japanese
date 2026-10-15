/**
 * 学习分享卡 —— 插件这一半：**把学习成就编进一条链接**，本机把它画成一张图。
 *
 * ══ 数据不出本机 ══════════════════════════════════════════════════
 * 卡上的连续天数 / 等级 / 昵称 / 日期**全在链接里**，不上传、不落库、没有
 * 服务端接口（2026-10-09 用户拍板）。链接同时是二维码的内容：手机扫码打开
 * 网页，网页用 canvas 现场把卡画出来 —— 服务端从头到尾没有见过这些数据，
 * 与「视频不上传、字幕不出本机」是同一条红线。代价是链接长一点、没有短码；
 * 换来的是零后端改动。
 *
 * ══ 卡片在插件里也画一份 ══════════════════════════════════════════
 * 2026-10-15 用户拍板：弹窗主题是**卡片本身**（不是二维码），电脑端直接
 * 下载图片发微信。所以 `drawShareCard` 在插件里照着网页端同坐标又画了一遍
 * —— 同一张卡、两处实现（坐标逐行一致，改版式两边一起改，源头都是
 * `temp/demo/share/v1-report.html`，750×1200）。不"调网页渲染好再取回来"
 * 的理由：那条路等于把链接里的学习数据发给网页服务端去画，虽然不落库，
 * 但数据终究出了本机 —— 本机画，红线一个字都不用解释。
 *
 * ⚠️ 链接格式与网页端 `web/src/utils/shareCard.ts` 是**同一份约定的两处实现**
 *     （明文 query：`?n=&s=&l=&t=&d=`）。改字段两边一起改，别只动一处 ——
 *     顺手加了 base64 之类的编码就会各写一份，迟早漂移。
 */
import QRCode from "qrcode";
import fs from "node:fs";

import type YoungLookPlugin from "../main";

export interface ShareCardPayload {
  nickname: string;
  /** 连续学习天数 */
  streak: number;
  /** 等级数字 1~7 */
  level: number;
  /** 等级名（港口 / 海湾 / … / 新大陆） */
  levelName: string;
  /** 'YYYY-MM-DD'（本地日期） */
  date: string;
}

/** 分享卡落地页路径。网页端路由表里的 `share-card`（`web/src/router/index.ts`）。 */
const SHARE_PATH = "/s/";

/** 本地日期 'YYYY-MM-DD' —— 用户在哪个时区，"今天"就是哪个今天。 */
export function localDay(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 拼分享链接。base 走 `plugin.webBase()`（本机是 vite 5173，线上是 younglook.cc）。 */
export function buildShareUrl(webBase: string, payload: ShareCardPayload): string {
  const q = new URLSearchParams({
    n: payload.nickname,
    s: String(payload.streak),
    l: String(payload.level),
    t: payload.levelName,
    d: payload.date.replace(/-/gu, ""),
  });
  return `${webBase.replace(/\/+$/u, "")}${SHARE_PATH}?${q.toString()}`;
}

/** 插件里生成卡片数据：昵称取账号资料，没有就用「洋流同学」。 */
export function shareCardPayloadFrom(
  plugin: YoungLookPlugin,
  opts: { streak: number; level: number; levelName: string },
): ShareCardPayload {
  const nickname = plugin.settings.accountProfile?.nickname?.trim() || "洋流同学";
  return {
    nickname: nickname.slice(0, 16),
    streak: Math.max(0, Math.floor(opts.streak)),
    level: opts.level,
    levelName: opts.levelName,
    date: localDay(),
  };
}

/**
 * 链接 → 二维码 SVG。
 *
 * 走 SVG 而不是 canvas：弹窗里那块区域会被 Obsidian 的缩放跟着放大缩小，
 * 位图会糊，矢量不会。
 */
export async function qrCodeSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: "svg", margin: 0, errorCorrectionLevel: "M" });
}

// ── 卡片绘制（与网页端同坐标的另一半实现）─────────────────────────────
//
// ⚠️⚠️ 下面整段与 `web/src/utils/shareCard.ts` 的 `drawShareCard` 是
// **同一张卡的两处实现**：常量、坐标、绘制顺序逐行一致。改版式先改 demo 稿
// （`temp/demo/share/v1-report.html`），再照着两边一起改 —— 只改一处的症状
// 是"扫码打开的卡和插件里下载的卡长得不一样"，而没有任何测试会报错。

/** 卡片设计尺寸（CSS 像素）。出图按 2 倍画，保证手机上不虚。 */
const CARD_W = 750;
const CARD_H = 1200;
const SCALE = 2;

const FONT = '"PingFang SC", "Hiragino Sans GB", -apple-system, "Microsoft YaHei", sans-serif';

const INK = "#0d0d0d";
const INK_2 = "#3d4448";
const MUTED = "#8f8f8f";
const FAINT = "#b3b3b3";
const HAIR = "#e6e8ea";
const ACC = "#1c7087";
const ACC_TINT = "#eaf7fa";
const ACC_LINE = "#b2dbe7";
const FLAME = "#ff7a59";

/** 顶部 / 底部品牌头留白，与 demo 稿一致 */
const PAD_X = 56;
const TOP = 54;
/** 底部波浪之上的安全区：内容块不会压到浪上 */
const BOTTOM_PAD = 190;
/** 波浪高度（demo 稿里 1200 档 = 214 + (1200-1000)*0.18） */
const SEA_H = 250;
/** 波浪 SVG 的 viewBox 高度（path 坐标按它写的，绘制时纵向拉伸） */
const SEA_VB = 214;

const SEA_BACK =
  "M0 92 C 62 56 125 56 187 92 S 312 128 375 92 S 500 56 562 92 S 687 128 750 92 L 750 214 L 0 214 Z";
const SEA_MAIN =
  "M0 116 C 62 82 125 82 187 116 S 312 150 375 116 S 500 82 562 116 S 687 150 750 116 L 750 214 L 0 214 Z";
const SEA_LINE_1 =
  "M0 74 C 62 42 125 42 187 74 S 312 106 375 74 S 500 42 562 74 S 687 106 750 74";
const SEA_LINE_2 =
  "M0 140 C 62 108 125 108 187 140 S 312 172 375 140 S 500 108 562 140 S 687 172 750 140";

function font(weight: number, size: number): string {
  return `${weight} ${size}px ${FONT}`;
}

/** 带字距的文本宽度。canvas 的 letterSpacing 在 iOS Safari 上不生效，只能逐字量。 */
function spacedWidth(ctx: CanvasRenderingContext2D, text: string, spacing: number): number {
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + spacing;
  return Math.max(w - spacing, 0);
}

/** 逐字绘制带字距的文本。x 是**对齐基准**（center 时给中心线）。 */
function drawSpaced(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number,
  align: "center" | "left" = "center",
): void {
  const total = spacedWidth(ctx, text, spacing);
  let cx = align === "center" ? x - total / 2 : x;
  ctx.textAlign = "left";
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacing;
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

/**
 * 画一整张卡，返回 PNG 的 data URL。
 *
 * 与网页端 `drawShareCard` 同坐标（见本节开头警语）。`otterSrc` 由调用方
 * （视图层）以 dataurl 形式传入（esbuild 的 .png loader 内联进 main.js）；
 * `qrText` 是分享链接 —— 印在卡右上角的那枚二维码扫出来就是它，别人扫这张
 * 图也能看到同一张卡。
 */
export async function drawShareCard(
  data: ShareCardPayload,
  opts: { otterSrc: string; qrText: string },
): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W * SCALE;
  canvas.height = CARD_H * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = "alphabetic";

  // 白底
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  const [otter, qr] = await Promise.all([
    loadImage(opts.otterSrc),
    QRCode.toDataURL(opts.qrText, { margin: 0, width: 196, errorCorrectionLevel: "M" }).then(
      loadImage,
    ),
  ]);

  // ── 顶部：左品牌 / 右二维码 ────────────────────────────────────────
  ctx.drawImage(otter, PAD_X, TOP + 3.5, 52, 52);
  ctx.fillStyle = INK;
  ctx.font = font(650, 24);
  ctx.textAlign = "left";
  const bnX = PAD_X + 52 + 14;
  ctx.fillText("洋流日语", bnX, TOP + 26);
  const bnW = ctx.measureText("洋流日语").width;
  ctx.fillStyle = FLAME;
  ctx.beginPath();
  ctx.arc(bnX + bnW + 9, TOP + 12, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = FAINT;
  ctx.font = font(400, 12);
  drawSpaced(ctx, "YOUNG LOOK", bnX, TOP + 53, 12 * 0.34, "left");

  const qrBox = 112;
  const qrX = CARD_W - PAD_X - qrBox;
  ctx.strokeStyle = HAIR;
  ctx.lineWidth = 1;
  roundRect(ctx, qrX + 0.5, TOP + 0.5, qrBox - 1, qrBox - 1, 10);
  ctx.stroke();
  ctx.drawImage(qr, qrX + 7, TOP + 7, qrBox - 14, qrBox - 14);
  if (data.date) {
    ctx.fillStyle = FAINT;
    ctx.font = font(400, 13);
    drawSpaced(ctx, data.date.replace(/-/gu, "."), qrX + qrBox / 2, TOP + qrBox + 9 + 14, 0.8);
  }

  // ── 中部：整块垂直居中（与 demo 稿 flex 居中同一口径）────────────────
  const blockH = 40.5 + 6 + 168 + 14 + 40.5 + 22 + 44 + 46 + 1 + 20 + 31.5;
  const areaTop = TOP + 59;
  const areaBottom = CARD_H - BOTTOM_PAD;
  let y = areaTop + Math.max((areaBottom - areaTop - blockH) / 2, 0);

  ctx.textAlign = "center";
  ctx.fillStyle = MUTED;
  ctx.font = font(400, 27);
  drawSpaced(ctx, "我已经连续学日语", CARD_W / 2, y + 29, 27 * 0.04);
  y += 40.5 + 6;

  // 巨型天数：数字与「天」同基线
  const numText = String(data.streak);
  ctx.font = font(700, 168);
  const numW = ctx.measureText(numText).width;
  ctx.font = font(600, 40);
  const unitW = ctx.measureText("天").width;
  const bigLeft = CARD_W / 2 - (numW + 10 + unitW) / 2;
  const bigBaseline = y + 168 * 0.78;
  ctx.textAlign = "left";
  ctx.fillStyle = ACC;
  ctx.font = font(700, 168);
  ctx.fillText(numText, bigLeft, bigBaseline);
  ctx.font = font(600, 40);
  ctx.fillText("天", bigLeft + numW + 10, bigBaseline);
  y += 168 + 14;

  ctx.textAlign = "center";
  ctx.fillStyle = INK;
  ctx.font = font(600, 27);
  drawSpaced(ctx, "看番听歌，学真日语", CARD_W / 2, y + 31, 27 * 0.01);
  y += 40.5 + 22;

  // 等级胶囊
  const who = `${data.nickname} ｜ Lv.${data.level} ${data.levelName}`;
  ctx.font = font(600, 19);
  const pillW = spacedWidth(ctx, who, 0) + 36;
  const pillX = CARD_W / 2 - pillW / 2;
  ctx.fillStyle = ACC_TINT;
  roundRect(ctx, pillX, y, pillW, 44, 22);
  ctx.fill();
  ctx.strokeStyle = ACC_LINE;
  ctx.lineWidth = 1;
  roundRect(ctx, pillX + 0.5, y + 0.5, pillW - 1, 43, 22);
  ctx.stroke();
  ctx.fillStyle = ACC;
  drawSpaced(ctx, who, CARD_W / 2, y + 22 + 7, 0);
  y += 44 + 46;

  // 分隔细线 + 一句话
  ctx.fillStyle = HAIR;
  ctx.fillRect(CARD_W / 2 - 20, y, 40, 1);
  y += 1 + 20;
  ctx.fillStyle = INK_2;
  ctx.font = font(400, 21);
  drawSpaced(ctx, "在语言学习的航行中，达到彼岸。", CARD_W / 2, y + 24, 21 * 0.04);

  // ── 底部：洋流波浪 ────────────────────────────────────────────────
  const seaTop = CARD_H - SEA_H;
  ctx.save();
  ctx.translate(0, seaTop);
  ctx.scale(1, SEA_H / SEA_VB);
  const back = ctx.createLinearGradient(0, 0, 0, SEA_VB);
  back.addColorStop(0, "#3aa8c6");
  back.addColorStop(1, "rgba(58,168,198,0)");
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = back;
  ctx.fill(new Path2D(SEA_BACK));
  ctx.globalAlpha = 1;
  const main = ctx.createLinearGradient(0, 0, 0, SEA_VB);
  main.addColorStop(0, "#2f9dbb");
  main.addColorStop(0.55, "#137f9d");
  main.addColorStop(1, "#064f66");
  ctx.fillStyle = main;
  ctx.fill(new Path2D(SEA_MAIN));
  ctx.strokeStyle = "#ffffff";
  ctx.lineCap = "round";
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = 2;
  ctx.stroke(new Path2D(SEA_LINE_1));
  ctx.globalAlpha = 0.16;
  ctx.stroke(new Path2D(SEA_LINE_2));
  ctx.restore();

  // 链接：压在深色水域里
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = "#ffffff";
  ctx.font = font(600, 24);
  ctx.textBaseline = "middle";
  drawSpaced(ctx, "younglook.cc", CARD_W / 2, CARD_H - 38 - 18, 24 * 0.1);
  ctx.globalAlpha = 1;

  return canvas.toDataURL("image/png");
}

/** 下载时给图片起的默认名（与网页端「保存图片」同一格式）。 */
export function shareCardFileName(date: string): string {
  return `洋流日语-学习卡-${date || "今天"}.png`;
}

/** electron remote 的保存框形状（ Obsidian 为插件初始化过 @electron/remote，
 *  与 `PersonalCenterView` 里两个 CSV 导出同一条 require 通道）。 */
interface RemoteSaveDialog {
  showSaveDialog: (options: {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
    properties?: string[];
  }) => Promise<{ canceled?: boolean; filePath?: string }>;
}

/**
 * 弹**系统保存框**让用户挑位置，把 PNG（data URL）写到选中的路径。
 *
 * 用户 2026-10-15 拍板：下载按钮必须弹文件选择器，保存到哪里由用户自己定 ——
 * 所以这里不走 `<a download>`（那个直接进默认下载目录，用户选不了位置），
 * 与 10-10「导出一律由用户自己选位置，插件不往库里写东西」是同一条口径。
 *
 * 返回值三态，调用方据此分岔：
 *  - 字符串      → 用户选了位置，已写盘，返回绝对路径；
 *  - null        → 用户取消了选择框（**不算出错**，静默返回）；
 *  - undefined   → 这个环境拿不到系统保存框 → 告诉用户没保存成。
 */
export async function savePngViaSystemDialog(
  defaultName: string,
  dataUrl: string,
): Promise<string | null | undefined> {
  try {
    const req = (window as unknown as { require?: (name: string) => unknown }).require;
    const electron = req?.("electron") as { remote?: { dialog?: RemoteSaveDialog } } | undefined;
    const dialog = electron?.remote?.dialog;
    if (!dialog?.showSaveDialog) return undefined;
    const result = await dialog.showSaveDialog({
      title: "保存学习卡片",
      defaultPath: defaultName,
      filters: [{ name: "图片", extensions: ["png"] }],
      properties: ["createDirectory", "showOverwriteConfirmation", "dontAddToRecent"],
    });
    if (result.canceled || !result.filePath) return null;
    let path = result.filePath;
    if (!/\.png$/i.test(path)) path += ".png";
    const base64 = dataUrl.replace(/^data:image\/png;base64,/u, "");
    fs.writeFileSync(path, Buffer.from(base64, "base64"));
    return path;
  } catch {
    return undefined;
  }
}
