import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger, type Logger } from '@lark-echo/core';
import { renderPage } from '@lark-echo/ui';
import type { UiData } from './ui-data.ts';

export interface UiServerOptions {
  data: UiData;
  /** 能力 token：只从 `lark-echo ui` 的 URL 传一次，换 cookie 后即失效（§4.4.3） */
  token: string;
  port?: number;
  idleMs?: number;
  logger?: Logger;
}

interface UiSession {
  csrf: string;
  lastSeen: number;
}

const MAX_BODY = 64 * 1024;

/**
 * 本地 Web 配置台（DESIGN §4.4）。
 * 安全面按 §4.4.3 实现：只监听 127.0.0.1、Host/Origin 校验（防 DNS rebinding）、
 * 能力 token 换 httpOnly cookie、写操作要 CSRF、空闲自动关端口。
 */
export class UiServer {
  private readonly opts: UiServerOptions;
  private readonly logger: Logger;
  private readonly sessions = new Map<string, UiSession>();
  private server?: Server;
  private idleTimer?: NodeJS.Timeout;
  private port = 0;

  constructor(opts: UiServerOptions) {
    this.opts = opts;
    this.logger = opts.logger ?? createLogger({ svc: 'ui-http' });
  }

  async start(): Promise<{ url: string; port: number }> {
    if (this.server) return { url: this.url(), port: this.port };
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((err: unknown) => {
        this.logger.error('ui request failed', { error: String(err) });
        if (!res.headersSent) this.send(res, 500, 'internal error');
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.opts.port ?? 0, '127.0.0.1', () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
    this.touch();
    this.logger.info('ui listening', { port: this.port });
    return { url: this.url(), port: this.port };
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const server = this.server;
    this.server = undefined;
    this.sessions.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.logger.info('ui closed', { port: this.port });
  }

  get listening(): boolean {
    return Boolean(this.server);
  }

  private url(): string {
    return `http://127.0.0.1:${this.port}/?t=${this.opts.token}`;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const idleMs = this.opts.idleMs ?? 30 * 60 * 1000;
    this.idleTimer = setTimeout(() => {
      this.logger.info('ui idle timeout, closing');
      void this.close();
    }, idleMs);
    this.idleTimer.unref?.();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 防 DNS rebinding：只接受本机 Host（§4.4.3）
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost') {
      this.logger.warn('ui rejected bad host', { host });
      return this.send(res, 403, 'forbidden host');
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const nonce = randomBytes(16).toString('base64');

    // 一次性 token → 换 httpOnly cookie
    if (url.pathname === '/' && url.searchParams.has('t')) {
      if (!safeEqual(url.searchParams.get('t')!, this.opts.token)) {
        this.logger.warn('ui rejected bad token');
        return this.send(res, 401, 'bad token');
      }
      const sid = randomBytes(24).toString('hex');
      this.sessions.set(sid, { csrf: randomBytes(18).toString('hex'), lastSeen: Date.now() });
      res.setHeader('Set-Cookie', `le_sid=${sid}; HttpOnly; SameSite=Strict; Path=/`);
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }

    const sid = cookie(req.headers.cookie, 'le_sid');
    const session = sid ? this.sessions.get(sid) : undefined;
    if (!session) {
      return this.send(res, 401, '请从 lark-echo ui 打开的链接访问');
    }
    session.lastSeen = Date.now();
    this.touch();

    if (url.pathname === '/') {
      return this.html(res, renderPage({ csrf: session.csrf, nonce }), nonce);
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      return this.json(res, 200, await this.opts.data.state());
    }

    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'POST' && req.method !== 'DELETE') {
        return this.json(res, 405, { error: 'method not allowed' });
      }
      // 防 CSRF：Origin 必须是本机 + 自定义头必须匹配（§4.4.3）
      const origin = req.headers.origin;
      if (origin) {
        let hostname = '';
        try {
          hostname = new URL(origin).hostname;
        } catch {
          hostname = 'invalid';
        }
        if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
          this.logger.warn('ui rejected bad origin', { origin });
          return this.json(res, 403, { error: 'forbidden origin' });
        }
      }
      const csrf = req.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !safeEqual(csrf, session.csrf)) {
        return this.json(res, 403, { error: 'bad csrf token' });
      }
      const body = await readJson(req);
      const result = await this.opts.data.action(url.pathname, req.method, body);
      this.logger.info('ui action', { path: url.pathname, method: req.method });
      return this.json(res, 200, result);
    }

    return this.send(res, 404, 'not found');
  }

  private send(res: ServerResponse, status: number, text: string): void {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(text);
  }

  private html(res: ServerResponse, body: string, nonce: string): void {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(body);
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(value));
  }
}

function cookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new Error('invalid json body');
  }
}
