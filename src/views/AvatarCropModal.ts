/**
 * 头像裁剪弹窗 —— 选好图片之后、上传之前的那一步。
 *
 * ══ 用户要的样子（2026-10-15 拍板）═════════════════════════════════════
 *   · **矩形实线框** = 真正会被保存的那一块（导出就是它）；
 *   · **圆形虚线** = 界面上真正看到的部分（框的内切圆）—— 提前告诉用户
 *     "四个角会被裁掉"，免得保存完才发现耳朵没了。
 *   两样画在同一张画布上。操作模型是 iOS 那套：**框钉在中间不动，
 *   缩放 / 拖动底下的图**（几何全部集中在 services/avatarCrop.ts）。
 *
 * ══ 为什么整个预览只用一张 canvas ════════════════════════════════════
 *   DOM 叠加层（一个 div 当遮罩、一个 div 画圆）要在 CSS 里处理
 *   `pointer-events: none`、明暗主题的边框色，还得跟图的缩放保持同步。
 *   画布里画就没有这些：遮罩用 evenodd 一次挖洞，边框色写死两遍
 *   （深色垫底 + 浅色压上）就同时适用于明暗两种主题。
 *
 * ══ 导出 ════════════════════════════════════════════════════════════
 *   永远导出**正方形**（框是方的），圆形只是提示。服务端那道居中裁方对方图
 *   是恒等运算，所以那条兜底不会因为前端先裁过就失效。
 */
import { Notice, setIcon, type App } from "obsidian";

import { DialogModal } from "../ui/dialog";
import { createButton } from "../ui/button";
import {
  AVATAR_OUTPUT_SIZE,
  centerView,
  clampOffset,
  drawSize,
  initialView,
  panBy,
  scaleFromSlider,
  sliderFromScale,
  sourceRect,
  zoomAt,
  type CropSize,
  type CropView,
} from "../services/avatarCrop";

/**
 * 画布边长（CSS px）。⚠️ **画布 ≠ 框**：框居中、比画布小一圈（见 FRAME），
 * 剩下的那圈是给「框外遮罩」和矩形描边站的地方 —— 框要是占满整块画布，
 * 描边就贴着边缘被圆角裁掉、遮罩没有面积可涂，用户会看不到"框"。
 */
const STAGE = 320;
/** 取景框边长（CSS px）。几何模块眼里的"画布"其实是它。 */
const CROP = 256;
/** 框在画布里的位置：居中，四周各留 (320-256)/2 = 32px。 */
const FRAME = { x: (STAGE - CROP) / 2, y: (STAGE - CROP) / 2, size: CROP };

/** 读图超时：图就在本机文件系统上，卡住的话多半是这个文件本身有问题。 */
const LOAD_TIMEOUT_MS = 15_000;

export interface AvatarCropResult {
  /** 裁好的方图，交给 `updateAvatar` 上传 */
  file: File;
  /**
   * 本地预览用（objectURL）。
   * ⚠️ 所有权**移交给调用方** —— 别在本弹窗关闭时 revoke 它，
   *    否则日记卡上的草稿预览会当场变成裂图。
   */
  previewUrl: string;
}

export interface AvatarCropOptions {
  onDone: (result: AvatarCropResult) => void;
}

export class AvatarCropModal extends DialogModal {
  private image: HTMLImageElement | null = null;
  private size: CropSize = { width: 1, height: 1 };
  private view: CropView = { scale: 1, offsetX: 0, offsetY: 0 };
  private canvasEl: HTMLCanvasElement | null = null;
  private sliderEl: HTMLInputElement | null = null;
  private footEl: HTMLElement | null = null;
  private note = "";
  private busy = false;
  /** Pointer Events 只给绝对坐标，所以要记着上一次的点，自己算增量。 */
  private dragging: { id: number; x: number; y: number } | null = null;
  /** 本弹窗自己造的 objectURL（预览 URL 不在里面 —— 它归调用方） */
  private ownedUrls: string[] = [];
  private loadTimer: number | null = null;

