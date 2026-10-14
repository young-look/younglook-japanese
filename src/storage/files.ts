/**
 * 本机素材文件读取与全文件哈希。
 *
 * 视频和字幕都留在用户原来的位置，插件只记路径 + 全文件 sha256，
 * 既不修改也不上传（`core/library` 里那份真正落到服务器的资料库逻辑一概不碰）。
 *
 * 身份判定（2026-10-14 重构定稿）：**只认整文件 sha256**。
 * 文件哪怕改动一个字节就是另一个文件、另一条学习记录——不搞采样近似，
 * 也不搞模糊匹配。桌面端跑在 Electron/Node 里，流式哈希不占内存。
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";

export interface FileSha {
  /** 64 位 hex 小写 */
  sha256: string;
  sizeBytes: number;
}

/**
 * 整文件 sha256（流式）。
 *
 * 几个 GB 的视频大约花 10~30 秒（SSD），调用方必须在 UI 上给「正在计算文件指纹」
 * 的状态提示，禁止无反馈卡死。文件不存在时抛出原始错误，由调用方决定怎么提示。
 */
export function sha256File(path: string): Promise<FileSha> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const pump = async () => {
      for await (const chunk of createReadStream(path)) {
        const buf = chunk as Buffer;
        hash.update(buf);
        sizeBytes += buf.length;
      }
      resolve({ sha256: hash.digest("hex"), sizeBytes });
    };
    pump().catch(reject);
  });
}

/** 文件大小（不读内容、不哈希）。导入框选完视频先给个体积显示用。 */
export async function fileSize(path: string): Promise<number> {
  const info = await stat(path);
  return info.size;
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
