// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "./obsidianDom";

// 必须先装 DOM 扩展再调卡片构建函数（构建函数运行时才碰 DOM，import 顺序无忧）
installObsidianDomHelpers();

import { AiUnavailableError, explainSentence, isNoBalanceError } from "../src/services/ai/client";
import { buildAnalysis, type AnalysisHandle } from "../src/views/study/analysis";
import {
  buildCopyPractice,
  buildImitation,
  buildReadAloud,
  romajiKeycaps,
  type CopyPracticeHandle,
  type ImitationPracticeHandle,
  type ReadAloudHandle,
  type ReadVerifyOutcome,
} from "../src/views/study/practices";
import { buildAssistant, type AssistantHandle } from "../src/views/study/assistant";
import type { AiGate } from "../src/services/ai/gate";
import type { PluginSettings } from "../src/settings/types";
import type { ProgressRow, SentenceAnalysis, SliceRow, Token } from "../src/types/entities";

/**
 * 学习页三步练习卡的按钮契约（2026-10-07 用户拍板，防回归钉子）。
 *
 * 三张卡同一个模型 —— **数据一律自动保存，「检查」是人点的验证动作**：
 * 跟读 =「开始录音↔停止」「检查」「重置」（录音停止那刻已入库；不再自动核对，
 * 2026-10-07 推翻 2026-10-04 的「录完即核对」）；抄写/仿写 =「检查」「重置」
 * 「提示」（草稿敲了就在，约 0.8 秒自动落库）。
 *
 *   1. 「检查」= 用当前环境能用的**最深检查**核对这一遍，**永不因配置失效**、
 *      **不被弹窗拦截**：AI 可用走 AI；不可用走本地/浅检查（灰字说明降级）。
 *      **可反复点** —— 没查成（网络/服务商抖动）再点一次就是重试。这是这次改
 *      口径的根因：用户不该对着一次失败的「保存」猜怎么重试。
 *      麦克风用不了时跟读主按钮位换脸成「标记完成」（不经检查记一笔）。
 *      ⚠️ 2026-10-04 的旧契约（"没余额点 AI 按钮只弹统一弹窗"）在仿写卡
 *      仍被有意推翻——检查不经过配置窗；那套锁定契约现在只约束「AI 解析」卡。
 *   2. 「重置」= 这一步完全恢复初始（完成标记、留档、草稿、录音全清）。
 *   3. 浅检查放行必须留痕：`verified: false` 落库（卡片标黄、上行不收）。
 *   4. 卡片里**没有任何就地余额提示**（showNotice 已删、空 message 不上屏、
 *      402 必须带 need-balance 错误码让 StudyView 分流到弹窗）。
 *
 * 哪一条断了，这里必须红 —— 用户已经为此返工过不止一次。
 */

const slice: SliceRow = {
  cid: "slice-1",
  episodeCid: "ep-1",
  assetCid: "asset-1",
  index: 1,
  startMs: 0,
  endMs: 1500,
  ja: "猫が寝ている。",
  zh: "猫在睡觉。",
  speaker: "",
  textHash: "hash",
  parserVersion: 1,
  analysis: null,
  rev: 0,
  rowDigest: "",
  clientUpdatedAt: "2026-10-04T00:00:00Z",
  deletedAt: null,
};

const token: Token = { surface: "猫", lemma: "猫", reading: "ねこ", romaji: "neko", pos: "noun" };

const BLOCKED: AiGate = {
  ok: false,
  reason: "need-balance",
  message: "内置模型余额用完了，充值或改用自定义模型后才能继续用。",
  canLogin: false,
};
const OPEN: AiGate = { ok: true };

function hostedSettings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return {
    vaultFolder: "看动漫学日语",
    mediaDir: "",
    aiMode: "hosted",
    byok: { baseUrl: "https://example.com/v1", apiKey: "sk-test", model: "qwen-plus" },
    byokSaved: null,
    byokLocked: false,
    serverEnv: "prod",
    customServerUrl: "",
    serverUrl: "https://younglook.cc",
    authServerUrl: "",
    authToken: "tok",
    refreshToken: "refresh",
    lastStatsSyncAt: 0,
    aiBalanceMillis: 0,
    accountProfile: null,
    autoSyncMinutes: 15,
    vaultLocalId: "test",
    spaces: [{ id: "test", owner: "", ownerServer: "", ownerName: "" }],
    activeSpaceId: "test",
    autoOpenPage: false,
    lastView: "",
    lastUpdateCheckAt: 0,
    dictPromptSeen: false,
  prefsUpdatedAt: "",
    lastVerifyDay: "",
    ...overrides,
  };
}

const progressRow = (overrides: Partial<ProgressRow> = {}): ProgressRow =>
  ({
    cid: "p1",
    sliceCid: slice.cid,
    imitationText: "",
    imitationCorrect: null,
    imitationVerifiedAt: null,
    ...overrides,
  }) as unknown as ProgressRow;

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === text,
  );
  if (!found) throw new Error(`卡片里找不到按钮「${text}」`);
  return found;
}

/** 「已经解析过」那一份解读：有一段正文，卡片上分界线底下是真有东西的 */
const SECTIONS = { words: "猫（ねこ）：猫。", grammar: "" };

/**
 * 自己搭一张卡，并能把"解析回来了"真的铺上屏（`showExplanation`）——
 * 按钮从「AI 解析」变「重新解析」只认 `explained`（解析区内部状态），
 * 光把 onExplain 桩掉是变不出来的：空的桩等于"解析没回来"。
 */
function buildReparseProbe(gate: AiGate): {
  handle: AnalysisHandle;
  onExplain: ReturnType<typeof vi.fn>;
  onReparseConfirm: ReturnType<typeof vi.fn>;
} {
  const onExplain = vi.fn(async () => {});
  const onReparseConfirm = vi.fn();
  const handle = buildAnalysis({
    onExplain,
    getGate: () => gate,
    checkGate: () => Promise.resolve(gate),
    onNeedSetup: () => {},
    onRecharge: () => {},
    onReparseConfirm,
    aiMode: "hosted",
  });
  // 解析回来的那一份照 showExplanation 铺上屏 —— 卡片这才算"解析过"
  onExplain.mockImplementation(async () => {
    handle.showExplanation({ translation: "猫在睡觉。", sections: SECTIONS }, "");
  });
  handle.load(slice);
  handle.showTokens([token]);
  return { handle, onExplain, onReparseConfirm };
}

/**
 * 把卡片推到"已经解析过"的待命态（按钮变「重新解析」）。
 * ⚠️ 按钮文案是在**点击链路的 finally** 里改的（`explained` 那一刻才为 true），
 *    所以不能点完就断言 —— 必须等它真的变了再拿按钮。
 */
