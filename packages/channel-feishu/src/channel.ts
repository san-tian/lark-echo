import { createWriteStream } from 'node:fs';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  createLogger,
  ensureDir,
  paths,
  splitText,
  type Attachment,
  type Channel,
  type ChatInfo,
  type ChatMember,
  type DownloadedAttachment,
  type HistoryMessage,
  type ConversationKey,
  type DoctorCheck,
  type InboundAttachment,
  type InboundMessage,
  type Logger,
  type OutboundMessage,
  type OutboundResult,
  type ReceiptKind,
  type ReceiptOptions,
} from '@instead/core';
import * as lark from '@larksuiteoapi/node-sdk';
import { toHistoryMessage, toInboundMessage, type FeishuMessageEvent } from './mapper.ts';

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
  /** 入站图片下载上限（飞书单图上限就是 10MB） */
  maxImageBytes?: number;
  /** 入站文件下载上限 */
  maxFileBytes?: number;
}

/** `/im/v1/messages/:id/resources/:key` 的 `type` 取值 */
const RESOURCE_TYPE: Record<InboundAttachment['kind'], string> = {
  image: 'image',
  file: 'file',
  video: 'media',
  audio: 'file',
};

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 30 * 1024 * 1024;

/** 附件名只用来拼路径，必须堵掉路径穿越与平台特殊字符 */
const safeName = (name: string, fallback: string): string => {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  return (cleaned.length > 0 ? cleaned : fallback).slice(0, 120);
};

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
  private readonly typingEmoji = process.env.INSTEAD_TYPING_EMOJI ?? 'Typing';
  private readonly doneEmoji = process.env.INSTEAD_DONE_EMOJI ?? 'DONE';

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
    if (msg.attachments?.length) {
      let lastId = '';
      for (const att of msg.attachments) {
        lastId = await this.sendMedia(chatId, att, msg.replyTo);
      }
      return { messageId: lastId };
    }
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
   * 发一个附件（决策 23）：先传资源换 key，再发消息。
   * 图走 `im/v1/images` + `msg_type: image`；其余一律当文件（`im/v1/files` + `msg_type: file`）。
   * 视频在飞书要封面 `image_key`（lark-cli 的 `--video-cover`），拿不到就先当文件发。
   */
  private async sendMedia(
    chatId: string,
    att: Attachment,
    replyTo?: string,
  ): Promise<string> {
    const data = await readFile(att.localPath);
    const msgType = mediaMsgType(att.kind);
    const content = await this.uploadMedia(att, data, msgType);
    const res = replyTo
      ? await this.client.im.message.reply({
          path: { message_id: replyTo },
          data: { content, msg_type: msgType },
        })
      : await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: msgType, content },
        });
    const err = res as FeishuApiError;
    if (err.code !== undefined && err.code !== 0) {
      throw new Error(`feishu media send failed: code=${err.code} msg=${err.msg ?? ''}`);
    }
    return res.data?.message_id ?? '';
  }

  /** 传资源并拼出消息体（`content` 就是发出去的那串 JSON） */
  private async uploadMedia(
    att: Attachment,
    data: Buffer,
    msgType: 'image' | 'file',
  ): Promise<string> {
    if (msgType === 'image') {
      const res = (await this.client.im.image.create({
        data: { image_type: 'message', image: data },
      })) as { msg?: string; image_key?: string; data?: { image_key?: string } };
      const key = res.image_key ?? res.data?.image_key;
      if (!key) throw new Error(`feishu image upload failed: ${res.msg ?? 'no image_key'}`);
      return mediaContent('image', key);
    }
    const res = (await this.client.im.file.create({
      data: { file_type: 'stream', file_name: att.name, file: data },
    })) as { msg?: string; file_key?: string; data?: { file_key?: string } };
    const key = res.file_key ?? res.data?.file_key;
    if (!key) throw new Error(`feishu file upload failed: ${res.msg ?? 'no file_key'}`);
    return mediaContent('file', key);
  }

  /**
   * 下载入站附件（决策 23）：落盘到 `~/.instead/media/<chatId>/`。
   * 用流式写 + 字节计数，超限就中止并删掉半个文件 —— 不信任 `content-length`。
   */
  async downloadAttachment(
    msg: InboundMessage,
    att: InboundAttachment,
  ): Promise<DownloadedAttachment | undefined> {
    const messageId = msg.replyTo;
    if (!messageId) return undefined;
    const limit =
      att.kind === 'image'
        ? (this.opts.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES)
        : (this.opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    const chatId = msg.conversationKey.replace(/^feishu:chat:/, '');
    const name = safeName(att.name ?? '', `${att.kind}_${att.key.slice(0, 8)}`);
    const dir = ensureDir(join(paths.mediaDir(), chatId));
    const localPath = join(dir, `${Date.now()}-${name}`);
    try {
      const res = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: att.key },
        params: { type: RESOURCE_TYPE[att.kind] },
      });
      const headers = (res as { headers?: Record<string, unknown> }).headers;
      const contentType = headers?.['content-type'];
      const bytes = await writeCapped(res.getReadableStream(), localPath, limit);
      this.logger.debug('attachment downloaded', { chatId, kind: att.kind, name, bytes });
      return {
        localPath,
        name,
        bytes,
        ...(typeof contentType === 'string' ? { mimeType: contentType } : {}),
      };
    } catch (err) {
      await rm(localPath, { force: true }).catch(() => undefined);
      this.logger.warn('attachment download failed', {
        chatId,
        kind: att.kind,
        name,
        error: String(err),
      });
      return undefined;
    }
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

  /** 群成员（供控制台「仅我」选择器用，决策 19） */
  async listMembers(chatId: string): Promise<ChatMember[]> {
    const res = (await this.client.request({
      method: 'GET',
      url: `/open-apis/im/v1/chats/${chatId}/members`,
      params: { member_id_type: 'open_id', page_size: 100 },
    })) as {
      code?: number;
      msg?: string;
      data?: { items?: Array<{ member_id?: string; name?: string }> };
    };
    if (res.code !== undefined && res.code !== 0) {
      throw new Error(`feishu members failed: code=${res.code} msg=${res.msg ?? ''}`);
    }
    return (res.data?.items ?? []).flatMap((m) =>
      m.member_id ? [{ id: m.member_id, name: m.name ?? m.member_id }] : [],
    );
  }

  /**
   * 拉群历史（bootstrapHistory §6.2）。按时间倒序翻页，取最近 limit 条，
   * 返回 oldest→newest；过滤系统消息、空文本、超出 maxAgeDays 的。
   */
  async fetchHistory(chatId: string, limit = 50, maxAgeDays = 7): Promise<HistoryMessage[]> {
    const since = maxAgeDays > 0 ? Date.now() - maxAgeDays * 86_400_000 : 0;
    const out: HistoryMessage[] = [];
    let pageToken: string | undefined;
    for (;;) {
      const res = (await this.client.request({
        method: 'GET',
        url: '/open-apis/im/v1/messages',
        params: {
          container_id_type: 'chat',
          container_id: chatId,
          sort_type: 'ByCreateTimeDesc',
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      })) as {
        code?: number;
        msg?: string;
        data?: { items?: unknown[]; page_token?: string };
      };
      if (res.code !== undefined && res.code !== 0) {
        throw new Error(`feishu history failed: code=${res.code} msg=${res.msg ?? ''}`);
      }
      for (const item of res.data?.items ?? []) {
        const parsed = toHistoryMessage(item);
        if (!parsed || parsed.ts < since) continue;
        out.push(parsed);
      }
      pageToken = res.data?.page_token ?? undefined;
      if (!pageToken || out.length >= limit) break;
    }
    return out.sort((a, b) => a.ts - b.ts).slice(-limit);
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
      ...(bot.ok ? {} : { hint: '检查 app_id / app_secret；必要时重新运行 instead connect' }),
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

/**
 * 附件 → 飞书 `msg_type` / 消息体。纯函数，便于测试。
 * 出站只分图和文件：视频要封面 `image_key`，拿不到就先当文件发。
 */
export const mediaMsgType = (kind: Attachment['kind']): 'image' | 'file' =>
  kind === 'image' ? 'image' : 'file';

export const mediaContent = (kind: Attachment['kind'], key: string): string =>
  JSON.stringify(kind === 'image' ? { image_key: key } : { file_key: key });

/**
 * 流式写文件 + 卡字节上限。超限就拆掉两端的流并报错（调用方负责删半成品）。
 * 不信任 `content-length`：字节数只按实际收到的算。
 */
function writeCapped(stream: Readable, filePath: string, limit: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(filePath);
    let bytes = 0;
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      stream.destroy();
      out.destroy();
      reject(err);
    };
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) fail(new Error(`attachment exceeds ${limit} bytes`));
    });
    stream.on('error', (err: Error) => fail(err));
    out.on('error', (err: Error) => fail(err));
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve(bytes);
    });
    stream.pipe(out);
  });
}

/** `instead connect` 用：不建长连接，只用一次 API 调用验证凭据 */export async function verifyCredentials(
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
