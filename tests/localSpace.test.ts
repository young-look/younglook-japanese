import { describe, expect, it } from "vitest";

import {
  accountLabel,
  anonymousSpace,
  findSpaceForAccount,
  nextSpaceId,
  resolveActiveSpaceId,
  sameServer,
} from "../src/services/localSpace";
import { fillDefaults, migrateSpaces } from "../src/settings/defaults";
import type { LocalSpace } from "../src/settings/types";

/**
 * 「匿名空间恒存在 + 一份本机数据只跟一个账号」的判定规则。
 *
 * 2026-10-10 模型重构（旧口径见 git 历史里的 `decideSpaceBinding`）：旧模型把
 * "匿名"当成"当前这份数据还没主人"，于是 A 认领后 B 登录只能二选一 —— 共用电脑
 * （情侣、家庭）上，后登录的人能一键把前一个人的数据抢走。现在反过来推：
 *  · 匿名空间**恒存在**且不属于任何账号；
 *  · 登录 = 进入"我在本机的空间"（没有就新建）；登出 = 切回匿名空间；
 *  · 绑定**永久**（登录不可逆）。
 *
 * 这文件守的还是**串号**这条线：判定错一步，就是把一个人的学习记录送给另一个
 * 账号。所以规则全在纯函数里，单独钉住。
 */

const PROD = "https://younglook.cc";
const DEV = "http://127.0.0.1:8060";

function space(id: string, owner = "", ownerName = "", ownerServer = ""): LocalSpace {
  // 归属了三样都得记全 —— ownerServer 空着时判定会按"没记过"处理（见 findSpaceForAccount）
  return { id, owner, ownerServer: owner ? ownerServer || PROD : "", ownerName };
}

describe("anonymousSpace", () => {
  it("找出那条不属于任何账号的空间（owner 空串 / 只有空白都算）", () => {
    expect(anonymousSpace([space("base", "u-1"), space("base-2")])?.id).toBe("base-2");
    expect(anonymousSpace([space("base", "u-1"), space("base-2", "  ")])?.id).toBe("base-2");
  });

  it("一条都没有 → null（老配置从旧模型升级上来时真的会没有）", () => {
    expect(anonymousSpace([])).toBeNull();
    expect(anonymousSpace([space("base", "u-1")])).toBeNull();
  });
});

describe("findSpaceForAccount", () => {
  it("同账号 + 同服务器 → 命中（末尾斜杠不算区别）", () => {
    const spaces = [space("base"), space("base-2", "u-1", "小明")];
    expect(findSpaceForAccount(spaces, { uid: "u-1", serverUrl: PROD })?.id).toBe("base-2");
    expect(findSpaceForAccount(spaces, { uid: "u-1", serverUrl: `${PROD}/` })?.id).toBe("base-2");
  });

  it("🔥 只比 uid 是 bug：dev 与线上各自的 uid 都从 1 起，同一个数字是两个人", () => {
    expect(findSpaceForAccount([space("base", "1", "小明", PROD)], { uid: "1", serverUrl: DEV })).toBeNull();
  });

  it("🔥 没记过服务器地址 → 不算命中（宁可多建一份，也不能把数据送错账号）", () => {
    const orphan: LocalSpace = { id: "base", owner: "u-1", ownerServer: "", ownerName: "小明" };
    expect(findSpaceForAccount([orphan], { uid: "u-1", serverUrl: PROD })).toBeNull();
  });

  it("🔥 拿不到 uid → null（保守：宁可不动，也不能凭空身份去认领）", () => {
    expect(findSpaceForAccount([space("base", "u-1")], { uid: "", serverUrl: PROD })).toBeNull();
    expect(findSpaceForAccount([space("base", "u-1")], { uid: "  ", serverUrl: PROD })).toBeNull();
  });

  it("匿名空间永远不会被当成某个账号的空间", () => {
    expect(findSpaceForAccount([space("base")], { uid: "u-1", serverUrl: PROD })).toBeNull();
  });
});

describe("resolveActiveSpaceId（启动时选库，只选不弹窗）", () => {
  it("登录着 → 待在「我的空间」", () => {
    const spaces = [space("base"), space("base-2", "u-1")];
    expect(
      resolveActiveSpaceId(spaces, { hasAccount: true, uid: "u-1", serverUrl: PROD, currentId: "base" }),
    ).toBe("base-2");
  });

  it("没登录 → 回匿名空间（哪怕当前停在某个账号的空间里：登出后不该看见别人的库）", () => {
    const spaces = [space("base", "u-1"), space("base-2")];
    expect(
      resolveActiveSpaceId(spaces, { hasAccount: false, uid: "u-1", serverUrl: PROD, currentId: "base" }),
    ).toBe("base-2");
  });

  it("登录了但本机还没建出这个账号的空间 → 保持不动（建空间是登录流程的事，这里不弹窗）", () => {
    const spaces = [space("base"), space("base-2", "u-2")];
    expect(
      resolveActiveSpaceId(spaces, { hasAccount: true, uid: "u-1", serverUrl: PROD, currentId: "base" }),
    ).toBe("base");
  });

  it("🔥 绝不让 activeSpaceId 指空：当前 id 找不到就落回第一条", () => {
    const spaces = [space("base", "u-2")];
    expect(
      resolveActiveSpaceId(spaces, { hasAccount: false, uid: "", serverUrl: PROD, currentId: "已经删掉的" }),
    ).toBe("base");
  });
});