async function toReparsed(handle: AnalysisHandle): Promise<HTMLButtonElement> {
  buttonByText(handle.root, "AI 解析").click();
  await vi.waitFor(() => buttonByText(handle.root, "重新解析"));
  return buttonByText(handle.root, "重新解析");
}

/** 点一下并等按钮文案变成 `text`（点击链路是异步的，别点完立刻断言） */
async function waitClick(btn: HTMLButtonElement, root: HTMLElement, text: string): Promise<void> {
  btn.click();
  await vi.waitFor(() => buttonByText(root, text));
}

function draftAreaOf(root: HTMLElement): HTMLTextAreaElement {
  const draft = Array.from(root.querySelectorAll("textarea")).find((area) => !area.disabled);
  if (!draft) throw new Error("找不到可输入的仿写框");
  return draft;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── AI 解析（analysis 卡）─────────────────────────────────────────────────

describe("AI 解析卡", () => {
  function build(gate: AiGate): {
    handle: AnalysisHandle;
    onExplain: ReturnType<typeof vi.fn>;
    onNeedSetup: ReturnType<typeof vi.fn>;
    /** 用户在「重新解析」确认窗上做了什么 —— 桩成"点确认"（默认）或"再想想" */
    onReparseConfirm: ReturnType<typeof vi.fn>;
  } {
    const onExplain = vi.fn(async () => {});
    const onNeedSetup = vi.fn();
    const onReparseConfirm = vi.fn();
    const handle = buildAnalysis({
      onExplain,
      getGate: () => gate,
      // 点击链路是异步的：先过核实口（这里桩成原样返回本地门控）
      checkGate: () => Promise.resolve(gate),
      onNeedSetup,
      onRecharge: () => {},
      // 确认窗由 StudyView 弹，这里只桩回调 —— 弹窗怎么弹不是这张卡的契约
      onReparseConfirm,
      aiMode: "hosted",
    });
    handle.load(slice);
    return { handle, onExplain, onNeedSetup, onReparseConfirm };
  }

  it("没余额：按钮置灰、title 说明原因，点击只弹统一弹窗、不发请求", async () => {
    const { handle, onExplain, onNeedSetup } = build(BLOCKED);
    const btn = buttonByText(handle.root, "AI 解析");

    expect(btn.classList.contains("yl-locked")).toBe(true);
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute("title")).toContain("余额");

    btn.click();
    await vi.waitFor(() => expect(onNeedSetup).toHaveBeenCalledTimes(1));
    expect(onExplain).not.toHaveBeenCalled();
  });

  it("门控放行：不置灰，点击正常发起解析", async () => {
    const { handle, onExplain, onNeedSetup } = build(OPEN);
    handle.showTokens([token]);
    const btn = buttonByText(handle.root, "AI 解析");

    expect(btn.classList.contains("yl-locked")).toBe(false);
    btn.click();
    await vi.waitFor(() => expect(onExplain).toHaveBeenCalledTimes(1));
    expect(onExplain).toHaveBeenCalledWith(["猫"]);
    expect(onNeedSetup).not.toHaveBeenCalled();
  });

  it("缓存说没钱但核实口放行（网页端刚充完值）：点击照常发请求，不弹配置窗", async () => {
    // 2026-10-05 定案：余额真值在服务端，缓存拦人不能直接判死 ——
    // getGate（渲染锁定态）可以旧，checkGate（点击核实）必须新
    const onExplain = vi.fn(async () => {});
    const onNeedSetup = vi.fn();
    const handle = buildAnalysis({
      onExplain,
      getGate: () => BLOCKED,
      checkGate: () => Promise.resolve(OPEN),
      onNeedSetup,
      onRecharge: () => {},
      onReparseConfirm: () => {},
      aiMode: "hosted",
    });
    handle.load(slice);
    handle.showTokens([token]);

    buttonByText(handle.root, "AI 解析").click();
    await vi.waitFor(() => expect(onExplain).toHaveBeenCalledTimes(1));
    expect(onNeedSetup).not.toHaveBeenCalled();
  });

  // ── 重新解析要花钱，先问一句（2026-10-08 用户拍板）──────────────────────

  it("本机已有解析（翻回来/刚解析完）：按钮就是「重新解析」，点了先弹确认窗", async () => {
    // 🔥 这条钉的是"看到的和会发生的对不上"那类 bug：内部 `explained` 已经是 true、
    //    点击也确实会弹确认窗，但按钮文案只在点击链路的 finally 里同步过 ——
    //    走缓存铺开这条路时按钮还写着「AI 解析」，用户只能点一下才知道它会花钱。
    const onExplain = vi.fn(async () => {});
    const onReparseConfirm = vi.fn();
    const handle = buildAnalysis({
      onExplain,
      getGate: () => OPEN,
      checkGate: () => Promise.resolve(OPEN),
      onNeedSetup: () => {},
      onRecharge: () => {},
      onReparseConfirm,
      aiMode: "hosted",
    });
    handle.load(slice);
    handle.showTokens([token]);
    // StudyView 命中本机缓存时就是这么调（见 loadSlice 的 `analysis?.done` 分支）
    handle.showCached({
      translation: "猫在睡觉。",
      explanation: SECTIONS,
    } as SentenceAnalysis);

    const btn = buttonByText(handle.root, "重新解析");
    btn.click();
    await vi.waitFor(() => expect(onReparseConfirm).toHaveBeenCalledTimes(1));
    // 文案对得上，行为也对得上：确认之前一个请求都没发
    expect(onExplain).not.toHaveBeenCalled();
  });

  it("已经解析过：再点「重新解析」只弹确认窗，不确认就不发请求", async () => {
    const { handle, onExplain, onReparseConfirm } = buildReparseProbe(OPEN);
    // 先解析一遍：卡片进入"已经解析过"的待命态（按钮变「重新解析」）
    const btn = await toReparsed(handle);

    await waitClick(btn, handle.root, "重新解析");
    expect(onReparseConfirm).toHaveBeenCalledTimes(1);
    // 🔥 这一步是全卡的要害：请求没发出去，一分钱都还没花
    expect(onExplain).toHaveBeenCalledTimes(1); // 只有上面那一次（把卡片推成"已解析"的那次）

    // 用户点了「再想想」/ 按了 ESC：什么都不发生，按钮回到待命态。
    // 不确认就必须能再点一次 —— 场景是"手滑点开、想想还是算了"
    await waitClick(btn, handle.root, "重新解析");
    expect(onReparseConfirm).toHaveBeenCalledTimes(2);
    expect(onExplain).toHaveBeenCalledTimes(1);
  });

  it("只重算解读那一块走完：提示语如实说「没有重新生成词表」，不留「正在准备逐词释义」", async () => {
    // 🔥 走这条路的按钮承诺必须与刚发生的事对得上：这次压根没请求词表，
    //    句子卡上那份是上一次留下的 —— 还说"正在准备"，用户会一直等一个不会来的东西。
    const { handle } = buildReparseProbe(OPEN);
    await toReparsed(handle);

    // StudyView.reparseExplanation 的收口顺序：先铺新解读，再说"只刷新了左边"
    handle.beginStream();
    handle.showExplanation({ translation: "猫睡了。", sections: SECTIONS }, "");
    handle.explanationRefreshed(true);

    const hint = handle.root.querySelector(".yl-analysis-hint")?.textContent ?? "";
    expect(hint).toContain("解读已更新");
    expect(hint).not.toContain("正在准备");

    // 句子卡上还没有词表（这一句从没落过档）时如实说词点不开，别撒谎
    handle.explanationRefreshed(false);
    expect(handle.root.querySelector(".yl-analysis-hint")?.textContent).toContain("点不开");
  });

  it("确认窗弹出来之前连点两下：只会弹一颗窗", async () => {
    const { handle, onExplain, onReparseConfirm } = buildReparseProbe(OPEN);
    const btn = await toReparsed(handle);

    // ⚠️ 两下**同步**点出去（中间不 await）：这正是用户手快时的形状。
    //    `busy`/`disabled` 只在点击链路的 await 之间挡住第二下 —— 若那个窗口没了
    //    或者忘了置位，这里就会冒出第二颗一模一样的确认窗。
    btn.click();
    btn.click();
    await vi.waitFor(() => expect(onReparseConfirm).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onReparseConfirm).toHaveBeenCalledTimes(1);
    expect(onExplain).toHaveBeenCalledTimes(1); // 只有"把卡片推成已解析"的那一次
  });

  it("首次解析（没解析过）不问直接发请求 —— 确认窗只管「重新解析」", async () => {
    const { handle, onExplain, onReparseConfirm } = build(OPEN);
    handle.showTokens([token]);

    buttonByText(handle.root, "AI 解析").click();
    await vi.waitFor(() => expect(onExplain).toHaveBeenCalledTimes(1));
    expect(onReparseConfirm).not.toHaveBeenCalled();
  });
});

