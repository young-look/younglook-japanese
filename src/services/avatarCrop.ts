/**
 * 头像裁剪的**几何**—— 纯数学，不碰 DOM，所以能直接单测。
 *
 * ══ 模型（2026-10-15 用户拍板）══════════════════════════════════════════
 *  iOS 那套：**取景框钉在画布正中不动，用户缩放 / 拖动底下的图**
 *  （另一种「框在图上移」的做法会让框跑出图外，得多写一整套边界处理，
 *  而它们能选出来的区域完全一样）。
 *
 *  · 图片以 **cover** 的方式铺满画布（contain 会让非方图在框里露白边）；
 *  · 「导出区正好是整块画布」这件事不是靠算出来的，而是靠**把拖动范围钳死**：
 *    图片绘制尺寸恒 ≥ 画布，偏移量只能在 `[画布宽-绘制宽, 0]` 之间跑，
 *    于是画布永远被图盖满，框外面不可能出现空白；
 *  · 导出的一定是**正方形**（框是方的），圆形虚线只是给用户的视觉提示 ——
 *    服务端收到方图后那道居中裁方是恒等操作，仍然是幂等的兜底。
 *
 * @param stage 画布边长（CSS px）。也就是最终截出来那一块的边长。
 */
export interface CropSize {
  width: number;
  height: number;
}

/** 一次「怎么看」的完整描述：缩放 + 平移。渲染与导出都只认它。 */
export interface CropView {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** 导出时要用的一块**原图**区域（自然像素）。 */
export interface SourceRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** 导出尺寸：服务端最终缩到 200×200，这里留 2.56 倍余量给高分屏。 */
export const AVATAR_OUTPUT_SIZE = 512;

/** 滑块走到头时能放大的倍数（相对"刚好铺满"）。 */
const MAX_ZOOM_RATIO = 4;

/**
 * 「刚好铺满画布」要用多大的缩放 —— **取 max 而不是 min**。
 *
 * 取 min（contain）的话，一张 16:9 的图在任何缩放下都有一条窄边不足 320，
 * 裁剪框里就会出现两块没图的地方；用户拖拽时图上会跟着露出一角背景。
 */
export function fitScale(size: CropSize, stage: number): number {
  return Math.max(stage / size.width, stage / size.height);
}

export function minScale(size: CropSize, stage: number): number {
  return fitScale(size, stage);
}

export function maxScale(size: CropSize, stage: number): number {
  return fitScale(size, stage) * MAX_ZOOM_RATIO;
}

/** 滑块位置（0~100）→ 缩放值。乘性插值：拖前一半和拖后一半手感一致。 */
export function scaleFromSlider(size: CropSize, stage: number, slider: number): number {
  const t = clamp(slider, 0, 100) / 100;
  const lo = minScale(size, stage);
  const hi = maxScale(size, stage);
  return lo * Math.pow(hi / lo, t);
}

/** 缩放值 → 滑块位置（`scaleFromSlider` 的逆）。 */
export function sliderFromScale(size: CropSize, stage: number, scale: number): number {
  const lo = minScale(size, stage);
  const hi = maxScale(size, stage);
  const raw = Math.log(clamp(scale, lo, hi) / lo) / Math.log(hi / lo);
  return clamp(raw, 0, 1) * 100;
}

/** 图片在这个缩放下的绘制尺寸。cover 前提下恒 ≥ stage —— 见 `clampOffset`。 */
export function drawSize(size: CropSize, scale: number): CropSize {
  return { width: size.width * scale, height: size.height * scale };
}

/**
 * 把偏移钳回到「图片仍盖满画布」的范围内。
 *
 * 这是整个几何里唯一的一道**约束**，也是"框外不会露白"的全部来源：
 * 绘制尺寸 ≥ 画布 ⇒ 上限 0（图左上角不得跑到画布内部）、下限 `stage - 绘制`
 * （右下角不得跑到画布内部）。
 */
export function clampOffset(view: CropView, size: CropSize, stage: number): CropView {
  const drawn = drawSize(size, view.scale);
  return {
    scale: view.scale,
    offsetX: clamp(view.offsetX, stage - drawn.width, 0),
    offsetY: clamp(view.offsetY, stage - drawn.height, 0),
  };
}

/** 拖动：在现有偏移上加一个增量，再钳回去。 */
export function panBy(
  view: CropView,
  size: CropSize,
  stage: number,
  dx: number,
  dy: number,
): CropView {
  return clampOffset({ ...view, offsetX: view.offsetX + dx, offsetY: view.offsetY + dy }, size, stage);
}

/**
 * 以某个点为锚点缩放（滚轮 / 双指捏合）。
 *
 * 不看锚点的话，滚动时画面会以画布左上角为中心放大，用户指着的那处特征
 * （比如脸）会一路漂走。锚点不变的意思是：**缩放前后，鼠标底下那一点
 * 对应的仍然是图片上的同一个像素**。
 *
 * @param anchorX / anchorY 锚点相对**画布左上角**的位置（CSS px）
 */
export function zoomAt(
  view: CropView,
  size: CropSize,
  stage: number,
  nextScale: number,
  anchorX: number,
  anchorY: number,
): CropView {
  const lo = minScale(size, stage);
  const hi = maxScale(size, stage);
  const target = clamp(nextScale, lo, hi);
  // 要让「锚点在图片上的位置」缩放前后相等：
  //   (anchor - offset) / scale = const   ⇒   offset' = anchor - (anchor - offset)·ratio
  const ratio = target / view.scale;
  return clampOffset(
    {
      scale: target,
      offsetX: anchorX - (anchorX - view.offsetX) * ratio,
      offsetY: anchorY - (anchorY - view.offsetY) * ratio,
    },
    size,
    stage,
  );
}

/**
 * 当前画面对应的**原图**区域 —— 导出就截这一块。
 *
 * 逆推关系：画布左上角在屏幕上画的是 `-offset/scale` 处的图片像素，
 * 画布边长 stage 对应图上 `stage / scale` 个像素。
 */
export function sourceRect(view: CropView, stage: number): SourceRect {
  const side = stage / view.scale;
  return {
    sx: -view.offsetX / view.scale,
    sy: -view.offsetY / view.scale,
    sw: side,
    sh: side,
  };
}

/** 初始状态：刚好铺满 + 居中。 */
export function initialView(size: CropSize, stage: number): CropView {
  return centerView({ scale: fitScale(size, stage), offsetX: 0, offsetY: 0 }, size, stage);
}

/** 不改变缩放、把图居中（「重置」按钮用）。 */
export function centerView(view: CropView, size: CropSize, stage: number): CropView {
  const drawn = drawSize(size, view.scale);
  return clampOffset(
    { scale: view.scale, offsetX: (stage - drawn.width) / 2, offsetY: (stage - drawn.height) / 2 },
    size,
    stage,
  );
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.min(Math.max(value, lo), hi);
}
