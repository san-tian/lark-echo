import {
  createLogger,
  splitText,
  type Channel,
  type ChatInfo,
  type ConversationKey,
  type DoctorCheck,
  type InboundMessage,
  type Logger,
  type OutboundMessage,
  type OutboundResult,
  type ReceiptKind,
  type ReceiptOptions,
} from '@lark-echo/core';
import * as lark from '@larksuiteoapi/node-sdk';
import { toInboundMessage, type FeishuMessageEvent } from './mapper.ts';

export interface FeishuChannelOptions {
  appId: string;
  appSecret: string;
  domain?: 'feishu' | 'lark';
  logger?: Logger;
  /** 用 contact API 解析发送者姓名；没有该权限时自动退回 open_id */
  resolveSenderNames?: boolean;
  /** 出站分片上限（§10.1，默认 4000） */
  chunkLimit?: number;
  /** 连接就绪超时 */
  connectTimeoutMs?: number;
}

interface FeishuApiError {
  code?: number;
  msg?: string;
}

/**
 * 飞书渠道：WebSocket 长连接（仅自建应用，免公网 IP/域名）。
 * 协议与权限细节见 docs/spikes/03-feishu-ws.md。
 */
export class FeishuChannel implements Channel {
  readonly id = 'feishu' as const;

  private readonly opts: FeishuChannelOptions;
  private readonly logger: Logger;
  private readonly client: lark.Client;
  private ws?: lark.WSClient;
  private botOpenId?: string;
  private readonly nameCache = new Map<string, string>();
  /** messageId -> reaction_id，用于收尾时撤掉「处理中」表情 */
  private readonly reactionIds = new Map<string, string>();
  private readonly typingEmoji = process.env.LARK_ECHO_TYPING_EMOJI ?? 'Typing';
  private readonly doneEmoji = process.env.LARK_ECHO_DONE_EMOJI ?? 'DONE';

