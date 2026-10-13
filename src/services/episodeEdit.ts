/**
 * 「编辑这一集」的数据层：改导入时配置的那组固有属性（视频名称、年份、
 * 集号、季度、集标题）。
 *
 * ⚠️ 两条硬边界：
 *
 *  1. **cid 不重派生**。workCid/episodeCid 由「名字 + 年份 (+ 季集号)」派生
 *     （见 core/ids.ts），编辑只改字段值、身份键原样保留 —— 本地所有引用
 *     （assets/slices/sessions）不动一根手指。代价是改完名再重新导入
 *     同一个视频会按新名字派生出一套新身份（旧行变空壳、列表自动隐藏，进度因为
 *     挂在字幕指纹上仍然恢复）——这是「换个名字重导」一直都有的既有行为，不是
 *     这里引入的；真要重派生 cid 得连动 outbox、服务端与 meta 全链，明确不做。
 *
 *  2. **改了名字要重新查重名**。名字 + 季集号是这一集在列表里的身份，
 *     改完跟别的集撞了就是两条长得一样的记录（见 findEditClash）。
 */

import { rowDigest } from "../core/digest";
import { normalizeEpisodeNumber } from "../core/ids";
import { episodeStem } from "../markdown/templates";
import { STORE, type StoreName, type VaultDb } from "../storage/db";
import type { EpisodeRow, WorkRow } from "../types/entities";

export interface EpisodeEditValues {
  /** 视频名称（= 作品名，整部作品共用） */
  workTitle: string;
  year: number | null;
  season: number | null;
  number: string;
  episodeTitle: string;
}

export interface EpisodeEditOutcome {
  ok: boolean;
  /** ok = false 时给人看的失败原因（撞名） */
  reason?: string;
}

/**
 * 编辑后的名字会不会撞上别的集的笔记名。撞了返回对方所属的视频名。
 *
 * ⚠️ 对比必须用**编辑之后**的口径：同一部作品的兄弟集会跟着新作品名走，
 * 拿库里旧的 WorkRow.title 去比，改名 + 撞集号两件事一起发生时就漏过去了。
 * 所以兄弟集一律按新作品名算 stem，别的作品按它们自己的名字算。
 */
export async function findEditClash(
  db: VaultDb,
  edited: { episodeCid: string; workCid: string },
  next: { workTitle: string; season: number | null; number: string },
): Promise<string | null> {
  const [episodes, works] = await Promise.all([
    db.getAll<EpisodeRow>(STORE.episodes),
    db.getAll<WorkRow>(STORE.works),
  ]);
  const workByCid = new Map(works.map((row) => [row.cid, row]));
  const stem = episodeStem(next.workTitle, next.season, next.number);
  for (const episode of episodes) {
    if (episode.deletedAt || episode.cid === edited.episodeCid) continue;
    const work = workByCid.get(episode.workCid);
    if (!work || work.deletedAt) continue;
    const title =
      episode.workCid === edited.workCid ? next.workTitle : work.title || work.titleJa || "未命名";
    if (episodeStem(title, episode.season, episode.number) === stem) {
      return work.title || work.titleJa || "未命名";
    }
  }
  return null;
}

/**
 * 保存编辑：字段有变化的行落库（摘要重算），然后搬笔记。
 *
 * 集号沿用导入的归一化（`normalizeEpisodeNumber`），4.0 与 4 落到同一个值。
 * 什么都没改时是空操作 —— 不写库、不动文件、不抬 clientUpdatedAt。
 *
 * 撞名在这里**再查一遍**（弹窗那次只是即时提示，是异步的，赶在回包前点保存
 * 完全可能）：撞了返回 `ok: false` + 一句人话，什么都没写。
 */
export async function saveEpisodeEdit(
  db: VaultDb,
  current: { work: WorkRow; episode: EpisodeRow },
  next: EpisodeEditValues,
): Promise<EpisodeEditOutcome> {
  const oldTitle = current.work.title || current.work.titleJa || "未命名";
  const newTitle = next.workTitle.trim();
  const number = normalizeEpisodeNumber(next.number);
  const season = next.season;
  const year = next.year;

  const workChanged = newTitle !== current.work.title || year !== current.work.year;
  const episodeChanged =
    season !== current.episode.season ||
    number !== current.episode.number ||
    next.episodeTitle.trim() !== current.episode.title;
  if (!workChanged && !episodeChanged) return { ok: true };

  if (workChanged || episodeChanged) {
    const clash = await findEditClash(
      db,
      { episodeCid: current.episode.cid, workCid: current.work.cid },
      { workTitle: newTitle, season, number },
    );
    if (clash) {
      return { ok: false, reason: `已经有同名的这一集了：撞上了《${clash}》` };
    }
  }

  const now = new Date().toISOString();
  const stores: StoreName[] = [];
  let nextWork: WorkRow | null = null;
  let nextEpisode: EpisodeRow | null = null;

  if (workChanged) {
    nextWork = { ...current.work, title: newTitle, year, clientUpdatedAt: now };
    nextWork.rowDigest = await rowDigest(nextWork as unknown as Record<string, unknown>);
    stores.push(STORE.works);
  }
  if (episodeChanged) {
    nextEpisode = {
      ...current.episode,
      season,
      number,
      title: next.episodeTitle.trim(),
      clientUpdatedAt: now,
    };
    nextEpisode.rowDigest = await rowDigest(nextEpisode as unknown as Record<string, unknown>);
    stores.push(STORE.episodes);
  }

  if (nextWork || nextEpisode) {
    await db.transaction(stores, "readwrite", async (tx) => {
      if (nextWork) await tx.put(STORE.works, nextWork);
      if (nextEpisode) await tx.put(STORE.episodes, nextEpisode);
    });
    // 落库成功后同步调用方手里的行：列表页保存后要重渲染，别让它读到旧名字
    if (nextWork) Object.assign(current.work, nextWork);
    if (nextEpisode) Object.assign(current.episode, nextEpisode);
  }

  return { ok: true };
}
