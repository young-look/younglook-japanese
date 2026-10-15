import { describe, expect, it } from "vitest";
import { inspectMicInput, micConstraints } from "../src/services/micCapture";

/**
 * 取麦克风的约束。
 *
 * 这里守的是一条**实测换来的**规则：只写 `{ audio: true }` 时浏览器默认开自动增益，
 * 录出来的音量会被按时间改写（回听着像"越来越小"），所以三个处理必须显式关掉。
 * 反过来，约束也不能写 `exact` —— 不支持的设备上要被忽略，而不是拿不到流。
 */
describe("micConstraints", () => {
  it("三个会自动改写声音的处理都关掉", () => {
    expect(micConstraints()).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });

  it("没写 exact —— 不支持的设备忽略就好，别把流搞没了", () => {
    const raw = JSON.stringify(micConstraints());
    expect(raw).not.toContain("exact");
    expect(raw).not.toContain("ideal");
  });
});

/**
 * 认蓝牙输入（用来提醒"这个麦克风采音会差一些"）。
 *
 * 两条判据各管一段，合起来才不留死角：
 *   · **设备名** —— 覆盖 AirPods / Windows「免提 Hands-Free」这类一眼能认的；
 *   · **采样率 ≤ 16kHz** —— HFP 通话模式的指纹，**认不出名字的杂牌也能兜住**。
 *
 * ⚠️ 反过来的方向同等重要（见下面"内置麦不算蓝牙"）：误报会让用户每次录音都被拦一次，
 * 比漏报更招人烦 —— 无关紧要的设备一律放过。
 */
describe("inspectMicInput", () => {
  /** 只桩被测方法用到的那些：Jsdom 没有真的 MediaStream（见下面那条注释）。 */
  const fakeStream = (label: string, sampleRate?: number) =>
    ({
      getTracks: () => [{ label, getSettings: () => ({ sampleRate }) }],
    }) as unknown as MediaStream;

  it("设备名是 AirPods —— 命中", () => {
    expect(inspectMicInput(fakeStream("Michael 的 AirPods Pro", 48000))).toMatchObject({
      isBluetooth: true,
      deviceName: "Michael 的 AirPods Pro",
    });
  });

  it("Windows 上的写法也认：「免提 / Hands-Free」同样命中", () => {
    // Windows 上同一副耳机注册成两条，能录音的那条名字里带这个
    expect(inspectMicInput(fakeStream("Headset (WH-1000XM5 Hands-Free AG Audio)")).isBluetooth).toBe(true);
    expect(inspectMicInput(fakeStream("耳机 (WH-1000XM5 免提电话)")).isBluetooth).toBe(true);
  });

  it("名字认不出来、但采样率只有 16k —— 照样命中（杂牌蓝牙的兜底判据）", () => {
    const info = inspectMicInput(fakeStream("麦克风 (USB Audio)", 16000));
    expect(info.isBluetooth).toBe(true);
    expect(info.sampleRate).toBe(16000);
  });

  it("内置麦克风：48kHz + 名字里没有蓝牙特征 → 不打扰", () => {
    const info = inspectMicInput(fakeStream("MacBook Pro 麦克风", 48000));
    expect(info.isBluetooth).toBe(false);
    expect(info.deviceName).toBe("MacBook Pro 麦克风");
  });

  it("拿不到采样率（有些环境不报）也不误判 —— 只按名字判", () => {
    expect(inspectMicInput(fakeStream("USB 立式麦克风", undefined)).isBluetooth).toBe(false);
  });

  it("一条轨道都没有 / 空设备名 —— 不崩，也不误判", () => {
    const empty = { getTracks: () => [] } as unknown as MediaStream;
    expect(inspectMicInput(empty)).toEqual({ isBluetooth: false, deviceName: "", sampleRate: 0 });
    // 设备名空 + 采样率正常 = 没有任何命中蓝牙的证据
    expect(inspectMicInput(fakeStream("", 48000)).isBluetooth).toBe(false);
  });
});
