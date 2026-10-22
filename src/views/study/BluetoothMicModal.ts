/**
 * 「这个麦克风采音会差一些」提示窗 —— 检测到用户**正在用蓝牙耳机录音**时问一句。
 *
 * ══ 为什么要有这一窗（2026-10-16 用户拍板）══════════════════════════════
 * 蓝牙耳机（AirPods）一旦被当作麦克风使用，整个蓝牙链路就被系统切到 **HFP 通话模式**：
 * 采样率从 48kHz 掉到 8/16kHz、单声道 —— 录出来明显发闷。**这是蓝牙协议的结构性限制**，
 * 插件改文件、改播放时机都救不回来（Windows 更狠：连放音通道一起降级）。
 *
 * 那插件该做什么？用户的答案是：**别替我优化，告诉我一声就行**。所以这一窗的全部职责是
 * **陈述事实 + 指一条路**，一个设备都不碰 —— 详见下面「三条纪律」。
 *
 * ══ 三条纪律（改这一窗前先读）═════════════════════════════════════════
 *   1. **不替用户挑设备**。曾落地过"录音自动避开蓝牙麦"（`pickBuiltInMicDeviceId` 那套），
 *      被用户明确否决：各用各的，用户自己决定的事插件别插手。所以这一窗只有"被告知 +
 *      自己决定"，**没有任何自动切换**。想换麦去系统设置里换，插件跟着走。
 *   2. **两个按钮都不强制**。主钮是「就用它录」—— 用户大概率就是这个意图（他已经点了
 *      开始录音）；次钮「先不录」= 取消**这一次**录音。插件不替他决定该不该继续。
 *   3. **关窗等于取消**（ESC / 点遮罩 / 点 ✕ 都算）：见 `onClose` ——
 *      不然 practices 那边会永远等在那里，麦克风也一直被占着。
 *
 * 壳走 `ui/dialog.ts` 的统一壳，别在这儿另写宽度/圆角。
 *
 * ⚠️ 图标名 `mic` 已在宿主的 lucide 集合里核实存在（同批核实：`headphones` / `bluetooth`
 *    都不在，别换成看着更贴题的那两个 —— 不在的图标会**静默不渲染**，只剩一块空白）。
 */
import { type App, Platform } from "obsidian";

import { DialogModal } from "../../ui/dialog";

export interface BluetoothMicModalOpts {
  /** 当前这支麦克风的设备名（`track.label`）；拿不到是空串 */
  deviceName: string;
  /** 实际采样率（Hz）；拿不到是 0 */
  sampleRate: number;
  /** 用户选了「就用它录」—— 照常开始这次录音 */
  onContinue: () => void;
  /**
   * 用户选了「先不录」，或**直接把窗关了**（ESC / 点遮罩 / ✕）——
   * 取消这一次录音，并**放开麦克风**（见 practices.releaseStream）。
   */
  onCancel: () => void;
}

/**
 * 各系统里「改输入设备」的位置 —— 告诉用户**去哪儿点**，而不是插件替他点。
 *
 * Windows 那句必须点名"免提 / Hands-Free"那条：同一副耳机在 Windows 上注册成两条设备，
 * 能录音的是带这名字的那条，想换成机子自己的麦克风就得避开它。
 */
function inputSettingPath(): string {
  if (Platform.isMacOS) return "系统设置 → 声音 → 输入，选「Mac 内置麦克风」";
  if (Platform.isWin) return "设置 → 系统 → 声音 → 输入，选机子自带的麦克风（别选带「免提 / Hands-Free」的那条）";
  return "系统的「声音 → 输入」设置，选本机自带的麦克风";
}

export class BluetoothMicModal extends DialogModal {
  /** 用户已经通过按钮 / 关窗给了答复 —— 保证两种关闭途径**只兑现一次** */
  private settled = false;

  constructor(
    app: App,
    private readonly opts: BluetoothMicModalOpts,
  ) {
    super(app);
  }

  onOpen(): void {
    const { body, foot } = this.buildShell({
      icon: "mic",
      title: "这支麦克风采音会差一些",
      // 设备名放副标题：它是"检测到你现在用的是哪个"的证据，不是正文的一部分
      subtitle: this.deviceLine(),
    });

    body.createEl("p", {
      text: "蓝牙耳机一旦要录音，整条蓝牙链路就会被系统切到「通话模式」：采样率从正常的 "
        + "48000Hz 掉到 16000Hz 甚至更低，录出来会明显发闷。这是蓝牙本身的限制，"
        + "跟耳机贵不贵没关系。",
      cls: "yl-lead",
    });
    body.createEl("p", {
      text: `想要更清楚的录音，建议改用机子自带的麦克风：${inputSettingPath()}。`,
      cls: "yl-lead",
    });

    this.fillFoot(
      foot,
      {
        // 主钮 = 继续录（用户已经点了「开始录音」，他的意图大概率就是这个）
        text: "就用它录",
        role: "primary",
        onClick: () => this.settle(this.opts.onContinue),
      },
      {
        // 副钮 = 取消这一次；不替用户改任何设置
        cancel: { text: "先不录", onClick: () => this.settle(this.opts.onCancel) },
      },
    );
  }

  onClose(): void {
    // ESC / 点遮罩 / 点 ✕ 都走到这里 —— 一律按「先不录」处理。
    // 漏了这一段，用户按 ESC 关窗后录音会永远停在"等你决定"，麦克风也不放。
    if (!this.settled) this.settle(this.opts.onCancel);
    super.onClose();
  }

  /** 兑现一次答复（先记账再关窗，避免 `onClose` 重复触发） */
  private settle(action: () => void): void {
    if (this.settled) return;
    this.settled = true;
    this.close();
    action();
  }

  /** 副标题那一行 —— 认不出名字时改成采样率那条证据，别写空值。 */
  private deviceLine(): string {
    const name = this.opts.deviceName.trim();
    if (name) return `检测到你现在用的是：${name}`;
    if (this.opts.sampleRate > 0) return `当前麦克风的采样率只有 ${this.opts.sampleRate}Hz`;
    return "当前麦克风像是蓝牙耳机";
  }
}
