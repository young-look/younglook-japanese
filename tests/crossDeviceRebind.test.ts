import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { progressCid, sliceCid } from "../src/core/ids";
import { STORE, VaultDb } from "../src/storage/db";
import {
  MIN_HIT_RATE,
  MIN_OFFSET_DENSITY,
  OFFSET_TOLERANCE,
  applyCrossDeviceRebind,
  collectCloudProgressRefs,
  hasAssociation,
  planCrossDeviceRebind,
  revertAssociation,
  type CloudProgressRef,
  type CrossDevicePlan,
  type LocalSliceRef,
} from "../src/services/crossDeviceRebind";
import type { ProgressRow, SliceRow } from "../src/types/entities";

/** 一条云端记录（旧句序 i）。 */
function cloud(i: number, sliceCid = `S:x${i}`): CloudProgressRef {
  return { sliceCid, sliceIndex: i };
}

/** 一个本地新切片（新句序 j）。 */
function local(j: number): LocalSliceRef {
  return { cid: `S:b${j}`, index: j };
}

const EMPTY_STATS = {
  cloudRows: 0, matched: 0, anchors: 0, aligned: 0, orphans: 0,
  hitRate: 0, offsetMedian: 0, offsetDensity: 0,
};

describe("planCrossDeviceRebind：位置锚定", () => {
  it("锚点充足、偏移一致 → 过闸并把未命中句按偏移对齐", () => {
    // local 50 句（0..49）；cloud 50 行。
    // index 10..29 的 cid 与 local 逐字相同（A/B 在这段完全一致）→ 命中，offset 0。
    const localSlices = Array.from({ length: 50 }, (_, j) => local(j));
    const cloudRows: CloudProgressRef[] = [];
    for (let i = 0; i < 50; i += 1) {
      cloudRows.push(i >= 10 && i <= 29 ? cloud(i, `S:b${i}`) : cloud(i));
    }

    const plan = planCrossDeviceRebind(cloudRows, localSlices);
    expect(plan.ok).toBe(true);
    expect(plan.stats.matched).toBe(20);
    expect(plan.stats.anchors).toBe(20);
    expect(plan.stats.offsetMedian).toBe(0);
    expect(plan.stats.offsetDensity).toBe(1);
    // 未命中 30 句，其中距最近锚点 ≤ EXTRAPOLATE_WINDOW(15) 的 25 句接上：
    //   · 头部旧 0..9：右锚点是旧 10，距离 10..1 → 接
    //   · 尾部旧 30..44：左锚点是旧 29，距离 1..15 → 接；旧 45..49 距离 16..20 → 落孤儿
    expect(plan.stats.orphans).toBe(5);
    expect(plan.pairs).toHaveLength(25);
    expect(plan.pairs).toContainEqual({ from: "S:x0", to: "S:b0" });
    expect(plan.pairs).toContainEqual({ from: "S:x44", to: "S:b44" });
    // 单侧锚点外推窗口之外：不接（外推越远越不可信）
    expect(plan.pairs).not.toContainEqual({ from: "S:x49", to: "S:b49" });
  });

  it("偏移散乱（断句重排）→ 闸门挡下，pairs 为空", () => {
    // 命中行一半 offset 0、一半 offset 10 → 集中度 0
    const localSlices = Array.from({ length: 80 }, (_, j) => local(j));
    const cloudRows: CloudProgressRef[] = [];
    for (let i = 0; i < 40; i += 1) {
      cloudRows.push(i % 2 === 0 ? cloud(i, `S:b${i}`) : cloud(i, `S:b${i + 10}`));
    }

    const plan = planCrossDeviceRebind(cloudRows, localSlices);
    expect(plan.ok).toBe(false);
    expect(plan.pairs).toHaveLength(0);
    expect(plan.stats.offsetDensity).toBeLessThan(0.7);
  });

  it("命中过少（锚点不足）→ 闸门挡下", () => {
    const localSlices = Array.from({ length: 50 }, (_, j) => local(j));
    const cloudRows: CloudProgressRef[] = [];
    for (let i = 0; i < 50; i += 1) cloudRows.push(cloud(i));
    // 只让 2 行命中
    cloudRows[0] = cloud(0, "S:b0");
    cloudRows[1] = cloud(1, "S:b1");

    const plan = planCrossDeviceRebind(cloudRows, localSlices);
    expect(plan.ok).toBe(false);
    expect(plan.stats.anchors).toBe(2);
    expect(plan.pairs).toHaveLength(0);
  });

  it("两侧锚点偏移不一致的段落不接（断句重排处留孤儿）", () => {
    // 段 A：旧 0..14 → 新 0..14（offset 0）
    // 段 B：旧 25..39 → 新 26..40（offset +1）
    // 段间旧 15..24 未命中，左右锚点相差 1（≤ 容差）→ 仍能接；
    // 若改成相差超过容差则整段落孤儿（见下一条）。
    const localSlices = Array.from({ length: 41 }, (_, j) => local(j));
    const cloudRows: CloudProgressRef[] = [];
    for (let i = 0; i <= 14; i += 1) cloudRows.push(cloud(i, `S:b${i}`));
    for (let i = 15; i <= 24; i += 1) cloudRows.push(cloud(i));
    for (let i = 25; i <= 39; i += 1) cloudRows.push(cloud(i, `S:b${i + 1}`));

    const plan = planCrossDeviceRebind(cloudRows, localSlices);
    expect(plan.ok).toBe(true);
    // 旧 15..19 取左锚 offset 0；旧 20..24 取右锚 offset +1
    expect(plan.pairs).toContainEqual({ from: "S:x17", to: "S:b17" });
    expect(plan.pairs).toContainEqual({ from: "S:x23", to: "S:b24" });
  });

  it("两侧偏移差超过容差 → 该段全部落孤儿", () => {
    const localSlices = Array.from({ length: 80 }, (_, j) => local(j));
    const cloudRows: CloudProgressRef[] = [];
    // 左段：旧 0..9 → 新 0..9（offset 0）
    for (let i = 0; i <= 9; i += 1) cloudRows.push(cloud(i, `S:b${i}`));
    // 中间未命中：旧 10..19（左右锚点 offset 差 20，远超容差）
    for (let i = 10; i <= 19; i += 1) cloudRows.push(cloud(i));
    // 右段：旧 20..29 → 新 40..49（offset +20）
    for (let i = 20; i <= 29; i += 1) cloudRows.push(cloud(i, `S:b${i + 20}`));

    const plan = planCrossDeviceRebind(cloudRows, localSlices);
    // 中间 10 句全落孤儿
    for (const row of plan.pairs) {
      expect(row.from.startsWith("S:x1")).toBe(false);
    }
    expect(OFFSET_TOLERANCE).toBeLessThan(20);
  });

  it("越界 / 重复认领 → 落孤儿", () => {
    const localSlices = [local(0), local(1)];
    const cloudRows = [cloud(0, "S:b0"), cloud(1, "S:b1"), cloud(5), cloud(6)];
    const plan = planCrossDeviceRebind(cloudRows, localSlices);
    // 旧 5 / 6 映射到新 5 / 6 → 越界，不接
    expect(plan.pairs).toHaveLength(0);
  });

  it("空输入 → 不过闸、无对", () => {
    expect(planCrossDeviceRebind([], []).ok).toBe(false);
  });
});

