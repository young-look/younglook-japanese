/**
 * 头像裁剪的几何用例。
 *
 * 这块是全组件唯一值得测的地方 —— DOM 部分靠肉眼，几何错了却是**静默的**：
 * 画面看着没问题，导出来的图偏了几十像素、或者四角带着一块空白背景，
 * 而这些恰好是用户能一眼看出的质量问题。
 *
 * 守三件事：
 *   · 图片永远盖满画布（cover）—— 框外绝不会露出背景；
 *   · 逆推出来的源区永远落在图片的真实边界内；
 *   · 缩放有锚点 —— 滚轮放大时鼠标底下那一点不跑。
 */
import { describe, expect, it } from "vitest";
import {
  AVATAR_OUTPUT_SIZE,
  centerView,
  clampOffset,
  drawSize,
  fitScale,
  initialView,
  maxScale,
  minScale,
  panBy,
  scaleFromSlider,
  sliderFromScale,
  sourceRect,
  zoomAt,
  type CropSize,
  type CropView,
} from "../src/services/avatarCrop";

const STAGE = 320;
/** 一张横图、一张竖图：cover 的两条分支都得走到 */
const WIDE: CropSize = { width: 1600, height: 900 };
const TALL: CropSize = { width: 900, height: 1600 };

const EPS = 1e-9;

describe("铺满画布（cover）", () => {
  it("横图按高度算缩放，短边刚好等于画布", () => {
    const scale = fitScale(WIDE, STAGE);
    expect(scale * WIDE.height).toBeCloseTo(STAGE, 6);
    expect(scale * WIDE.width).toBeGreaterThan(STAGE);
  });

  it("竖图按宽度算缩放，短边刚好等于画布", () => {
    const scale = fitScale(TALL, STAGE);
    expect(scale * TALL.width).toBeCloseTo(STAGE, 6);
    expect(scale * TALL.height).toBeGreaterThan(STAGE);
  });

  it("初始视图：铺满并居中（initialView）", () => {
    const view = initialView(WIDE, STAGE);
    expect(view.scale).toBeCloseTo(fitScale(WIDE, STAGE), 6);
    const drawn = drawSize(WIDE, view.scale);
    // 居中 = 多出来的那部分平均分在两边
    expect(view.offsetX).toBeCloseTo((STAGE - drawn.width) / 2, 6);
    expect(view.offsetY).toBeCloseTo((STAGE - drawn.height) / 2, 6);
  });
});

describe("拖动边界：画布永远被图盖满", () => {
  it("往右下拖会被钳回 0（图左上角不许进画布）", () => {
    const view = clampOffset({ scale: 1, offsetX: 500, offsetY: 500 }, WIDE, STAGE);
    expect(view.offsetX).toBe(0);
    expect(view.offsetY).toBe(0);
  });

  it("往左上拖到底也露不出边（图右下角不许进画布）", () => {
    const start = initialView(WIDE, STAGE);
    const drawn = drawSize(WIDE, start.scale);
    const view = clampOffset({ scale: start.scale, offsetX: -99999, offsetY: -99999 }, WIDE, STAGE);
    expect(view.offsetX).toBeCloseTo(STAGE - drawn.width, 6);
    expect(view.offsetY).toBeCloseTo(STAGE - drawn.height, 6);
    // 换句话说：offset + 绘制尺寸 ≥ 画布 —— 覆盖关系成立
    expect(view.offsetX + drawn.width).toBeGreaterThanOrEqual(STAGE - EPS);
    expect(view.offsetY + drawn.height).toBeGreaterThanOrEqual(STAGE - EPS);
  });

  it("连续乱拖一通之后依然盖得住（一百次随机拖拽）", () => {
    let view: CropView = initialView(TALL, STAGE);
    let seed = 20261015;
    for (let i = 0; i < 100; i++) {
      // 线性同余，省得去 mock Math.random
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const dx = (seed % 400) - 200;
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const dy = (seed % 400) - 200;
      view = panBy(view, TALL, STAGE, dx, dy);
      const drawn = drawSize(TALL, view.scale);
      expect(view.offsetX).toBeLessThanOrEqual(EPS);
      expect(view.offsetY).toBeLessThanOrEqual(EPS);
      expect(view.offsetX + drawn.width).toBeGreaterThanOrEqual(STAGE - EPS);
      expect(view.offsetY + drawn.height).toBeGreaterThanOrEqual(STAGE - EPS);
    }
  });
});