  constructor(opts: FeishuChannelOptions) {
    this.opts = opts;
    this.logger = opts.logger ?? createLogger({ svc: 'channel-feishu' });
    this.client = new lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: opts.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.warn,
    });
  }

  async start(onInbound: (msg: InboundMessage) => void): Promise<void> {
    this.botOpenId = await this.fetchBotOpenId().catch((err: unknown) => {
      this.logger.warn('cannot resolve bot open_id; mention gating degraded', {
        error: String(err),
      });
      return undefined;
    });
    this.logger.info('feishu bot identity', { botOpenId: this.botOpenId ?? 'unknown' });

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        const event = data as FeishuMessageEvent;
        const senderName = await this.resolveSenderName(
          event.sender?.sender_id?.open_id ?? '',
        ).catch(() => undefined);
        const msg = toInboundMessage(event, {
          ...(this.botOpenId ? { botOpenId: this.botOpenId } : {}),
          ...(senderName ? { senderName } : {}),
        });
        if (!msg) return;
        this.logger.info('inbound feishu message', {
          eventId: msg.id,
          chatId: msg.conversationKey,
          mentioned: msg.mentioned,
          threadId: msg.threadId ?? '',
        });
        onInbound(msg);
      },
    });

    this.ws = new lark.WSClient({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      domain: this.opts.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.warn,
      autoReconnect: true,
      onReconnecting: () => this.logger.warn('feishu ws reconnecting'),
      onReconnected: () => this.logger.info('feishu ws reconnected'),
      onError: (err) => this.logger.error('feishu ws failed', { error: String(err) }),
    });
    await this.ws.start({ eventDispatcher: dispatcher });
    this.logger.info('feishu ws started');
  }

  async stop(): Promise<void> {
    this.ws?.close({ force: true });
    this.ws = undefined;
  }

  async send(msg: OutboundMessage): Promise<OutboundResult> {
    const chatId = msg.conversationKey.replace(/^feishu:chat:/, '');
    const chunks = splitText(msg.text, this.opts.chunkLimit ?? 4000);
    let messageId = '';
    for (const chunk of chunks) {
      const content = JSON.stringify({ text: chunk });
      const res = msg.replyTo
        ? await this.client.im.message.reply({
            path: { message_id: msg.replyTo },
            data: { content, msg_type: 'text' },
          })
        : await this.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, msg_type: 'text', content },
          });
      const err = res as FeishuApiError;
      if (err.code !== undefined && err.code !== 0) {
        throw new Error(`feishu send failed: code=${err.code} msg=${err.msg ?? ''}`);
      }
      messageId = res.data?.message_id ?? messageId;
    }
    return { messageId };
  }

  /**
   * 回执：`seen` 给触发消息打表情（比发一条文字消息轻得多），`done` 换成完成态。
   * 表情 API 在当前权限集下即可用（实测不需要额外 scope）。
   */
  async receipt(
    conversationKey: ConversationKey,
    kind: ReceiptKind,
    opts?: ReceiptOptions,
  ): Promise<void> {
    if (kind === 'started') return; // 已由 seen 的表情覆盖，不再发文字
    if (kind === 'queued') {
      if (opts?.text) {
        await this.send({ conversationKey, text: opts.text, turnId: 'receipt:queued', seq: 0 });
      }
      return;
    }
    const messageId = opts?.replyTo;
    if (!messageId) return;
    if (kind === 'seen') {
      await this.addReaction(messageId, this.typingEmoji);
      return;
    }
    if (kind === 'done') {
      await this.clearReaction(messageId);
      await this.addReaction(messageId, this.doneEmoji);
    }
  }

  private async addReaction(messageId: string, emojiType: string): Promise<void> {
    try {
      const res = (await this.client.request({
        method: 'POST',
        url: `/open-apis/im/v1/messages/${messageId}/reactions`,
        data: { reaction_type: { emoji_type: emojiType } },
      })) as { code?: number; msg?: string; data?: { reaction_id?: string } };
      if (res.code !== undefined && res.code !== 0) {
        throw new Error(`code=${res.code} msg=${res.msg ?? ''}`);
      }
      const id = res.data?.reaction_id;
      if (id) this.reactionIds.set(messageId, id);
    } catch (err) {
      // 回执失败不影响主流程
      this.logger.debug('add reaction failed', { messageId, emojiType, error: String(err) });
    }
  }

  private async clearReaction(messageId: string): Promise<void> {
    const id = this.reactionIds.get(messageId);
    if (!id) return;
    this.reactionIds.delete(messageId);
    try {
      await this.client.request({
        method: 'DELETE',
        url: `/open-apis/im/v1/messages/${messageId}/reactions/${id}`,
      });
    } catch (err) {
      this.logger.debug('clear reaction failed', { messageId, error: String(err) });
    }
  }

  async listChats(): Promise<ChatInfo[]> {
    const chats: ChatInfo[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.client.im.chat.list({
        params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
      });
      const err = res as FeishuApiError;
      if (err.code !== undefined && err.code !== 0) {
        throw new Error(`feishu chat list failed: code=${err.code} msg=${err.msg ?? ''}`);
      }
      for (const item of res.data?.items ?? []) {
        if (!item.chat_id) continue;
        chats.push({
          chatId: item.chat_id,
          name: item.name ?? item.chat_id,
          botInChat: true,
        });
      }
      pageToken = res.data?.page_token ?? undefined;
    } while (pageToken);
    return chats;
  }

  /** 从真实 API 错误码反推缺失权限（PLAN Task 5 要求，不硬编码权限清单） */
  async doctor(): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];

    const bot = await this.tryApi(() => this.fetchBotOpenId());
    checks.push({
      id: 'feishu.credentials',
      ok: bot.ok,
      detail: bot.ok ? `bot open_id=${bot.value}` : bot.error,
      ...(bot.ok ? {} : { hint: '检查 app_id / app_secret；必要时重新运行 lark-echo connect' }),
    });
    if (bot.ok) this.botOpenId = bot.value;

    const chats = await this.tryApi(() => this.listChats());
    checks.push({
      id: 'feishu.im:chat:readonly',
      ok: chats.ok,
      detail: chats.ok ? `可见 ${chats.value.length} 个群` : chats.error,
      ...(chats.ok
        ? {}
        : { hint: '按上面的 msg 到开放平台补权限（通常是 im:chat:readonly），然后重新发布版本' }),
    });

    const ws = await this.tryApi(() => this.probeWs());
    checks.push({
      id: 'feishu.websocket',
      ok: ws.ok,
      detail: ws.ok ? '长连接可用' : ws.error,
      ...(ws.ok ? {} : { hint: '确认应用已开启「长连接」事件订阅方式，并订阅 im.message.receive_v1' }),
    });

    return checks;
  }

  /** 机器人自己的 open_id（用于 mention 判定） */
  getBotOpenId(): string | undefined {
    return this.botOpenId;
  }

  private async fetchBotOpenId(): Promise<string> {
    const res = (await this.client.request({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    })) as { code?: number; msg?: string; bot?: { open_id?: string; app_name?: string } };
    if (res.code !== undefined && res.code !== 0) {
      throw new Error(`code=${res.code} msg=${res.msg ?? ''}`);
    }
    const openId = res.bot?.open_id;
    if (!openId) throw new Error('bot info 未返回 open_id');
    return openId;
  }

  private async resolveSenderName(openId: string): Promise<string | undefined> {
    if (!openId || this.opts.resolveSenderNames === false) return undefined;
    const cached = this.nameCache.get(openId);
    if (cached) return cached;
    const res = (await this.client.request({
      method: 'GET',
      url: `/open-apis/contact/v3/users/${openId}`,
      params: { user_id_type: 'open_id' },
    })) as { code?: number; data?: { user?: { name?: string } } };
    const name = res.data?.user?.name;
    if (name) this.nameCache.set(openId, name);
    return name;
  }

  /** 起一个临时 WSClient 验证长连接是否可用，然后关掉 */
  private probeWs(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new lark.WSClient({
        appId: this.opts.appId,
        appSecret: this.opts.appSecret,
        domain: this.opts.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
        loggerLevel: lark.LoggerLevel.error,
        autoReconnect: false,
        onReady: () => {
          ws.close({ force: true });
          resolve();
        },
        onError: (err) => {
          ws.close({ force: true });
          reject(new Error(String(err)));
        },
      });
      void ws
        .start({ eventDispatcher: new lark.EventDispatcher({}).register({}) })
        .catch((err: unknown) => reject(new Error(String(err))));
      setTimeout(() => {
        ws.close({ force: true });
        reject(new Error('长连接超时（10s）'));
      }, 10_000).unref?.();
    });
  }

  private async tryApi<T>(fn: () => Promise<T>): Promise<
    { ok: true; value: T } | { ok: false; error: string }
  > {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** `lark-echo connect` 用：不建长连接，只用一次 API 调用验证凭据 */
export async function verifyCredentials(
  appId: string,
  appSecret: string,
  domain: 'feishu' | 'lark' = 'feishu',
): Promise<{ ok: true; botOpenId: string; appName?: string } | { ok: false; error: string }> {
  try {
    const client = new lark.Client({
      appId,
      appSecret,
      domain: domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.error,
    });
    const res = (await client.request({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    })) as { code?: number; msg?: string; bot?: { open_id?: string; app_name?: string } };
    if (res.code !== undefined && res.code !== 0) return { ok: false, error: `code=${res.code} msg=${res.msg ?? ''}` };
    if (!res.bot?.open_id) return { ok: false, error: 'bot info 未返回 open_id' };
    return {
      ok: true,
      botOpenId: res.bot.open_id,
      ...(res.bot.app_name ? { appName: res.bot.app_name } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
