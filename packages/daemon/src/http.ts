import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger, type Logger } from '@anylark/core';
import { renderPage } from '@anylark/ui';
import type { UiData } from './ui-data.ts';

export interface UiServerOptions {
  data: UiData;
  /**
   * 能力 token。**设了就需要它换 cookie；不设则直接放行**（决策 18）。
   * 约定：绑 loopback 时不设（本地单人使用）；绑非 loopback 时必设。
   */
  token?: string;
  /** 监听地址，默认 127.0.0.1 */
  host?: string;
  /** 额外的合法 Host（如 tailnet 的 MagicDNS 名） */
  allowHosts?: string[];
  port?: number;
  logger?: Logger;
}

interface UiSession {
  csrf: string;
  lastSeen: number;
}

const MAX_BODY = 64 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * 本地 Web 配置台（DESIGN §4.4）。
 * 安全面按 §4.4.3 + 决策 18：
 * - 默认只监听 127.0.0.1
 * - `--host` 可绑 tailnet 地址；Host 头白名单 = loopback + 绑定地址 + 额外白名单（防 DNS rebinding）
 * - 绑非 loopback 时默认要求能力 token；显式 `--no-auth` 才关（会打印警告）
 * - 写操作一律要 CSRF + Origin 校验，与是否鉴权无关
 * - 不自动关闭：显式 `anylark ui --stop` 或 daemon 停止才关（决策 20）
 */
export class UiServer {
  private readonly opts: UiServerOptions;
  private readonly logger: Logger;
  private readonly sessions = new Map<string, UiSession>();
  private readonly allowHosts: Set<string>;
  private server?: Server;
  private port = 0;

  constructor(opts: UiServerOptions) {
    this.opts = opts;
    this.logger = opts.logger ?? createLogger({ svc: 'ui-http' });
    this.allowHosts = new Set(LOOPBACK);
    for (const h of opts.allowHosts ?? []) this.allowHosts.add(h);
    const host = opts.host ?? '127.0.0.1';
    if (host !== '0.0.0.0' && host !== '::') this.allowHosts.add(host);
  }

  async start(): Promise<{ url: string; port: number; host: string }> {
    const host = this.opts.host ?? '127.0.0.1';
    if (this.server) return { url: this.url(), port: this.port, host };
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((err: unknown) => {
        this.logger.error('ui request failed', { error: String(err) });
        if (!res.headersSent) this.send(res, 500, 'internal error');
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.opts.port ?? 0, host, () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
    this.logger.info('ui listening', { host, port: this.port, auth: Boolean(this.opts.token) });
    return { url: this.url(), port: this.port, host };
  }

  async close(): Promise<void> {
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
    const host = this.opts.host ?? '127.0.0.1';
    const base = `http://${host}:${this.port}/`;
    return this.opts.token ? `${base}?t=${this.opts.token}` : base;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!this.allowHosts.has(host)) {
      this.logger.warn('ui rejected bad host', { host });
      return this.send(res, 403, 'forbidden host');
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const nonce = randomBytes(16).toString('base64');

    const sid = cookie(req.headers.cookie, 'le_sid');
    let session = sid ? this.sessions.get(sid) : undefined;

    if (this.opts.token) {
      // 一次性 token → httpOnly cookie，并重定向掉 URL 里的 token
      if (url.pathname === '/' && url.searchParams.has('t')) {
        if (!safeEqual(url.searchParams.get('t')!, this.opts.token)) {
          this.logger.warn('ui rejected bad token');
          return this.send(res, 401, 'bad token');
        }
        this.newSession(res);
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
      }
      if (!session) return this.send(res, 401, '请从 anylark ui 打开的链接访问');
    } else if (!session) {
      // 无鉴权模式：首次访问首页即建立会话（仍需 cookie 才能带 CSRF）
      if (url.pathname !== '/') return this.send(res, 401, '请先打开配置台首页');
      session = this.newSession(res);
    }

    session.lastSeen = Date.now();

    if (url.pathname === '/') {
      return this.html(res, renderPage({ csrf: session.csrf, nonce }), nonce);
    }

    if (url.pathname.startsWith('/api/') && req.method === 'GET') {
      const data = this.opts.data;
      if (url.pathname === '/api/state') return this.json(res, 200, await data.state());
      if (url.pathname === '/api/fs') {
        return this.json(res, 200, await data.listDirs(url.searchParams.get('path') ?? undefined));
      }
      if (url.pathname === '/api/sessions') {
        const agent = (url.searchParams.get('agent') ?? 'pi') as 'pi' | 'claude' | 'codex';
        return this.json(
          res,
          200,
          await data.listSessions(agent, url.searchParams.get('cwd') ?? ''),
        );
      }
      if (url.pathname === '/api/models') {
        const agent = (url.searchParams.get('agent') ?? 'pi') as 'pi' | 'claude' | 'codex';
        return this.json(res, 200, await data.listModels(agent));
      }
      if (url.pathname === '/api/members') {
        return this.json(res, 200, await data.listMembers(url.searchParams.get('chatId') ?? ''));
      }
      return this.json(res, 404, { error: 'not found' });
    }

    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'POST' && req.method !== 'DELETE') {
        return this.json(res, 405, { error: 'method not allowed' });
      }
      const origin = req.headers.origin;
      if (origin) {
        let hostname = '';
        try {
          hostname = new URL(origin).hostname;
        } catch {
          hostname = 'invalid';
        }
        if (!this.allowHosts.has(hostname)) {
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

  private newSession(res: ServerResponse): UiSession {
    const sid = randomBytes(24).toString('hex');
    const session: UiSession = { csrf: randomBytes(18).toString('hex'), lastSeen: Date.now() };
    this.sessions.set(sid, session);
    res.setHeader('Set-Cookie', `le_sid=${sid}; HttpOnly; SameSite=Strict; Path=/`);
    return session;
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
