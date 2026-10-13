import { describe, expect, it } from "vitest";
import {
  KEEP_MARGIN_SECONDS,
  MIN_TRIM_SECONDS,
  findSilenceBounds,
  trimRecording,
  trimSupported,
} from "../src/services/audioTrim";

/**
 * 首尾空白探测与裁剪的硬规则。
 *
 * 钉这几条是因为它们坏了**不报错** —— 录音照旧能存能播，只是安静地剪错：
 *   · 余量被改小 → 削掉用户读的起音（唯一会招投诉的那种错）；
 *   · 判定线退化成"底噪 × 单一倍数"或写死绝对值 → 头尾底噪一不一样就判反：
 *     尾巴永远剪不掉（倍数太低），或者反过来把轻声当空白剪掉（倍数太高）；
 *   · 门槛被去掉 → 0.2 秒的空白也剪，收益抵不上风险；
 *   · 只剪一端判成两端 → 结尾那截被吃掉，听着像话没说完。
 *
 * 造样本的方式：**底噪 + 有声段**。底噪给恒定小值，有声段给正弦，
 * 静音段就是底噪本身——跟真实录音的底噪形态一致。
 */

const RATE = 48000;

/** 造一段 PCM：每段给"底噪幅值"或"有声幅值"。 */
function makePcm(parts: Array<{ seconds: number; amp: number }>): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.seconds, 0);
  const out = new Float32Array(Math.round(total * RATE));
  let offset = 0;
  for (const part of parts) {
    const count = Math.round(part.seconds * RATE);
    for (let i = 0; i < count; i += 1) {
      // 有声段用 440Hz 正弦，底噪用 0.6 倍频的抖动 —— 两者频谱不同但能量差 40dB 以上
      const phase = (2 * Math.PI * 440 * i) / RATE;
      out[offset + i] =
        part.amp > 0.02
          ? part.amp * Math.sin(phase)
          : part.amp * Math.sin(phase * 0.6) * (i % 2 === 0 ? 1 : -1);
    }
    offset += count;
  }
  return out;
}

const QUIET = 0.001; // 底噪
const LOUD = 0.3; // 说话

