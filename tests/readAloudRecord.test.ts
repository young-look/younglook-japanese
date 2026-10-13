// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "./obsidianDom";

// 必须先装 DOM 扩展再调卡片构建函数（构建函数运行时才碰 DOM，import 顺序无忧）
installObsidianDomHelpers();

/**
 * 跟读卡「录完的收尾」契约（2026-10-10 用户拍板）。
 *
 * ── 老流程（2026-10-03 口径，本次推翻）──────────────────────────────────
 *   `await trimRecording(raw)` → 才 `audio.src = 剪好的` → 才上屏。
 *   两个病：
 *     ① 录完要干等一个「处理中…」，不能立刻回听；
 *     ② "录完立刻回听"那一下，正好和重编码（`OfflineAudioContext` 解码 +
 *        Opus 重编码，都是重 CPU）**撞在一起** —— 回听会在**中段断一下**。
 *
 * ── 新流程 ─────────────────────────────────────────────────────────────
 *   **原始录音先上屏**（录完立刻能听、也不跟裁剪抢 CPU），裁剪挪到后台；
 *   剪好的那份用来**换播放源（用户还没开听时）+ 送核对 + 入库**。原文件仍然不留。
 *
 * 这里钉六条 —— 每一条断了都是用户当场能听见/能丢数据的：
 *   1. 录完立刻能听：第一个 blob URL 就是原始件，且**不等**裁剪回来；
 *   2. 裁剪回来时按「用户有没有开听」分流：
 *      · 还没开听 → 播放源换成剪好的那份（第一遍就听到干净版本，不必先听一截留白）；
 *      · 已经在听（点过播放 / 拖过进度）→ **一个字节都不动** —— 换 `audio.src`
 *        会把正在播（或已拖好位置）的那一份打断并复位；
 *   3. 「检查」送出去的是**剪好的**那份（时长也用它），不是原始件；
 *   4. 剪不出来（没得剪 / 环境不支持 / 出岔子）→ 退回原始件，录音不丢、也不换源；
 *   5. 换句 / 重置 / 重录之后，**迟到的裁剪结果不许落库** —— 否则会把用户
 *      刚删掉的录音又救回来（同理也不许换源）。
 */

const trimCtl = vi.hoisted(() => ({
  /** 假裁剪器返回什么：`blob: null` = 没得剪/剪不出来（jsdom 里的真实行为就是这个） */
  result: { blob: null as Blob | null, seconds: 0, removed: 0 },
  /** 让"后台裁剪"可以被挂住，用来验"上屏不等它"和"迟到的结果要作废" */
  gate: Promise.resolve() as Promise<void>,
  calls: 0,
}));

vi.mock("../src/services/audioTrim", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/audioTrim")>();
  return {
    ...actual,
    trimRecording: async (_blob: Blob) => {
      trimCtl.calls += 1;
      await trimCtl.gate;
      return trimCtl.result;
    },
  };
});

import { buildReadAloud, type ReadAloudHandle } from "../src/views/study/practices";
import type { ProgressRow, SliceRow } from "../src/types/entities";

const sliceAt = (cid: string): SliceRow => ({
  cid,
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
  clientUpdatedAt: "2026-10-10T00:00:00Z",
  deletedAt: null,
});

const RAW_BYTES = "raw-bytes"; // 9 字节 —— 用体积当"这是哪一份"的指纹
const TRIMMED_BYTES = "trimmed-bytes"; // 13 字节

/** 假 MediaRecorder：`stop()` 就按真机顺序吐一块数据再触发 onstop。 */
class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = (): boolean => true;
  mimeType: string;
  state = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? "audio/webm";
    FakeRecorder.instances.push(this);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    const chunk = new Blob([RAW_BYTES], { type: this.mimeType });
    this.ondataavailable?.({ data: chunk });
    this.onstop?.();
  }
}

const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === text,
  );
  if (!found) throw new Error(`卡片里找不到按钮「${text}」`);
  return found;
}

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const originalAudio = window.Audio;
const originalMediaRecorder = (window as unknown as Record<string, unknown>).MediaRecorder;
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

let created: Blob[] = [];
let saveRecording: ReturnType<typeof vi.fn>;

