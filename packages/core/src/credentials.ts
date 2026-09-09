import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ensureHome, paths, writeSecretFile } from './paths.ts';

export interface FeishuCredential {
  appId: string;
  appSecret: string;
  createdAt: number;
}

/**
 * 凭据只经 CLI 的 TTY 输入写入（§8.1），永不经过会话 transcript / argv / HTTP。
 * 读取只给 daemon 用，任何返回值都不得进日志或出站消息。
 */
export function saveCredential(appId: string, appSecret: string, now = Date.now()): FeishuCredential {
  ensureHome();
  const cred: FeishuCredential = { appId, appSecret, createdAt: now };
  writeSecretFile(paths.credential(appId), JSON.stringify(cred, null, 2));
  return cred;
}

export function loadCredential(appId: string): FeishuCredential | undefined {
  try {
    const raw = readFileSync(paths.credential(appId), 'utf8');
    const parsed = JSON.parse(raw) as FeishuCredential;
    if (!parsed.appId || !parsed.appSecret) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function revokeCredential(appId: string): boolean {
  try {
    unlinkSync(paths.credential(appId));
    return true;
  } catch {
    return false;
  }
}

export function listCredentials(): { appId: string; createdAt: number }[] {
  try {
    return readdirSync(paths.credentialsDir())
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        try {
          const c = JSON.parse(readFileSync(join(paths.credentialsDir(), f), 'utf8')) as FeishuCredential;
          return [{ appId: c.appId, createdAt: c.createdAt }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** 兜底 redaction（§8.1）：主防线是 secret 根本不进会话，这里只处理旧文档抄来的命令 */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 8) out = out.split(s).join('***');
  }
  return out;
}

const SECRET_SHAPE = /\b[A-Za-z0-9]{28,40}\b/g;

/** 疑似飞书 app secret 的形态匹配（doctor 扫描 transcript 用） */
export function looksLikeSecret(text: string): boolean {
  return SECRET_SHAPE.test(text);
}
