import type { ChannelId, ConversationKey, InboundMessage, OutboundMessage } from './types.ts';

export interface OutboundResult {
  /** 渠道侧消息 id，用于审计与出站幂等核对 */
  messageId: string;
}

export interface ChatInfo {
  chatId: string;
  name: string;
  /** 机器人是否在群里 */
  botInChat: boolean;
}

export interface DoctorCheck {
  id: string;
  ok: boolean;
  /** 缺失时告诉用户去哪儿补，而不是只报错 */
  hint?: string;
  detail?: string;
}

/**
 * 渠道适配层契约。飞书是第一个实现（packages/channel-feishu），
 * 后续 Slack/企微沿用同一形状。
 */
export interface Channel {
  readonly id: ChannelId;
  start(onInbound: (msg: InboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<OutboundResult>;
  /** 轻量回执（👀 / 排队中 / 已开始处理），失败不应影响主流程 */
  receipt(conversationKey: ConversationKey, kind: ReceiptKind, text?: string): Promise<void>;
  /** 机器人所在的群，供 `/feishu-bind` 面板使用 */
  listChats(): Promise<ChatInfo[]>;
  doctor(): Promise<DoctorCheck[]>;
}

export type ReceiptKind = 'seen' | 'queued' | 'started' | 'done';
