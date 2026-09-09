import {
  createLogger,
  type AgentAdapter,
  type AgentId,
  type AgentSessionHandle,
  type Logger,
  type SessionDriver,
  type SessionRef,
} from '@lark-echo/core';

export interface SessionPoolOptions {
  adapters: Partial<Record<AgentId, AgentAdapter>>;
  /** idle 回收阈值（§11.4，默认 30 分钟） */
  idleMs?: number;
  /** 启动会话时使用的模型（`<provider>/<modelId>`），来自 session_settings */
  getModel?: (sessionId: string) => string | undefined;
  logger?: Logger;
  now?: () => number;
}

interface PoolEntry {
  ref: SessionRef;
  adapter: AgentAdapter;
  handle: AgentSessionHandle;
  lastUsedAt: number;
  createdAt: number;
}

export interface SessionInfo {
  ref: SessionRef;
  idleMs: number;
  ageMs: number;
}

/**
 * 每 session 一个 agent 进程（§11.4：不是每群一个 —— 1:N 下同 session 的多群共用进程）。
 */
export class SessionPool implements SessionDriver {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly opts: Required<Omit<SessionPoolOptions, 'logger' | 'getModel'>> &
    Pick<SessionPoolOptions, 'getModel'> & { logger: Logger };
  private sweeper?: NodeJS.Timeout;

  constructor(opts: SessionPoolOptions) {
    this.opts = {
      adapters: opts.adapters,
      idleMs: opts.idleMs ?? 30 * 60 * 1000,
      now: opts.now ?? (() => Date.now()),
      getModel: opts.getModel,
      logger: opts.logger ?? createLogger({ svc: 'session-pool' }),
    };
  }

  async acquire(ref: SessionRef): Promise<{ adapter: AgentAdapter; handle: AgentSessionHandle }> {
    let entry = this.entries.get(ref.sessionId);
    if (!entry) {
      const adapter = this.opts.adapters[ref.agent];
      if (!adapter) throw new Error(`no adapter registered for agent: ${ref.agent}`);
      const model = this.opts.getModel?.(ref.sessionId);
      const handle = await adapter.start({
        cwd: ref.cwd,
        sessionId: ref.sessionId,
        ...(model ? { model } : {}),
      });
      entry = {
        ref,
        adapter,
        handle,
        lastUsedAt: this.opts.now(),
        createdAt: this.opts.now(),
      };
      this.entries.set(ref.sessionId, entry);
      this.opts.logger.info('session started', {
        sessionId: ref.sessionId,
        agent: ref.agent,
        cwd: ref.cwd,
      });
    }
    entry.lastUsedAt = this.opts.now();
    return { adapter: entry.adapter, handle: entry.handle };
  }

  /** 当前在池中的会话句柄（模型切换用） */
  get(sessionId: string): { adapter: AgentAdapter; handle: AgentSessionHandle } | undefined {
    const entry = this.entries.get(sessionId);
    return entry ? { adapter: entry.adapter, handle: entry.handle } : undefined;
  }

  touch(ref: SessionRef): void {
    const entry = this.entries.get(ref.sessionId);
    if (entry) entry.lastUsedAt = this.opts.now();
  }

  async release(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    try {
      await entry.adapter.stop(entry.handle);
    } catch (err) {
      this.opts.logger.warn('stop session failed', { sessionId, error: String(err) });
    }
    this.opts.logger.info('session released', { sessionId });
  }

  /** 回收 idle 会话；由 daemon 定时调用 */
  async sweep(): Promise<string[]> {
    const now = this.opts.now();
    const released: string[] = [];
    for (const [sessionId, entry] of this.entries) {
      if (now - entry.lastUsedAt > this.opts.idleMs) {
        await this.release(sessionId);
        released.push(sessionId);
      }
    }
    return released;
  }

  startSweeper(intervalMs = 60_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      void this.sweep();
    }, intervalMs);
    this.sweeper.unref?.();
  }

  list(): SessionInfo[] {
    const now = this.opts.now();
    return [...this.entries.values()].map((e) => ({
      ref: e.ref,
      idleMs: now - e.lastUsedAt,
      ageMs: now - e.createdAt,
    }));
  }

  async closeAll(): Promise<void> {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    for (const sessionId of [...this.entries.keys()]) await this.release(sessionId);
  }
}
