import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLogger,
  newId,
  newTurnId,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentSessionHandle,
  type ContextBlock,
  type HistoryEntry,
  type Logger,
  type SessionRef,
  type StartOptions,
  type TurnEvent,
  type TurnHandle,
  type TurnResult,
  type UserMessage,
} from '@lark-echo/core';
import { buildTurnArgs, resolveCodexCommand, type SandboxMode } from './codex-cli.ts';
import {
  codexItem,
  extractErrorMessage,
  parseCodexLine,
  toolLabel,
  type CodexJsonEvent,
} from './events.ts';
import { findRolloutFile, readRolloutHistory } from './rollout.ts';

export interface CodexAdapterOptions {
  /** codex 可执行文件；默认 `which codex` → `CODEX_BIN` → 已知绝对路径 */
  command?: string;
  /** 默认模型；每轮以 `-m` 传入 */
  model?: string;
  /** 不传则沿用 codex 自己的 config.toml */
  sandboxMode?: SandboxMode;
  extraArgs?: string[];
  /** 会话级系统提示，每轮都拼到 prompt 前面（决策 21：回复契约） */
  appendSystemPrompt?: string;
  /** 默认 true（daemon 的 cwd 不一定是 git repo） */
  skipGitRepoCheck?: boolean;
  /** rollout 根目录；默认 `$CODEX_HOME/sessions` 或 `~/.codex/sessions` */
  sessionsDir?: string;
  turnTimeoutMs?: number;
  logger?: Logger;
}

interface ActiveTurn {
  turnId: string;
  listeners: Set<(event: TurnEvent) => void>;
  buffered: TurnEvent[];
  settle: (result: TurnResult) => void;
  settled: Promise<TurnResult>;
  done: boolean;
  aborted: boolean;
  completed: boolean;
  sawThreadStart: boolean;
  lastAgentMessage?: string;
  errorText?: string;
  timeoutError?: string;
  spawnError?: string;
  stderr: string;
  child?: ChildProcessWithoutNullStreams;
  tmpDir?: string;
  outFile?: string;
  timer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
}

interface CodexSession {
  ref: SessionRef;
  /** 该会话使用的模型（start 传入优先，其次 adapter 默认） */
  model?: string;
  /** 已确认可 resume 的 codex thread id；新会话在首轮 `thread.started` 后才有 */
  threadId?: string;
  /** true = 下一轮必须新建 thread */
  fresh: boolean;
  /** injectContext 累积，下一轮拼到 prompt 前面 */
  pendingContext: string[];
  current?: ActiveTurn;
}

