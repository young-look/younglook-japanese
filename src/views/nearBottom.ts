/**
 * 「快滚到底了，再拉一页」的触发器 —— 消费记录（spendSection.ts）同款机制的抽出版，
 * 供历史（historySection.ts）与词库（vocabSection.ts）共用。
 *
 * 刻意只做**触发**，不做状态：seq / loading / hasMore 的状态机仍归各 section
 * 自持（与 spendSection 同构）。`ready()` 是闸门 —— 返回 false 就一拍也不触发；
 * `fire()` 里各 section 自己还会再走一遍同样的闸门（双保险，与 spendSection
 * L389-392 的 maybeMore 同款）。
 *
 * 无 IntersectionObserver 的环境（jsdom / 老内核）退回滚动监听：哨兵顶端
 * 进入「容器底 + 160px」以内就算到位。destroy 断开观察器 / 摘掉监听。
 */

export interface NearBottomDeps {
  /** 哨兵元素（一个 1px 高的空 div，放在列表末尾） */
  sentinel: HTMLElement;
  /**
   * 滚动容器（IntersectionObserver 的 root）。插件里是 `.yl-v3-body` ——
   * 滚动条在它身上，不在 pane 上；不给就退回窗口视口。
   */
  scrollRoot: HTMLElement | null;
  /** 闸门：false 时一拍也不触发（典型实现 = hasMore && !loading && !dead） */
  ready: () => boolean;
  /** 触发加载 */
  fire: () => void;
}

export interface NearBottomTrigger {
  /** 断开观察器 / 摘掉滚动监听。调完之后这个触发器不再做任何事 */
  destroy(): void;
}

export function createNearBottomTrigger(deps: NearBottomDeps): NearBottomTrigger {
  let observer: IntersectionObserver | null = null;
  let onScroll: (() => void) | null = null;

  const maybeMore = (): void => {
    if (!deps.ready()) return;
    deps.fire();
  };

  if (typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) maybeMore();
      },
      { root: deps.scrollRoot ?? null, rootMargin: "160px" },
    );
    observer.observe(deps.sentinel);
  } else {
    onScroll = (): void => {
      const rect = deps.sentinel.getBoundingClientRect();
      const bottom = deps.scrollRoot
        ? deps.scrollRoot.getBoundingClientRect().bottom
        : window.innerHeight;
      if (rect.top <= bottom + 160) maybeMore();
    };
    (deps.scrollRoot ?? window).addEventListener("scroll", onScroll, { passive: true });
  }

  return {
    destroy: () => {
      observer?.disconnect();
      if (onScroll) (deps.scrollRoot ?? window).removeEventListener("scroll", onScroll);
    },
  };
}
