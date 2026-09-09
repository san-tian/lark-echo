import { createLogger, type Logger } from './logger.ts';
import { newTraceId } from './ids.ts';
import { formatPendingWindow, formatHistorical } from './pending-window.ts';
import { decideInbound, chatIdOfKey, conversationKeyFor, sessionRefFor } from './router.ts';
import { SessionQueue } from './queue.ts';
import type { Channel } from './channel.ts';
import type { SessionDriver } from './session-driver.ts';
import type { Db } from './state/db.ts';
import {
  clearPendingWindow,
  chatIdOf,
  markInbound,
  pendingWindowFor,
  recordInbound,
} from './state/inbound.ts';
import {
  enqueueOutbound,
  listPendingOutbound,
  markOutboundFailed,
  markOutboundSent,
} from './state/outbound.ts';
import { getBootstrapRecord, saveBootstrapRecord } from './state/bootstrap.ts';
import type {
  ConversationKey,
  ContextBlock,
  InboundMessage,
  OutboundMessage,
  TurnEvent,
} from './types.ts';

export interface DispatcherOptions {
  db: Db;
  channel: Channel;
  driver: SessionDriver;
  queue?: SessionQueue;
  logger?: Logger;
  /** pendingWindow 上限（默认 50，对齐 OpenClaw §6.1） */
  pendingWindowLimit?: number;
  /** 单条出站最大字符数（§10.1，默认 4000） */
  chunkLimit?: number;
  /** 出站重试上限（超过则标记 failed，不再重试） */
  maxSendAttempts?: number;
  /** bootstrapHistory（§6.2）：绑定时回填群历史，默认开、50 条、7 天内 */
  bootstrap?: { enabled?: boolean; maxMessages?: number; maxAgeDays?: number };
  onTurnEvent?: (event: TurnEvent) => void;
}

/**
 * 入站 → 路由 → 会话 → 出站 的编排。daemon 与测试共用这一份逻辑。
 */
export class Dispatcher {
  private readonly db: Db;
  private readonly channel: Channel;
  private readonly driver: SessionDriver;
  private readonly queue: SessionQueue;
  private readonly logger: Logger;
  private readonly pendingWindowLimit: number;
  private readonly chunkLimit: number;
  private readonly maxSendAttempts: number;
  private readonly bootstrap: { enabled: boolean; maxMessages: number; maxAgeDays: number };
  private readonly onTurnEvent?: (event: TurnEvent) => void;

  constructor(opts: DispatcherOptions) {
    this.db = opts.db;
    this.channel = opts.channel;
    this.driver = opts.driver;
    this.queue = opts.queue ?? new SessionQueue({ logger: opts.logger });
    this.logger = opts.logger ?? createLogger({ svc: 'dispatcher' });
    this.pendingWindowLimit = opts.pendingWindowLimit ?? 50;
    this.chunkLimit = opts.chunkLimit ?? 4000;
    this.maxSendAttempts = opts.maxSendAttempts ?? 3;
    this.bootstrap = {
      enabled: opts.bootstrap?.enabled ?? true,
      maxMessages: opts.bootstrap?.maxMessages ?? 50,
      maxAgeDays: opts.bootstrap?.maxAgeDays ?? 7,
    };
    this.onTurnEvent = opts.onTurnEvent;
  }

