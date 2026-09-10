import {
  BindError,
  defaultModelKey,
  deleteBindCode,
  deleteBinding,
  discardOutbound,
  getBool,
  getInt,
  getSessionModel,
  getSetting,
  insertBinding,
  issueBindCode,
  listBindCodes,
  listBindings,
  listPendingOutbound,
  newBindCode,
  setSetting,
  setSessionModel,
  SETTINGS,
  type AgentId,
  type Binding,
  type Channel,
  type ChatMember,
  type Db,
  type DoctorCheck,
  type Logger,
  type MirrorMode,
  type ModelInfo,
} from '@anylark/core';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { SessionPool } from './session-pool.ts';

export interface UiDirListing {
  path: string;
  parent?: string;
  dirs: { name: string; path: string }[];
}

export interface UiSessionOption {
  sessionId: string;
  mtime: number;
}

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

export interface UiSettings {
  bootstrapEnabled: boolean;
  bootstrapMaxMessages: number;
  bootstrapMaxAgeDays: number;
  pendingWindowMax: number;
  codexSandboxMode: string;
}

export interface UiState {
  now: number;
  daemon: { pid: number; channel: string };
  bindings: (Binding & { name?: string })[];
  sessions: UiSession[];
  codes: { code: string; sessionId: string; expiresAt: number }[];
  chats: UiChat[];
  models: Record<string, ModelInfo[]>;
  defaultModels: Partial<Record<AgentId, string>>;
  settings: UiSettings;
  recentCwds: string[];
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
      ...(getSessionModel(this.deps.db, b.sessionId)
        ? { model: getSessionModel(this.deps.db, b.sessionId)! }
        : {}),
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
      defaultModels: {
        pi: getSetting(this.deps.db, defaultModelKey('pi')),
        claude: getSetting(this.deps.db, defaultModelKey('claude')),
        codex: getSetting(this.deps.db, defaultModelKey('codex')),
      },
      settings: {
        bootstrapEnabled: getBool(this.deps.db, SETTINGS.bootstrapEnabled, true),
        bootstrapMaxMessages: getInt(this.deps.db, SETTINGS.bootstrapMaxMessages, 50),
        bootstrapMaxAgeDays: getInt(this.deps.db, SETTINGS.bootstrapMaxAgeDays, 7),
        pendingWindowMax: getInt(this.deps.db, SETTINGS.pendingWindowMax, 50),
        codexSandboxMode: getSetting(this.deps.db, SETTINGS.codexSandboxMode) ?? '',
      },
      recentCwds: [...new Set(bindings.map((b) => b.cwd))],
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
        return { released: await this.deps.pool.release(String(body.sessionId ?? '')) };
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
      case '/api/default-model': {
        const agent = String(body.agent ?? 'pi') as AgentId;
        setSetting(
          this.deps.db,
          defaultModelKey(agent),
          body.model ? String(body.model) : undefined,
        );
        log.info('default model set', { agent, model: body.model ?? null });
        return { agent, model: body.model ?? null };
      }
      case '/api/settings': {
        const key = String(body.key ?? '');
        if (!(Object.values(SETTINGS) as string[]).includes(key)) {
          throw new Error(`不允许修改的配置项: ${key}`);
        }
        const raw = body.value;
        const value = raw === undefined || raw === null || raw === '' ? undefined : String(raw);
        setSetting(this.deps.db, key, value);
        log.info('setting set', { key, value: value ?? null });
        return { key, value: value ?? null };
      }
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

  /** 某 agent 的可选模型（不需要会话在运行，adapter 自行探测） */
  async listModels(agent: AgentId): Promise<ModelInfo[]> {
    const adapter = this.deps.pool.adapterFor(agent);
    if (!adapter?.models) return [];
    try {
      return await adapter.models();
    } catch {
      return [];
    }
  }

  /** 目录选择器：限制在 $HOME 内，避免任意路径浏览 */
  async listDirs(input?: string): Promise<UiDirListing> {
    const home = homedir();
    let path = input?.trim() ? resolve(input) : home;
    if (path !== home && !path.startsWith(home + '/')) path = home;
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: join(path, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      path,
      ...(path === home ? {} : { parent: dirname(path) }),
      dirs,
    };
  }

  /** 某目录下已有的 agent 会话，供会话选择器使用 */
  async listSessions(agent: AgentId, cwd: string): Promise<UiSessionOption[]> {
    const dir = sessionDirFor(agent, cwd);
    if (!dir) return [];
    const entries = await readdir(dir).catch(() => []);
    const out: UiSessionOption[] = [];
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = sessionIdFromFile(agent, name);
      if (!sessionId) continue;
      const info = await stat(join(dir, name)).catch(() => undefined);
      out.push({ sessionId, mtime: info?.mtimeMs ?? 0 });
    }
    return out.sort((a, b) => b.mtime - a.mtime).slice(0, 50);
  }

  async listMembers(chatId: string): Promise<ChatMember[]> {
    if (!this.deps.channel.listMembers) return [];
    return this.deps.channel.listMembers(chatId).catch(() => []);
  }
}

function sessionDirFor(agent: AgentId, cwd: string): string | undefined {
  if (agent === 'pi') {
    const slug = `--${cwd.replace(/^\//, '').replace(/\//g, '-')}--`;
    return join(homedir(), '.pi', 'agent', 'sessions', slug);
  }
  if (agent === 'claude') return join(homedir(), '.claude', 'projects', cwd.replace(/\//g, '-'));
  return undefined; // codex 的 rollout 按日期分目录，暂不列举
}

function sessionIdFromFile(agent: AgentId, name: string): string | undefined {
  if (agent === 'pi') return /_([^_]+)\.jsonl$/.exec(name)?.[1];
  if (agent === 'claude') return /^(.+)\.jsonl$/.exec(name)?.[1];
  return undefined;
}
