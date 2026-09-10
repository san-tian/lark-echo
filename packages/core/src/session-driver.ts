import type { AgentAdapter, AgentSessionHandle, SessionRef } from './types.ts';

/**
 * 会话驱动：把「拿到某个 session 的 adapter 句柄」这件事从路由逻辑里抽出来。
 * daemon 用真实 adapter + idle 回收实现；测试用 FakeDriver。
 */
export interface SessionDriver {
  /** 拿到（必要时启动）该 session 的句柄 */
  acquire(ref: SessionRef): Promise<{ adapter: AgentAdapter; handle: AgentSessionHandle }>;
  /** 标记活动，重置 idle 计时 */
  touch(ref: SessionRef): void;
  /**
   * 释放（idle 回收 / 接管）。
   * @returns 是否真的释放了；false = 本来就没有这个会话在跑。
   *   调用方（CLI / 配置台）要靠它区分「已停止」和「本来就没跑」，
   *   否则会对着不存在的会话报成功。
   */
  release(sessionId: string): Promise<boolean>;
}