/** 进程退出/信号收尾时用到的结果 */
interface ExitOutcome {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

const MAX_STDERR = 8 * 1024;

/**
 * Codex CLI 的 AgentAdapter：**每轮一个 `codex exec` 子进程**（docs/spikes/05-codex-adapter.md）。
 * 不用 app-server —— per-turn 已能可靠拿到最终文本与 thread id，且天然无跨轮串扰。
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  readonly capabilities: AgentCapabilities = {
    persistent: false,
    steer: false,
    liveAttach: 'lease',
    approvals: false,
    // 模型只能通过下一轮进程的 `-m` 生效，没有运行时切换接口（spike §3）
    modelSwitch: 'restart',
    // codex 自己生成 thread id（ULID），只能拿学到的 id resume
    sessionIdSemantics: 'opaque',
  };

  private readonly opts: CodexAdapterOptions;
  private readonly logger: Logger;
  private readonly command: string;
  private readonly sessionsDir: string;
  private readonly turnTimeoutMs: number;
  private readonly sessions = new Map<AgentSessionHandle, CodexSession>();

  constructor(opts: CodexAdapterOptions = {}) {
    this.opts = opts;
    this.logger = opts.logger ?? createLogger({ svc: 'adapter-codex' });
    this.command = resolveCodexCommand(opts.command);
    this.sessionsDir =
      opts.sessionsDir ??
      join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'sessions');
    this.turnTimeoutMs = opts.turnTimeoutMs ?? 10 * 60 * 1000;
  }

  async start(opts: StartOptions): Promise<AgentSessionHandle> {
    const ref: SessionRef = {
      agent: 'codex',
      // 新会话的占位 id 必须是 UUID：非 UUID 会被 resume 当成 thread name 静默新建会话（spike §1.3）
      sessionId: opts.sessionId ?? newId(),
      cwd: opts.cwd,
      driver: 'daemon',
    };
    const handle: AgentSessionHandle = { ref, capabilities: this.capabilities };
    const model = opts.model ?? this.opts.model;
    this.sessions.set(handle, {
      ref,
      ...(model ? { model } : {}),
      ...(opts.sessionId ? { threadId: opts.sessionId } : {}),
      fresh: !opts.sessionId,
      pendingContext: [],
    });
    this.logger.info('codex session registered', {
      sessionId: ref.sessionId,
      cwd: opts.cwd,
      resume: Boolean(opts.sessionId),
    });
    return handle;
  }

  async send(handle: AgentSessionHandle, msg: UserMessage): Promise<TurnHandle> {
    const session = this.requireSession(handle);
    const running = session.current;
    if (running && !running.done) {
      throw new Error(`codex turn already in progress: ${running.turnId}`);
    }

    const turnId = newTurnId();
    const listeners = new Set<(event: TurnEvent) => void>();
    let settle!: (result: TurnResult) => void;
    const settled = new Promise<TurnResult>((resolve) => {
      settle = resolve;
    });
    const active: ActiveTurn = {
      turnId,
      listeners,
      buffered: [],
      settle,
      settled,
      done: false,
      aborted: false,
      completed: false,
      sawThreadStart: false,
      stderr: '',
    };
    active.timer = setTimeout(() => {
      active.timeoutError = `codex turn timeout after ${this.turnTimeoutMs}ms`;
      this.logger.warn('codex turn timeout', { turnId, sessionId: session.ref.sessionId });
      this.kill(active, 'SIGKILL');
      void this.finish(session, active, { signal: 'SIGKILL' });
    }, this.turnTimeoutMs);
    session.current = active;

    try {
      this.spawnTurn(session, active, msg);
    } catch (err) {
      active.spawnError = String(err);
      void this.finish(session, active, {});
    }

    return {
      turnId,
      settled,
      onEvent: (listener) => {
        listeners.add(listener);
        if (active.buffered.length > 0) {
          const pending = active.buffered.splice(0, active.buffered.length);
          for (const event of pending) this.deliver(listener, event);
        }
        return () => listeners.delete(listener);
      },
    };
  }

  async abort(handle: AgentSessionHandle, turnId: string): Promise<void> {
    const session = this.requireSession(handle);
    const active = session.current;
    if (!active || active.turnId !== turnId || active.done) return;
    active.aborted = true;
    this.logger.info('aborting codex turn', { turnId });
    this.kill(active, 'SIGINT');
    active.killTimer = setTimeout(() => this.kill(active, 'SIGKILL'), 3_000);
    active.killTimer.unref?.();
    // 兜底：进程赖着不退就强制收尾
    const fallback = setTimeout(() => {
      if (!active.done) void this.finish(session, active, { signal: 'SIGKILL' });
    }, 5_000);
    fallback.unref?.();
  }

  async stop(handle: AgentSessionHandle): Promise<void> {
    const session = this.sessions.get(handle);
    if (!session) return;
    this.sessions.delete(handle);
    const active = session.current;
    if (active) {
      active.aborted = true;
      this.kill(active, 'SIGKILL');
      await Promise.race([
        active.settled,
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
      if (!active.done) await this.finish(session, active, { signal: 'SIGKILL' });
      this.cleanupTmp(active);
    }
    this.logger.info('codex session stopped', { sessionId: session.ref.sessionId });
  }

  async *history(handle: AgentSessionHandle, cursor?: string): AsyncIterable<HistoryEntry> {
    const session = this.requireSession(handle);
    const threadId = session.threadId ?? session.ref.sessionId;
    const file = findRolloutFile(this.sessionsDir, threadId);
    if (!file) {
      this.logger.warn('codex rollout not found for history', { threadId, sessionsDir: this.sessionsDir });
      return;
    }
    yield* readRolloutHistory(file, cursor);
  }

  async injectContext(handle: AgentSessionHandle, ctx: ContextBlock): Promise<void> {
    const session = this.requireSession(handle);
    session.pendingContext.push(ctx.text);
    this.logger.debug('context queued for next codex turn', {
      sessionId: handle.ref.sessionId,
      kind: ctx.kind,
    });
  }

  // ---------------------------------------------------------------- internals

  private spawnTurn(session: CodexSession, active: ActiveTurn, msg: UserMessage): void {
    const tmpDir = mkdtempSync(join(tmpdir(), 'lark-echo-codex-'));
    active.tmpDir = tmpDir;
    const outFile = join(tmpDir, 'last-message.txt');
    active.outFile = outFile;

    let imagePaths: string[] = [];
    if (msg.images?.length) imagePaths = writeImages(tmpDir, msg.images);

    const prompt = buildPrompt(msg, [
      ...(this.opts.appendSystemPrompt ? [this.opts.appendSystemPrompt] : []),
      ...session.pendingContext,
    ]);
    session.pendingContext = [];

    const resumeId = session.fresh ? undefined : session.threadId;
    const args = buildTurnArgs({
      ...(resumeId ? { resumeId } : {}),
      ...(session.model ? { model: session.model } : {}),
      ...(this.opts.sandboxMode ? { sandboxMode: this.opts.sandboxMode } : {}),
      ...(this.opts.extraArgs ? { extraArgs: this.opts.extraArgs } : {}),
      ...(this.opts.skipGitRepoCheck === undefined
        ? {}
        : { skipGitRepoCheck: this.opts.skipGitRepoCheck }),
      ...(imagePaths.length > 0 ? { imagePaths } : {}),
      outputLastMessagePath: outFile,
    });

    this.logger.info('spawning codex turn', {
      turnId: active.turnId,
      sessionId: session.ref.sessionId,
      resume: Boolean(resumeId),
      args: args.join(' '),
    });

    const child = spawn(this.command, args, {
      cwd: session.ref.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    active.child = child;

    child.stdout.setEncoding('utf8');
    let buffer = '';
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const event = parseCodexLine(line);
        if (event) this.handleEvent(session, active, event);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      active.stderr = (active.stderr + chunk).slice(-MAX_STDERR);
    });

    child.on('error', (err) => {
      active.spawnError = `无法启动 codex（${this.command}）：${err.message}`;
      void this.finish(session, active, {});
    });

    child.on('close', (exitCode, signal) => {
      if (buffer.trim()) {
        const event = parseCodexLine(buffer);
        if (event) this.handleEvent(session, active, event);
      }
      void this.finish(session, active, { exitCode, signal });
    });

    // 子进程早退时避免 EPIPE 变成 unhandled error
    child.stdin.on('error', () => undefined);
    child.stdin.end(prompt);
  }

  private handleEvent(session: CodexSession, active: ActiveTurn, event: CodexJsonEvent): void {
    switch (event.type) {
      case 'thread.started': {
        const threadId = typeof event.thread_id === 'string' ? event.thread_id : undefined;
        if (!threadId) break;
        active.sawThreadStart = true;
        if (session.fresh || !session.threadId) {
          session.threadId = threadId;
          session.fresh = false;
          if (session.ref.sessionId !== threadId) {
            this.logger.info('codex thread id learned', {
              placeholder: session.ref.sessionId,
              threadId,
            });
            // 新会话的首轮才拿得到真实 id；daemon 若已持久化占位 id 需回写（spike §4.3）
            session.ref.sessionId = threadId;
          }
        }
        break;
      }
      case 'turn.started':
        this.emit(active, { turnId: active.turnId, type: 'started' });
        break;
      case 'turn.completed':
        active.completed = true;
        break;
      case 'turn.failed':
        active.errorText = extractErrorMessage(event) ?? 'codex turn failed';
        break;
      case 'error':
        active.errorText = active.errorText ?? (extractErrorMessage(event) ?? 'codex error');
        break;
      case 'item.started':
      case 'item.completed': {
        const item = codexItem(event);
        if (!item) break;
        if (item.type === 'agent_message') {
          const text = typeof item.text === 'string' ? item.text : '';
          if (text) {
            active.lastAgentMessage = text;
            // --json 没有逐 token 增量，每条完整 agent 消息算一次 delta（spike §4.1）
            if (event.type === 'item.completed') {
              this.emit(active, { turnId: active.turnId, type: 'delta', text });
            }
          }
          break;
        }
        if (item.type === 'error') {
          active.errorText = active.errorText ?? (extractErrorMessage(event) ?? 'codex item error');
          break;
        }
        if (event.type === 'item.completed') {
          const label = toolLabel(item);
          if (label) this.emit(active, { turnId: active.turnId, type: 'tool', text: label });
        }
        break;
      }
      default:
        break;
    }
  }

  private async finish(
    session: CodexSession,
    active: ActiveTurn,
    outcome: ExitOutcome,
  ): Promise<void> {
    if (active.done) return;
    active.done = true;
    if (active.timer) clearTimeout(active.timer);
    if (active.killTimer) clearTimeout(active.killTimer);
    if (session.current === active) session.current = undefined;

    let text = active.lastAgentMessage ?? '';
    const fromFile = readOutFile(active.outFile);
    if (fromFile) text = fromFile; // `-o` 是权威最终文本（spike §1.2）
    this.cleanupTmp(active);

    let error = active.timeoutError ?? active.spawnError;
    // `turn.completed` 之前的 error 事件可能是可恢复的：实测 provider 断流时 codex 会连发
    // {"type":"error","message":"Reconnecting... 1/5 ..."} 并自行重连成功。只有没完成的 turn 才算失败。
    if (!error && !active.completed) error = active.errorText;
    if (!error && !active.aborted && !active.completed && outcome.exitCode !== 0 && !active.sawThreadStart) {
      const stderr = active.stderr.trim().slice(-500);
      error = `codex 未能启动会话（exit ${outcome.exitCode ?? '?'}）${stderr ? `: ${stderr}` : ''}`;
    }
    if (!error && !active.aborted && !active.completed && outcome.exitCode !== 0) {
      const stderr = active.stderr.trim().slice(-500);
      error = `codex exited with code ${outcome.exitCode}${stderr ? `: ${stderr}` : ''}`;
    }
    if (!error && active.completed && active.errorText) {
      this.logger.warn('codex reported a recoverable error before completing', {
        turnId: active.turnId,
        error: active.errorText,
      });
    }
    if (text) this.emit(active, { turnId: active.turnId, type: 'final', text });
    if (active.aborted) this.emit(active, { turnId: active.turnId, type: 'aborted' });
    if (error) this.emit(active, { turnId: active.turnId, type: 'error', text: error });

    active.settle({
      text,
      aborted: active.aborted,
      ...(error ? { error } : {}),
    });
  }

  private emit(active: ActiveTurn, event: TurnEvent): void {
    if (active.listeners.size === 0) {
      // 订阅者还没挂上（send 返回前的 started/delta 可能先到），先缓存
      if (active.buffered.length < 100) active.buffered.push(event);
      return;
    }
    for (const listener of active.listeners) this.deliver(listener, event);
  }

  private deliver(listener: (event: TurnEvent) => void, event: TurnEvent): void {
    try {
      listener(event);
    } catch (err) {
      this.logger.error('codex event listener threw', { error: String(err), type: event.type });
    }
  }

  private kill(active: ActiveTurn, signal: NodeJS.Signals): void {
    const child = active.child;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill(signal);
    } catch (err) {
      this.logger.warn('codex kill failed', { signal, error: String(err) });
    }
  }

  private cleanupTmp(active: ActiveTurn): void {
    const dir = active.tmpDir;
    if (!dir) return;
    active.tmpDir = undefined;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn('codex temp cleanup failed', { dir, error: String(err) });
    }
  }

  private requireSession(handle: AgentSessionHandle): CodexSession {
    const session = this.sessions.get(handle);
    if (!session) throw new Error(`codex session not started: ${handle.ref.sessionId}`);
    return session;
  }
}

export function buildPrompt(msg: UserMessage, injected: string[] = []): string {
  const parts: string[] = [...injected];
  for (const ctx of msg.context ?? []) parts.push(ctx.text);
  parts.push(msg.text);
  return parts.join('\n\n');
}

function readOutFile(file: string | undefined): string {
  if (!file || !existsSync(file)) return '';
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function writeImages(dir: string, images: NonNullable<UserMessage['images']>): string[] {
  return images.map((image, index) => {
    const file = join(dir, `image-${index}.${extensionFor(image.mimeType)}`);
    writeFileSync(file, Buffer.from(image.data, 'base64'), { mode: 0o600 });
    return file;
  });
}

function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'bin';
  }
}
