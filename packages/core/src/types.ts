/**
 * 统一消息协议 + adapter 契约（DESIGN §10.2 / §10.3）
 */

export type AgentId = 'pi' | 'claude' | 'codex';
export type ChannelId = 'feishu';

/** 渠道侧会话标识：`feishu:chat:<chat_id>`，与 SessionRef.sessionId 多对一（§1.1） */
export type ConversationKey = `${ChannelId}:chat:${string}`;

export type DriverKind = 'daemon' | 'native-tui' | 'in-proc';
export type MirrorMode = 'off' | 'user' | 'user+assistant' | 'full';

export interface Actor {
  id: string;
  name: string;
}

export interface Attachment {
  kind: 'image' | 'file';
  localPath: string;
  name: string;
}

/** 入站消息（渠道无关的规范化形态） */
export interface InboundMessage {
  /** 渠道事件 id，去重键（飞书 event_id） */
  id: string;
  channel: ChannelId;
  conversationKey: ConversationKey;
  actor: Actor;
  text: string;
  attachments: Attachment[];
  ts: number;
  replyTo?: string;
  /** 是否 @ 了机器人（决定触发还是进 pendingWindow） */
  mentioned: boolean;
  /** 话题群标识（缺口 H：M0 检测到就提示不支持） */
  threadId?: string;
}

export interface OutboundMessage {
  conversationKey: ConversationKey;
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  /** 幂等键：同一 turn 的同一 seq 只发一次（缺口 B） */
  turnId: string;
  seq: number;
}

export interface SessionRef {
  agent: AgentId;
  sessionId: string;
  cwd: string;
  driver: DriverKind;
}

export type TurnEventType = 'started' | 'delta' | 'tool' | 'final' | 'error' | 'aborted';

export interface TurnEvent {
  turnId: string;
  /** 由 dispatcher 填（adapter 不知道路由信息） */
  conversationKey?: ConversationKey;
  type: TurnEventType;
  text?: string;
}

/** 绑定记录（chat 1:1 session） */
export interface Binding {
  chatId: string;
  sessionId: string;
  agent: AgentId;
  cwd: string;
  ownerOpenId: string;
  mirrorMode: MirrorMode;
  createdAt: number;
}

export interface BindCode {
  code: string;
  sessionId: string;
  agent: AgentId;
  cwd: string;
  createdAt: number;
  expiresAt: number;
}

export interface ModelInfo {
  id: string;
  label?: string;
  provider?: string;
}

/** 注入到 agent 的只读上下文（pendingWindow / bootstrapHistory / 指令） */
export interface ContextBlock {
  kind: 'pending-window' | 'historical' | 'instructions';
  conversationKey: ConversationKey;
  chatName?: string;
  text: string;
}

/** adapter 入参（缺口 G：图片由 adapter 各自转换） */
export interface UserMessage {
  text: string;
  /** 触发该 turn 的群；adapter 可据此给事件打标 */
  conversationKey?: ConversationKey;
  images?: { data: string; mimeType: string }[];
  context?: ContextBlock[];
}

export interface AgentCapabilities {
  persistent: boolean;
  steer: boolean;
  liveAttach: 'in-proc' | 'lease' | 'none';
  approvals: boolean;
  /** 配置台据此决定模型下拉是否可用（§4.4.2） */
  modelSwitch: 'runtime' | 'restart' | 'none';
}

export interface StartOptions {
  cwd: string;
  sessionId?: string;
  model?: string;
}

/** adapter 返回的会话句柄（各 adapter 可扩展） */
export interface AgentSessionHandle {
  readonly ref: SessionRef;
  readonly capabilities: AgentCapabilities;
}

export interface TurnResult {
  text: string;
  aborted: boolean;
  error?: string;
}

export interface TurnHandle {
  turnId: string;
  /** turn 完全结束（对应 pi 的 agent_settled，不是 agent_end，见 spike 1） */
  settled: Promise<TurnResult>;
  onEvent(listener: (event: TurnEvent) => void): () => void;
}

export interface HistoryEntry {
  id: string;
  role: 'user' | 'assistant' | 'other';
  text: string;
  ts?: number;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly capabilities: AgentCapabilities;
  start(opts: StartOptions): Promise<AgentSessionHandle>;
  send(handle: AgentSessionHandle, msg: UserMessage): Promise<TurnHandle>;
  abort(handle: AgentSessionHandle, turnId: string): Promise<void>;
  stop(handle: AgentSessionHandle): Promise<void>;
  history?(handle: AgentSessionHandle, cursor?: string): AsyncIterable<HistoryEntry>;
  injectContext?(handle: AgentSessionHandle, ctx: ContextBlock): Promise<void>;
  /** 列出可切换的模型（有 handle 时查该会话；不传 handle 时 adapter 可自行探测） */
  models?(handle?: AgentSessionHandle): Promise<ModelInfo[]>;
  /** 仅 `modelSwitch === 'runtime'` 时实现；`model` 支持 `<provider>/<modelId>` */
  setModel?(handle: AgentSessionHandle, model: string): Promise<void>;
}
