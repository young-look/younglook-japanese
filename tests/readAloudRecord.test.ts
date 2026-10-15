// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "./obsidianDom";

// 必须先装 DOM 扩展再调卡片构建函数（构建函数运行时才碰 DOM，import 顺序无忧）
installObsidianDomHelpers();

/**
 * 跟读卡「录完的收尾」契约（2026-10-10 用户拍板 · 2026-10-15 三次修正后定稿）。
 *
 * ── 老流程（2026-10-03 口径，已推翻）────────────────────────────────────
 *   `await trimRecording(raw)` → 才 `audio.src = 剪好的` → 才上屏。
 *   两个病：① 录完要干等「处理中…」；② 回听那下和重编码（重 CPU）撞车 → 中段断。
 *
 * ── 现行流程 ───────────────────────────────────────────────────────────
 *   **原始录音先上屏**（录完立刻能听，保底），重封装挪到后台；
 *   干净 webm 用来**换播放源 + 送核对 + 入库**。原文件仍然不留。
 *
 * 🔥 病根与换源时机（2026-10-15 第三次定位，彻底坐实）：
 *   **病根 = MediaRecorder 直接产出的 webm 是「单簇 + 单一索引点」**，播放器首播要
 *   自己找索引 → 开头顿一下；而 webm-muxer 重封装出来的是「多簇 + 多索引 + 写死时长」，
 *   首播顺（用户亲证：老录音——就是重封装过的——第一次播不卡）。所以"先播原始件"
 *   这个方向本身是错的：它让第一遍听的恰恰是会卡的那份。
 *   正确做法：重封装只要 ~100ms，远快于人手点播放（≥200ms）—— 重封装件一回来，
 *   **只要还没开听就立刻换成干净 webm**，第一遍就顺；只有抢在它回来之前已经开听了
 *   （几乎不可能，保底）才等这一遍 `ended` 再换，绝不打断在播的那份。
 *
 * 这里钉七条 —— 每一条断了都是用户当场能听见/能丢数据的：
 *   1. 录完立刻能听：第一个 blob URL 就是原始件，且**不等**重封装回来；
 *   2. 重封装回来**按是否开听分流**：
 *      · 还没开听 → **立刻**换播放源成干净 webm（第一遍就听多簇多索引的那份）；
 *      · 已经在听（点过播放 / 拖过进度）→ **一个字节都不动**，记成待换，等这一遍
 *        `ended` 才挂上 —— 换 src 会把正在播（或已拖好位置）的那份打断并复位；
 *   3. 「检查」送出去的是**干净 webm**（时长也用它），不是原始件；
 *   4. 封不出来（环境不支持 / 解码 / 编码失败）→ 退回原始件，录音不丢、也不换源；
 *   5. 换句 / 重置 / 重录之后，**迟到的重封装结果不许落库、也不许留下来** —— 否则会把
 *      用户刚删掉的录音又救回来、或者把上一句的声音挂到新的一句上；
 *   6. 收尾没有「处理中…」过场：录完立刻回到可再录的态；
 *   7. ⚠️ **静音预热已整体撤除**（曾作为"第一遍播就卡"的修法，实机成了「录完回听完全没声」
 *      的元凶 —— 蓝牙耳机从 HFP 切回 A2DP 的窗口里，预热让输出持续活跃把路由卡死）。
 *      钉子改成：**任何代码路径都不许改写播放器音量**（无声事故面 = "借走音量"）；
 *      录音**一律用系统当前默认的输入设备**（2026-10-15 用户口径：各用各的 —— 插件不替
 *      用户挑设备、不在输入/输出之间做交叉选择，用户在系统里选什么插件就用什么）。
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
import type { ProgressRow, StudySentence } from "../src/types/entities";

const sliceAt = (cid: string): StudySentence => ({
  cid,
  index: 1,
  startMs: 0,
  endMs: 1500,
  ja: "猫が寝ている。",
  zh: "猫在睡觉。",
  speaker: "",
  textHash: "hash",
  analysis: null,
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

/**
 * 把麦克风换成指定那一支。
 *
 * @returns `stopped()` —— 这条流的音轨被 stop 过没有。验"取消录音必须放开麦克风"
 *   靠它：macOS 上麦克风不释放，菜单栏上的小橙点会一直亮着。
 */
function setMicDevice(label: string, sampleRate?: number): { stopped: () => boolean } {
  let stopped = false;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [
          {
            label,
            getSettings: () => ({ sampleRate }),
            stop: () => {
              stopped = true;
            },
          },
        ],
      })),
    },
  });
  return { stopped: () => stopped };
}