describe("源区逆推", () => {
  it("铺满居中时截的是正中间那块正方形", () => {
    const view = initialView(WIDE, STAGE);
    const rect = sourceRect(view, STAGE);
    // 方图边长 = 短边；位置居中
    expect(rect.sw).toBeCloseTo(WIDE.height, 6);
    expect(rect.sh).toBeCloseTo(rect.sw, 6);
    expect(rect.sx + rect.sw / 2).toBeCloseTo(WIDE.width / 2, 6);
    expect(rect.sy + rect.sh / 2).toBeCloseTo(WIDE.height / 2, 6);
  });

  it("源区永远落在图片真实边界内（含拖到极端时）", () => {
    const start = initialView(WIDE, STAGE);
    for (const scale of [minScale(WIDE, STAGE), fitScale(WIDE, STAGE) * 2, maxScale(WIDE, STAGE)]) {
      for (const [ox, oy] of [[0, 0], [-99999, 0], [0, -99999], [-99999, -99999], [99999, 99999]]) {
        const view = clampOffset({ scale, offsetX: ox, offsetY: oy }, WIDE, STAGE);
        const rect = sourceRect(view, STAGE);
        expect(rect.sx).toBeGreaterThanOrEqual(-EPS);
        expect(rect.sy).toBeGreaterThanOrEqual(-EPS);
        expect(rect.sx + rect.sw).toBeLessThanOrEqual(WIDE.width + EPS);
        expect(rect.sy + rect.sh).toBeLessThanOrEqual(WIDE.height + EPS);
      }
    }
    expect(start.scale).toBeGreaterThan(0);
  });

  it("放大后截的是更小的区域（缩放生效）", () => {
    const base = initialView(WIDE, STAGE);
    const zoomed = zoomAt(base, WIDE, STAGE, base.scale * 3, STAGE / 2, STAGE / 2);
    expect(sourceRect(zoomed, STAGE).sw).toBeLessThan(sourceRect(base, STAGE).sw);
  });
});

describe("缩放", () => {
  it("以鼠标为锚点：那一点底下的图片像素不变", () => {
    const base = initialView(WIDE, STAGE);
    const anchorX = 120;
    const anchorY = 210;
    const zoomed = zoomAt(base, WIDE, STAGE, base.scale * 2.5, anchorX, anchorY);

    // 屏幕上同一坐标 → 图上的同一个像素
    const pixelBefore = { x: (anchorX - base.offsetX) / base.scale, y: (anchorY - base.offsetY) / base.scale };
    const pixelAfter = { x: (anchorX - zoomed.offsetX) / zoomed.scale, y: (anchorY - zoomed.offsetY) / zoomed.scale };
    expect(pixelAfter.x).toBeCloseTo(pixelBefore.x, 6);
    expect(pixelAfter.y).toBeCloseTo(pixelBefore.y, 6);
  });

  it("缩放夹在[刚好铺满, 四倍]之间，超出只是被夹住", () => {
    const base = initialView(WIDE, STAGE);
    const lo = minScale(WIDE, STAGE);
    const hi = maxScale(WIDE, STAGE);
    const tooSmall = zoomAt(base, WIDE, STAGE, 0.0001, STAGE / 2, STAGE / 2);
    expect(tooSmall.scale).toBeCloseTo(lo, 6);
    const tooBig = zoomAt(base, WIDE, STAGE, 9999, STAGE / 2, STAGE / 2);
    expect(tooBig.scale).toBeCloseTo(hi, 6);
    expect(hi / lo).toBeCloseTo(4, 6);
  });

  it("滑块两端对应最小/最大缩放，并与缩放值互为逆运算", () => {
    expect(scaleFromSlider(WIDE, STAGE, 0)).toBeCloseTo(minScale(WIDE, STAGE), 6);
    expect(scaleFromSlider(WIDE, STAGE, 100)).toBeCloseTo(maxScale(WIDE, STAGE), 6);
    const mid = scaleFromSlider(WIDE, STAGE, 50);
    expect(sliderFromScale(WIDE, STAGE, mid)).toBeCloseTo(50, 6);
    // 越界的手写值也要夹住
    expect(sliderFromScale(WIDE, STAGE, 1e9)).toBeCloseTo(100, 6);
  });
});

describe("居中与输出", () => {
  it("centerView 保持缩放、把图拖回中心", () => {
    // 横图纵向就会 tailor 到边界上（height 正好等于画布），可动的是横向 ——
    // 这才是要看的方向。
    const base = initialView(WIDE, STAGE);
    const dragged = panBy(base, WIDE, STAGE, -25, 0);
    expect(dragged.offsetX).not.toBeCloseTo(base.offsetX, 3);
    const centered = centerView(dragged, WIDE, STAGE);
    expect(centered.scale).toBeCloseTo(dragged.scale, 9);
    expect(centered.offsetX).toBeCloseTo(base.offsetX, 6);
  });

  it("拖到底之外再居中，也回得到正确位置", () => {
    const wild = panBy(initialView(TALL, STAGE), TALL, STAGE, 0, -99999);
    const centered = centerView(wild, TALL, STAGE);
    expect(centered.offsetY).toBeCloseTo(initialView(TALL, STAGE).offsetY, 6);
  });

  it("导出尺寸够 200×200 的服务端成品用", () => {
    // 服务端最后 resize 到 200 —— 2.5 倍以上是高分屏不糊的下限
    expect(AVATAR_OUTPUT_SIZE).toBeGreaterThanOrEqual(200 * 2.5);
  });
});
