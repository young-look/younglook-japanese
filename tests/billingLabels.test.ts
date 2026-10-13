import { describe, expect, it } from "vitest";
import {
  SCENE_TEXT,
  TXN_TYPE_TEXT,
  sceneText,
  txnName,
  txnSubNote,
} from "../src/services/billingApi";

/**
 * 消费明细「条目名称」的唯一真源（2026-10-11 拍板：**以客户端为基准**）。
 *
 * 网页端 web/src/api/billing.ts 逐字镜像这张表；那边
 * src/api/__tests__/billing-labels.spec.ts 会读本文件逐字比对。
 * 同一组期望值在两端各断言一遍 —— 谁改歪了都跑不掉。
 */
describe("消费明细条目名称", () => {
  const tx = (over: Partial<{ scene: string; note: string; type: string }> = {}) => ({
    scene: "",
    note: "",
    type: "consume",
    ...over,
  });

  it("场景名优先：四个 AI 场景都是客户端那套词", () => {
    expect(txnName(tx({ scene: "analyze" }))).toBe("AI 解析");
    expect(txnName(tx({ scene: "imitation" }))).toBe("仿写核对");
    expect(txnName(tx({ scene: "ask" }))).toBe("助手问答");
    expect(txnName(tx({ scene: "read_aloud", note: "语音评估 2.7 秒" }))).toBe("跟读核对");
  });

  it("没有场景就按类型：充值那笔叫「充值」，不把服务端那句长备注当名字", () => {
    expect(txnName(tx({ type: "recharge", note: "内置模型额度充值" }))).toBe("充值");
    expect(txnName(tx({ type: "refund", note: "人工退款至支付宝 a@b.c（张三）" }))).toBe("退款");
    expect(txnName(tx({ type: "gift" }))).toBe("赠送");
  });

  it("类型也认不出才轮备注，都没有就「其他」——永不吐英文原值", () => {
    expect(txnName(tx({ type: "some_new_kind", note: "某笔调整" }))).toBe("某笔调整");
    expect(txnName(tx({ type: "some_new_kind" }))).toBe("其他");
    expect(txnName(tx({ type: "some_new_kind" }))).not.toContain("some_new_kind");
  });

  it("小字只在名称来自场景时才补 —— 跟读那笔的实测秒数要留，重复信息不摆第二遍", () => {
    expect(txnSubNote(tx({ scene: "read_aloud", note: "语音评估 2.7 秒" }))).toBe("语音评估 2.7 秒");
    expect(txnSubNote(tx({ scene: "analyze" }))).toBe("");
    expect(txnSubNote(tx({ type: "recharge", note: "内置模型额度充值" }))).toBe("");
    expect(txnSubNote(tx({ type: "refund", note: "人工退款至支付宝 a@b.c（张三）" }))).toBe("");
  });

  it("本机 BYOK 那侧走的 sceneText 读的是同一张表", () => {
    expect(sceneText("read_aloud", "read_aloud")).toBe("跟读核对");
    expect(sceneText("something_else", "something_else")).toBe("something_else");
  });

  it("两张表里不含英文原值、也不含带「到期」的文案（账户页护栏）", () => {
    const dump = JSON.stringify({ SCENE_TEXT, TXN_TYPE_TEXT });
    expect(dump).not.toContain("到期");
    for (const value of Object.values(TXN_TYPE_TEXT)) {
      expect(value).toMatch(/[\u4e00-\u9fa5]/);
    }
  });
});
