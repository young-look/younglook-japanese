/**
 * 本机素材文件读取。
 *
 * 插件的音乐玩法：视频和字幕都留在用户原来的位置，插件只记路径 + 采样指纹，
 * 既不复制也不上传（`core/library` 里那份真正落到服务器的资料库逻辑一概不碰）。
 *
 * ⚠️ 指纹算法必须与服务端 `core/psync/validators.py::asset_fingerprint` 逐字节一致，
 * 否则同一份文件在两端算出两个 cid，跨设备去重就废了。
 */

import { open } from "node:fs/promises";
import { sha256Hex } from "../core/hash";

/** 算法版本。抬了版本要把存量标记为降级，不能悄悄改。 */
export const FP_VERSION = 1;

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;

export interface FileProbe {
  sizeBytes: number;
  /** 采样指纹；读不到文件时为 null */
  fingerprint: string | null;
  fpVersion: number;
}

/**
 * sha256(head + size + tail)。
 *
 * 只读取首尾各 64KB，整集视频几个 GB 也只花几十毫秒。
 * 文件小于 64KB 时 tail 为空 —— 两端都要遵守「head 取 min(64KB, size)，
 * tail 取剩余部分的最后 min(64KB, size-head)」这个顺序，否则小文件会对不上。
 */
export async function probeFile(path: string): Promise<FileProbe> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    const size = stat.size;

    const headLen = Math.min(HEAD_BYTES, size);
    const head = Buffer.alloc(headLen);
    let read = 0;
    while (read < headLen) {
      const done = await handle.read(head, read, headLen - read, read);
      if (done.bytesRead === 0) break;
      read += done.bytesRead;
    }

    const tailLen = Math.min(TAIL_BYTES, Math.max(0, size - headLen));
    const tail = Buffer.alloc(tailLen);
    if (tailLen > 0) {
      let tailRead = 0;
      while (tailRead < tailLen) {
        const done = await handle.read(tail, tailRead, tailLen - tailRead, size - tailLen + tailRead);
        if (done.bytesRead === 0) break;
        tailRead += done.bytesRead;
      }
    }

    return {
      sizeBytes: size,
      fingerprint: await sha256Hex([head, String(size), tail]),
      fpVersion: FP_VERSION,
    };
  } finally {
    await handle.close();
  }
}

/** 文件是否还在原处。跨会话回来先用它核对一遍。 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    const handle = await open(path, "r");
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

export async function readTextFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