// ── 解析卡的按钮行必须落在卡片中线上（2026-10-09 用户令：改没了测试必须红）─────

describe("解析卡的按钮行垂直居中（2026-10-09）", () => {
  const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

  it("解读还没生成时，空的解读层必须整层收起", () => {
    // 症状只有 4px，而且**完全不报错**：`.yl-analysis-block` 是 flex 列 + `gap: 8px`，
    // 空的 .yl-analysis-explanation 照样算 flex 的一项 ⇒ 它在按钮行下面白占一个 8px
    // 间距，卡片于是"上紧下松"。实机 2x 截图实测：上留白 10.5px、下留白 18.5px，
    // 按钮与说明文字的中线比卡片中线高 4px —— 用户看到的就是"没垂直居中"。
    // 修法 = 让空层 display:none（`:empty` 只认"一个子节点都没有"，而它平时就是
    // createDiv() 出来的空壳，流式分节全由 pushFields 挂进来）。
    const css = read("../styles.css");
    expect(css).toMatch(/\.yl-analysis-explanation:empty\s*\{\s*display:\s*none;/);
    // ⚠️ 不许改成负 margin 抵消：那只是把偏差藏起来，以后一加兄弟节点口径又对不上。
    expect(css).not.toMatch(/\.yl-analysis-explanation\b[^{]*\{[^}]*margin-top:\s*-/);
  });
});

// ── 仿写卡（检查 / 重置 / 提示）──────────────────────────────────────────

describe("仿写卡", () => {
  function build(
    gate: AiGate,
    onVerify: Parameters<typeof buildImitation>[0]["onVerify"] = async () => ({
      status: "error",
      message: "",
    }),
  ) {
    const onNeedSetup = vi.fn();
    const onPassUnverified = vi.fn(async () =>
      progressRow({ imitationCorrect: true, imitationVerifiedAt: null }),
    );
    const onHint = vi.fn();
    const handle = buildImitation({
      onVerify,
      onPassUnverified,
      onHint,
      onRecharge: () => {},
      getGate: () => gate,
      checkGate: () => Promise.resolve(gate),
      onNeedSetup,
      onReset: vi.fn(async () => progressRow()),
      loadDraft: vi.fn(async () => ""),
      saveDraft: vi.fn(async () => undefined),
    });
    handle.load(slice, undefined);
    return { handle, onNeedSetup, onPassUnverified, onHint };
  }

  function fillDraft(handle: ImitationPracticeHandle, text = "猫が寝ていると思う。"): HTMLTextAreaElement {
    const draft = draftAreaOf(handle.root);
    draft.value = text;
    draft.dispatchEvent(new Event("input"));
    return draft;
  }

  it("没配置模型：检查照样可点（不被弹窗拦截），点了直接浅检查放行", async () => {
    const { handle, onNeedSetup, onPassUnverified } = build(BLOCKED);
    const draft = fillDraft(handle);
    const text = draft.value;

    const btn = buttonByText(handle.root, "检查");
    expect(btn.classList.contains("yl-locked")).toBe(false);
    btn.click();

    await vi.waitFor(() => expect(onPassUnverified).toHaveBeenCalledWith(text, slice.cid));
    // 🔥 检查不借道配置窗 —— 2026-10-04 推翻旧契约的断言，换口径后仍要成立
    expect(onNeedSetup).not.toHaveBeenCalled();
  });

  it("浅检查放行后：头部「已完成」（灰 —— 没人判过对错，不冒充正解）", async () => {
    const { handle } = build(BLOCKED);
    fillDraft(handle);
    buttonByText(handle.root, "检查").click();

    await vi.waitFor(() => {
      const status = handle.root.querySelector(".yl-step-status");
      expect(status?.textContent).toBe("已完成");
    });
    const status = handle.root.querySelector(".yl-step-status");
    expect(status!.classList.contains("yl-step-status-plain")).toBe(true);
  });

  it("浅检查拒绝照抄原句：不落库，黄字说明", async () => {
    const { handle, onPassUnverified } = build(BLOCKED);
    fillDraft(handle, slice.ja);

    buttonByText(handle.root, "检查").click();
    // 点击先过（异步的）核实口再决定浅检查，等流程落定后断言
    await vi.waitFor(() => {
      const hint = handle.root.querySelector(".yl-practice-actions span.yl-muted-sm");
      expect(hint!.classList.contains("yl-warn-text")).toBe(true);
      expect(hint!.textContent).toContain("照抄");
    });
    expect(onPassUnverified).not.toHaveBeenCalled();
  });

  it("没配置模型：灰字里有虚线「开启 AI」入口，点了才弹配置窗", () => {
    const { handle, onNeedSetup } = build(BLOCKED);
    const hint = handle.root.querySelector(".yl-practice-actions span.yl-muted-sm");
    expect(hint!.textContent).toContain("开启 AI");

    hint!.querySelector<HTMLButtonElement>("button")!.click();
    expect(onNeedSetup).toHaveBeenCalledTimes(1);
  });

  it("AI 可用：点「检查」送 AI 判定，带发起时绑定的句子 cid", async () => {
    const onVerify = vi.fn(async (_text: string, _sliceCid: string) => ({ status: "error", message: "" }) as const);
    const { handle } = build(OPEN, onVerify);
    fillDraft(handle);

    buttonByText(handle.root, "检查").click();
    await vi.waitFor(() => expect(onVerify).toHaveBeenCalledTimes(1));
    expect(onVerify.mock.calls[0][0]).toBe("猫が寝ていると思う。");
    expect(onVerify.mock.calls[0][1]).toBe(slice.cid);
  });

  it("缓存说没钱但核实口放行（网页端刚充完值）：检查走 AI 判定，不落「未核对」", async () => {
    const onVerify = vi.fn(async (_text: string, _sliceCid: string) => ({ status: "error", message: "" }) as const);
    const onPassUnverified = vi.fn(async () => progressRow({ imitationCorrect: true, imitationVerifiedAt: null }));
    const handle = buildImitation({
      onVerify: onVerify as unknown as (
        text: string,
        sliceCid: string,
      ) => Promise<{ status: "error"; message: string }>,
      onPassUnverified,
      onHint: vi.fn(),
      onRecharge: () => {},
      getGate: () => BLOCKED,
      checkGate: () => Promise.resolve(OPEN),
      onNeedSetup: vi.fn(),
      onReset: vi.fn(async () => progressRow()),
      loadDraft: vi.fn(async () => ""),
      saveDraft: vi.fn(async () => undefined),
    });
    handle.load(slice, undefined);
    fillDraft(handle);

    buttonByText(handle.root, "检查").click();
    await vi.waitFor(() => expect(onVerify).toHaveBeenCalledTimes(1));
    expect(onPassUnverified).not.toHaveBeenCalled();
  });

  it("AI 判对：头部「正解 ✓」（青蓝）—— 与「已完成」（没人判过）分开", async () => {
    const onVerify = vi.fn(async () => ({
      status: "ok" as const,
      verdict: { correct: true, reason: "结构一致", suggestion: "", suggestionNote: "", translation: "猫在睡觉。" },
      progress: progressRow({
        imitationCorrect: true,
        imitationVerifiedAt: new Date().toISOString(),
        imitationText: "猫が寝ていると思う。",
      }),
    }));
    const { handle } = build(OPEN, onVerify);
    fillDraft(handle);

    buttonByText(handle.root, "检查").click();
    const status = handle.root.querySelector(".yl-step-status") as HTMLElement;
    await vi.waitFor(() => expect(status.textContent).toBe("正解 ✓"));
    expect(status.classList.contains("yl-step-status-ok")).toBe(true);
  });

  it("点「提示」：只转发 onHint（弹窗由上层门控决定），卡片自己不摆提示", () => {
    const { handle, onHint } = build(BLOCKED);
    buttonByText(handle.root, "提示").click();
    expect(onHint).toHaveBeenCalledTimes(1);
  });

  it("「重置」：清掉留档，调 onReset", async () => {
    const onReset = vi.fn(async () => progressRow());
    const handle = buildImitation({
      onVerify: vi.fn(),
      onPassUnverified: vi.fn(async () => progressRow()),
      onHint: vi.fn(),
      onRecharge: () => {},
      getGate: () => OPEN,
      checkGate: () => Promise.resolve(OPEN),
      onNeedSetup: vi.fn(),
      onReset,
      loadDraft: vi.fn(async () => ""),
      saveDraft: vi.fn(async () => undefined),
    });
    handle.load(slice, progressRow({ imitationText: "猫が寝ていると思う。", imitationCorrect: true, imitationVerifiedAt: new Date().toISOString() }));

    const reset = buttonByText(handle.root, "重置");
    expect(reset.disabled).toBe(false);
    reset.click();
    await vi.waitFor(() => expect(onReset).toHaveBeenCalledTimes(1));
  });

  it("核对出错且 message 为空（没余额、弹窗已接管）：卡片不上屏任何提示", async () => {
    const { handle } = build(OPEN);
    fillDraft(handle);
    const btn = buttonByText(handle.root, "检查");
    btn.click();

    // finally 恢复按钮文案并解禁 = 检查流程走完（点击后头几拍 disabled=true，
    // 文案也变过「判定中…」，等它回去才算数 —— 不能在流程还没开始时就误判完成）
    await vi.waitFor(() => {
      expect(btn.textContent).toBe("检查");
      expect(btn.disabled).toBe(false);
    });
    const hint = handle.root.querySelector(".yl-practice-actions span.yl-muted-sm");
    expect(hint).not.toBeNull();
    expect(hint!.classList.contains("yl-warn-text")).toBe(false);
    expect(hint!.textContent).not.toContain("余额");
  });

  it("核对出错且有 message（普通报错）：仍然就地显示 —— 只有没余额那档静音", async () => {
    const onVerify = vi.fn(async () => ({ status: "error" as const, message: "AI 没连上（网络或 Key 的问题），可以稍后再试。" }));
    const { handle } = build(OPEN, onVerify);
    fillDraft(handle);
    const btn = buttonByText(handle.root, "检查");
    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("检查");
      expect(btn.disabled).toBe(false);
    });
    const hint = handle.root.querySelector(".yl-practice-actions span.yl-muted-sm");
    expect(hint!.classList.contains("yl-warn-text")).toBe(true);
    expect(hint!.textContent).toContain("没连上");
  });

  it("行内余额提示的旧口子 showNotice 不得复活", () => {
    const { handle } = build(OPEN);
    expect((handle as unknown as Record<string, unknown>).showNotice).toBeUndefined();
  });
});

