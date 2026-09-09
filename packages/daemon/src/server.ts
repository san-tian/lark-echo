import {
  BindError,
  createLogger,
  deleteBinding,
  getBinding,
  insertBinding,
  issueBindCode,
  listBindings,
  newBindCode,
  paths,
  pruneExpiredBindCodes,
  setMirrorMode,
  SessionQueue,
  Dispatcher,
  countPendingInbound,
  type AgentAdapter,
  type AgentId,
  type Binding,
  type Channel,
  type Db,
  type Logger,
  type MirrorMode,
} from '@lark-echo/core';
import { IpcServer, type IpcParams } from './ipc.ts';
import { SessionPool } from './session-pool.ts';

export interface DaemonOptions {
  db: Db;
  channel: Channel;
  adapters: Partial<Record<AgentId, AgentAdapter>>;
  socketPath?: string;
  logger?: Logger;
  idleMs?: number;
  queue?: SessionQueue;
  flushIntervalMs?: number;
  sweepIntervalMs?: number;
  /** 仅测试：允许通过 IPC 注入入站事件 */
  allowInjection?: boolean;
}

export interface DaemonStatus {
  channel: string;
  bindings: number;
  sessions: number;
  pendingInbound: number;
  queueBySession: Record<string, number>;
}

/**
 * daemon：IPC + 渠道 + 会话池 + 定时任务。
 * 所有写操作走同一套 core 逻辑 —— CLI / pi 扩展 / Web 配置台都是它的前端（§4.4）。
 */
export class Daemon {
  readonly dispatcher: Dispatcher;
  readonly pool: SessionPool;
  readonly queue: SessionQueue;
  private readonly db: Db;
  private readonly channel: Channel;
  private readonly logger: Logger;
  private readonly ipc: IpcServer;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly allowInjection: boolean;
  private readonly flushIntervalMs: number;
  private readonly sweepIntervalMs: number;

  constructor(opts: DaemonOptions) {
    this.db = opts.db;
    this.channel = opts.channel;
    this.logger = opts.logger ?? createLogger({ svc: 'daemon' });
    this.allowInjection = opts.allowInjection ?? false;
    this.flushIntervalMs = opts.flushIntervalMs ?? 5_000;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 60_000;
    this.queue = opts.queue ?? new SessionQueue({ logger: this.logger });
    this.pool = new SessionPool({
      adapters: opts.adapters,
      logger: this.logger,
      ...(opts.idleMs ? { idleMs: opts.idleMs } : {}),
    });
    this.dispatcher = new Dispatcher({
      db: opts.db,
      channel: opts.channel,
      driver: this.pool,
      queue: this.queue,
      logger: this.logger,
    });
    this.ipc = new IpcServer(
      opts.socketPath ?? paths.socket(),
      (method, params) => this.handle(method, params),
      this.logger,
    );
  }

  async start(): Promise<void> {
    await this.ipc.listen();
    await this.channel.start((msg) => {
      void this.dispatcher.handleInbound(msg).catch((err) => {
        this.logger.error('handleInbound failed', { error: String(err), eventId: msg.id });
      });
    });
    this.timers.push(
      setInterval(() => void this.dispatcher.flushOutbound(), this.flushIntervalMs),
      setInterval(() => void this.pool.sweep(), this.sweepIntervalMs),
      setInterval(() => pruneExpiredBindCodes(this.db), 60_000),
    );
    for (const t of this.timers) t.unref?.();
    this.logger.info('daemon started', { socket: paths.socket() });
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    await this.channel.stop().catch(() => undefined);
    await this.pool.closeAll();
    await this.ipc.close();
    this.logger.info('daemon stopped');
  }

  status(): DaemonStatus {
    const bindings = listBindings(this.db);
    const sessions = this.pool.list();
    const queueBySession: Record<string, number> = {};
    for (const s of sessions) queueBySession[s.ref.sessionId] = this.queue.pendingCount(s.ref.sessionId);
    return {
      channel: this.channel.id,
      bindings: bindings.length,
      sessions: sessions.length,
      pendingInbound: countPendingInbound(this.db),
      queueBySession,
    };
  }

  private async handle(method: string, params: IpcParams): Promise<unknown> {
    switch (method) {
      case 'ping':
        return { ok: true, pid: process.pid };
      case 'status':
        return this.status();
      case 'bind.list':
        return listBindings(this.db);
      case 'bind.get':
        return getBinding(this.db, String(params.chatId)) ?? null;
      case 'bind.add':
        return this.bindAdd(params);
      case 'bind.remove':
        return { removed: deleteBinding(this.db, String(params.chatId)) };
      case 'bind.code.issue':
        return this.issueCode(params);
      case 'mirror.set':
        return {
          updated: setMirrorMode(
            this.db,
            String(params.chatId),
            String(params.mode) as MirrorMode,
          ),
        };
      case 'session.list':
        return this.pool.list();
      case 'session.release':
        await this.pool.release(String(params.sessionId));
        return { released: true };
      case 'doctor':
        return { checks: await this.channel.doctor() };
      case 'channel.chats':
        return this.channel.listChats();
      case 'inbound.inject':
        if (!this.allowInjection) throw new Error('injection disabled');
        await this.dispatcher.handleInbound(params.message as never);
        return { injected: true };
      case 'shutdown':
        setTimeout(() => void this.stop(), 10).unref?.();
        return { stopping: true };
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  private bindAdd(params: IpcParams): Binding {
    return insertBinding(this.db, {
      chatId: String(params.chatId),
      sessionId: String(params.sessionId),
      agent: String(params.agent ?? 'pi') as AgentId,
      cwd: String(params.cwd ?? process.cwd()),
      ownerOpenId: String(params.ownerOpenId ?? ''),
      mirrorMode: (params.mirrorMode ? String(params.mirrorMode) : 'off') as MirrorMode,
      createdAt: Date.now(),
    });
  }

  private issueCode(params: IpcParams): { code: string; expiresAt: number } {
    const sessionId = String(params.sessionId);
    const agent = String(params.agent ?? 'pi') as AgentId;
    const cwd = String(params.cwd ?? process.cwd());
    const ttlMs = params.ttlMs ? Number(params.ttlMs) : undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = newBindCode();
      try {
        const issued = issueBindCode(this.db, {
          code,
          sessionId,
          agent,
          cwd,
          ...(ttlMs ? { ttlMs } : {}),
        });
        return { code: issued.code, expiresAt: issued.expiresAt };
      } catch (err) {
        if (err instanceof BindError) throw err;
        if (String(err).includes('UNIQUE')) continue;
        throw err;
      }
    }
    throw new Error('failed to allocate a unique bind code');
  }
}
