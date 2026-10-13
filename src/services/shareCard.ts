/**
 * 学习分享卡 —— 插件这一半：**把学习成就编进一条链接**，再把它画成二维码。
 *
 * ══ 数据不出本机 ══════════════════════════════════════════════════
 * 卡上的连续天数 / 等级 / 昵称 / 日期**全在链接里**，不上传、不落库、没有
 * 服务端接口（2026-10-09 用户拍板）。手机扫码打开网页，网页用 canvas 现场
 * 把卡画出来 —— 服务端从头到尾没有见过这些数据，与「视频不上传、字幕不出
 * 本机」是同一条红线。代价是链接长一点、没有短码；换来的是零后端改动。
 *
 * ⚠️ 链接格式与网页端 `web/src/utils/shareCard.ts` 是**同一份约定的两处实现**
 *     （明文 query：`?n=&s=&l=&t=&d=`）。改字段两边一起改，别只动一处 ——
 *     顺手加了 base64 之类的编码就会各写一份，迟早漂移。
 */
import QRCode from "qrcode";

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
