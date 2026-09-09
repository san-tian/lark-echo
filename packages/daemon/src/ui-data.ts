import {
  BindError,
  deleteBindCode,
  deleteBinding,
  discardOutbound,
  getSessionModel,
  insertBinding,
  issueBindCode,
  listBindCodes,
  listBindings,
  listPendingOutbound,
  newBindCode,
  setSessionModel,
  type AgentId,
  type Binding,
  type Channel,
  type Db,
  type DoctorCheck,
  type Logger,
  type MirrorMode,
  type ModelInfo,
} from '@lark-echo/core';
import type { SessionPool } from './session-pool.ts';

export interface UiChat {
  chatId: string;
  name: string;
  sessionId?: string;
}

export interface UiSession {
  sessionId: string;
  agent: AgentId;
  cwd: string;
  driver: string;
  idleMs: number;
  model?: string;
  capabilities: { modelSwitch: string };
}

export interface UiState {
  now: number;
  daemon: { pid: number; channel: string };
  bindings: (Binding & { name?: string })[];
  sessions: UiSession[];
  codes: { code: string; sessionId: string; expiresAt: number }[];
  chats: UiChat[];
  models: Record<string, ModelInfo[]>;
  queue: {
    pendingInbound: number;
    pendingOutbound: { id: number; chatId: string; text: string; attempts: number; createdAt: number }[];
  };
  doctor: { checks: DoctorCheck[]; at: number } | null;
}

export interface UiDataDeps {
  db: Db;
  channel: Channel;
  pool: SessionPool;
  flushOutbound: () => Promise<void>;
  pendingInbound: () => number;
  logger: Logger;
}

/**
 * 配置台的数据/动作层：与 CLI、会话内命令共用同一套 core 逻辑（§4.4）。
 * 写操作一律走这里，UI 不直接碰 SQLite。
 */
export class UiData {
  private readonly deps: UiDataDeps;
  private chatsCache?: { at: number; value: UiChat[] };
  private doctorCache?: { at: number; value: DoctorCheck[] };
  private readonly modelsCache = new Map<string, { at: number; value: ModelInfo[] }>();

  constructor(deps: UiDataDeps) {
    this.deps = deps;
  }

  async state(): Promise<UiState> {
    const chats = await this.chats();
    const nameOf = new Map(chats.map((c) => [c.chatId, c.name]));
    const bindings = listBindings(this.deps.db).map((b) => ({
      ...b,
      ...(nameOf.get(b.chatId) ? { name: nameOf.get(b.chatId) } : {}),
    }));
    const sessions: UiSession[] = this.deps.pool.list().map((s) => {
      const live = this.deps.pool.get(s.ref.sessionId);
      return {
        sessionId: s.ref.sessionId,
        agent: s.ref.agent,
        cwd: s.ref.cwd,
        driver: s.ref.driver,
        idleMs: s.idleMs,
        ...(getSessionModel(this.deps.db, s.ref.sessionId)
          ? { model: getSessionModel(this.deps.db, s.ref.sessionId)! }
          : {}),
        capabilities: { modelSwitch: live?.adapter.capabilities.modelSwitch ?? 'none' },
      };
    });
    const models: Record<string, ModelInfo[]> = {};
    for (const s of sessions) {
      const list = await this.modelsFor(s.sessionId);
      if (list.length) models[s.sessionId] = list;
    }
    return {
      now: Date.now(),
      daemon: { pid: process.pid, channel: this.deps.channel.id },
      bindings,
      sessions,
      codes: listBindCodes(this.deps.db).map((c) => ({
        code: c.code,
        sessionId: c.sessionId,
        expiresAt: c.expiresAt,
      })),
      chats,
      models,
      queue: {
        pendingInbound: this.deps.pendingInbound(),
        pendingOutbound: listPendingOutbound(this.deps.db, 50).map((m) => ({
          id: m.id,
          chatId: m.chatId,
          text: m.text,
          attempts: m.attempts,
          createdAt: m.createdAt,
        })),
      },
      doctor: this.doctorCache ? { checks: this.doctorCache.value, at: this.doctorCache.at } : null,
    };
  }

