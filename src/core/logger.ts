/**
 * 极简日志：统一前缀，方便用户在 Obsidian 控制台里筛。
 *
 * 只有 warn / error / debug 三档，**没有 info**：Obsidian 的规范只放行这三档
 * （插件不该在用户控制台里刷屏），原来的 info 一律并入 debug。
 */

const PREFIX = "[洋流]";

export function createLogger(scope: string) {
  const tag = `${PREFIX} ${scope}`;
  return {
    debug(message: string, ...args: unknown[]): void {
      console.debug(`${tag} ${message}`, ...args);
    },
    warn(message: string, ...args: unknown[]): void {
      console.warn(`${tag} ${message}`, ...args);
    },
    error(message: string, ...args: unknown[]): void {
      console.error(`${tag} ${message}`, ...args);
    },
    /** 耗时打点。出错也照常结束，不打断主流程。 */
    async timing<T>(label: string, fn: () => Promise<T>): Promise<T> {
      const started = Date.now();
      try {
        return await fn();
      } finally {
        console.debug(`${tag} ${label} ${Date.now() - started}ms`);
      }
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;

export const log = createLogger("core");
