import { listCredentials, loadCredential } from '@instead/core';
import { FeishuChannel } from '@instead/channel-feishu';
import { withDaemon } from './daemon-client.ts';

export interface ChatSummary {
  chatId: string;
  name: string;
}

/**
 * 列群：daemon 在就问它（复用已建立的长连接），不在就自己拿凭据直连。
 * @throws 本机没有凭据时抛出
 */
export async function listChats(): Promise<ChatSummary[]> {
  const remote = await withDaemon((c) => c.call<ChatSummary[]>('channel.chats'));
  if (remote) return remote;
  const appId = listCredentials()[0]?.appId;
  const cred = appId ? loadCredential(appId) : undefined;
  if (!cred) throw new Error('本机没有飞书凭据，先运行: instead connect <app_id>');
  return new FeishuChannel({ appId: cred.appId, appSecret: cred.appSecret }).listChats();
}
