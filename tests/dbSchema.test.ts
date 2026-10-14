// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { DB_VERSION, STORE, VaultDb, vaultDbName } from "../src/storage/db";

/**
 * 本地库的结构与升级。
 *
 * 钉的是退役表的清理：库版本只升不降，`onupgradeneeded` 是**唯一**能删表的地方，
 * 所以"下线一个 store"必须显式记进 RETIRED_STORES 并抬版本 —— 否则那张表
 * （和里面的数据）会永远留在每个用户的库里。
 */

/**
 * 造一个"老库"：按旧版本号打开，手动建出指定的表再关掉连接
 * （不关的话，后面开更高版本会被 blocked）。
 */
function legacyDb(key: string, version: number, store: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(vaultDbName(key), version);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(store)) {
        request.result.createObjectStore(store, { keyPath: "text" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 再开一条连接读当前库里到底有哪些表（VaultDb 自己不暴露库句柄）。 */
function storeNames(key: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(vaultDbName(key));
    request.onsuccess = () => resolve(Array.from(request.result.objectStoreNames));
    request.onerror = () => reject(request.error);
  });
}

describe("本地库升级", () => {
  it("老库里的退役表（tts）被删掉，业务表一个不少", async () => {
    const legacy = await legacyDb("legacy-tts", DB_VERSION - 1, "tts");
    legacy.close();

    const vault = await VaultDb.open("legacy-tts");
    const names = await storeNames("legacy-tts");
    vault.close();

    expect(names).not.toContain("tts");
    expect(names).toContain(STORE.sentences);
    expect(names).toContain(STORE.recordings);
  });

  it("新库根本不会建出退役表", async () => {
    const vault = await VaultDb.open("fresh-vault");
    const names = await storeNames("fresh-vault");
    vault.close();

    expect(names).not.toContain("tts");
    expect(names.length).toBeGreaterThan(5);
  });
});