describe("sameServer", () => {
  it("末尾斜杠、空白不算区别", () => {
    expect(sameServer(" https://a.cc/ ", "https://a.cc")).toBe(true);
  });

  it("🔒 空地址永远不算同一台 —— 「没记过」不能当成「同一台」", () => {
    expect(sameServer("", "")).toBe(false);
    expect(sameServer("https://a.cc", "")).toBe(false);
  });
});

describe("nextSpaceId", () => {
  it("从 -2 起给新空间起名，不和老库撞", () => {
    const spaces = [space("base")];
    expect(nextSpaceId(spaces, "base")).toBe("base-2");
  });

  it("已有的序号跳过去，不会覆盖别人的库名", () => {
    const spaces = [space("base"), space("base-2"), space("base-3")];
    expect(nextSpaceId(spaces, "base")).toBe("base-4");
  });

  it("完全不看 uid —— 库名短、进日志也不怕，归属记在 owner 字段上", () => {
    const spaces = [space("base")];
    expect(nextSpaceId(spaces, "base")).not.toContain("u-");
  });
});

describe("accountLabel", () => {
  it("昵称 + UID 前 8 位（用来分辨同名同姓的两个账号）", () => {
    expect(accountLabel("小明", "1a2b3c4d5e6f7788")).toBe("小明（UID 1a2b3c4d）");
  });

  it("没昵称退回 UID；两样都没有时给个中性说法（不能显示 null）", () => {
    expect(accountLabel("", "1a2b3c4d5e6f")).toBe("UID 1a2b3c4d");
    expect(accountLabel("", "")).toBe("这个账号");
  });
});

describe("migrateSpaces", () => {
  it("🔥 老配置里没有这一项 → 补成一条指向老库、还没认领（老用户零迁移）", () => {
    const { spaces, activeSpaceId } = migrateSpaces({}, "legacy0001");
    expect(spaces).toEqual([space("legacy0001")]);
    expect(activeSpaceId).toBe("legacy0001");
  });

  it("已经是多空间的配置原样保留（不再凭空添一条）", () => {
    const given = { spaces: [space("base"), space("base-2", "u-2", "小红")] };
    const { spaces, activeSpaceId } = migrateSpaces(given, "base");
    expect(spaces).toHaveLength(2);
    expect(spaces[1].owner).toBe("u-2");
    expect(activeSpaceId).toBe("base");
  });

  it("activeSpaceId 指向不存在的空间 → 落回第一条（不能开出一个没有归属的库）", () => {
    const given = { spaces: [space("base", "u-1")], activeSpaceId: "已经删掉的" };
    expect(migrateSpaces(given, "base").activeSpaceId).toBe("base");
  });

  it("没有 id 或 id 重复的条目直接丢掉（没有 id 就没有库，留着也没用）", () => {
    const given = {
      spaces: [
        space("base", "u-1"),
        { id: "  ", owner: "u-9", ownerName: "" },
        space("base", "u-2"),
      ],
    };
    const { spaces } = migrateSpaces(given as never, "base");
    // 丢掉坏行之后还得补上匿名空间（不变量：恒有且仅有一条）
    expect(spaces).toEqual([
      space("base", "u-1"),
      { id: "base-2", owner: "", ownerServer: "", ownerName: "" },
    ]);
  });

  it("🔥 表非空时**不**再按 vaultLocalId 补一条 —— 认回旧库换了第一条的 id 之后，不能凭空多出一个空空间", () => {
    const given = { spaces: [space("adopted-key", "u-1", "小明")] };
    const { spaces, activeSpaceId } = migrateSpaces(given, "base");
    // 认回的旧库保持自己的 id，不会被换成 "base"
    expect(spaces[0].id).toBe("adopted-key");
    expect(activeSpaceId).toBe("adopted-key");
    expect(spaces.some((row) => row.id === "base")).toBe(false);
  });

  it("🔥 旧模型认领过、表里一条匿名空间都没有 → 补一条**新的空匿名空间**（2026-10-10 不变量）", () => {
    const given = { spaces: [space("base", "u-1", "小明")], activeSpaceId: "base" };
    const { spaces, activeSpaceId } = migrateSpaces(given, "base");
    expect(spaces.map((row) => row.id)).toEqual(["base", "base-2"]);
    expect(spaces[0]).toEqual(space("base", "u-1", "小明")); // 老库原地不动
    expect(spaces[1]).toEqual({ id: "base-2", owner: "", ownerServer: "", ownerName: "" });
    expect(activeSpaceId).toBe("base"); // 活跃空间不受影响，切库交给启动 reconcile
  });
});

describe("fillDefaults 与空间表", () => {
  it("第一次装上：一个空间、用的就是刚生成的 vaultLocalId、还没认领", () => {
    const settings = fillDefaults(undefined);
    expect(settings.spaces).toHaveLength(1);
    expect(settings.spaces[0]).toEqual({
      id: settings.vaultLocalId,
      owner: "",
      ownerServer: "",
      ownerName: "",
    });
    expect(settings.activeSpaceId).toBe(settings.vaultLocalId);
  });

  it("已经定住 vaultLocalId 的老配置：空间表跟着它走，不重新生成", () => {
    const settings = fillDefaults({ vaultLocalId: "fixed0001" });
    expect(settings.vaultLocalId).toBe("fixed0001");
    expect(settings.activeSpaceId).toBe("fixed0001");
  });
});
