import { describe, expect, it } from "vitest";
import { pickLibrary, reclaimableKeys, type VaultDbProbe } from "../src/services/vaultKey";

/**
 * 这组用例守的是"数据别丢"这条线（2026-09-25 的真实事故）：
 * 库名曾经是每次加载新生成的随机 id，重载一次就等于换一个空库。
 * 找回逻辑本身也必须保守 —— 认错库等于把另一个 vault 的数据搬进来。
 */

const VAULT = "/Users/you/Vaults/douyin";

function probe(key: string, sentences: number, progress = 0, vaultPath: string | null = null): VaultDbProbe {
  return { key, sentences, progress, vaultPath };
}

describe("pickLibrary", () => {
  it("只有一个装着数据的旧库 → 认回来（老版本没有归属标记）", () => {
    const out = pickLibrary([probe("aaa", 313), probe("bbb", 0)], VAULT, "bbb");
    expect(out.key).toBe("aaa");
    expect(out.orphans).toBe(0);
  });

  it("归属路径对得上的优先，标注着别的 vault 的直接排除", () => {
    const out = pickLibrary(
      [probe("mine", 50, 0, VAULT), probe("other", 646, 0, "/Users/you/Vaults/网文")],
      VAULT,
      "empty",
    );
    expect(out.key).toBe("mine");
    expect(out.orphans).toBe(0); // 别 vault 的不算候选，也就没有"待合并"
  });

  it("路径带尾斜杠 / 大小写不同也算同一个 vault", () => {
    const out = pickLibrary([probe("mine", 10, 0, "/Users/you/Vaults/Douyin/")], VAULT, "empty");
    expect(out.key).toBe("mine");
  });

  it("多个候选中，归属标记写着别的 vault 的一律排除", () => {
    const out = pickLibrary(
      [probe("x", 100, 0, "/Users/you/Vaults/别的库"), probe("y", 90, 0, "/Users/you/Vaults/第三个")],
      VAULT,
      "empty",
    );
    expect(out.key).toBeNull();
    expect(out.orphans).toBe(0);
  });

  it("没有归属标记的多份老库 → 认台词最多的那份（这次事故的主场景）", () => {
    const out = pickLibrary([probe("a", 20), probe("b", 646), probe("c", 0)], VAULT, "empty");
    expect(out.key).toBe("b");
    expect(out.orphans).toBe(1);
  });

  it("有标记的优先于没标记的，哪怕台词少", () => {
    const out = pickLibrary([probe("mine", 3, 0, VAULT), probe("legacy", 646)], VAULT, "empty");
    expect(out.key).toBe("mine");
    expect(out.orphans).toBe(1);
  });

  it("同一路径的多个库 → 取台词最多的那份", () => {
    const out = pickLibrary(
      [probe("old", 3, 1, VAULT), probe("new", 313, 40, VAULT)],
      VAULT,
      "empty",
    );
    expect(out.key).toBe("new");
    expect(out.orphans).toBe(1);
  });

  it("条数打平看学习进度条数", () => {
    const out = pickLibrary([probe("a", 10, 1, VAULT), probe("b", 10, 9, VAULT)], VAULT, "empty");
    expect(out.key).toBe("b");
  });

  it("当前正在用的库不参与候选（它是空的，别自己认自己）", () => {
    const out = pickLibrary([probe("current", 0), probe("old", 313)], VAULT, "current");
    expect(out.key).toBe("old");
  });

  it("全是空库 → 不认，回车用当前的 key", () => {
    const out = pickLibrary([probe("a", 0), probe("b", 0), probe("c", 0)], VAULT, "c");
    expect(out.key).toBeNull();
    expect(out.orphans).toBe(0);
  });
});

/**
 * 多账号隔离（2026-10-09）加进来的第一步过滤：本机并存的几份学习数据
 * **前缀一样、vaultPath 也一样**，认库流程光看探测结果分不出谁是谁。
 * 已登记在 settings.spaces 里的必须整批排除 —— 否则给新账号开的空空间
 * 一启动就会把**另一个账号**的空间认回来。
 */
describe("reclaimableKeys", () => {
  it("已登记的空间一律排除（它们是别的账号的数据，不是孤儿旧库）", () => {
    const keys = ["base", "base-2", "base-3", "orphan0001"];
    const out = reclaimableKeys(keys, "base", ["base", "base-2"]);
    expect(out).toEqual(["base-3", "orphan0001"]);
  });

  it("当前正在用的库也不参与（自己不会认自己）", () => {
    const out = reclaimableKeys(["a", "b"], "a", []);
    expect(out).toEqual(["b"]);
  });

  it("一个空间都没登记时，扫到的全是候选（老用户的老库要能被认回来）", () => {
    const out = reclaimableKeys(["empty", "old"], "empty", []);
    expect(out).toEqual(["old"]);
  });
});
