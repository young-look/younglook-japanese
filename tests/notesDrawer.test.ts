/**
 * 笔记抽屉「开抽屉显示什么」的纯函数钉子（2026-10-09「输入即缓存 + 保存即锁定」）。
 *
 * resolveNoteView 是三态决策的唯一实现：
 *   草稿非空     → 编辑态（草稿是用户最新意图，盖过已保存内容）
 *   没草稿有存稿 → 锁定态（保存即锁定，重开抽屉看内容）
 *   两头都空     → 编辑态空框
 * 它挂在本文件里，是因为这些口径改坏了症状完全静默（显示错内容、草稿丢失），
 * vitest 在 node 环境跑不了 DOM/Modal，纯函数是最能钉住口径的那一层。
 */

import { describe, expect, it } from "vitest";
import { resolveNoteView } from "../src/views/notesDrawer";

describe("resolveNoteView（开抽屉的形态决策）", () => {
  it("两头都空 → 编辑态空框", () => {
    expect(resolveNoteView({ draft: "", baseline: "" })).toEqual({ mode: "edit", text: "" });
  });

  it("没草稿但已保存过 → 锁定态显示已保存内容", () => {
    expect(resolveNoteView({ draft: "", baseline: "这句是反讽" })).toEqual({
      mode: "locked",
      text: "这句是反讽",
    });
  });

  it("有草稿 → 编辑态，草稿盖过已保存内容", () => {
    expect(
      resolveNoteView({ draft: "改了一半的说法", baseline: "已保存的旧说法" }),
    ).toEqual({ mode: "edit", text: "改了一半的说法" });
  });

  it("草稿只有空白 = 没草稿 → 走已保存内容的锁定态", () => {
    expect(resolveNoteView({ draft: "   \n  ", baseline: "已保存" })).toEqual({
      mode: "locked",
      text: "已保存",
    });
  });

  it("已保存内容为空白也当没存 → 编辑态空框", () => {
    expect(resolveNoteView({ draft: "", baseline: "  " })).toEqual({ mode: "edit", text: "" });
  });

  it("草稿与存稿内容相同 → 编辑态（不该在重开时被折叠成锁定态）", () => {
    // 关抽屉时抽屉侧已经把"与存稿一致"的草稿清成空串才存进 StudyView，
    // 这里钉的是：万一原样传回来，也不该误判 —— 文本一致就按草稿路径回编辑态。
    const text = "同一份内容";
    expect(resolveNoteView({ draft: text, baseline: text })).toEqual({ mode: "edit", text });
  });

  it("CRLF 统一成 LF（与保存口径一致，避免假性不一致）", () => {
    expect(resolveNoteView({ draft: "第一行\r\n第二行", baseline: "" })).toEqual({
      mode: "edit",
      text: "第一行\n第二行",
    });
    expect(resolveNoteView({ draft: "", baseline: "第一行\r\n第二行" }).text).toBe(
      "第一行\n第二行",
    );
  });
});
