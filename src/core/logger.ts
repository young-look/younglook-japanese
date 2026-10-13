/** 极简日志：统一前缀，方便用户在 Obsidian 控制台里筛。 */

const PREFIX = "[洋流]";

export function createLogger(scope: string) {
  const tag = `${PREFIX} ${scope}`;
  return {
    debug(message: string, ...args: unknown[]): void {
      console.debug(`${tag} ${message}`, ...args);
    },
    info(message: string, ...args: unknown[]): void {
      console.info(`${tag} ${message}`, ...args);
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