/**
 * 卡片里的播放器是 `new Audio()`（刻意不进 DOM），测试本来碰不到它。
 * 这里把全局 `Audio` 换成"建完就把实例留下来"的壳 —— 好断言**现在挂着的是哪一份文件**，
 * 这是"裁剪回来到底换没换源"的唯一直接证据。
 */
let audioEls: HTMLAudioElement[] = [];

/** 播放器现在挂着的播放源（= 真正会出声的那一份）。空串 = 没挂 */
const playerSrc = (): string => audioEls[0]?.getAttribute("src") ?? "";

beforeEach(() => {
  trimCtl.result = { blob: null, seconds: 0, removed: 0 };
  trimCtl.gate = Promise.resolve();
  trimCtl.calls = 0;
  created = [];
  audioEls = [];
  saveRecording = vi.fn(async () => undefined);

  (window as unknown as Record<string, unknown>).Audio = function (this: unknown) {
    const element = new originalAudio();
    // jsdom 的 `play()` 是"未实现"（返回 undefined），但规范要求真浏览器返回 Promise，
    // 卡片里写的是 `void audio.play().catch(...)` —— 不补桩，一点播放就炸。补个最小实现。
    element.play = (() => Promise.resolve()) as unknown as typeof element.play;
    audioEls.push(element);
    return element;
  } as unknown as typeof Audio;

  URL.createObjectURL = ((blob: Blob) => {
    created.push(blob);
    return `blob:${created.length}`;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;

  FakeRecorder.instances = [];
  (window as unknown as Record<string, unknown>).MediaRecorder = FakeRecorder;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: () => undefined }] })),
    },
  });
});

afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  (window as unknown as Record<string, unknown>).Audio = originalAudio;
  (window as unknown as Record<string, unknown>).MediaRecorder = originalMediaRecorder;
  if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
});

interface Harness {
  handle: ReadAloudHandle;
  onVerify: ReturnType<typeof vi.fn>;
  onReset: ReturnType<typeof vi.fn>;
  loadRecording: ReturnType<typeof vi.fn>;
}

function build(): Harness {
  const onVerify = vi.fn(async () => ({ status: "ok", message: "", verified: true }) as const);
  const onReset = vi.fn(async () => ({}) as ProgressRow);
  const loadRecording = vi.fn(async () => null);
  const handle = buildReadAloud({
    onVerify: onVerify as unknown as Parameters<typeof buildReadAloud>[0]["onVerify"],
    onManualConfirm: vi.fn(async () => undefined),
    canUseAi: () => true,
    onRerecord: () => undefined,
    onReset: onReset as unknown as Parameters<typeof buildReadAloud>[0]["onReset"],
    loadRecording:
      loadRecording as unknown as Parameters<typeof buildReadAloud>[0]["loadRecording"],
    saveRecording: saveRecording as unknown as Parameters<
      typeof buildReadAloud
    >[0]["saveRecording"],
  });
  handle.load(sliceAt("slice-1"), undefined);
  return { handle, onVerify, onReset, loadRecording };
}

/**
 * 点「开始录音」并把那颗 100ms 计时器**接管**下来手动走拍。
 *
 * 不走真时间：`seconds` 不过 `MIN_RECORD_SECONDS`(0.8s) 的话，「停止」会被当成
 * 误触直接丢掉，那样反而测不到收尾。走 10 拍 = 1.0 秒。
 */
async function recordAndStop(handle: ReadAloudHandle): Promise<void> {
  const ticks: Array<() => void> = [];
  const spy = vi.spyOn(window, "setInterval").mockImplementation(((
    fn: () => void,
  ) => {
    ticks.push(fn);
    return 1;
  }) as unknown as typeof window.setInterval);
  buttonByText(handle.root, "开始录音").click();
  await flush();
  spy.mockRestore();
  expect(FakeRecorder.instances).toHaveLength(1);
  for (let i = 0; i < 10; i += 1) for (const tick of ticks) tick();
  buttonByText(handle.root, "停止").click();
  await flush();
}

const bar = (handle: ReadAloudHandle): HTMLElement =>
  handle.root.querySelector(".yl-read-controls") as HTMLElement;

