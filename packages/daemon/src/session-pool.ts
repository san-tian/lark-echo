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
  /** 启动会话时使用的模型（`<provider>/<modelId>`），来自 session_settings / 默认模型 */
  getModel?: (sessionId: string, agent: AgentId) => string | undefined;
  /** 逻辑 id → adapter 实际使用的 id（如 codex thread_id），用于重启后 resume */
  resolveSessionId?: (logicalId: string, agent: AgentId) => string | undefined;
  /** adapter 学到真实 id 后回调（持久化别名） */
  onSessionId?: (logicalId: string, agent: AgentId, realId: string) => void;
  logger?: Logger;
  now?: () => number;
}

interface PoolEntry {
  ref: SessionRef;
  adapter: AgentAdapter;
  handle: AgentSessionHandle;
  lastUsedAt: number;
  createdAt: number;
  /** 已经上报过的真实 id，避免重复写库 */
  reportedRealId?: string;
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
  private readonly opts: SessionPoolOptions & { logger: Logger; idleMs: number; now: () => number };
  private sweeper?: NodeJS.Timeout;

  constructor(opts: SessionPoolOptions) {
    this.opts = {
      ...opts,
      idleMs: opts.idleMs ?? 30 * 60 * 1000,
      now: opts.now ?? (() => Date.now()),
      logger: opts.logger ?? createLogger({ svc: 'session-pool' }),
    };
  }

  async acquire(ref: SessionRef): Promise<{ adapter: AgentAdapter; handle: AgentSessionHandle }> {
    let entry = this.entries.get(ref.sessionId);
    if (!entry) {
      const adapter = this.opts.adapters[ref.agent];
      if (!adapter) throw new Error(`no adapter registered for agent: ${ref.agent}`);
      const model = this.opts.getModel?.(ref.sessionId, ref.agent);
      // 有别名时用真实 id 启动（per-turn adapter 重启后 resume）
      const realId = this.opts.resolveSessionId?.(ref.sessionId, ref.agent) ?? ref.sessionId;
      const handle = await adapter.start({
        cwd: ref.cwd,
        sessionId: realId,
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

  /** 按 agent 取 adapter（控制台列模型用，不需要会话已启动） */
  adapterFor(agent: AgentId): AgentAdapter | undefined {
    return this.opts.adapters[agent];
  }

  touch(ref: SessionRef): void {
    const entry = this.entries.get(ref.sessionId);
    if (!entry) return;
    entry.lastUsedAt = this.opts.now();
    // per-turn adapter 会在第一轮把 handle.ref.sessionId 改成 CLI 真实 id
    const real = entry.handle.ref.sessionId;
    if (real && real !== ref.sessionId && entry.reportedRealId !== real) {
      entry.reportedRealId = real;
      this.opts.logger.info('session id alias learned', {
        logicalId: ref.sessionId,
        realId: real,
        agent: ref.agent,
      });
      this.opts.onSessionId?.(ref.sessionId, ref.agent, real);
    }
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
