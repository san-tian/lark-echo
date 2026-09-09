import { newTurnId } from '../ids.ts';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentSessionHandle,
  ContextBlock,
  ConversationKey,
  InboundMessage,
  OutboundMessage,
  SessionRef,
  StartOptions,
  TurnEvent,
  TurnHandle,
  TurnResult,
  UserMessage,
} from '../types.ts';
import type { Channel, ChatInfo, DoctorCheck, OutboundResult, ReceiptKind } from '../channel.ts';
import type { SessionDriver } from '../session-driver.ts';

export interface FakeChannelState {
  sent: OutboundMessage[];
  receipts: { conversationKey: ConversationKey; kind: ReceiptKind; text?: string }[];
  chats: ChatInfo[];
  /** 下一次 send 抛错（测试出站重试） */
  failNextSend: boolean;
}

export class FakeChannel implements Channel {
  readonly id = 'feishu' as const;
  readonly sent: OutboundMessage[] = [];
  readonly receipts: { conversationKey: ConversationKey; kind: ReceiptKind; text?: string }[] = [];
  chats: ChatInfo[] = [];
  failNextSend = false;
  private onInbound?: (msg: InboundMessage) => void;

  async start(onInbound: (msg: InboundMessage) => void): Promise<void> {
    this.onInbound = onInbound;
  }
  async stop(): Promise<void> {
    this.onInbound = undefined;
  }
  async send(msg: OutboundMessage): Promise<OutboundResult> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('fake channel send failed');
    }
    this.sent.push(msg);
    return { messageId: `fake-msg-${this.sent.length}` };
  }
  async receipt(key: ConversationKey, kind: ReceiptKind, text?: string): Promise<void> {
    this.receipts.push({ conversationKey: key, kind, ...(text ? { text } : {}) });
  }
  async listChats(): Promise<ChatInfo[]> {
    return this.chats;
  }
  async doctor(): Promise<DoctorCheck[]> {
    return [{ id: 'fake', ok: true }];
  }
  /** 测试投递入站事件 */
  async inject(msg: InboundMessage): Promise<void> {
    await this.onInbound?.(msg);
  }
  textsFor(conversationKey: ConversationKey): string[] {
    return this.sent.filter((m) => m.conversationKey === conversationKey).map((m) => m.text);
  }
}

export interface FakeAdapterOptions {
  reply?: string | ((msg: UserMessage) => string);
  /** 每个 turn 的耗时，用来制造排队场景 */
  delayMs?: number;
  fail?: boolean;
  sessionId?: string;
}

interface ActiveTurn {
  turnId: string;
  listeners: Set<(e: TurnEvent) => void>;
  settle: (r: TurnResult) => void;
  done: boolean;
}

export class FakeAdapter implements AgentAdapter {
  readonly id = 'pi' as const;
  readonly capabilities: AgentCapabilities = {
    persistent: true,
    steer: false,
    liveAttach: 'lease',
    approvals: false,
    modelSwitch: 'restart',
  };
  readonly received: UserMessage[] = [];
  readonly aborted: string[] = [];
  readonly contexts: ContextBlock[] = [];
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly reply: string | ((msg: UserMessage) => string);
  private readonly delayMs: number;
  private readonly fail: boolean;
  private readonly sessionId: string;
  private started = 0;

  constructor(opts: FakeAdapterOptions = {}) {
    this.reply = opts.reply ?? 'fake reply';
    this.delayMs = opts.delayMs ?? 0;
    this.fail = opts.fail ?? false;
    this.sessionId = opts.sessionId ?? 'fake-session';
  }

  async start(opts: StartOptions): Promise<AgentSessionHandle> {
    this.started += 1;
    return {
      ref: {
        agent: 'pi',
        sessionId: opts.sessionId ?? this.sessionId,
        cwd: opts.cwd,
        driver: 'daemon',
      },
      capabilities: this.capabilities,
    };
  }

  async send(handle: AgentSessionHandle, msg: UserMessage): Promise<TurnHandle> {
    this.received.push(msg);
    for (const c of msg.context ?? []) this.contexts.push(c);
    const turnId = newTurnId();
    const listeners = new Set<(e: TurnEvent) => void>();
    let settle!: (r: TurnResult) => void;
    const settled = new Promise<TurnResult>((res) => {
      settle = res;
    });
    const active: ActiveTurn = { turnId, listeners, settle, done: false };
    this.turns.set(turnId, active);
    const emit = (e: TurnEvent): void => {
      for (const l of listeners) l(e);
    };
    const finish = (r: TurnResult): void => {
      if (active.done) return;
      active.done = true;
      this.turns.delete(turnId);
      active.settle(r);
    };

    setTimeout(() => {
      if (active.done) return;
      const key = msg.conversationKey ?? ('feishu:chat:unknown' as ConversationKey);
      emit({ turnId, conversationKey: key, type: 'started' });
      if (this.fail) {
        emit({ turnId, conversationKey: key, type: 'error', text: 'fake failure' });
        finish({ text: '', aborted: false, error: 'fake failure' });
        return;
      }
      const text = typeof this.reply === 'function' ? this.reply(msg) : this.reply;
      emit({ turnId, conversationKey: key, type: 'delta', text });
      emit({ turnId, conversationKey: key, type: 'final', text });
      finish({ text, aborted: false });
    }, this.delayMs);

    return {
      turnId,
      settled,
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  async abort(_handle: AgentSessionHandle, turnId: string): Promise<void> {
    this.aborted.push(turnId);
    const active = this.turns.get(turnId);
    if (active && !active.done) {
      active.done = true;
      this.turns.delete(turnId);
      active.settle({ text: '', aborted: true });
    }
  }

  async stop(): Promise<void> {
    for (const [id, active] of this.turns) {
      active.done = true;
      active.settle({ text: '', aborted: true });
      this.turns.delete(id);
    }
  }

  get startCount(): number {
    return this.started;
  }
  get activeTurns(): number {
    return this.turns.size;
  }
}

/** 测试用 SessionDriver：一个 adapter 服务所有 session（记录 ref 用于断言） */
export class FakeDriver implements SessionDriver {
  readonly acquired: SessionRef[] = [];
  readonly touched: SessionRef[] = [];
  readonly released: string[] = [];
  readonly adapter: AgentAdapter;

  constructor(adapter: AgentAdapter) {
    this.adapter = adapter;
  }

  async acquire(ref: SessionRef): Promise<{ adapter: AgentAdapter; handle: AgentSessionHandle }> {
    this.acquired.push(ref);
    const handle = await this.adapter.start({ cwd: ref.cwd, sessionId: ref.sessionId });
    return { adapter: this.adapter, handle };
  }
  touch(ref: SessionRef): void {
    this.touched.push(ref);
  }
  async release(sessionId: string): Promise<void> {
    this.released.push(sessionId);
  }
}