// ── 跟读卡（录音钮 / 检查 / 重置 · 录音自动入库，检查归人点）──────────────

describe("跟读卡", () => {
  function build() {
    const onManualConfirm = vi.fn(async () => {
      // 卡片只等落库完成，不读返回值（sliceDone 它自己维护）
    });
    const onReset = vi.fn(async () => progressRow());
    const onVerify = vi.fn(
      async () => ({ status: "ok", message: "每个词都读对了。", verified: true }) as const,
    );
    const handle: ReadAloudHandle = buildReadAloud({
      onVerify: onVerify as unknown as Parameters<typeof buildReadAloud>[0]["onVerify"],
      onManualConfirm,
      canUseAi: () => false,
      onRerecord: () => {},
      onReset,
      loadRecording: vi.fn(async () => null),
      saveRecording: vi.fn(async () => undefined),
    });
    handle.load(slice, undefined);
    return { handle, onManualConfirm, onReset, onVerify };
  }

  it("跟读卡三颗钮：本步动作 + 检查 + 重置，**没有「保存」**（数据自动保存）", () => {
    const { handle } = build();
    // ⚠️ 只数**按钮行**里那三颗：回听条上也有一颗图标钮（播放），它不是"动作"按钮
    //    （2026-10-08 回听条自绘后新增）。
    const texts = Array.from(
      handle.root.querySelectorAll(".yl-practice-actions button"),
    ).map((b) => b.textContent);
    expect(texts).toHaveLength(3);
    expect(texts).not.toContain("保存");
    expect(texts).toContain("检查");
    expect(texts[2]).toBe("重置");
  });

  it("回听条常驻：没录音时也在原位，只是压暗不可点（**不做显隐**）", () => {
    const { handle } = build();
    const bar = handle.root.querySelector(".yl-read-controls") as HTMLElement;
    expect(bar).toBeTruthy();
    // 🔥 这条钉的是"按钮不跑位"的根：回听条必须**一直在**，用 is-off 表达"还没录音"，
    //    不许 display:none —— 一显隐就会把下面那行按钮整行顶下去，
    //    用户点完「开始录音」还得追着鼠标找「停止」（2026-10-08 用户报的就是这个）。
    expect(bar.style.display).not.toBe("none");
    expect(bar.classList.contains("is-off")).toBe(true);
    expect((bar.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
    expect((bar.querySelector("input[type=range]") as HTMLInputElement).disabled).toBe(true);
    // 没有录音时时间归零，不挂着上一份的时长
    expect(bar.querySelector(".yl-read-clock")!.textContent).toBe("0:00.0 / 0:00.0");
  });

  it("jsdom 没有 MediaRecorder = 无麦态：主按钮换脸成「标记完成」，点了不经检查记一笔", () => {
    const { handle, onManualConfirm } = build();
    // 🔥 换脸而不是置灰：无麦时这张卡唯一还能做的事就是"记完成"，得留一个可点的口子
    const confirm = buttonByText(handle.root, "标记完成");
    expect(confirm.disabled).toBe(false);

    confirm.click();
    expect(onManualConfirm).toHaveBeenCalledTimes(1);
    const hint = handle.root.querySelector(".yl-practice-actions span.yl-muted-sm");
    expect(hint!.classList.contains("yl-warn-text")).toBe(true);
    expect(hint!.textContent).toContain("标记完成");
  });

  it("无麦记完成之后：头部「已完成」（没人判过），主按钮置灰，重置可点并调 onReset", async () => {
    const { handle, onReset } = build();
    buttonByText(handle.root, "标记完成").click();

    await vi.waitFor(() => {
      const status = handle.root.querySelector(".yl-step-status");
      expect(status?.textContent).toBe("已完成");
    });
    expect(buttonByText(handle.root, "标记完成").disabled).toBe(true);
    const reset = buttonByText(handle.root, "重置");
    expect(reset.disabled).toBe(false);

    reset.click();
    await vi.waitFor(() => expect(onReset).toHaveBeenCalledTimes(1));
  });

  it("本地存过录音：回放条请回来，「检查」可点且可反复点（重试 = 再点一次）", async () => {
    // jsdom 没有 blob URL 工厂：补桩让回放条路径走通（结束恢复，别漏给别的用例）
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:mock") as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    try {
      const onVerify = vi.fn(
        async (_payload: unknown, _sliceCid: string) =>
          ({ status: "ok", message: "每个词都读对了。", verified: true }) as const,
      );
      const blob = new Blob(["x"], { type: "audio/webm" });
      const handle: ReadAloudHandle = buildReadAloud({
        onVerify,
        onManualConfirm: vi.fn(async () => {}),
        canUseAi: () => true,
        onRerecord: () => {},
        onReset: vi.fn(async () => progressRow()),
        loadRecording: vi.fn(async () => ({ blob, mimeType: "audio/webm", seconds: 2.5 })),
        saveRecording: vi.fn(async () => undefined),
      });
      handle.load(slice, undefined);

      const check = buttonByText(handle.root, "检查");
      await vi.waitFor(() => expect(check.disabled).toBe(false));

      // 回听条跟着亮起来：去掉压暗、播放钮可点（"录了就变色"的那一半）
      const bar = handle.root.querySelector(".yl-read-controls") as HTMLElement;
      await vi.waitFor(() => expect(bar.classList.contains("is-off")).toBe(false));
      expect((bar.querySelector("button") as HTMLButtonElement).disabled).toBe(false);
      expect((bar.querySelector("input[type=range]") as HTMLInputElement).disabled).toBe(false);

      check.click();
      await vi.waitFor(() => expect(onVerify).toHaveBeenCalledTimes(1));
      // 落库认发起检查时绑定的句子 cid（回包可能已经换句）
      expect(onVerify.mock.calls[0][1]).toBe(slice.cid);

      // 核对完录音不清 —— 再点一次还是核对同一份（2026-10-07 口径的核心）
      await vi.waitFor(() => expect(check.disabled).toBe(false));
      check.click();
      await vi.waitFor(() => expect(onVerify).toHaveBeenCalledTimes(2));
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it("跟读三态：AI 逐词全对=正解 / 本地只查有出声=已完成 / 判错=未通过（颜色类跟着走）", async () => {
    // 🔥 这条钉的就是用户 2026-10-09 报的"做对做错都写已完成、没有区分度"。
    //    三态判据全来自 ReadVerifyOutcome：`verified` 分「AI 判过」和「只查了有出声」。
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:mock") as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    try {
      const cases: Array<{ outcome: ReadVerifyOutcome; text: string; cls: string }> = [
        {
          outcome: { status: "ok", verified: true, message: "每个词都读对了。" },
          text: "正解 ✓",
          cls: "yl-step-status-ok",
        },
        {
          outcome: { status: "ok", verified: false, message: "只查了有没有出声" },
          text: "已完成",
          cls: "yl-step-status-plain",
        },
        {
          outcome: { status: "wrong", message: "原句上标红的词读得不太准，重录一遍再试试。" },
          text: "未通过 ✕",
          cls: "yl-step-status-bad",
        },
      ];
      for (const item of cases) {
        const blob = new Blob(["x"], { type: "audio/webm" });
        const handle: ReadAloudHandle = buildReadAloud({
          onVerify: vi.fn(async () => item.outcome) as unknown as Parameters<
            typeof buildReadAloud
          >[0]["onVerify"],
          onManualConfirm: vi.fn(async () => {}),
          canUseAi: () => true,
          onRerecord: () => {},
          onReset: vi.fn(async () => progressRow()),
          loadRecording: vi.fn(async () => ({ blob, mimeType: "audio/webm", seconds: 2.5 })),
          saveRecording: vi.fn(async () => undefined),
        });
        handle.load(slice, undefined);

        const check = buttonByText(handle.root, "检查");
        await vi.waitFor(() => expect(check.disabled).toBe(false));
        check.click();

        const status = handle.root.querySelector(".yl-step-status") as HTMLElement;
        await vi.waitFor(() => expect(status.textContent).toBe(item.text));
        expect(status.classList.contains(item.cls)).toBe(true);
        handle.dispose();
      }
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it("从进度行回来：readAloudVerifiedAt 有值才是「正解」，否则只是「已完成」", () => {
    // 换句回来 / 插件重载后走的就是这条路 —— 少了这条判据，「正解」会退化成「已完成」。
    const verified = progressRow({ readAloudAt: new Date().toISOString(), readAloudVerifiedAt: new Date().toISOString() });
    const onlyRead = progressRow({ readAloudAt: new Date().toISOString() });
    const read = buildReadAloud({
      onVerify: vi.fn(async () => ({ status: "error", message: "" }) as const) as unknown as Parameters<
        typeof buildReadAloud
      >[0]["onVerify"],
      onManualConfirm: vi.fn(async () => {}),
      canUseAi: () => true,
      onRerecord: () => {},
      onReset: vi.fn(async () => progressRow()),
      loadRecording: vi.fn(async () => null),
      saveRecording: vi.fn(async () => undefined),
    });

    read.load(slice, verified);
    let status = read.root.querySelector(".yl-step-status") as HTMLElement;
    expect(status.textContent).toBe("正解 ✓");
    expect(status.classList.contains("yl-step-status-ok")).toBe(true);

    read.load(slice, onlyRead);
    status = read.root.querySelector(".yl-step-status") as HTMLElement;
    expect(status.textContent).toBe("已完成");
    expect(status.classList.contains("yl-step-status-plain")).toBe(true);
    read.dispose();
  });

});

// ── 跟读卡「按钮不跑位」的接线钉子（2026-10-08）────────────────────────────

describe("跟读卡按钮定死位置（2026-10-08 用户令：改没了测试必须红）", () => {
  const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

  it("回听条常驻：代码里不许再出现 controls.show/hide", () => {
    // 🔥 用户报的原话是「点开始录音/停止，按钮会跑到别的位置，还得去移动鼠标」。
    //    根因就是回听条**显隐**：录完才 show，把下面那行按钮整行顶下去。
    //    这条钉子钉住"别再退回显隐"—— 那种回退不报错、界面也"看着正常"，
    //    只有点一下才发现按钮追不上手。
    const src = read("../src/views/study/practices.ts");
    expect(src).not.toContain("controls.show(");
    expect(src).not.toContain("controls.hide(");
    // 有录音 / 没录音的差别只由这一句表达（压暗，不是摘出文档流）
    expect(src).toContain('controls.toggleClass("is-off"');
  });

  it("三颗钮不设固定宽度：跟抄写卡同 padding、自然宽（2026-10-08 二次拍板）", () => {
    // 同日上午定的 92px 等宽被用户当面推翻：「三个按钮的 padding 和其他抄写卡
    // 一致，别弄那么宽」。⇒ 这里**不许再出现**针对跟读按钮行的 width 规则；
    // 谁想把定宽加回来必须先问用户（代价：录音钮换文案时检查/重置会横移一点）。
    const css = read("../styles.css");
    expect(css).not.toContain(".yl-read .yl-practice-actions > button");
    // 也不许走「每颗各写一个宽度」的老路 —— 那是三颗三档的来源
    expect(css).not.toContain("yl-read-recbtn");
    expect(css).not.toContain("yl-read-checkbtn");
  });

  it("按钮文案保持短句，别把自然宽的按钮撑宽", () => {
    // 定宽废除后文案不再是硬上限，但用户要的就是窄按钮 —— 文案别加长。
    const src = read("../src/views/study/practices.ts");
    expect(src).toContain('recordButton.setText("取麦克风…")');
    expect(src).not.toContain("正在取麦克风");
  });

  it("回听条播放钮放大一号（34px）、滑杆用浅一档的 accent（2026-10-08 用户令）", () => {
    const css = read("../styles.css");
    // 播放钮：28px 全局基底上按作用域放大 20%（28×1.2≈34），形状不变
    expect(css).toMatch(
      /\.yl-read-controls \.yl-btn-icon \{\s*width: 34px;\s*height: 34px;/,
    );
    // 滑杆已播/圆钮用 --yl-acc-mid（46% 亮度）；--yl-acc-solid（36%）被用户嫌深
    const seg = css.slice(
      css.indexOf(".yl-read-controls .yl-read-slider"),
      css.indexOf(".yl-practice-actions"),
    );
    expect(seg).toContain("--yl-acc-mid");
    expect(seg).not.toContain("--yl-acc-solid");
  });

  it("回听条的滑杆整条自绘：不许退回 accent-color（实机会变灰细条）", () => {
    // 🔥 用户 2026-10-08 报「完全没改动」，根因就是这条：
    //    Obsidian 的 app.css 用 `input[type='range'] { -webkit-appearance: none;
    //    height: var(--slider-track-height); }` + 白色药丸 thumb 改写了所有滑杆，
    //    而 appearance:none 之后 **accent-color 彻底失效** ⇒ 预览（浏览器默认长相）
    //    里是粗青蓝条，实机却退回 4px 灰轨 + 白药丸，看着像没做过。
    const css = read("../styles.css");
    // ① 轨道 / 圆钮两件都得自己声明（缺一件就退回宿主长相）
    expect(css).toContain(".yl-read-controls .yl-read-slider::-webkit-slider-runnable-track");
    expect(css).toContain(".yl-read-controls .yl-read-slider::-webkit-slider-thumb");
    // ② 高度必须显式写 8px 轨道（写在外层盒子上，圆钮才和轨道同心）
    expect(css).toMatch(/\.yl-read-controls \.yl-read-slider \{[\s\S]*?appearance: none;/);
    // ③ 进度色只能来自 --yl-fill 渐变
    expect(css).toContain("var(--yl-fill");
    // ⚠️ 只禁**回听条这一条规则里**的 accent-color（视频条的 .yl-clip-slider 还留着
    //    旧的 accent-color 写法，那是另一个待办，别把断言写成全局的 —— 会误伤）。
    expect(css).not.toMatch(/\.yl-read-controls \.yl-read-slider[^{]*\{[^}]*accent-color/);
    // ④ 选择器必须带 .yl-read-controls 前缀：Obsidian 那条是 `input[type='range']`
    //    （特异性 0,1,1），单类名（0,1,0）压不过它，高度会被打回 4px。
    const src = read("../src/views/study/practices.ts");
    expect(src).toContain('seekSlider.style.setProperty("--yl-fill"');
  });
});

// ── 抄写卡（检查 / 重置 / 提示）──────────────────────────────────────────

describe("抄写卡", () => {
  function build(outcomeOk = true, hasDict = true) {
    const onReset = vi.fn(async () => progressRow());
    const onImeHelp = vi.fn();
    const onNeedDict = vi.fn();
    const onSubmit = vi.fn(async () => ({
      result: outcomeOk
        ? { level: "correct" as const, ok: true, accuracy: 1, ops: [], hint: "" }
        : {
            level: "wrong" as const,
            ok: false,
            accuracy: 0.5,
            ops: [{ op: "missing" as const, expected: "猫", actual: "" }],
            hint: "",
          },
      progress: outcomeOk
        ? progressRow({ copyDoneAt: new Date().toISOString(), copyText: slice.ja })
        : progressRow(),
    }));
    const handle: CopyPracticeHandle = buildCopyPractice({
      onSubmit: onSubmit as unknown as Parameters<typeof buildCopyPractice>[0]["onSubmit"],
      onReset,
      getRomaji: vi.fn(async () => "neko"),
      hasDict: () => hasDict,
      onNeedDict,
      loadDraft: vi.fn(async () => ""),
      saveDraft: vi.fn(async () => undefined),
      onImeHelp,
    });
    handle.load(slice, undefined);
    return { handle, onSubmit, onReset, onImeHelp, onNeedDict };
  }

  it("头部提示里的「日语输入法」是可点词，点了触发 onImeHelp（帮助弹窗的出口）", () => {
    const { handle, onImeHelp } = build();
    const link = buttonByText(handle.root, "日语输入法");
    link.click();
    expect(onImeHelp).toHaveBeenCalledTimes(1);
  });

  it("空草稿：检查与重置都置灰；敲上字后检查可点、点了送 onSubmit（带句子 cid）", () => {
    const { handle, onSubmit } = build();
    const check = buttonByText(handle.root, "检查");
    const reset = buttonByText(handle.root, "重置");
    expect(check.disabled).toBe(true);
    expect(reset.disabled).toBe(true);

    const draft = draftAreaOf(handle.root);
    draft.value = slice.ja;
    draft.dispatchEvent(new Event("input"));
    expect(check.disabled).toBe(false);
    expect(reset.disabled).toBe(false);

    check.click();
    expect(onSubmit).toHaveBeenCalledWith(slice.ja, slice.cid);
  });

  it("抄写已通过（留档态）：检查置灰、重置可点，头部「正解 ✓」", () => {
    const { handle, onReset } = build();
    handle.load(slice, progressRow({ copyDoneAt: new Date().toISOString(), copyText: slice.ja }));

    const status = handle.root.querySelector(".yl-step-status");
    expect(status?.textContent).toBe("正解 ✓");
    expect(status!.classList.contains("yl-step-status-ok")).toBe(true);
    expect(buttonByText(handle.root, "检查").disabled).toBe(true);
    const reset = buttonByText(handle.root, "重置");
    expect(reset.disabled).toBe(false);

    reset.click();
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("「提示」点开键序罗马音行，再点收起", () => {
    const { handle } = build();
    const hint = buttonByText(handle.root, "提示");
    const romaji = handle.root.querySelector<HTMLElement>(".yl-copy-romaji")!;

    hint.click();
    expect(romaji.style.display).not.toBe("none");

    hint.click();
    expect(romaji.style.display).toBe("none");
  });

  it("词典没装上：点「提示」不摆罗马音行，转去要「安装词典」（每次点都说）", () => {
    // 2026-10-11 用户拍板：词典引导只放两处，抄写提示是其中之一 ——
    // 用户主动要读音的那一刻，是唯一值得打断他的时刻。
    const { handle, onNeedDict } = build(true, false);
    const hint = buttonByText(handle.root, "提示");
    const romaji = handle.root.querySelector<HTMLElement>(".yl-copy-romaji")!;

    hint.click();
    hint.click();

    expect(onNeedDict).toHaveBeenCalledTimes(2);
    expect(romaji.style.display).toBe("none");
  });

  it("装完词典：showRomaji() 直接把罗马音行补上，不用再点一次「提示」", async () => {
    const { handle } = build();
    const romaji = handle.root.querySelector<HTMLElement>(".yl-copy-romaji")!;
    expect(romaji.style.display).toBe("none");

    handle.showRomaji();

    await vi.waitFor(() => expect(romaji.textContent).toContain("neko"));
    expect(romaji.style.display).not.toBe("none");
  });

  it("抄写没对上：头部「未通过 ✕」（浅红）—— 抄写逐字比对，只有对/错两档", async () => {
    const { handle } = build(false);
    const draft = draftAreaOf(handle.root);
    draft.value = "猫が寝てる。";
    draft.dispatchEvent(new Event("input"));
    buttonByText(handle.root, "检查").click();

    const status = handle.root.querySelector(".yl-step-status") as HTMLElement;
    await vi.waitFor(() => expect(status.textContent).toBe("未通过 ✕"));
    expect(status.classList.contains("yl-step-status-bad")).toBe(true);
  });
});

// ── 抄写提示的键帽切分（2026-10-09 用户报「漏单词」的防回归钉子）─────────────

describe("抄写提示键帽切分", () => {
  it("长音键 - 是合法键帽：含长音的词不再整颗消失", () => {
    // 现场句：灯ちゃんホントにボーカルだったんだね —— 修复前 bo-karu 被过滤，
    // 提示行只剩 da tta n da ne，整词凭空蒸发
    expect(romajiKeycaps("tomori chan honto ni bo-karu da tta n da ne")).toEqual([
      "tomori",
      "chan",
      "honto",
      "ni",
      "bo-karu",
      "da",
      "tta",
      "n",
      "da",
      "ne",
    ]);
    // 孤零零的长音键也留（読み只有ー时）
    expect(romajiKeycaps("bo-")).toEqual(["bo-"]);
  });

  it("不能敲的符号词照旧丢掉，不做占位", () => {
    expect(romajiKeycaps("konnichiha 。『』 watashi")).toEqual(["konnichiha", "watashi"]);
    expect(romajiKeycaps("")).toEqual([]);
  });
});

// ── 小助手（402 → 统一弹窗，不就地摆提示）────────────────────────────────

describe("小助手", () => {
  it("真问出 402：走 onNoBalance 统一弹窗，面板里不冒提示行", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 402, text: async () => "" })));
    const onNoBalance = vi.fn();
    const handle: AssistantHandle = buildAssistant({
      onSettings: () => hostedSettings(),
      onPricing: () => {},
      getGate: () => OPEN,
      checkGate: () => Promise.resolve(OPEN),
      onNeedSetup: () => {},
      onNoBalance,
      // 用户头像取账号快照；测试里给个固定的首字占位即可（不测图）
      getUserAvatar: () => ({ url: null, initial: "洋" }),
    });
    handle.load(slice);
    handle.prompt("这一句怎么仿写？");

    await vi.waitFor(() => expect(onNoBalance).toHaveBeenCalledTimes(1));
    const hint = handle.root.querySelector(".yl-assistant-hint");
    expect(hint).not.toBeNull();
    expect(hint!.getAttribute("style")).toContain("none");
  });
});

// ── 服务端 402 的机器可读错误码 ──────────────────────────────────────────

describe("402 错误码", () => {
  it("内置模型 402 → AiUnavailableError 带 code=need-balance（StudyView 靠它分流到弹窗）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 402, text: async () => "" })));
    const error = await explainSentence(
      { ja: slice.ja, zh: slice.zh, words: ["猫"] },
      hostedSettings(),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(AiUnavailableError);
    expect((error as AiUnavailableError).code).toBe("need-balance");
  });

  it("isNoBalanceError 只认 code，普通报错不误伤", () => {
    expect(isNoBalanceError(new AiUnavailableError("x", "need-balance"))).toBe(true);
    expect(isNoBalanceError(new AiUnavailableError("x"))).toBe(false);
    expect(isNoBalanceError(new Error("x"))).toBe(false);
    expect(isNoBalanceError("need-balance")).toBe(false);
  });
});

// ── 源码钉子：接线本身不许拆 ─────────────────────────────────────────────

describe("AI 提醒弹窗的接线钉子（2026-10-04 用户令：改没了测试必须红）", () => {
  const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

  it("StudyView 的各个 AI 出口（解析两块/核对/跟读核对）都接了 need-balance 弹窗分流", () => {
    const src = read("../src/views/StudyView.ts");
    // 各条会撞 402 的出口，逐个点清（2026-10-08 更新）：
    //   1 跟读核对（requestReadAloudCheck）
    //   1 仿写核对（verifyImitation）
    //   2 解读那一块 —— 2026-10-08 改流式后**一分为二**：流本身失败一次、
    //     一个字都没到时的非流式退路再判一次（都要能弹充值窗）
    //   2 逐词释义 —— 首次 + 失败重试一次
    expect(src.match(/isNoBalanceError\(/g)?.length).toBe(6);
    // 上面对应的 6 处 catch + 助手 onNoBalance 接线，共 7 处
    expect(src.match(/this\.handleOutOfBalance\(\)/g)?.length).toBe(7);
    // 统一弹窗本体还在（配置窗 + 充值窗至少各一处实例化）
    expect(src.match(/new ModelSetupModal\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("助手的 402 走 onNoBalance，不落就地提示", () => {
    // 2026-10-09 改真流式后**一分为二**：正文已经吐了一部分才失败、和
    // 一个字都没到就失败，两条路都要能弹「余额用完」窗 —— 漏一条 =
    // 换个触发条件就静默不弹（用户以为还能问，其实钱没了）。
    expect(read("../src/views/study/assistant.ts").match(/isNoBalanceError\(/g)?.length).toBe(2);
  });

  it("「重新解析」只重算左侧解读：句子卡那一路（词表 / 压灰 / 闪卡）都不碰", () => {
    // 🔥 2026-10-08 用户拍板：右侧句子卡上的逐词释义没有变过，再跑一遍等于为同一份
    //    词表再付一次钱。这条钉子钉的就是"它没被顺手带回去重算" —— 那种回退不报错，
    //    只是账单上多一笔、卡片多闪一下。
    const src = read("../src/views/StudyView.ts");
    const start = src.indexOf("private async reparseExplanation");
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf("\n  private ", start + 10);
    const body = src.slice(start, next < 0 ? undefined : next);

    // 只发解读那一块（共用流式出口），不发 words 请求
    expect(body).toContain("streamExplanation(");
    expect(body).not.toContain("fetchWords(");
    // 句子卡不参与：不压灰、不重铺读音、不闪卡
    expect(body).not.toContain("setHeroWordsPending(");
    expect(body).not.toContain("loadHeroReading(");
    expect(body).not.toContain("flashHero(");
    // 新解读**并进**已有记录（词表/读音/词源原样保留），不是整份覆盖
    expect(body).toContain("mergeExplanation(");
    // 确认窗的确认出口必须接到这条路上（别回到会重算两块的那条）
    expect(src).toContain("void this.reparseExplanation()");

    // 🔥 而且**必须带 `refresh`** —— 不带它，服务端照旧回解析缓存里那一份，
    //    用户点的"重新解析"看上去就是按了没反应（2026-10-08 实机报的 bug）。
    expect(body).toContain("slice, true)");
    // 没有本机落档、退回"两块一起"那条例外上，左侧那一块照样要 refresh
    expect(body).toContain("handleExplain(input.words, true)");
  });

  it("refresh 要一路传到请求上：流式与非流式退路**两个出口都得带**", () => {
    // 🔥 非流式那条是"流式坏了之后的退路"。漏传 refresh 就变成"流式一坏，
    //    重新解析又回去读缓存" —— 同一个 bug 换了个触发条件，而且不报错、
    //    日志里干干净净，只能靠这条钉子拦住。
    const src = read("../src/views/StudyView.ts");
    const start = src.indexOf("private async streamExplanation");
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf("\n  private ", start + 10);
    const body = src.slice(start, next < 0 ? undefined : next);

    expect(body).toContain("refresh = false");
    expect(body.match(/\{ refresh \}/g)?.length).toBe(2);
  });

  it("仿写卡不再有 showNotice 这个行内提示口子", () => {
    expect(read("../src/views/study/practices.ts")).not.toContain("showNotice");
  });

  it("跟读卡不再自动核对（2026-10-07 推翻「录完即核对」）：「检查」钮常驻，收尾不许自动跑核对", () => {
    const src = read("../src/views/study/practices.ts");
    // 跟读那一半 = 抄写卡之前的部分
    const readAloudHalf = src.slice(0, src.indexOf("// ── 抄写"));
    // ⚠️ 只断言前缀：这颗钮 2026-10-08 起还挂了定宽的类名（`cls: "yl-read-checkbtn"`），
    //    这里钉的是"「检查」钮还在、还是那颗常驻的"，不是它的类名拼写。
    expect(readAloudHalf).toContain('createButton(actions, { text: "检查"');
    expect(readAloudHalf).not.toContain("saveButton");
    // 录完只入库不核对：finalizeRecording 的收尾里不许再出现自动核对
    expect(readAloudHalf).not.toContain("void runCheck(forSliceCid);");
  });

  it("三张卡都没有「保存」按钮（2026-10-07：数据自动保存，检查归人点）", () => {
    const src = read("../src/views/study/practices.ts");
    expect(src).not.toContain('text: "保存"');
  });

  it("门控必须把没余额当不放行处理", () => {
    const src = read("../src/services/ai/gate.ts");
    expect(src).toContain('"need-balance"');
    expect(src).toContain("aiBalanceMillis <= 0");
  });
});
