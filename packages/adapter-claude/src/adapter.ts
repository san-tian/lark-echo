/**
 * Claude Code 的 AgentAdapter（DESIGN §10.3 / §10.4）。
 *
 * 事实基线（spike 4 实测，claude 2.1.258）：
 * - **一个 turn 一个进程**：`claude -p --output-format stream-json --verbose --include-partial-messages`
 * - 续跑用 `--resume <session_id>`（跨目录按 ID 找，见 spike 4）
 * - 第一轮没有 session id：不传 `--resume`，从 `system/init` 的 `session_id` 学回来
 * - 最终文本取 `result` 事件的 `result` 字段
 * - 流式文本取 `stream_event` → `content_block_delta` → `delta.type === "text_delta"` 的 `delta.text`
 * - 无头模式下权限提示**不会挂住**：CLI 直接拒绝并回 `system/permission_denied`（spike 4 实测）；
 *   仍然有 turn 超时兜底，防 CLI 版本漂移后卡死
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  createLogger,
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
} from '@instead/core';
import {
  assistantText,
  deltaText,
  parseStreamLine,
  sessionIdOf,
  toolUseNames,
  type ClaudeResultEvent,
  type ClaudeStreamMessage,
} from './stream-json.ts';
import {
  claudeProjectsRoot,
  readTranscript,
  transcriptExists,
  transcriptPath,
} from './transcript.ts';

export interface ClaudeAdapterOptions {
  /** 默认 `claude`（本机 /usr/local/bin/claude） */
  command?: string;
  /** 传 `--model <model>`；`modelSwitch: 'restart'` 表示只在下一次 start 时生效 */
  model?: string;
  /** 传 `--permission-mode <mode>`；**默认不传**，交给用户自己的 Claude 配置（决策 5：不拦截） */
  permissionMode?: string;
  /** 每轮都追加的静态系统提示（`--append-system-prompt`） */
  appendSystemPrompt?: string;
  extraArgs?: string[];
  /** 单轮超时，默认 10 分钟 */
  turnTimeoutMs?: number;
  /** 覆盖 `~/.claude/projects`（测试用；默认跟随 `CLAUDE_CONFIG_DIR`） */
  projectsRoot?: string;
  logger?: Logger;
}

export interface ClaudeArgsInput {
  /** claude 自己的 session_id；第一轮没有 */
  resume?: string;
  /** 第一轮用它钉住 session id，使逻辑 id == claude id（daemon 重启后仍能 resume） */
  sessionId?: string;
  model?: string;
  permissionMode?: string;
  appendSystemPrompt?: string;
  extraArgs?: string[];
}

/**
 * 单轮命令行。
 * 实测约束：`--output-format stream-json` 必须配 `--verbose`；增量消息要 `--include-partial-messages`。
 * prompt **不走 argv**（写 stdin），避免把群消息里的敏感内容放进 `ps`。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 钉住 session id 的策略：
 * - 逻辑 id 是 UUID → 直接 `--session-id`，claude 用它，重启后能 `--resume`（无需别名）
 * - 不是 UUID（如 `le-e2e`）→ claude 会报 `Invalid session ID`，所以不传，
 *   改成从流里学真实 id，由 daemon 的 session_aliases 持久化
 */
const pinnableId = (id: string): string | undefined => (UUID_RE.test(id) ? id : undefined);

export function buildArgs(input: ClaudeArgsInput): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (input.resume) args.push('--resume', input.resume);
  else if (input.sessionId) args.push('--session-id', input.sessionId);
  if (input.model) args.push('--model', input.model);
  if (input.permissionMode) args.push('--permission-mode', input.permissionMode);
  if (input.appendSystemPrompt) args.push('--append-system-prompt', input.appendSystemPrompt);
  if (input.extraArgs?.length) args.push(...input.extraArgs);
  return args;
}

