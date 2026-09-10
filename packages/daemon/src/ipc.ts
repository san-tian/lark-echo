import { chmodSync, unlinkSync } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { createLogger, type Logger } from '@instead/core';

export type IpcParams = Record<string, unknown>;

export interface IpcRequest {
  id: string;
  method: string;
  params?: IpcParams;
}

export interface IpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type IpcHandler = (method: string, params: IpcParams) => Promise<unknown>;

/** Unix domain socket + JSONL（§10）。只监听本机文件，权限 0600。 */
export class IpcServer {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly logger: Logger;
  private readonly socketPath: string;
  private readonly handler: IpcHandler;

  constructor(socketPath: string, handler: IpcHandler, logger?: Logger) {
    this.socketPath = socketPath;
    this.handler = handler;
    this.logger = logger ?? createLogger({ svc: 'ipc' });
    this.server = createServer((socket) => this.onConnection(socket));
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        try {
          chmodSync(this.socketPath, 0o600);
        } catch {
          /* ignore */
        }
        this.logger.info('ipc listening', { socket: this.socketPath });
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    try {
      unlinkSync(this.socketPath);
    } catch {
      /* ignore */
    }
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        void this.dispatch(socket, line);
      }
    });
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));
  }

  private async dispatch(socket: Socket, line: string): Promise<void> {
    let req: IpcRequest;
    try {
      req = JSON.parse(line) as IpcRequest;
    } catch {
      socket.write(JSON.stringify({ id: '?', ok: false, error: 'invalid json' }) + '\n');
      return;
    }
    try {
      const result = await this.handler(req.method, req.params ?? {});
      socket.write(JSON.stringify({ id: req.id, ok: true, result } satisfies IpcResponse) + '\n');
    } catch (err) {
      this.logger.warn('ipc handler failed', { method: req.method, error: String(err) });
      socket.write(
        JSON.stringify({
          id: req.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies IpcResponse) + '\n',
      );
    }
  }
}

export class IpcClient {
  private readonly socket: Socket;
  private buffer = '';
  private counter = 0;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (err) => this.failAll(err));
    socket.on('close', () => this.failAll(new Error('ipc connection closed')));
  }

  static connect(socketPath: string): Promise<IpcClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      socket.once('connect', () => resolve(new IpcClient(socket)));
      socket.once('error', reject);
    });
  }

  call<T = unknown>(method: string, params: IpcParams = {}, timeoutMs = 30_000): Promise<T> {
    const id = `c${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ipc call timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.write(JSON.stringify({ id, method, params } satisfies IpcRequest) + '\n');
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let res: IpcResponse;
      try {
        res = JSON.parse(line) as IpcResponse;
      } catch {
        continue;
      }
      const pending = this.pending.get(res.id);
      if (!pending) continue;
      this.pending.delete(res.id);
      if (res.ok) pending.resolve(res.result);
      else pending.reject(new Error(res.error ?? 'ipc error'));
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}