describe("collectCloudProgressRefs：挑出属于本集的云端记录", () => {
  let db: VaultDb;
  const dbSuffix = () => Math.random().toString(36).slice(2, 8);

  beforeEach(async () => {
    db = await VaultDb.open(`assoc-collect-${dbSuffix()}`);
  });

  function row(sliceCid: string, provenance?: Record<string, unknown>, deletedAt: string | null = null): ProgressRow {
    return {
      cid: progressCid(sliceCid), sliceCid, sliceIndex: 0,
      copyAttempts: 1, copyDoneAt: null, copyEpoch: 0, copyText: "",
      readAloudAt: null, readAloudSeconds: 0, readEpoch: 0,
      imitationText: "", imitationCorrect: null,
      provenance, deletedAt,
      clientUpdatedAt: "2026-10-06T12:00:00.000Z",
    } as unknown as ProgressRow;
  }

  it("带 provenance 且 work/集号匹配 → 入选；无 provenance / 别的作品 → 不入选", async () => {
    await db.bulkPut(STORE.progress, [
      row("S:cloud1", { work_cid: "W:1", episode_number: "3", slice_index: 7 }),
      row("S:cloud2", { work_cid: "W:1", episode_number: "3", slice_index: 8 }),
      row("S:other", { work_cid: "W:1", episode_number: "4", slice_index: 1 }),
      row("S:otherwork", { work_cid: "W:2", episode_number: "3", slice_index: 1 }),
      row("S:local"), // 本地新学，没有 provenance
      row("S:gone", { work_cid: "W:1", episode_number: "3", slice_index: 9 }, "2026-10-07T00:00:00.000Z"),
    ] as never);

    const refs = await collectCloudProgressRefs(db, { workCid: "W:1", episodeNumber: "3" });
    expect(refs.map((r) => r.sliceCid).sort()).toEqual(["S:cloud1", "S:cloud2"]);
    expect(refs[0].sliceIndex).toBe(7);
    await db.close();
  });
});

