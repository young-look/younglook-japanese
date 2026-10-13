import { describe, expect, it } from "vitest";
import { micConstraints } from "../src/services/micCapture";

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
