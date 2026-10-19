import { afterEach, describe, expect, it } from "vitest";
import { cueSeconds, cueTones, playRecordingCue } from "../src/services/audioCues";

/**
 * 录音提示音（2026-10-19 加）。
 *
 * 钉这些是因为它们坏了**不报错、只是功能悄悄没了或者悄悄变糟**：
 *  · 方向反了（开场下行、收场上行）→ 耳朵分不出是"要开始了"还是"结束了"，
 *    提示音等于白给；
 *  · 开场音没等播完就开录 → 提示音被录进这一遍，**落在第一个词头上** ——
 *    那正是发音评估最容易判歪的位置（真机：整句 88、只有首词被压到 34）；
 *  · 放不出声时卡住流程 → 录音这主流程被一个锦上添花的东西挡下来。
 */
describe("录音提示音 · 音的设计", () => {
  it("开场是上行、收场是下行 —— 方向本身就是信息（苹果那套的模子）", () => {
    const start = cueTones("start");
    const stop = cueTones("stop");
    expect(start[1].freq).toBeGreaterThan(start[0].freq);
    expect(stop[1].freq).toBeLessThan(stop[0].freq);
  });

  it("两音不重叠（听得出是两声），整串短到不拖沓（0.15~0.35 秒）", () => {
    for (const kind of ["start", "stop"] as const) {
      const [first, second] = cueTones(kind);
      expect(second.at).toBeGreaterThanOrEqual(first.at + first.dur);
      // 太短听着像杂音，太长就成了"等提示音"（0.15~0.35 秒这段是听感上最舒服的）
      const total = cueSeconds(kind);
      expect(total).toBeGreaterThan(0.15);
      expect(total).toBeLessThan(0.35);
    }
  });

  it("音高落在中高音区（400~1200Hz）：不刺耳，也不至于闷到听不见", () => {
    for (const tone of [...cueTones("start"), ...cueTones("stop")]) {
      expect(tone.freq).toBeGreaterThan(400);
      expect(tone.freq).toBeLessThan(1200);
    }
  });
});

// ── 播放契约 ─────────────────────────────────────────────────────────────

class FakeParam {
  setValueAtTime(): void {}
  exponentialRampToValueAtTime(): void {}
}

class FakeOsc {
  type = "sine";
  frequency = new FakeParam();
  startedAt = -1;
  stoppedAt = -1;
  connect(): void {}
  start(at: number): void {
    this.startedAt = at;
  }
  stop(at: number): void {
    this.stoppedAt = at;
  }
}

/** 装一个假 AudioContext，把排出去的音都记下来。 */
function installFakeAudioContext(): FakeOsc[] {
  const oscs: FakeOsc[] = [];
  class FakeAudioContext {
    state = "running";
    currentTime = 0;
    destination = {};
    createOscillator(): FakeOsc {
      const osc = new FakeOsc();
      oscs.push(osc);
      return osc;
    }
    createGain(): { gain: FakeParam; connect(): void } {
      return { gain: new FakeParam(), connect: () => undefined };
    }
    resume(): Promise<void> {
      return Promise.resolve();
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  }
  (globalThis as unknown as Record<string, unknown>).AudioContext = FakeAudioContext;
  return oscs;
}

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).AudioContext;
});

describe("录音提示音 · 播放契约", () => {
  it("没有 AudioContext（不支持的环境）→ 立即放行：**提示音不许把录音卡住**", async () => {
    const before = Date.now();
    await expect(playRecordingCue("start")).resolves.toBeUndefined();
    expect(Date.now() - before).toBeLessThan(100);
  });

  it("有 AudioContext → **等声音播完**才兑现（开场音不许被录进第一句话）", async () => {
    const oscs = installFakeAudioContext();
    const before = Date.now();
    await playRecordingCue("start");
    const elapsed = Date.now() - before;

    // 两个音都排了，且第二个排在第一个之后
    expect(oscs).toHaveLength(2);
    expect(oscs[0].startedAt).toBeGreaterThanOrEqual(0);
    expect(oscs[1].startedAt).toBeGreaterThan(oscs[0].startedAt);
    // 音本身 ~0.2 秒 + 蓝牙输出延迟的余量 → 兑现时刻必须晚于音结束（300ms 是下限）
    expect(elapsed).toBeGreaterThanOrEqual(300);
  });
});