describe("跟读卡：录完的收尾（原始件先上屏 · 裁剪走后台）", () => {
  it("录完立刻能听：第一个播放源就是**原始件**，不等后台裁剪", async () => {
    const hold = deferred();
    trimCtl.gate = hold.promise; // 把"后台裁剪"挂住 = 裁剪还没回来的那一瞬
    const { handle } = build();

    await recordAndStop(handle);

    // 原始件已经上屏：体积是 RAW_BYTES（9），不是剪好的那份（13）
    expect(created).toHaveLength(1);
    expect(created[0].size).toBe(RAW_BYTES.length);
    expect(playerSrc()).toBe("blob:1");
    expect(bar(handle).classList.contains("is-off")).toBe(false);
    expect((bar(handle).querySelector("button") as HTMLButtonElement).disabled).toBe(false);
    expect((bar(handle).querySelector("input[type=range]") as HTMLInputElement).disabled).toBe(
      false,
    );

    // 「检查」也可点 —— 不必等裁剪（它自己会等）
    expect(buttonByText(handle.root, "检查").disabled).toBe(false);
    // 关键：裁剪还挂着的时候，**一次入库都没发生**
    expect(saveRecording).not.toHaveBeenCalled();

    // 放行后台裁剪，收摊（免得悬挂的 promise 飘到下一个用例）
    hold.resolve();
    await flush();
  });

  it("用户还没开听：裁剪回来就把播放源换成剪好的那份 —— 第一遍听到的就是干净的", async () => {
    const trimmedBlob = new Blob([TRIMMED_BYTES], { type: "audio/webm" });
    trimCtl.result = { blob: trimmedBlob, seconds: 3.2, removed: 1.5 };
    const { handle, onVerify } = build();

    await recordAndStop(handle);
    await flush();

    // ① 播放源换成剪好的那份：一共两条 blob URL，第二条指向 13 字节那份
    expect(created).toHaveLength(2);
    expect(created[0].size).toBe(RAW_BYTES.length);
    expect(created[1]).toBe(trimmedBlob);
    expect(playerSrc()).toBe("blob:2");
    // 旧的那条 URL 立刻放掉 —— 不该等 releaseAudio 才回收
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:1");
    // 播放条上的时长也跟着换成剪出来的（jsdom 读不到 audio.duration，走 current.seconds）
    expect(handle.root.querySelector(".yl-read-clock")?.textContent).toContain("3.2");

    // ② 入库：存的是**剪好的**那份（原文件不留 · 2026-10-03 口径不变）
    expect(saveRecording).toHaveBeenCalledTimes(1);
    const [savedCid, savedBlob, savedMime, savedSeconds] = saveRecording.mock.calls[0] as [
      string,
      Blob,
      string,
      number,
    ];
    expect(savedCid).toBe("slice-1");
    expect(savedBlob).toBe(trimmedBlob);
    expect(savedMime).toBe("audio/webm");
    expect(savedSeconds).toBe(3.2);

    // ③ 「检查」送出去的也是剪好的那份，时长用剪出来的（0.2 秒的留白不进判定）
    buttonByText(handle.root, "检查").click();
    await flush();
    expect(onVerify).toHaveBeenCalledTimes(1);
    const payload = onVerify.mock.calls[0][0] as { blob: Blob; mimeType: string; seconds: number };
    expect(payload.blob).toBe(trimmedBlob);
    expect(payload.mimeType).toBe("audio/webm");
    expect(payload.seconds).toBe(3.2);
  });

  it("用户已经在听：裁剪回来**一个字节都不动播放源**，只换核对 / 存档那份", async () => {
    const hold = deferred();
    trimCtl.gate = hold.promise; // 先把裁剪挂住，好让用户抢在它回来之前开听
    const trimmedBlob = new Blob([TRIMMED_BYTES], { type: "audio/webm" });
    trimCtl.result = { blob: trimmedBlob, seconds: 3.2, removed: 1.5 };
    const { handle, onVerify } = build();

    await recordAndStop(handle);
    // 用户点播放（裁剪还没回来）
    (bar(handle).querySelector("button") as HTMLButtonElement).click();
    await flush();

    hold.resolve(); // 裁剪这时才回来
    await flush();

    // ① 播放源没被动过：只有一次 createObjectURL，还是原始件那条 URL。
    //    ⚠️ 剪好之后改 `audio.src` 会把正在播的那一份打断并复位，正是要修的毛病的近亲。
    expect(created).toHaveLength(1);
    expect(playerSrc()).toBe("blob:1");
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    // ② 存档 / 核对照旧换成剪好的那份
    expect(saveRecording).toHaveBeenCalledTimes(1);
    expect((saveRecording.mock.calls[0] as [string, Blob])[1]).toBe(trimmedBlob);

    buttonByText(handle.root, "检查").click();
    await flush();
    const payload = onVerify.mock.calls[0][0] as { blob: Blob };
    expect(payload.blob).toBe(trimmedBlob);
  });

  it("用户拖过进度条（还没播）：也算已经开始回听，同样不换源", async () => {
    const hold = deferred();
    trimCtl.gate = hold.promise;
    trimCtl.result = {
      blob: new Blob([TRIMMED_BYTES], { type: "audio/webm" }),
      seconds: 3.2,
      removed: 1.5,
    };
    const { handle } = build();

    await recordAndStop(handle);
    const slider = bar(handle).querySelector("input[type=range]") as HTMLInputElement;
    slider.value = "500";
    slider.dispatchEvent(new Event("input"));
    await flush();

    hold.resolve();
    await flush();

    // 换源会把用户刚拖好的位置复位 —— 所以拖动过就等于"已经开听了"
    expect(created).toHaveLength(1);
    expect(playerSrc()).toBe("blob:1");
  });

  it("剪不出来（没得剪 / 判不出 / 环境不支持）→ 退回原始件，录音不丢、检查照点", async () => {
    trimCtl.result = { blob: null, seconds: 0, removed: 0 };
    const { handle, onVerify } = build();

    await recordAndStop(handle);
    await flush();

    // 没剪出东西就**不换源** —— 把同一个文件再挂一遍只是白白重载，播放条还会闪一下
    expect(created).toHaveLength(1);
    expect(playerSrc()).toBe("blob:1");

    // 入库退回原始件（不能因为"剪不出来"就把录音弄丢）
    expect(saveRecording).toHaveBeenCalledTimes(1);
    const saved = saveRecording.mock.calls[0] as [string, Blob, string, number];
    expect(saved[1].size).toBe(RAW_BYTES.length);
    // 时长退回计时器数出来的那 1.0 秒（解码都失败时为 0）
    expect(saved[3]).toBe(1);

    buttonByText(handle.root, "检查").click();
    await flush();
    expect(onVerify).toHaveBeenCalledTimes(1);
    const payload = onVerify.mock.calls[0][0] as { blob: Blob; seconds: number };
    expect(payload.blob.size).toBe(RAW_BYTES.length);
    expect(payload.seconds).toBe(1);
  });

  it("换句之后迟到的那趟裁剪不许落库 —— 否则会把刚被清掉的录音又救回来", async () => {
    const hold = deferred();
    trimCtl.gate = hold.promise;
    trimCtl.result = { blob: new Blob([TRIMMED_BYTES], { type: "audio/webm" }), seconds: 3.2, removed: 1.5 };
    const { handle } = build();

    await recordAndStop(handle);
    expect(saveRecording).not.toHaveBeenCalled();

    // 换句（load 走 releaseAudio → 把收尾批次作废）
    handle.load(sliceAt("slice-2"), undefined);
    await flush();

    hold.resolve(); // 上一句的裁剪这时才回来
    await flush();

    expect(saveRecording).not.toHaveBeenCalled();
    // 作废的那趟裁剪同样不许碰播放源（这一句已经换了新录音 / 空了）
    expect(created).toHaveLength(1);
  });

  it("收尾不再有「处理中…」过场：录完立刻回到可再录的态", async () => {
    const { handle } = build();
    await recordAndStop(handle);

    // 主按钮回到「开始录音」且**可点** —— 后台裁剪不算过场，不必等它
    const record = buttonByText(handle.root, "开始录音");
    expect(record.disabled).toBe(false);
    expect(handle.root.textContent).not.toContain("处理中");
    expect(handle.root.textContent).not.toContain("正在剪掉");
  });
});
