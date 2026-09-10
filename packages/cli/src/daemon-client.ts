import { paths } from '@instead/core';
import { IpcClient } from '@instead/daemon';

/**
 * 连不上 daemon 时返回 undefined，**daemon 在但调用失败时照原样抛出**。
 *
 * 这个区分是有意的：只有「daemon 不在」才允许退化成直接写库。若把两者混成
 * 同一个 undefined，一次偶发的 IPC 失败会让 CLI 绕过 daemon 直接改库 ——
 * daemon 内存里的状态与库就此分叉，直到它重启才会发现。
 */
export async function withDaemon<T>(
  fn: (client: IpcClient) => Promise<T>,
  socketPath = paths.socket(),
): Promise<T | undefined> {
  let client: IpcClient;
  try {
    client = await IpcClient.connect(socketPath);
  } catch {
    return undefined; // daemon 不在 —— 唯一允许退化的情况
  }
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

/**
 * 「daemon 活着吗」——任何失败都算不活，不抛。
 * 与 withDaemon 的区别：这里的调用失败本身就是答案，不是异常。
 */
export async function pingDaemon(
  socketPath = paths.socket(),
): Promise<{ pid: number } | undefined> {
  try {
    return await withDaemon((c) => c.call<{ pid: number }>('ping'), socketPath);
  } catch {
    return undefined;
  }
}

/** 等 daemon 起来（启动后轮询 socket） */
export async function waitForDaemon(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingDaemon()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** 等 daemon 停掉；true = 已停，false = 超时仍在 */
export async function waitForDaemonGone(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await pingDaemon())) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