/** 日志用：`--append-system-prompt` 的值（群消息上下文）不进日志 */
export function redactArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    out.push(arg);
    if (arg === '--append-system-prompt' && i + 1 < args.length) {
      out.push(`<${args[i + 1]!.length} chars>`);
      i++;
    }
  }
  return out;
}

/** 与 pi adapter 一致：注入的只读上下文放在真实消息之前 */
export function buildPrompt(msg: UserMessage): string {
  const parts: string[] = [];
  for (const ctx of msg.context ?? []) parts.push(ctx.text);
  parts.push(msg.text);
  return parts.join('\n\n');
}

interface ActiveTurn {
  turnId: string;
  listeners: Set<(event: TurnEvent) => void>;
  settle: (result: TurnResult) => void;
  done: boolean;
  text: string;
  sawDelta: boolean;
  aborted: boolean;
  buffer: string;
  stderr: string;
  child?: ChildProcess;
  timer: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
}

interface ClaudeSession {
  ref: SessionRef;
  /** claude 自己的 session_id；第一轮从 `system/init` 学到，之后用于 `--resume` */
  claudeSessionId?: string;
  /** 本次 start 传入的模型（覆盖 adapter 默认） */
  model?: string;
  /** injectContext 排队，下一轮拼进 `--append-system-prompt` */
  pendingContext: string[];
  current?: ActiveTurn;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 3000;

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude' as const;
  readonly capabilities: AgentCapabilities = {
    // 一轮一进程，没有常驻会话进程
    persistent: false,
    // CLI 无中途注入用户消息的能力
    steer: false,
    // 同一 session 由 daemon 单飞；用户自己的 TUI 要接管得先停 daemon（租约语义）
    liveAttach: 'lease',
    // 无头下权限提示直接拒绝，没有审批通道
    approvals: false,
    // 只有 `--model` 启动参数，没有运行时切换；下一次 start 生效
    modelSwitch: 'restart',
    // claude 自己生成 UUID 会话 id，只能拿学到的 id resume
    sessionIdSemantics: 'opaque',
  };