describe("跟读 · 首尾空白探测", () => {
  it("两头都剪，且切点留够余量", () => {
    // 3 秒空白 + 4 秒说话 + 2 秒空白
    const pcm = makePcm([
      { seconds: 3, amp: QUIET },
      { seconds: 4, amp: LOUD },
      { seconds: 2, amp: QUIET },
    ]);
    const bounds = findSilenceBounds(pcm, RATE);
    expect(bounds).not.toBeNull();
    // 3 秒空白扣掉 0.2 秒余量
    expect(bounds!.lead).toBeCloseTo(3 - KEEP_MARGIN_SECONDS, 1);
    expect(bounds!.tail).toBeCloseTo(2 - KEEP_MARGIN_SECONDS, 1);
  });

  it("绝不把说话的部分算进空白里 —— 余量是硬保证", () => {
    // 3 秒空白 + 4 秒说话 + 2 秒空白；有声段必须完整落在 [lead, 9-lead] 之间
    const pcm = makePcm([
      { seconds: 3, amp: QUIET },
      { seconds: 4, amp: LOUD },
      { seconds: 2, amp: QUIET },
    ]);
    const bounds = findSilenceBounds(pcm, RATE)!;
    const total = 9;
    // 跳完剩下的区间必须**完全包含**真正的有声段 [3, 7]
    expect(bounds.lead).toBeLessThanOrEqual(3);
    expect(total - bounds.tail).toBeGreaterThanOrEqual(7);
  });

  it("空白不够长就整段不剪（省下的时间抵不上风险）", () => {
    // 0.3 秒空白（< MIN_TRIM_SECONDS 0.5）
    const pcm = makePcm([
      { seconds: 0.3, amp: QUIET },
      { seconds: 4, amp: LOUD },
      { seconds: 0.3, amp: QUIET },
    ]);
    expect(findSilenceBounds(pcm, RATE)).toEqual({ lead: 0, tail: 0 });
  });

  it("只剪够长的那一头，不连坐另一头", () => {
    // 开头 3 秒空白够长，结尾 0.2 秒不够长 → 只剪开头
    const pcm = makePcm([
      { seconds: 3, amp: QUIET },
      { seconds: 4, amp: LOUD },
      { seconds: 0.2, amp: QUIET },
    ]);
    const bounds = findSilenceBounds(pcm, RATE)!;
    expect(bounds.lead).toBeGreaterThan(2);
    expect(bounds.tail).toBe(0);
  });

  it("从头到尾都在说话 → 判不出边界，返回 null（等价于一秒都不剪）", () => {
    // 全程有声 ⇒ 10 分位"底噪"也落在说话上 ⇒ 找不到安静段，判定为"判不出来"。
    // 这是安全默认：宁可整段不剪，也不去猜一个可能切到字的边界。
    expect(findSilenceBounds(makePcm([{ seconds: 4, amp: LOUD }]), RATE)).toBeNull();
  });

  it("整段静音 / 全是噪声 → 判不出来，返回 null（而不是当成大段空白）", () => {
    // 全程底噪：没有"有声段"可找
    expect(findSilenceBounds(makePcm([{ seconds: 5, amp: QUIET }]), RATE)).toBeNull();
  });

  it("太短的录音不判（< 1 秒）", () => {
    expect(findSilenceBounds(makePcm([{ seconds: 0.5, amp: LOUD }]), RATE)).toBeNull();
  });

  it("阈值跟着底噪走 —— 底噪抬高一档，剪出来的量跟着变", () => {
    // 同样的结构，只把底噪放大到 8 倍：分位底噪抬高 → 判定跟着调整
    const shape = (floorAmp: number) =>
      makePcm([
        { seconds: 3, amp: floorAmp },
        { seconds: 4, amp: LOUD },
        { seconds: 2, amp: floorAmp },
      ]);
    const quiet = findSilenceBounds(shape(QUIET), RATE)!;
    const noisy = findSilenceBounds(shape(QUIET * 8), RATE)!;
    // 有声段 40dB 于底噪，两种底噪下都应稳定找到同一个有声段
    expect(quiet.lead).toBeCloseTo(noisy.lead, 1);
    expect(quiet.tail).toBeCloseTo(noisy.tail, 1);
  });

  it("尾部底噪比开头高一截时，尾巴照样要剪掉 —— 真机录音的常态", () => {
    // 开头是用户屏息等着的（底噪 0.0012），结尾是读完那口气、手去够停止键（底噪 0.005）：
    // 真机录音里尾部"安静"常比开头吵三四倍。
    //
    // ⚠️ 这条是回归用例。早先判定线是 `max(底噪×3, 0.004)`：
    // 尾部 0.005 一乘就过了线 → lastLoud 钉在最后一帧 → tail 算成负数 → **一帧都不剪**，
    // 而头部照剪不误。用户看到的是「开头切掉了，尾巴没切」，
    // 整个过程**不报错**，只是安静地把拖的那截尾巴留着（2026-10-03 实报）。
    const pcm = makePcm([
      { seconds: 3, amp: 0.0012 },
      { seconds: 3, amp: LOUD },
      { seconds: 3, amp: 0.005 },
    ]);
    const bounds = findSilenceBounds(pcm, RATE)!;
    expect(bounds.lead).toBeCloseTo(3 - KEEP_MARGIN_SECONDS, 1);
    expect(bounds.tail).toBeCloseTo(3 - KEEP_MARGIN_SECONDS, 1);
  });

  it("尾部底噪再高些（0.006）也还剪得动", () => {
    const pcm = makePcm([
      { seconds: 2, amp: 0.0012 },
      { seconds: 3, amp: LOUD },
      { seconds: 5, amp: 0.006 },
    ]);
    const bounds = findSilenceBounds(pcm, RATE)!;
    expect(bounds.lead).toBeCloseTo(2 - KEEP_MARGIN_SECONDS, 1);
    expect(bounds.tail).toBeCloseTo(5 - KEEP_MARGIN_SECONDS, 1);
  });

  it("说到最后一个字才停 → 尾巴一秒都不剪（宁可少剪，不可剪到字上）", () => {
    // 反向保护：判定线变宽松之后，绝不能把"还没说完"的尾巴当成空白。
    const pcm = makePcm([
      { seconds: 1, amp: QUIET },
      { seconds: 6, amp: LOUD },
    ]);
    const bounds = findSilenceBounds(pcm, RATE)!;
    expect(bounds.lead).toBeCloseTo(1 - KEEP_MARGIN_SECONDS, 1);
    expect(bounds.tail).toBe(0);
  });

  it("常量本身没被改坏", () => {
    expect(KEEP_MARGIN_SECONDS).toBe(0.2);
    expect(MIN_TRIM_SECONDS).toBe(0.5);
  });
});

/**
 * `trimRecording` 的对外契约。
 *
 * 这里**只验"剪不出来时怎么办"**，不验真的剪 —— 那要重编码，只有真浏览器里有
 * `AudioEncoder`（测试环境没有，正好可以拿它验降级路径）。
 * 真正的端到端裁剪另有一条真 Chromium 的探针（temp/rec-e2e-probe.mjs）。
 *
 * 钉的是那条最要命的契约：**裁剪失败绝不能把录音流程打断**。
 * 它一旦抛出去，用户点完「停下」会看到一段红字、录音没了 —— 而裁剪本来只是锦上添花。
 */
describe("跟读 · 裁剪失败时的降级", () => {
  it("环境不支持时不抛，返回 blob: null 让调用方用原文件", async () => {
    expect(trimSupported()).toBe(false);
    const raw = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
    const result = await trimRecording(raw);
    expect(result.blob).toBeNull();
    expect(result.removed).toBe(0);
  });

  it("喂一坨解不开的垃圾也不抛 —— 解不出来就当没得剪", async () => {
    const junk = new Blob([new Uint8Array([0xff, 0x00, 0x13, 0x37])], { type: "audio/webm" });
    // `trimSupported()` 为假时会直接短路返回，这条断言仍然成立；
    // 它真正防的是"将来支持了、但解码失败"那一刻不许把异常漏出去。
    await expect(trimRecording(junk)).resolves.toEqual({ blob: null, seconds: 0, removed: 0 });
  });
});