  /** 渠道事件入口。幂等：同一 event_id 重复投递不会重复执行。 */
  async handleInbound(msg: InboundMessage): Promise<void> {
    const traceId = newTraceId();
    const log = this.logger.child({ traceId, eventId: msg.id, chatId: chatIdOf(msg) });
    const decision = decideInbound(this.db, msg);
    const sessionId = decision.action === 'unbound' ? null : decision.binding.sessionId;
    const fresh = recordInbound(this.db, msg, sessionId);
    if (!fresh) {
      log.debug('duplicate inbound ignored');
      return;
    }

    if (decision.action === 'unbound') {
      log.info('inbound to unbound chat');
      await this.reply(
        msg.conversationKey,
        '本群未绑定任何会话。请在终端执行 lark-echo bind，或在 agent 会话中完成绑定。',
      );
      markInbound(this.db, msg.id, 'done');
      return;
    }
    if (decision.action === 'thread-unsupported') {
      log.warn('topic group unsupported');
      await this.reply(msg.conversationKey, '暂不支持话题群（topic group），请把机器人拉进普通群。');
      markInbound(this.db, msg.id, 'dropped');
      return;
    }
    if (decision.action === 'context') {
      log.debug('stored as pending-window context');
      return; // 已按 context 落盘，不触发
    }

    const ref = sessionRefFor(this.db, chatIdOf(msg));
    if (!ref) return;
    const window = pendingWindowFor(this.db, chatIdOf(msg), this.pendingWindowLimit);
    const context = formatPendingWindow(msg, window);

    const { ahead, dropped } = this.queue.enqueue(ref.sessionId, {
      chatId: chatIdOf(msg),
      enqueuedAt: Date.now(),
      run: () => this.runTurn(msg, ref, context, traceId),
      onDrop: (reason) => {
        void this.reply(
          msg.conversationKey,
          reason === 'overflow' ? '消息队列已满，本条已丢弃。' : '消息排队超时，本条已丢弃。',
        );
        markInbound(this.db, msg.id, 'dropped');
      },
    });
    if (dropped) return;
    if (ahead > 0) {
      await this.channel
        .receipt(msg.conversationKey, 'queued', {
          text: `排队中（前面 ${ahead} 条 · 本会话正在响应其他群）`,
          ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
        })
        .catch(() => undefined);
    } else {
      await this.channel
        .receipt(msg.conversationKey, 'seen', msg.replyTo ? { replyTo: msg.replyTo } : {})
        .catch(() => undefined);
    }
  }

  private async runTurn(
    msg: InboundMessage,
    ref: NonNullable<ReturnType<typeof sessionRefFor>>,
    context: ReturnType<typeof formatPendingWindow>,
    traceId: string,
  ): Promise<void> {
    const chatId = chatIdOf(msg);
    const log = this.logger.child({ traceId, chatId, sessionId: ref.sessionId, eventId: msg.id });
    markInbound(this.db, msg.id, 'dispatched');

    let turnId = '';
    try {
      const { adapter, handle } = await this.driver.acquire(ref);
      this.driver.touch(ref);
      const bootstrap = await this.ensureBootstrap(msg, ref);
      const contextBlocks: ContextBlock[] = [
        ...(bootstrap ? [bootstrap] : []),
        ...(context ? [context] : []),
      ];
      const turn = await adapter.send(handle, {
        // 决策 21：以普通用户聊天的形式注入（用户名字），不提「飞书」，
        // 避免触发 agent 主动调 lark-cli 回群
        text: `[${msg.actor.name}] ${msg.text}`,
        conversationKey: msg.conversationKey,
        context: contextBlocks,
      });
      turnId = turn.turnId;
      const off = turn.onEvent((event) => {
        this.onTurnEvent?.({ ...event, conversationKey: msg.conversationKey });
        log.debug('turn event', { turnId: event.turnId, kind: event.type });
      });
      const result = await turn.settled;
      off();
      this.driver.touch(ref);

      if (result.error) {
        log.error('turn failed', { turnId, error: result.error });
        await this.reply(msg.conversationKey, `处理失败：${result.error.slice(0, 300)}`).catch(
          () => undefined,
        );
      }
      if (result.aborted) log.info('turn aborted', { turnId });

      clearPendingWindow(this.db, chatId);
      const text = result.text?.trim();
      if (text) await this.deliver(msg.conversationKey, turnId, text, msg.replyTo);
      markInbound(this.db, msg.id, 'done');
      await this.channel
        .receipt(msg.conversationKey, 'done', msg.replyTo ? { replyTo: msg.replyTo } : {})
        .catch(() => undefined);
    } catch (err) {
      log.error('turn threw', { turnId, error: String(err) });
      markInbound(this.db, msg.id, 'dropped');
      await this.reply(msg.conversationKey, `处理失败：${String(err).slice(0, 200)}`).catch(
        () => undefined,
      );
    }
  }

