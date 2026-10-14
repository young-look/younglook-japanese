/**
 * 抄写/仿写草稿的本机暂存（2026-10-07 新口径的地面工事）。
 *
 * 三步卡改口径后没有「保存」了：正在敲的字**自动**落在这里，检查（及其失败
 * 重试）是独立于人手之外的动作。草稿是 scratch 性质 —— 不进 ProgressRow、
 * 不上云同步：同步得跟服务端的分步合并逻辑（PROGRESS_STEP_GROUPS）纠缠，
 * 而"敲了一半的句子"本来就只对敲它的那台设备有意义（与录音同口径）。
 *
 * 存储就用 meta 表一行一条（`draft:copy:<cid>` / `draft:imitation:<cid>`），
 * 和演示包标记（`demo.ts`）、笔记布局旗子同一套本机旗子做法。**空串 = 删除**：
 * 检查通过（留档接管）和「重置」（回到初始）都按删除算，meta 里不留尸体。
 */

import { STORE, type VaultDb } from "../storage/db";

interface MetaRow {
  key: string;
  value: string;
}

export type DraftStep = "copy" | "imitation";

function draftKey(step: DraftStep, sliceCid: string): string {
  return `draft:${step}:${sliceCid}`;
}

/** 读一句的草稿。没有返回空串，调用方不用判 undefined。 */
export async function loadDraft(db: VaultDb, step: DraftStep, sliceCid: string): Promise<string> {
  try {
    const row = await db.get<MetaRow>(STORE.meta, draftKey(step, sliceCid));
    return typeof row?.value === "string" ? row.value : "";
  } catch {
    // meta 表读不上（老库升级失败之类）就当没草稿，别挡着学习流程
    return "";
  }
}

/**
 * 存一句的草稿。`text` 清空 = 删除（meta 行直接删，不留空行）。
 *
 * 写失败**静默吞掉**：草稿是锦上添花 —— 存不上，这次会话里输入框里照样有字，
 * 检查也照常能跑。为它弹窗反而打断学习。
 */
export async function saveDraft(
  db: VaultDb,
  step: DraftStep,
  sliceCid: string,
  text: string,
): Promise<void> {
  try {
    if (text) {
      await db.put(STORE.meta, { key: draftKey(step, sliceCid), value: text } satisfies MetaRow);
    } else {
      await db.delete(STORE.meta, draftKey(step, sliceCid));
    }
  } catch {
    // 存不上就算了（见上）：不打断输入，也不弹通知
  }
}