  constructor(
    app: App,
    private readonly source: File,
    private readonly options: AvatarCropOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    const { body, foot } = this.buildShell({
      // dialog.ts 里点名可用的图标之一（pencil / crop / image 都不在宿主 lucide 里）
      icon: "upload",
      title: "裁剪头像",
      subtitle: "方框内是保存的部分，圆形是界面上看到的部分",
      width: "wide",
    });
    this.footEl = foot;

    const stage = body.createDiv({ cls: "yl-crop-stage" });
    this.canvasEl = stage.createEl("canvas", {
      cls: "yl-crop-canvas",
      attr: {
        width: String(Math.round(STAGE * pixelRatio())),
        height: String(Math.round(STAGE * pixelRatio())),
        // 可聚焦 + application 角色：只用鼠标的话键盘用户就没法调位置了。
        // 画布没有语义，靠 aria-label 说出它是干什么的。
        tabindex: "0",
        role: "application",
        "aria-label": "头像裁剪框：拖动图片调整位置，按加减号缩放",
      },
    });
    this.canvasEl.style.width = `${STAGE}px`;
    this.canvasEl.style.height = `${STAGE}px`;

    const zoomRow = body.createDiv({ cls: "yl-crop-zoom" });
    setIcon(zoomRow.createSpan({ cls: "yl-crop-zoom-icon" }), "minus");
    this.sliderEl = zoomRow.createEl("input", {
      type: "range",
      cls: "yl-crop-slider",
      attr: { min: "0", max: "100", step: "0.5", "aria-label": "缩放" },
    });
    setIcon(zoomRow.createSpan({ cls: "yl-crop-zoom-icon" }), "plus");

    this.bindCanvas(this.canvasEl);
    this.sliderEl.addEventListener("input", () => {
      if (!this.image) return;
      // 滑块没有锚点，以框中心为准（几何的坐标系原点在框左上角，见 FRAME 注释）
      this.view = zoomAt(
        this.view, this.size, CROP,
        scaleFromSlider(this.size, CROP, Number(this.sliderEl?.value ?? 0)),
        CROP / 2, CROP / 2,
      );
      this.paint();
    });

    this.renderFoot();
    void this.load();
  }

  /** 收尾钩子。**别去覆盖 `onClose`** —— 那会把壳体清理 CSS 类名的活一起吃掉。 */
  onBeforeClose(): void {
    if (this.loadTimer !== null) window.clearTimeout(this.loadTimer);
    this.loadTimer = null;
    for (const url of this.ownedUrls) URL.revokeObjectURL(url);
    this.ownedUrls = [];
    this.image = null;
  }

  // ── 交互 ──────────────────────────────────────────────────────────────

