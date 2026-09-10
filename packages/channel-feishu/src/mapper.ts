import type { HistoryMessage, InboundMessage } from '@instead/core';

/** 飞书 im.message.receive_v1 事件（只声明我们用到的字段） */
export interface FeishuMessageEvent {
  event_id?: string;
  sender?: {
    sender_id?: { open_id?: string; user_id?: string; union_id?: string };
    sender_type?: string;
  };
  message?: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    create_time?: string;
    mentions?: Array<{ key?: string; id?: { open_id?: string }; name?: string }>;
  };
}

export interface MapperOptions {
  /** 机器人自己的 open_id，用于识别 @ 与过滤自己发的消息 */
  botOpenId?: string;
  /** 发送者显示名（可选，由调用方解析） */
  senderName?: string;
}

/**
 * 飞书事件 → 统一入站消息。
 * 返回 undefined 表示这条事件不该进入系统（自己发的、机器人发的、缺关键字段）。
 */
export function toInboundMessage(
  event: FeishuMessageEvent,
  opts: MapperOptions = {},
): InboundMessage | undefined {
  const message = event.message;
  const chatId = message?.chat_id;
  const messageId = message?.message_id;
  const eventId = event.event_id ?? messageId;
  if (!chatId || !messageId || !eventId) return undefined;

  const senderId = event.sender?.sender_id?.open_id ?? '';
  // 忽略机器人/应用自己发的消息，避免回环
  if (event.sender?.sender_type === 'app' || event.sender?.sender_type === 'bot') return undefined;
  if (opts.botOpenId && senderId === opts.botOpenId) return undefined;

  const mentioned = Boolean(
    opts.botOpenId && message?.mentions?.some((m) => m.id?.open_id === opts.botOpenId),
  );
  const text = extractText(message?.message_type ?? '', message?.content ?? '', message?.mentions);

  return {
    id: eventId,
    channel: 'feishu',
    conversationKey: `feishu:chat:${chatId}`,
    actor: { id: senderId, name: opts.senderName ?? shortId(senderId) },
    text,
    attachments: [],
    ts: Number(message?.create_time ?? Date.now()),
    mentioned,
    ...(messageId ? { replyTo: messageId } : {}),
    ...(message?.thread_id ? { threadId: message.thread_id } : {}),
  };
}

/** 文本/富文本取纯文本；图片、文件先用占位符（M1 再落盘） */
export function extractText(
  messageType: string,
  rawContent: string,
  mentions?: Array<{ key?: string }>,
): string {
  const content = safeParse(rawContent);
  if (messageType === 'text') {
    const raw = typeof content?.text === 'string' ? content.text : rawContent;
    return stripMentionKeys(raw, mentions).trim();
  }
  if (messageType === 'post') return extractPostText(content).trim();
  if (messageType === 'image') return '[图片]';
  if (messageType === 'file') return `[文件: ${String(content?.file_name ?? '')}]`;
  if (messageType === 'audio') return '[语音]';
  if (messageType === 'media') return '[视频]';
  if (messageType === 'sticker') return '[表情]';
  return `[${messageType || '未知消息'}]`;
}

/** 富文本：把 tag=text 的节点拼起来，at 节点替换成 @名字 */
function extractPostText(content: Record<string, unknown> | undefined): string {
  if (!content) return '';
  const lines = Array.isArray(content.content) ? content.content : [];
  const parts: string[] = [];
  if (typeof content.title === 'string' && content.title) parts.push(content.title);
  for (const line of lines as unknown[]) {
    if (!Array.isArray(line)) continue;
    parts.push(
      line
        .map((node) => {
          const n = node as { tag?: string; text?: string; user_name?: string };
          if (n.tag === 'text') return n.text ?? '';
          if (n.tag === 'at') return `@${n.user_name ?? ''}`;
          if (n.tag === 'a') return n.text ?? '';
          return '';
        })
        .join(''),
    );
  }
  return parts.join('\n');
}

function stripMentionKeys(text: string, mentions?: Array<{ key?: string }>): string {
  let out = text;
  for (const m of mentions ?? []) {
    if (m.key) out = out.split(m.key).join('');
  }
  return out.replace(/[ \t]{2,}/g, ' ');
}

function safeParse(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const shortId = (id: string): string => (id.length > 8 ? `${id.slice(0, 6)}…` : id);

/** 历史消息（bootstrapHistory）解析：系统消息/空文本返回 undefined */
export function toHistoryMessage(item: unknown): HistoryMessage | undefined {
  const it = item as {
    message_id?: string;
    msg_type?: string;
    content?: string;
    body?: { content?: string };
    create_time?: string;
    sender?: { id?: string; sender_type?: string; id_type?: string };
  };
  if (!it?.message_id) return undefined;
  if (it.msg_type === 'system') return undefined;
  // 消息列表 API 的内容在 body.content 里（事件 API 才是 message.content）
  const raw = it.body?.content ?? it.content ?? '{}';
  let text = extractText(it.msg_type ?? 'text', raw).trim();
  if (!text) return undefined;
  // 去掉 @_user_1 这类提及占位
  text = text.replace(/@_user_\d+/g, '').trim();
  if (!text) return undefined;
  const isBot = it.sender?.sender_type === 'app' || it.sender?.sender_type === 'bot';
  const senderId = it.sender?.id ?? '';
  const senderName = isBot ? '机器人' : senderId ? shortId(senderId) : 'unknown';
  return { id: it.message_id, senderName, text, ts: Number(it.create_time ?? 0) };
}
