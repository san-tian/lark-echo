import { statSync } from 'node:fs';
import {
  ensureHome,
  listCredentials,
  loadCredential,
  paths,
  revokeCredential,
  saveCredential,
  type DoctorCheck,
} from '@instead/core';
import { FeishuChannel, verifyCredentials } from '@instead/channel-feishu';
import { flag, type Args } from '../args.ts';
import { fail, ok, print } from '../io.ts';
import { withDaemon } from '../daemon-client.ts';
import { promptHidden } from '../tty.ts';

export async function cmdConnect(args: Args): Promise<number> {
  const appId = args.positional[1];
  if (!appId) {
    print('用法: instead connect <app_id>');
    return 1;
  }
  const domain = (flag(args, 'domain') ?? 'feishu') as 'feishu' | 'lark';
  const secret = process.env.INSTEAD_APP_SECRET ?? (await promptHidden('App Secret: '));
  if (!secret) {
    fail('未输入 secret');
    return 1;
  }
  print('正在校验凭据…');
  const result = await verifyCredentials(appId, secret, domain);
  if (!result.ok) {
    fail(`凭据校验失败: ${result.error}`);
    return 1;
  }
  ensureHome();
  saveCredential(appId, secret);
  ok(`凭据校验通过，已存入 ${paths.credential(appId)} (0600)`);
  print(`  bot open_id: ${result.botOpenId}`);
  if (result.appName) print(`  应用名称: ${result.appName}`);
  print('');
  print('下一步:');
  print('  1. 把机器人拉进目标群');
  print('  2. instead daemon start');
  print('  3. instead bind --owner <你的 open_id>   # 或在群里 @机器人 一次，从 instead logs 里找到 open_id');
  return 0;
}

export function cmdRevoke(args: Args): number {
  const appId = args.positional[1];
  if (!appId) {
    print('用法: instead revoke <app_id>');
    return 1;
  }
  ok(revokeCredential(appId) ? `已删除 ${appId} 的本机凭据` : `${appId} 没有本机凭据`);
  return 0;
}

function printChecks(checks: DoctorCheck[]): void {
  for (const check of checks) {
    (check.ok ? ok : fail)(`${check.id}${check.detail ? ` — ${check.detail}` : ''}`);
    if (!check.ok && check.hint) print(`    → ${check.hint}`);
  }
}

export async function cmdDoctor(args: Args): Promise<number> {
  const remote = await withDaemon((c) => c.call<{ checks: DoctorCheck[] }>('doctor'));
  if (remote) {
    printChecks(remote.checks);
    return remote.checks.every((c) => c.ok) ? 0 : 1;
  }
  const appId = flag(args, 'app') ?? listCredentials()[0]?.appId;
  if (!appId) {
    fail('本机没有飞书凭据，先运行: instead connect <app_id>');
    return 1;
  }
  const cred = loadCredential(appId);
  if (!cred) {
    fail(`凭据文件不存在: ${paths.credential(appId)}`);
    return 1;
  }
  const mode = (statSync(paths.credential(appId)).mode & 0o777).toString(8);
  (mode === '600' ? ok : fail)(`凭据文件权限 ${mode}（应为 600）`);
  const channel = new FeishuChannel({ appId: cred.appId, appSecret: cred.appSecret });
  const checks = await channel.doctor();
  printChecks(checks);
  return checks.every((c) => c.ok) ? 0 : 1;
}