  private bindCanvas(canvas: HTMLCanvasElement): void {
    canvas.addEventListener("pointerdown", (event) => {
      if (!this.image) return;
      canvas.setPointerCapture(event.pointerId);
      this.dragging = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.addClass("is-dragging");
    });
    canvas.addEventListener("pointermove", (event) => {
      const drag = this.dragging;
      if (!drag || drag.id !== event.pointerId) return;
      // 触屏上 `movementX/Y` 常常是 0 —— 只信绝对坐标，增量自己减。
      // 拖动增量是位移差，两个坐标系里一样；stage 传的是框（CROP）。
      this.view = panBy(
        this.view, this.size, CROP, event.clientX - drag.x, event.clientY - drag.y,
      );
      drag.x = event.clientX;
      drag.y = event.clientY;
      this.paint();
    });
    const endDrag = (event: PointerEvent): void => {
      if (!this.dragging || this.dragging.id !== event.pointerId) return;
      this.dragging = null;
      canvas.removeClass("is-dragging");
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    canvas.addEventListener(
      "wheel",
      (event: WheelEvent) => {
        if (!this.image) return;
        // { passive: false } 不能省：wheel / touchmove 在多数浏览器里默认是
        // passive 的，那样 preventDefault 会失效，整页跟着滚轮滚。
        event.preventDefault();
        const box = canvas.getBoundingClientRect();
        // 鼠标坐标是画布系的；几何的锚点要框系的 —— 减掉框在画布里的偏移
        this.view = zoomAt(
          this.view, this.size, CROP,
          this.view.scale * Math.pow(0.999, event.deltaY),
          event.clientX - box.left - FRAME.x, event.clientY - box.top - FRAME.y,
        );
        this.paint();
        this.syncSlider();
      },
      { passive: false },
    );

    canvas.addEventListener("keydown", (event: KeyboardEvent) => {
      if (!this.image) return;
      const step = event.shiftKey ? 24 : 8;
      let handled = true;
      switch (event.key) {
        case "ArrowLeft":
          this.view = panBy(this.view, this.size, CROP, step, 0);
          break;
        case "ArrowRight":
          this.view = panBy(this.view, this.size, CROP, -step, 0);
          break;
        case "ArrowUp":
          this.view = panBy(this.view, this.size, CROP, 0, step);
          break;
        case "ArrowDown":
          this.view = panBy(this.view, this.size, CROP, 0, -step);
          break;
        case "+":
        case "=":
          this.view = zoomAt(this.view, this.size, CROP, this.view.scale * 1.1, CROP / 2, CROP / 2);
          break;
        case "-":
          this.view = zoomAt(this.view, this.size, CROP, this.view.scale / 1.1, CROP / 2, CROP / 2);
          break;
        default:
          handled = false;
      }
      if (!handled) return;
      event.preventDefault();
      this.paint();
      this.syncSlider();
    });
  }

  // ── 读图 ──────────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    const url = URL.createObjectURL(this.source);
    this.ownedUrls.push(url);
    const image = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        this.loadTimer = window.setTimeout(() => reject(new Error("读图超时")), LOAD_TIMEOUT_MS);
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("这个文件不是能打开的图片"));
        image.src = url;
      });
    } catch (error) {
      this.note = error instanceof Error ? error.message : "图片读不出来";
      // 读不出来就更要让局面停在"能关窗"：确定钮置灰，别把人卡在一张空画布前面。
      this.renderFoot();
      return;
    }
    if (this.loadTimer !== null) window.clearTimeout(this.loadTimer);
    this.loadTimer = null;
    this.image = image;
    this.size = { width: image.naturalWidth, height: image.naturalHeight };
    this.view = initialView(this.size, CROP);
    this.syncSlider();
    this.paint();
    this.renderFoot();
  }

  // ── 画 ────────────────────────────────────────────────────────────────

  /**
   * 四层一次画完：图 → 框外遮罩 → 矩形实线 → 内切圆虚线。
   *
   * ⚠️ `setLineDash` 是**上下文状态**：不复位的话下一次 `stroke` 会接着走虚线，
   *    实线框会莫名变成虚的，而且没有任何报错。
   */
  private paint(): void {
    const canvas = this.canvasEl;
    const image = this.image;
    if (!canvas || !image) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const ratio = pixelRatio();
    // backing store 按 dpr 放大，之后一律按 CSS px 落笔（否则 Retina 上会糊）
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, STAGE, STAGE);

    const drawn = drawSize(this.size, this.view.scale);
    // ⚠️ 几何算出的 offset 是**框系**的（框左上角 = 原点）；画到画布上要加框偏移。
    //    漏掉这一步的话图会画到左上角去，框里看到的就不是用户框的那块。
    ctx.drawImage(image, FRAME.x + this.view.offsetX, FRAME.y + this.view.offsetY, drawn.width, drawn.height);

    // 遮罩：先铺满整块，再用 evenodd 把中间的框挖空
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.beginPath();
    ctx.rect(0, 0, STAGE, STAGE);
    ctx.rect(FRAME.x, FRAME.y, FRAME.size, FRAME.size);
    ctx.fill("evenodd");

    // 主题无关的描边：一层深色垫底 + 一层浅色压上，明暗底上都看得见
    ctx.setLineDash([]);
    strokeFrame(ctx, "rgba(0, 0, 0, 0.35)", 3);
    strokeFrame(ctx, "rgba(255, 255, 255, 0.92)", 1.5);

    ctx.setLineDash([6, 5]);
    strokeCircle(ctx, "rgba(0, 0, 0, 0.35)", 2);
    strokeCircle(ctx, "rgba(255, 255, 255, 0.92)", 1.2);
    ctx.setLineDash([]);
  }

  private syncSlider(): void {
    if (!this.sliderEl) return;
    this.sliderEl.value = String(sliderFromScale(this.size, CROP, this.view.scale));
  }

  // ── 底栏 ──────────────────────────────────────────────────────────────

  private renderFoot(): void {
    const foot = this.footEl;
    if (!foot) return;
    this.fillFoot(
      foot,
      {
        text: this.busy ? "处理中…" : "确定",
        role: "primary",
        disabled: this.busy || !this.image,
        onClick: () => void this.commit(),
      },
      { cancel: { text: "取消" }, note: this.note },
    );
    // 「重置」是第三颗钮，壳体的 fillFoot 只管两颗 —— 自己排进去。
    // 底栏是居中一排、写入顺序即左右顺序，所以它在最左边。
    const resetEl = createButton(foot, {
      text: "重置",
      disabled: !this.image,
      onClick: () => this.reset(),
    });
    foot.prepend(resetEl);
  }

  private reset(): void {
    if (!this.image) return;
    this.view = centerView(initialView(this.size, CROP), this.size, CROP);
    this.syncSlider();
    this.paint();
  }

  // ── 导出 ──────────────────────────────────────────────────────────────

  private async commit(): Promise<void> {
    const image = this.image;
    if (!image || this.busy) return;
    // 导出前再钳一次：几何本身是钳过的，但这里兜住任何 bypass（比如调用方
    // 直接改过 view）。成本是一次乘法，不值得省。stage 用框（CROP）——
    // 导出的就是框里那块，不是整块画布。
    const view = clampOffset(this.view, this.size, CROP);
    this.busy = true;
    this.note = "";
    this.renderFoot();
    try {
      const rect = sourceRect(view, CROP);
      const out = document.createElement("canvas");
      out.width = AVATAR_OUTPUT_SIZE;
      out.height = AVATAR_OUTPUT_SIZE;
      const ctx = out.getContext("2d");
      if (!ctx) throw new Error("这台设备上开不了画布");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(
        image, rect.sx, rect.sy, rect.sw, rect.sh,
        0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE,
      );
      const blob = await toBlob(out);
      const stem = this.source.name.replace(/\.[^.]+$/u, "") || "avatar";
      const ext = blob.type === "image/webp" ? "webp" : "png";
      const file = new File([blob], `${stem}-avatar.${ext}`, { type: blob.type });
      const previewUrl = URL.createObjectURL(blob);
      // ⚠️ 这张 URL **不记进 ownedUrls**：移交调用方，由它决定什么时候回收。
      this.close();
      this.options.onDone({ file, previewUrl });
    } catch (error) {
      this.note = error instanceof Error ? error.message : "没能导出这张图";
      new Notice(this.note);
      this.busy = false;
      this.renderFoot();
    }
  }
}

function strokeFrame(ctx: CanvasRenderingContext2D, color: string, width: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.strokeRect(FRAME.x, FRAME.y, FRAME.size, FRAME.size);
}

function strokeCircle(ctx: CanvasRenderingContext2D, color: string, width: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(STAGE / 2, STAGE / 2, FRAME.size / 2, 0, Math.PI * 2);
  ctx.stroke();
}

function pixelRatio(): number {
  // Electron 上通常是 1 或 2；无头环境可能拿到 0 / NaN —— 那样 canvas 会以 0
  // 尺寸被创建出来，画上去什么都不见。退成 1。
  const ratio = window.devicePixelRatio || 1;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/**
 * `canvas.toBlob` 的 Promise 包装，顺带做 WebP → PNG 回退。
 *
 * ⚠️ 说不支持 WebP 的环境会**静默给你一张 PNG**，所以必须看结果的 `blob.type`，
 *    不能假定"要什么就得到什么"。
 * ⚠️ 不要用 `toDataURL`：大图的 base64 是几百 KB 的字符串，慢又吃内存。
 */
async function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const webp = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/webp", 0.92);
  });
  if (webp && webp.type === "image/webp") return webp;
  const png = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (!png) throw new Error("这台设备上导不出图片");
  return png;
}