/** 蓝牙耳机的典型长相：名字带 AirPods，且 HFP 通话模式把采样率压到 16kHz。 */
const useBluetoothMic = (): { stopped: () => boolean } =>
  setMicDevice("Michael 的 AirPods Pro", 16000);

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
  // 默认给一支本机内置麦（48kHz、名字里没有蓝牙特征）—— 现有用例走的都是
  // "没命中蓝牙"那条路；要命中就用 useBluetoothMic() 换掉。
  setMicDevice("MacBook Pro 麦克风", 48000);
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

function build(extra?: Partial<Parameters<typeof buildReadAloud>[0]>): Harness {
  const onVerify = vi.fn(async () => ({ status: "ok", message: "", verified: true }) as const);
  const onReset = vi.fn(async () => ({}) as ProgressRow);
  const loadRecording = vi.fn(async () => null);
  const opts = {
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
  };
  // extra 留给"蓝牙麦克风那句问询"这类按用例才有的回调
  const handle = buildReadAloud(extra ? { ...opts, ...extra } : opts);
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

  it("重封装回来（还没开听）→ **立刻**换上干净 webm：第一遍就听多簇多索引的那份", async () => {
    const trimmedBlob = new Blob([TRIMMED_BYTES], { type: "audio/webm" });
    trimCtl.result = { blob: trimmedBlob, seconds: 3.2, removed: 1.5 };
    const { handle, onVerify } = build();

    await recordAndStop(handle);
    await flush(); // 重封装已经落定（真机上只要 0.1 秒，比人手快得多）

    // ① 播放源**立刻换成干净 webm** —— 第一遍就不听单簇单索引的原始件（病根）
    expect(created).toHaveLength(2);
    expect(created[0].size).toBe(RAW_BYTES.length);
    expect(created[1]).toBe(trimmedBlob);
    expect(playerSrc()).toBe("blob:2");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:1");
    // 时长跟着换成干净 webm 的（jsdom 读不到 audio.duration，走 current.seconds）
    expect(handle.root.querySelector(".yl-read-clock")?.textContent).toContain("3.2");

    // ② 入库：存的仍是**干净 webm**（原文件不留 · 2026-10-03 口径不变）
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

    // ③ 「检查」送出去的也是干净 webm，时长用解码出来的（0.2 秒的留白不进判定）
    buttonByText(handle.root, "检查").click();
    await flush();
    expect(onVerify).toHaveBeenCalledTimes(1);
    const payload = onVerify.mock.calls[0][0] as { blob: Blob; mimeType: string; seconds: number };
    expect(payload.blob).toBe(trimmedBlob);
    expect(payload.mimeType).toBe("audio/webm");
    expect(payload.seconds).toBe(3.2);
  });

  it("已经在听了，重封装才回来：不打断，等这一遍播完（ended）才换上", async () => {
    const hold = deferred();
    trimCtl.gate = hold.promise; // 先把重封装挂住
    const trimmedBlob = new Blob([TRIMMED_BYTES], { type: "audio/webm" });
    trimCtl.result = { blob: trimmedBlob, seconds: 3.2, removed: 1.5 };
    const { handle } = build();

    await recordAndStop(handle);
    // 用户已经点播放（在重封装回来之前）—— 这时 listeningStarted = true
    (bar(handle).querySelector("button") as HTMLButtonElement).click();
    await flush();

    hold.resolve(); // 重封装这时才回来
    await flush();
    // 已经在听了：不立刻换，只是记成"待换"，播放源仍是原始件
    expect(created).toHaveLength(1);
    expect(playerSrc()).toBe("blob:1");

    // 这一遍播完（ended）→ 才换上干净 webm，旧的立刻放掉
    audioEls[0].dispatchEvent(new Event("ended"));
    await flush();
    expect(created).toHaveLength(2);
    expect(created[1]).toBe(trimmedBlob);
    expect(playerSrc()).toBe("blob:2");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:1");
    expect(handle.root.querySelector(".yl-read-clock")?.textContent).toContain("3.2");
  });

  it("正在播的时候重封装才回来：一个字节都不动（换源会打断并复位）", async () => {
    const hold = deferred();
    trimCtl.gate = hold.promise; // 先把重封装挂住，好让用户抢在它回来之前开听
    const trimmedBlob = new Blob([TRIMMED_BYTES], { type: "audio/webm" });
    trimCtl.result = { blob: trimmedBlob, seconds: 3.2, removed: 1.5 };
    const { handle, onVerify } = build();

    await recordAndStop(handle);
    // 用户点播放（重封装还没回来）
    (bar(handle).querySelector("button") as HTMLButtonElement).click();
    await flush();

    hold.resolve(); // 重封装这时才回来
    await flush();

    // ① 播放源没被动过：只有一次 createObjectURL，还是原始件那条 URL。
    //    ⚠️ 已经在听时改 `audio.src` 会把正在播的那一份打断并复位，正是要修的毛病的近亲。
    expect(created).toHaveLength(1);
    expect(playerSrc()).toBe("blob:1");
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    // ② 存档 / 核对照旧换成干净 webm
    expect(saveRecording).toHaveBeenCalledTimes(1);
    expect((saveRecording.mock.calls[0] as [string, Blob])[1]).toBe(trimmedBlob);

    buttonByText(handle.root, "检查").click();
    await flush();
    const payload = onVerify.mock.calls[0][0] as { blob: Blob };
    expect(payload.blob).toBe(trimmedBlob);
  });

  it("拖过进度条之后重封装才回来：位置不被复位，等播完才换", async () => {
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

    // 换源会把用户刚拖好的位置复位 —— 所以拖过之后重封装回来同样不许碰播放源
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

  // ── ⚠️ 静音预热已整体撤除（2026-10-15 深夜）─────────────────────────────
  //
  // 它曾是"第一遍播就卡"的候选修法，实测成了「录完回听**完全没声**」的元凶：
  // 蓝牙耳机（AirPods）录音结束要从 HFP 切回 A2DP，预热让音频输出在这个切换窗口里
  // 持续活跃，把输出路由卡死。录完到点播放之间的**自然静默**正是系统切设备需要的。
  // 留一条钉子：播放器的音量属于用户，**任何代码路径都不许改写它** ——
  // "完全没声"这种事故面，就是从"借走音量"开始的。

  it("回听条音量恒为 1：任何代码路径都不许改写（无声事故的回归钉子）", async () => {
    const { handle } = build();
    await recordAndStop(handle);
    expect(audioEls[0].volume).toBe(1);

    // 换句 / 重置 / 播放之后再查一遍 —— 不许有任何路径把音量留在 0
    handle.load(sliceAt("slice-2"), undefined);
    await flush();
    expect(audioEls[0].volume).toBe(1);

    FakeRecorder.instances = []; // recordAndStop 内部断言"恰好一台录音机"，重录前清掉上一台的计数
    await recordAndStop(handle);
    (bar(handle).querySelector("button") as HTMLButtonElement).click();
    await flush();
    expect(audioEls[0].volume).toBe(1);
    expect(audioEls[0].loop).toBe(false);
  });

  // ── 🔒 录音设备：**各用各的**（2026-10-15 用户最终口径）──────────────────
  //
  // 插件**不替用户挑麦克风**：一律 `getUserMedia({ audio: micConstraints() })`，不指定
  // `deviceId`、不枚举设备、不在输入与输出之间做交叉选择。用户在系统声音设置里选了什么
  // （AirPods 麦就 AirPods 麦、Mac 内置麦就内置麦），插件就照用什么。
  // 曾落地过「录音避开蓝牙麦」（pickBuiltInMicDeviceId + avoidBluetoothInput 两层），
  // **被用户明确否决并整套删除** —— 不许再加回来。

  it("录音用系统默认输入设备：`getUserMedia` 一个 deviceId 都不传", async () => {
    const { handle } = build();
    await recordAndStop(handle);

    const gum = navigator.mediaDevices.getUserMedia as unknown as { mock: { calls: unknown[][] } };
    expect(gum.mock.calls.length).toBeGreaterThan(0);
    for (const call of gum.mock.calls) {
      const constraints = call[0] as { audio?: Record<string, unknown> };
      // ① 不许带 deviceId —— 带了就是又在替用户挑设备
      expect((constraints.audio ?? {}).deviceId).toBeUndefined();
      // ② 三个"音频处理"仍然必须关掉（AGC 会按时间改写音量，回听着像越来越小）
      expect((constraints.audio ?? {}).autoGainControl).toBe(false);
      expect((constraints.audio ?? {}).echoCancellation).toBe(false);
      expect((constraints.audio ?? {}).noiseSuppression).toBe(false);
    }
  });
});

/**
 * 蓝牙麦克风：**只告知一次，不替用户换设备**（2026-10-16 用户口径）。
 *
 * 蓝牙耳机一开麦就被系统压进 HFP 通话模式（采样率掉到 8/16kHz），录出来会闷 ——
 * 这是蓝牙协议的限制，插件改不了。用户要的只是"告诉我一声"，然后**他自己决定**：
 *   · 继续用蓝牙录 → 照录不误；
 *   · 不录了 → 放开麦克风，他自己去系统设置里换。
 * ⚠️ 所以这里**没有任何一处**会去指定别的 `deviceId`（那条的路已被明确否决）。
 */
describe("跟读卡：蓝牙麦克风只问一句（2026-10-16 用户口径）", () => {
  /** 命中时的那句问询（`() => true` = 上层弹窗了，先不给答复） */
  const asking = () => vi.fn(() => true);
  /** 问询包：取到它才能在用例里扮演"用户在窗里点了哪个钮" */
  const askedWith = (hint: ReturnType<typeof asking>) =>
    (hint.mock.calls as unknown as unknown[][])[0][0] as {
      deviceName: string;
      sampleRate: number;
      onContinue(): void;
      onCancel(): void;
    };

  it("用的是蓝牙麦 → 先问一句：拿到麦克风就把来龙去脉交出去，暂不开录", async () => {
    useBluetoothMic();
    const onBluetoothMicHint = asking();
    const { handle } = build({ onBluetoothMicHint });

    buttonByText(handle.root, "开始录音").click();
    await flush();

    // ① 问了，而且把证据都带出来了
    expect(onBluetoothMicHint).toHaveBeenCalledTimes(1);
    expect(askedWith(onBluetoothMicHint).deviceName).toBe("Michael 的 AirPods Pro");
    expect(askedWith(onBluetoothMicHint).sampleRate).toBe(16000);
    // ② 用户还没表态，录音机一台都没建 —— 不许抢跑
    expect(FakeRecorder.instances).toHaveLength(0);
  });

  it("用户说「就用它录」→ 照常开录（一个设备都不替他换）", async () => {
    useBluetoothMic();
    const onBluetoothMicHint = asking();
    const { handle } = build({ onBluetoothMicHint });

    buttonByText(handle.root, "开始录音").click();
    await flush();
    askedWith(onBluetoothMicHint).onContinue();
    await flush();

    expect(FakeRecorder.instances).toHaveLength(1);
    // 从头到尾只有一次 getUserMedia，用的还是系统默认那支蓝牙麦 —— 没有任何"换一下试试"
    const gum = navigator.mediaDevices.getUserMedia as unknown as { mock: { calls: unknown[][] } };
    expect(gum.mock.calls).toHaveLength(1);
    expect((gum.mock.calls[0][0] as { audio: Record<string, unknown> }).audio.deviceId).toBeUndefined();
  });

  it("用户说「先不录」→ 取消这次，**立刻把麦克风放开**、卡片回到能再录的态", async () => {
    const mic = useBluetoothMic();
    const onBluetoothMicHint = asking();
    const { handle } = build({ onBluetoothMicHint });

    buttonByText(handle.root, "开始录音").click();
    await flush();
    askedWith(onBluetoothMicHint).onCancel();
    await flush();

    // ① 音轨停掉了 —— 不停的话 macOS 菜单栏那个小橙点会一直亮着，看着像还在偷录
    expect(mic.stopped()).toBe(true);
    // ② 没有录音机、没有上屏的音频
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(created).toHaveLength(0);
    // ③ 录音钮回到「开始录音」，点了还能再录
    expect(buttonByText(handle.root, "开始录音").disabled).toBe(false);
  });

  it("等用户表态的那会儿换了句：回调迟到也不能把录音挂到新句子上", async () => {
    useBluetoothMic();
    const onBluetoothMicHint = asking();
    const { handle } = build({ onBluetoothMicHint });

    buttonByText(handle.root, "开始录音").click();
    await flush();
    // 用户在窗还开着的时候翻了下一句 —— abort() 会把那条麦克风流停掉
    handle.load(sliceAt("slice-2"), undefined);
    await flush();

    // 迟到的「就用它录」必须被吞掉：`stream` 已经没了，硬录会在 new MediaRecorder(null) 上炸
    expect(() => askedWith(onBluetoothMicHint).onContinue()).not.toThrow();
    await flush();
    expect(FakeRecorder.instances).toHaveLength(0);
  });

  it("用的是本机麦克风采音正常 → 一句都不问", async () => {
    const onBluetoothMicHint = asking();
    const { handle } = build({ onBluetoothMicHint });

    await recordAndStop(handle);

    expect(onBluetoothMicHint).not.toHaveBeenCalled();
    expect(FakeRecorder.instances).toHaveLength(1);
  });
});