describe("applyCrossDeviceRebind / revertAssociation", () => {
  let db: VaultDb;
  const dbSuffix = () => Math.random().toString(36).slice(2, 8);

  beforeEach(async () => {
    db = await VaultDb.open(`assoc-apply-${dbSuffix()}`);
  });

  function row(sliceCid: string): ProgressRow {
    return {
      cid: progressCid(sliceCid), sliceCid,
      copyAttempts: 3, copyDoneAt: "2026-10-06T12:00:00.000Z", copyEpoch: 1, copyText: "写了",
      readAloudAt: null, readAloudSeconds: 0, readEpoch: 0,
      imitationText: "", imitationCorrect: null,
      clientUpdatedAt: "2026-10-06T12:00:00.000Z", deletedAt: null,
    } as unknown as ProgressRow;
  }

  it("执行关联：新行带 recovery、旧行打墓碑；撤销后旧行复活、新行墓碑", async () => {
    await db.put(STORE.progress, row("S:old"));

    const plan: CrossDevicePlan = {
      ok: true,
      pairs: [{ from: "S:old", to: "S:new" }],
      stats: { ...EMPTY_STATS, cloudRows: 1, aligned: 1 },
    };
    const { moved } = await applyCrossDeviceRebind(db, plan, "E:1");
    expect(moved).toBe(1);

    const movedRow = await db.get<ProgressRow & { recovery?: { from: string; source: string } }>(
      STORE.progress, progressCid("S:new"),
    );
    expect(movedRow?.sliceCid).toBe("S:new");
    expect(movedRow?.copyAttempts).toBe(3);
    expect(movedRow?.recovery).toEqual({ from: "S:old", at: expect.any(String), source: "cloud-assoc" });

    const tombstone = await db.get<ProgressRow>(STORE.progress, progressCid("S:old"));
    expect(tombstone?.deletedAt).toBeTruthy();
    expect(await hasAssociation(db, "E:1")).toBe(true);

    // ── 撤销 ──
    const { reverted } = await revertAssociation(db, "E:1");
    expect(reverted).toBe(1);

    const revived = await db.get<ProgressRow & { recovery?: { from: string; source: string } }>(
      STORE.progress, progressCid("S:old"),
    );
    expect(revived?.deletedAt).toBeNull();
    // 反向 recovery：服务端据此删掉新行的等级线，经验值不双计
    expect(revived?.recovery).toEqual({ from: "S:new", at: expect.any(String), source: "cloud-assoc-revert" });

    const deadNew = await db.get<ProgressRow>(STORE.progress, progressCid("S:new"));
    expect(deadNew?.deletedAt).toBeTruthy();
    expect(await hasAssociation(db, "E:1")).toBe(false);
    await db.close();
  });

  it("plan 不过闸 / 空对 → 什么都不做", async () => {
    await db.put(STORE.progress, row("S:old"));
    const { moved } = await applyCrossDeviceRebind(
      db, { ok: false, pairs: [{ from: "S:old", to: "S:new" }], stats: EMPTY_STATS }, "E:1",
    );
    expect(moved).toBe(0);
    expect(await db.get(STORE.progress, progressCid("S:new"))).toBeUndefined();
    await db.close();
  });

  it("没有批次记录时撤销是空操作", async () => {
    expect((await revertAssociation(db, "E:none")).reverted).toBe(0);
    await db.close();
  });

  it("确认接回时，暂存的孤儿纠正/解析一起落到新切片上（用完即清）", async () => {
    await db.put(STORE.slices, {
      rev: 0, rowDigest: "", cid: "S:new", episodeCid: "E:1", assetCid: "A:1", index: 3,
      startMs: 0, endMs: 100, ja: "明日また", zh: "", speaker: "",
      textHash: "th", parserVersion: 1, analysis: null,
      clientUpdatedAt: "2026-10-06T12:00:00.000Z", deletedAt: null,
    } as never);
    await db.put(STORE.progress, row("S:old"));
    // pull 时因本地无切片而被暂存的孤儿补丁（见 sync/snapshot.ts）
    await db.put(STORE.meta, {
      key: "orphanPatch:S:old",
      value: {
        correction: { ja: "直した", zh: "改好了", readingFixes: {} },
        analysis: { engine: "plugin-ai-v1", tokens: [], done: true },
        at: "2026-10-06T12:00:00.000Z",
      },
    } as never);

    await applyCrossDeviceRebind(
      db, { ok: true, pairs: [{ from: "S:old", to: "S:new" }], stats: { ...EMPTY_STATS, aligned: 1 } }, "E:1",
    );

    const slice = await db.get<SliceRow & { textFixes?: { ja?: string } }>(STORE.slices, "S:new");
    expect(slice?.textFixes?.ja).toBe("直した");
    expect(slice?.analysis?.engine).toBe("plugin-ai-v1");
    // 暂存用完即清 —— 不留死账
    expect(await db.get(STORE.meta, "orphanPatch:S:old")).toBeUndefined();
    await db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 真实数据标定（方案「真实数据标定（必须做一次）」一节）
//
// 之前的闸门阈值（MIN_ANCHORS / MIN_HIT_RATE / MIN_OFFSET_DENSITY …）是**保守初值**，
// 必须拿一对「同一集、同一内容、但异标点 / 异全半角 / 异假名写法 / 汉字↔假名 / 断句不同」
// 的字幕版本跑一次，看真实命中率与偏移分布，再回填。下面这对台词按真实番剧对白
// 的分布构造（A 版 44 句、B 版 43 句），走**真实 `sliceCid`**（三句 hash），
// 因此能复现「换一版字幕 —— 哪怕只差一个标点 —— cid 成片变掉」这条真实的坑：
//
//   变换类型                    期望落点            本次样本里出现在
//   ────────────────────────────────────────────────────────────────
//   标点 / 空白 / 全半角        B1 后身份直接吃掉 → 命中   大多数句
//   半角片假名（NFKC 折全角）   同上 → 命中                A35→B34（ﾏｱﾈ）
//   汉字↔假名（つける/付ける…） 身份不同 → 未命中，靠位置锚定   5 / 22 / 37 / 38
//   断句合并（两句并一句）      未命中 + 其后整体位移 −1      23 与 24 并成一句
//
// 关键点：三句 hash 让一处改写**波及前后各一句**（命中行只在其三句窗口全部一致时成立），
// 所以每个「汉字↔假名」点实际产生 3 句连续的未命中 —— 位置锚定正是为这类
// 「小范围、局部偏移一致」的缺口设计的。
// ─────────────────────────────────────────────────────────────────────────────

/** A 版字幕（原盘）：44 句。 */
const A_LINES: readonly string[] = [
  "おはよう、今日もいい天気だね。",
  "うん、でも少し寒いかも。",
  "そうか、上着を持ってきた？",
  "忘れちゃった。",
  "まったく、君はいつもそうだな。",
  "ごめん、次は気をつけるよ。",
  "まあ、風邪を引かなければいいけど。",
  "心配してくれてありがとう。",
  "別に、ただの友達だからな。",
  "そういうところが優しいんだよ。",
  "やめてくれよ、照れるから。",
  "ふふ、顔が赤いよ。",
  "気のせいだ。",
  "そう？私はそうは思わないけど。",
  "もう、行こうよ。遅刻する。",
  "待って、まだ靴を履いてない。",
  "早くしてよ、電車が来ちゃう。",
  "わかった、わかった。",
  "今日の授業、何だったっけ？",
  "数学と英語、あと世界史。",
  "数学は苦手なんだよな。",
  "僕も苦手、でも頑張る。",
  "君は本当に真面目だね。",
  "そうでもないよ、ただ怠けたくないだけ。",
  "それで十分だと思うよ。",
  "ありがとう、そう言ってもらえると嬉しい。",
  "さあ、急ごう。",
  "駅まで走る？",
  "走ったら疲れるから嫌だ。",
  "じゃあ、走らない程度に急ごう。",
  "それって、ただ歩くだけじゃない？",
  "細かいことは気にするな。",
  "君って、たまに適当だよね。",
  "たまにじゃなくて、いつもかも。",
  "自覚してるんだ。",
  "まあね。",
  "あ、電車来たよ。",
  "よかった、間に合った。",
  "ほら、急いだ甲斐があっただろ。",
  "はいはい、君の勝ち。",
  "素直じゃないなあ。",
  "うるさいなあ。",
  "でも、嫌いじゃないよ。",
  "知ってる。",
];

/** B 版字幕（另一个字幕组 / 另一版压制）：与 A 同内容，但写法有出入。 */
const B_LINES: readonly string[] = [
  "おはよう 今日もいい天気だね",                 // 标点 → 空白、去句号
  "うん でも少し寒いかも",
  "そうか 上着を持ってきた?",                    // 全角 ？ → 半角 ?
  "忘れちゃった",
  "まったく 君はいつもそうだな",
  "ごめん 次は気を付けるよ",                      // つける → 付ける（汉字↔假名）
  "まあ 風邪を引かなければいいけど",
  "心配してくれてありがとう",
  "別に ただの友達だからな",
  "そういうところが優しいんだよ",
  "やめてくれよ 照れるから",
  "ふふ 顔が赤いよ",
  "気のせいだ",
  "そう? 私はそうは思わないけど",                 // 全角 ？ → 半角 ?
  "もう 行こうよ 遅刻する",
  "待って まだ靴を履いてない",
  "早くしてよ 電車が来ちゃう",
  "わかった わかった",
  "今日の授業 何だったっけ?",
  "数学と英語 あと世界史",
  "数学は苦手なんだよな",
  "僕も苦手 でも頑張る",
  "きみは本当に真面目だね",                        // 君 → きみ（汉字↔假名）
  "そうでもないよ ただ怠けたくないだけ それで十分だと思うよ", // A23+A24 断句合并
  "ありがとう そう言ってもらえると嬉しい",
  "さあ 急ごう",
  "駅まで走る?",
  "走ったら疲れるから嫌だ",
  "じゃあ 走らない程度に急ごう",
  "それって ただ歩くだけじゃない？",
  "細かいことは気にするな",
  "君って たまに適当だよね",
  "たまにじゃなくて いつもかも",
  "自覚してるんだ",
  "ﾏｱﾈ",                                       // 半角片假名 → NFKC 折全角 → まあね
  "あ 電車来たよ",
  "良かった 間に合った",                          // よかった → 良かった（汉字↔假名）
  "ほら 急いだかいがあっただろ",                    // 甲斐 → かい（汉字↔假名）
  "はいはい 君の勝ち",
  "素直じゃないなあ",
  "うるさいなあ",
  "でも 嫌いじゃないよ",
  "知ってる",
];

/**
 * 把一串台词按**真实规则**变成切片引用：cid 走 `sliceCid(prev,cur,next)`，
 * `index` 与导入器一致（1-based，见 importer 里 `index: cue.index`）。
 * 返回的第一份当「A 版已上云」的云端记录，第二份当「B 版本次导入」的本地切片。
 */
async function sliceRefsOf(
  lines: readonly string[],
): Promise<{ cloud: CloudProgressRef[]; local: LocalSliceRef[] }> {
  const cids: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    cids.push(await sliceCid(lines[i - 1] ?? null, lines[i], lines[i + 1] ?? null));
  }
  return {
    cloud: cids.map((cid, i) => ({ sliceCid: cid, sliceIndex: i + 1 })),
    local: cids.map((cid, i) => ({ cid, index: i + 1 })),
  };
}

describe("真实数据标定：同内容异写法的一集字幕", () => {
  it("标点/全半角/半角片假名差异 → 身份直接命中；汉字↔假名 + 断句差异 → 位置锚定补齐", async () => {
    const a = await sliceRefsOf(A_LINES);
    const b = await sliceRefsOf(B_LINES);

    const plan = planCrossDeviceRebind(a.cloud, b.local);
    const s = plan.stats;

    // 观测日志（跑一次把真实数字打出来，作为回填阈值的依据）
    // eslint-disable-next-line no-console
    console.log(
      `[标定] cloudRows=${s.cloudRows} matched=${s.matched} anchors=${s.anchors} ` +
        `aligned=${s.aligned} orphans=${s.orphans} hitRate=${s.hitRate.toFixed(3)} ` +
        `offsetMedian=${s.offsetMedian} offsetDensity=${s.offsetDensity.toFixed(3)} ok=${plan.ok}`,
    );

    // ── 命中：B1 把标点 / 全半角 / 半角片假名差异在身份层吃掉，这些句子 cid 逐字相同 ──
    // 至少要有相当一部分句子是「零成本挂回」的 —— 否则说明归一化口径没对齐
    expect(s.hitRate).toBeGreaterThan(0.4);
    expect(s.matched).toBeGreaterThanOrEqual(20);

    // ── 未命中：只剩汉字↔假名与断句两类，量级可控 ──
    // 越小的「需要启发式兜底」的面积越安全
    expect(s.orphans).toBeLessThan(s.cloudRows * 0.5);

    // ── 闸门放行：偏移集中、锚点充足、命中率过线 ──
    expect(plan.ok).toBe(true);
    expect(s.offsetDensity).toBeGreaterThanOrEqual(0.7);
    expect(s.anchors).toBeGreaterThanOrEqual(3);

    // ── 对齐质量：断句合并处（A23+A24 → B 一句）之后的句子应整体位移 −1 ──
    // A 的第 26 句「ありがとう…」（0-based 25）在 B 里落到第 25 句（0-based 24）
    const thanksA = a.cloud[25].sliceCid;
    expect(plan.pairs).toContainEqual({ from: thanksA, to: b.local[24].cid });
    // 合并点本身（A24「それで十分…」被并进 B 的一句里）→ 认不回，落孤儿
    const mergedA = a.cloud[24].sliceCid;
    expect(plan.pairs.some((pair) => pair.from === mergedA)).toBe(false);

    // ── 保守边界仍然成立：命中率下限不能低到 0（那等于闸门失效） ──
    expect(MIN_HIT_RATE).toBeGreaterThan(0);
    expect(MIN_HIT_RATE).toBeLessThanOrEqual(s.hitRate);
    expect(MIN_OFFSET_DENSITY).toBeLessThanOrEqual(s.offsetDensity);
  });
});