  /**
   * bootstrapHistory（§6.2）：该群第一次触发时，把最近 N 条历史作为只读上下文注入一次。
   * 幂等：以 (session_id, chat_id) 记入 bootstrap_records，重启/重绑不重复。
   */
  private async ensureBootstrap(
    msg: InboundMessage,
    ref: NonNullable<ReturnType<typeof sessionRefFor>>,
  ): Promise<ContextBlock | undefined> {
    if (!this.bootstrap.enabled) return undefined;
    if (!this.channel.fetchHistory) return undefined;
    const chatId = chatIdOf(msg);
    if (getBootstrapRecord(this.db, ref.sessionId, chatId)) return undefined;
    const history = await this.channel
      .fetchHistory(chatId, this.bootstrap.maxMessages, this.bootstrap.maxAgeDays)
      .catch((err: unknown) => {
        this.logger.warn('bootstrap history fetch failed', {
          chatId,
          sessionId: ref.sessionId,
          error: String(err),
        });
        return [];
      });
    if (history.length === 0) return undefined;
    const lines = history.map((h) => `[${formatTime(h.ts)}] ${h.senderName}: ${h.text}`);
    const ctx = formatHistorical(msg.conversationKey, `群 ${chatId.slice(0, 8)}…`, lines);
    saveBootstrapRecord(this.db, {
      sessionId: ref.sessionId,
      chatId,
      ...(history[history.length - 1] ? { lastMsgId: history[history.length - 1]!.id } : {}),
      count: history.length,
      text: ctx.text,
      fetchedAt: Date.now(),
    });
    this.logger.info('bootstrap history injected', {
      chatId,
      sessionId: ref.sessionId,
      count: history.length,
    });
    return ctx;
  }

  /** 出站：落盘 → 发送 → 标记（缺口 B：按 turnId 幂等） */
  private async deliver(
    conversationKey: ConversationKey,
    turnId: string,
    text: string,
    replyTo?: string,
  ): Promise<void> {
    const chunks = splitText(text, this.chunkLimit);
    for (let seq = 0; seq < chunks.length; seq++) {
      enqueueOutbound(this.db, {
        conversationKey,
        turnId,
        seq,
        text: chunks[seq]!,
        ...(replyTo ? { replyTo } : {}),
      });
    }
    await this.flushOutbound();
  }

  /** 重试挂起的出站消息；daemon 定时调用，测试里也可手动调用 */
  async flushOutbound(limit = 50): Promise<void> {
    for (const record of listPendingOutbound(this.db, limit)) {
      try {
        const res = await this.channel.send({
          conversationKey: conversationKeyFor(record.chatId),
          text: record.text,
          turnId: record.turnId,
          seq: record.seq,
          ...(record.replyTo ? { replyTo: record.replyTo } : {}),
        });
        markOutboundSent(this.db, record.id, res.messageId);
      } catch (err) {
        this.logger.warn('outbound send failed', {
          chatId: record.chatId,
          turnId: record.turnId,
          error: String(err),
        });
        markOutboundFailed(this.db, record.id, this.maxSendAttempts);
      }
    }
  }

  private async reply(conversationKey: ConversationKey, text: string): Promise<void> {
    await this.channel.send({
      conversationKey,
      text,
      turnId: `control:${newTraceId()}`,
      seq: 0,
    });
  }
}

const formatTime = (ts: number): string => new Date(ts).toISOString().slice(11, 16); // HH:MM

/** 4000 字分片，优先在换行处切，保护代码块（§10.1） */
export function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}