  /** 所有写操作入口；返回给前端的 JSON */
  async action(path: string, method: string, body: Record<string, unknown>): Promise<unknown> {
    const log = this.deps.logger.child({ svc: 'ui', action: path });
    switch (path) {
      case '/api/bind': {
        const binding = insertBinding(this.deps.db, {
          chatId: String(body.chatId ?? ''),
          sessionId: String(body.sessionId ?? ''),
          agent: String(body.agent ?? 'pi') as AgentId,
          cwd: String(body.cwd ?? process.cwd()),
          ownerOpenId: String(body.ownerOpenId ?? ''),
          mirrorMode: 'off' as MirrorMode,
          createdAt: Date.now(),
        });
        log.info('bind created', { chatId: binding.chatId, sessionId: binding.sessionId });
        return { binding };
      }
      case '/api/unbind': {
        const removed = deleteBinding(this.deps.db, String(body.chatId ?? ''));
        log.info('bind removed', { chatId: String(body.chatId ?? ''), removed });
        return { removed };
      }
      case '/api/code': {
        const sessionId = String(body.sessionId ?? '');
        const agent = String(body.agent ?? 'pi') as AgentId;
        const cwd = String(body.cwd ?? process.cwd());
        for (let i = 0; i < 10; i++) {
          try {
            const issued = issueBindCode(this.deps.db, { code: newBindCode(), sessionId, agent, cwd });
            log.info('code issued', { sessionId, expiresAt: issued.expiresAt });
            return { code: issued.code, expiresAt: issued.expiresAt };
          } catch (err) {
            if (err instanceof BindError) throw err;
            if (String(err).includes('UNIQUE')) continue;
            throw err;
          }
        }
        throw new Error('无法分配唯一绑定码，请重试');
      }
      case '/api/code/delete':
        return { removed: deleteBindCode(this.deps.db, String(body.code ?? '')) };
      case '/api/model': {
        const sessionId = String(body.sessionId ?? '');
        const model = body.model ? String(body.model) : undefined;
        setSessionModel(this.deps.db, sessionId, model);
        const live = this.deps.pool.get(sessionId);
        if (model && live?.adapter.setModel && live.adapter.capabilities.modelSwitch === 'runtime') {
          await live.adapter.setModel(live.handle, model);
          log.info('model switched (runtime)', { sessionId, model });
          return { applied: 'runtime', model };
        }
        log.info('model stored', { sessionId, model: model ?? null });
        return { applied: 'next-start', model: model ?? null };
      }
      case '/api/session/release': {
        await this.deps.pool.release(String(body.sessionId ?? ''));
        return { released: true };
      }
      case '/api/outbound/flush': {
        await this.deps.flushOutbound();
        return { flushed: true };
      }
      case '/api/outbound/discard':
        return { discarded: discardOutbound(this.deps.db, Number(body.id)) };
      case '/api/doctor/refresh':
        return { checks: await this.refreshDoctor() };
      case '/api/chats/refresh':
        return { chats: await this.refreshChats() };
      default:
        throw new Error(`unknown action: ${method} ${path}`);
    }
  }

  async chats(): Promise<UiChat[]> {
    if (this.chatsCache && Date.now() - this.chatsCache.at < 60_000) return this.chatsCache.value;
    return this.refreshChats();
  }

  private async refreshChats(): Promise<UiChat[]> {
    const bound = new Map(listBindings(this.deps.db).map((b) => [b.chatId, b.sessionId]));
    const value: UiChat[] = (await this.deps.channel.listChats()).map((c) => ({
      chatId: c.chatId,
      name: c.name,
      ...(bound.get(c.chatId) ? { sessionId: bound.get(c.chatId)! } : {}),
    }));
    this.chatsCache = { at: Date.now(), value };
    return value;
  }

  private async refreshDoctor(): Promise<DoctorCheck[]> {
    const checks = await this.deps.channel.doctor();
    this.doctorCache = { at: Date.now(), value: checks };
    return checks;
  }

  private async modelsFor(sessionId: string): Promise<ModelInfo[]> {
    const cached = this.modelsCache.get(sessionId);
    if (cached && Date.now() - cached.at < 30_000) return cached.value;
    const live = this.deps.pool.get(sessionId);
    if (!live?.adapter.models) return [];
    try {
      const value = await live.adapter.models(live.handle);
      this.modelsCache.set(sessionId, { at: Date.now(), value });
      return value;
    } catch {
      return [];
    }
  }
}
