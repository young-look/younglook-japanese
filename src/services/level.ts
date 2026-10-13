/**
 * 学习等级 —— 用「学过的句子数」当经验值。
 *
 * ⚠️ 门槛表与 `core/users/services/level.py` 的 LEVEL_LADDER 是**同一份口径的两处拷贝**
 * （插件本地没有服务端也能算级，所以必须本地有一份）。改门槛时两处要一起改 ——
 * 将来若云同步协议里带上 ladder 下发，这里再换成远端为准。
 *
 * 经验值口径：完成三步（跟读→抄写→仿写）的句子数，1 句 = 1 分。
 */

export const LEVEL_LADDER: ReadonlyArray<readonly [number, string, number]> = [
  [1, '港口', 0],
  [2, '海湾', 25],
  [3, '迷雾', 100],
  [4, '风暴', 500],
  [5, '远洋', 1500],
  [6, '群岛', 3000],
  [7, '新大陆', 10000],
];

export interface LevelInfo {
  level: number;
  name: string;
  /** 当前经验值（完成三步的句子数） */
  exp: number;
  /** 下一级的名字；满级为 null —— 满级没有下一级，别在界面上绕回来 */
  nextName: string | null;
  /** 距下一级还差多少句；满级为 null */
  toNext: number | null;
  /** 本级进度 0~1（满级恒为 1） */
  progress: number;
}

export function levelFromExp(exp: number): LevelInfo {
  const safe = Math.max(Math.floor(exp || 0), 0);
  let current = LEVEL_LADDER[0];
  let next: readonly [number, string, number] | null = null;
  for (let i = 0; i < LEVEL_LADDER.length; i++) {
    if (safe >= LEVEL_LADDER[i][2]) {
      current = LEVEL_LADDER[i];
      next = LEVEL_LADDER[i + 1] ?? null;
    }
  }

  const floor = current[2];
  const ceiling = next ? next[2] : current[2];
  const span = Math.max(ceiling - floor, 1);
  const progress = next ? Math.min(1, (safe - floor) / span) : 1;

  return {
    level: current[0],
    name: current[1],
    exp: safe,
    nextName: next ? next[1] : null,
    toNext: next ? Math.max(next[2] - safe, 0) : null,
    progress,
  };
}
