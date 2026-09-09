import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createLogger, type Logger } from '@lark-echo/core';

export interface PiRpcOptions {
  command?: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  logger?: Logger;
  /** 请求超时（毫秒） */
  requestTimeoutMs?: number;
}

export interface PiResponse {
  type: 'response';
  command: string;
  success: boolean;
  id?: string;
  data?: unknown;
  error?: string;
}

export type PiEvent = Record<string, unknown> & { type: string };

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
}

const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

/**
 * `pi --mode rpc` 的 JSONL 客户端（协议见 docs/spikes/01-pi-rpc.md）。
 *
 * 两个 spike 结论直接体现在这里：
 * - 阻塞式 `extension_ui_request` 一律取消，避免 headless 进程卡死（spike 1 §2）
 * - 只按 LF 切分（协议要求，不能用 readline）
 */
export class PiRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly logger: Logger;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: PiEvent) => void>();
  private readonly requestTimeoutMs: number;
  private buffer = '';
  private counter = 0;
  private closed = false;
  private exitResolve!: () => void;
  readonly exited: Promise<void>;

  constructor(opts: PiRpcOptions) {
    this.logger = opts.logger ?? createLogger({ svc: 'pi-rpc' });
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.child = spawn(opts.command ?? 'pi', opts.args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
    });
    this.exited = new Promise((res) => {
      this.exitResolve = res;
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text) this.logger.debug('pi stderr', { text: text.slice(0, 500) });
    });
    this.child.on('exit', (code) => {
      this.closed = true;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`pi exited (code ${code}) while waiting for ${p.command}`));
        this.pending.delete(id);
      }
      this.exitResolve();
    });
    this.child.on('error', (err) => {
      this.logger.error('pi spawn failed', { error: String(err) });
      this.closed = true;
      this.exitResolve();
    });
  }

  onEvent(listener: (event: PiEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 发一条命令并等它的 response（事件继续走 onEvent） */
  request(command: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('pi rpc client is closed'));
    const id = `req-${++this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi rpc request timeout: ${command}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, command });
      this.write({ id, type: command, ...payload });
    });
  }

  /** 不需要响应的命令 */
  write(obj: Record<string, unknown>): void {
    if (this.closed) return;
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  async close(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.kill(signal);
    } catch {
      /* already gone */
    }
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 3000))]);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.logger.warn('unparseable pi output line', { line: line.slice(0, 300) });
        continue;
      }
      this.handle(parsed);
    }
  }

  private handle(obj: Record<string, unknown>): void {
    const type = String(obj.type ?? '');
    if (type === 'response') {
      const id = obj.id ? String(obj.id) : undefined;
      const pending = id ? this.pending.get(id) : undefined;
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id!);
      if (obj.success === false) {
        pending.reject(new Error(String(obj.error ?? `pi command failed: ${pending.command}`)));
      } else {
        pending.resolve(obj.data);
      }
      return;
    }
    if (type === 'extension_ui_request') {
      this.handleUiRequest(obj);
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(obj as PiEvent);
      } catch (err) {
        this.logger.error('event listener threw', { error: String(err), type });
      }
    }
  }

  /** 阻塞式对话框在 headless 下一律取消（spike 1 §2） */
  private handleUiRequest(obj: Record<string, unknown>): void {
    const method = String(obj.method ?? '');
    if (!DIALOG_METHODS.has(method)) return; // setWidget / status / notify 等是 fire-and-forget
    this.logger.warn('auto-cancelling blocking extension dialog', { method });
    this.write({ type: 'extension_ui_response', id: obj.id, cancelled: true });
  }
}