  private readonly opts: ClaudeAdapterOptions;
  private readonly logger: Logger;
  private readonly projectsRoot: string;
  /** 保留已释放的会话（含学到的 claudeSessionId），idle 回收后再 acquire 仍能 --resume */
  private readonly sessions = new Map<string, ClaudeSession>();

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.opts = opts;
    this.logger = opts.logger ?? createLogger({ svc: 'adapter-claude' });
    this.projectsRoot = opts.projectsRoot ?? claudeProjectsRoot();
  }

  async start(opts: StartOptions): Promise<AgentSessionHandle> {
    const sessionId = opts.sessionId ?? newTurnId();
    const ref: SessionRef = { agent: 'claude', sessionId, cwd: opts.cwd, driver: 'daemon' };
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.ref = ref;
      if (opts.model) existing.model = opts.model;
      this.logger.info('claude session reused', {
        sessionId,
        cwd: opts.cwd,
        claudeSessionId: existing.claudeSessionId ?? null,
      });
      return { ref, capabilities: this.capabilities };
    }
    // 请求的 id 本身有转录文件（比如用户在 CLI 里 --session <claude session id> 绑定已有会话）→ 直接续跑
    const known = transcriptExists(opts.cwd, sessionId, this.projectsRoot) ? sessionId : undefined;
    const session: ClaudeSession = {
      ref,
      pendingContext: [],
      ...(known ? { claudeSessionId: known } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    };
    this.sessions.set(sessionId, session);
    this.logger.info('claude session started', {
      sessionId,
      cwd: opts.cwd,
      resumable: Boolean(known),
    });
    return { ref, capabilities: this.capabilities };
  }

  async send(handle: AgentSessionHandle, msg: UserMessage): Promise<TurnHandle> {
    const session = this.requireSession(handle);
    if (msg.images?.length) {
      // claude -p 的纯文本 stdin 模式不吃图片；要支持得换 --input-format stream-json（见 spike 4 缺口）
      throw new Error('adapter-claude 暂不支持图片输入');
    }
    const turnId = newTurnId();
    const listeners = new Set<(event: TurnEvent) => void>();
    let settle!: (result: TurnResult) => void;
    const settled = new Promise<TurnResult>((res) => {
      settle = res;
    });
    const active: ActiveTurn = {
      turnId,
      listeners,
      settle,
      done: false,
      text: '',
      sawDelta: false,
      aborted: false,
      buffer: '',
      stderr: '',
      timer: setTimeout(() => {
        this.logger.warn('turn timeout', { turnId, sessionId: session.ref.sessionId });
        this.kill(active);
        void this.finish(session, active, { error: 'turn timeout' });
      }, this.opts.turnTimeoutMs ?? DEFAULT_TIMEOUT_MS),
    };
    session.current = active;

    const injected = session.pendingContext.splice(0, session.pendingContext.length).join('\n\n');
    const appendSystemPrompt = [this.opts.appendSystemPrompt, injected]
      .filter((part): part is string => Boolean(part))
      .join('\n\n');
    const model = session.model ?? this.opts.model;
    const args = buildArgs({
      ...(session.claudeSessionId
        ? { resume: session.claudeSessionId }
        : // 第一轮：逻辑 id 是 UUID 就钉住，否则让 claude 自己生成、我们从流里学
          (() => {
            const pinned = pinnableId(session.ref.sessionId);
            return pinned ? { sessionId: pinned } : {};
          })()),
      ...(model ? { model } : {}),
      ...(this.opts.permissionMode ? { permissionMode: this.opts.permissionMode } : {}),
      ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
      ...(this.opts.extraArgs ? { extraArgs: this.opts.extraArgs } : {}),
    });
    this.logger.info('claude turn start', {
      turnId,
      sessionId: session.ref.sessionId,
      cwd: session.ref.cwd,
      resume: session.claudeSessionId ?? null,
      args: redactArgs(args).join(' '),
    });

    const turnHandle = (): TurnHandle => ({
      turnId,
      settled,
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });

    let child: ChildProcess;
    try {
      child = spawn(this.opts.command ?? 'claude', args, {
        cwd: session.ref.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // 凭据只走环境/用户配置，argv 上永远没有 secret
        env: process.env,
      });
    } catch (err) {
      await this.finish(session, active, { error: `claude spawn failed: ${String(err)}` });
      return turnHandle();
    }
    active.child = child;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onStdout(session, active, chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      active.stderr = (active.stderr + chunk).slice(-4000);
    });
    child.on('error', (err) => {
      void this.finish(session, active, { error: `claude spawn error: ${String(err)}` });
    });
    child.on('close', (code, signal) => {
      void this.onClose(session, active, code, signal);
    });
    child.stdin?.on('error', () => {
      /* 进程早退时 EPIPE，真实原因在 close/stderr 里 */
    });
    // prompt 走 stdin（不是 argv）
    child.stdin?.end(`${buildPrompt(msg)}\n`);

    return turnHandle();
  }

  /**
   * 中断当前 turn。
   * 用 SIGTERM：实测（spike 4）SIGTERM 直接终止，不产出 `result` 事件；
   * 而 SIGINT 会被 CLI 解释成「用户打断」，先吐一条 `user` 消息 `[Request interrupted by user]`
   * 再给 `result{subtype:"error_during_execution", terminal_reason:"aborted_streaming"}` —— 更接近
   * 交互式 Ctrl-C 的语义。这里选 SIGTERM 是因为 abort 的语义是「停掉这一轮」，不想让 CLI
   * 把半截话写进转录；要更温和的语义就换 SIGINT。
   */
  async abort(handle: AgentSessionHandle, turnId: string): Promise<void> {
    const session = this.requireSession(handle);
    const active = session.current;
    if (!active || active.turnId !== turnId) return;
    active.aborted = true;
    this.logger.info('aborting claude turn', { turnId, sessionId: session.ref.sessionId });
    this.kill(active);
    // 兜底：进程没退出也要收尾，别让 dispatcher 的队列卡住
    setTimeout(() => {
      if (session.current === active && !active.done) {
        void this.finish(session, active, { aborted: true });
      }
    }, 5000).unref?.();
  }

  async stop(handle: AgentSessionHandle): Promise<void> {
    const session = this.sessions.get(handle.ref.sessionId);
    if (!session) return;
    const active = session.current;
    if (active && !active.done) {
      active.aborted = true;
      this.kill(active);
    }
    session.pendingContext = [];
    // 刻意保留 session 记录（含 claudeSessionId）：一轮一进程，没有常驻进程要关，
    // 而 idle 回收（§11.4）后再次 acquire 必须还能 --resume，否则会话历史就断了。
    this.logger.info('claude session stopped', {
      sessionId: session.ref.sessionId,
      claudeSessionId: session.claudeSessionId ?? null,
    });
  }

  async *history(handle: AgentSessionHandle, cursor?: string): AsyncIterable<HistoryEntry> {
    const session = this.requireSession(handle);
    const sessionId = session.claudeSessionId ?? session.ref.sessionId;
    const file = transcriptPath(session.ref.cwd, sessionId, this.projectsRoot);
    yield* readTranscript(file, cursor);
  }

  /** 把只读上下文排队，下一轮拼进 `--append-system-prompt`（§6.2 注入通道） */
  async injectContext(handle: AgentSessionHandle, ctx: ContextBlock): Promise<void> {
    const session = this.requireSession(handle);
    session.pendingContext.push(ctx.text);
    this.logger.info('claude context queued', {
      sessionId: session.ref.sessionId,
      kind: ctx.kind,
      chars: ctx.text.length,
    });
  }

  private onStdout(session: ClaudeSession, active: ActiveTurn, chunk: string): void {
    active.buffer += chunk;
    let idx: number;
    while ((idx = active.buffer.indexOf('\n')) >= 0) {
      const line = active.buffer.slice(0, idx);
      active.buffer = active.buffer.slice(idx + 1);
      this.onLine(session, active, line);
    }
  }

  private onLine(session: ClaudeSession, active: ActiveTurn, line: string): void {
    if (!line.trim() || active.done) return;
    const msg = parseStreamLine(line);
    if (!msg) {
      this.logger.warn('unparseable claude stream line', { line: line.slice(0, 300) });
      return;
    }
    const sid = sessionIdOf(msg);
    if (sid && session.claudeSessionId !== sid) {
      // 第一轮在这里学到 claude 自己的 session_id，之后每轮 --resume 它
      // （因为我们用 --session-id 钉过，正常情况下 sid === ref.sessionId）
      session.claudeSessionId = sid;
      if (sid !== session.ref.sessionId) {
        // 回传给 daemon：真实 id 变了，SessionPool 会把它持久化到 session_aliases
        this.logger.info('claude session id differs from requested', {
          requested: session.ref.sessionId,
          actual: sid,
        });
        // ref.sessionId 是 sessions 的 key —— 改 ref 必须同时改 map，
        // 否则后续 requireSession(handle) 拿新 id 去查会查不到（"session not started"）。
        // 两个 key 都留：调用方手里的 handle 可能还是旧 id。
        this.sessions.delete(session.ref.sessionId);
        session.ref.sessionId = sid;
        this.sessions.set(sid, session);
      }
      this.logger.info('learned claude session id', {
        sessionId: session.ref.sessionId,
        claudeSessionId: sid,
      });
    }
    this.onMessage(session, active, msg);
  }

  private onMessage(session: ClaudeSession, active: ActiveTurn, msg: ClaudeStreamMessage): void {
    switch (msg.type) {
      case 'system': {
        const subtype = String(msg.subtype ?? '');
        if (subtype === 'permission_denied') {
          const tool = String(msg.tool_name ?? 'tool');
          this.logger.warn('claude permission denied', { tool, turnId: active.turnId });
          this.emit(active, {
            turnId: active.turnId,
            type: 'tool',
            text: `permission-denied: ${tool}`,
          });
        }
        return;
      }
      case 'stream_event': {
        const delta = deltaText(msg);
        if (delta) {
          active.sawDelta = true;
          active.text += delta;
          this.emit(active, { turnId: active.turnId, type: 'delta', text: delta });
        }
        return;
      }
      case 'assistant': {
        for (const name of toolUseNames(msg)) {
          this.emit(active, { turnId: active.turnId, type: 'tool', text: name });
        }
        if (!active.sawDelta) {
          // 没有 partial messages 时的兜底文本来源
          const text = assistantText(msg);
          if (text) active.text = text;
        }
        return;
      }
      case 'result': {
        void this.finish(session, active, { result: msg as ClaudeResultEvent });
        return;
      }
      default:
        return;
    }
  }

  private emit(active: ActiveTurn, event: TurnEvent): void {
    for (const listener of active.listeners) listener(event);
  }

  private async onClose(
    session: ClaudeSession,
    active: ActiveTurn,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (active.buffer.trim()) {
      this.onLine(session, active, active.buffer);
      active.buffer = '';
    }
    if (active.done) return;
    if (active.aborted) {
      await this.finish(session, active, { aborted: true });
      return;
    }
    const stderr = active.stderr.trim().slice(0, 300);
    await this.finish(session, active, {
      error: `claude exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})${stderr ? `: ${stderr}` : ''}`,
    });
  }

  /** 收尾：算最终文本 / 错误，发 final|aborted|error，settle */
  private async finish(
    session: ClaudeSession,
    active: ActiveTurn,
    outcome: { result?: ClaudeResultEvent; aborted?: boolean; error?: string },
  ): Promise<void> {
    if (active.done) return;
    active.done = true;
    clearTimeout(active.timer);
    if (active.killTimer) clearTimeout(active.killTimer);
    if (session.current === active) session.current = undefined;

    let text = active.text;
    let aborted = Boolean(outcome.aborted);
    let error = outcome.error;

    const result = outcome.result;
    if (result) {
      if (typeof result.result === 'string') text = result.result;
      if (result.is_error) {
        const detail =
          (typeof result.result === 'string' && result.result) ||
          (Array.isArray(result.errors) && result.errors.length > 0
            ? result.errors.join('; ')
            : String(result.subtype ?? 'claude error'));
        error = error ?? detail;
        if (result.terminal_reason === 'aborted_streaming' || result.terminal_reason === 'aborted') {
          aborted = true;
        }
        if (/No conversation found/i.test(detail) && session.claudeSessionId) {
          // 转录被删/清空：丢掉缓存的 id，下一轮重新开会话，否则每轮都失败
          this.logger.warn('resume target missing, dropping claude session id', {
            sessionId: session.ref.sessionId,
            claudeSessionId: session.claudeSessionId,
          });
          session.claudeSessionId = undefined;
        }
      }
    } else if (!error && !aborted) {
      error = 'claude 进程结束但未产出 result 事件';
    }

    if (text) this.emit(active, { turnId: active.turnId, type: 'final', text });
    if (aborted) this.emit(active, { turnId: active.turnId, type: 'aborted' });
    if (error) this.emit(active, { turnId: active.turnId, type: 'error', text: error });
    active.settle({
      text,
      aborted,
      ...(error ? { error } : {}),
    });
  }

  /** SIGTERM，宽限期后 SIGKILL */
  private kill(active: ActiveTurn): void {
    const child = active.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    active.killTimer = setTimeout(() => {
      if (active.done) return;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, KILL_GRACE_MS);
    active.killTimer.unref?.();
  }

  private requireSession(handle: AgentSessionHandle): ClaudeSession {
    const session = this.sessions.get(handle.ref.sessionId);
    if (!session) throw new Error(`claude session not started: ${handle.ref.sessionId}`);
    return session;
  }
}
