import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './paths.ts';

/** 入站附件保留时长（决策 23）；agent 通常是当轮读，留 7 天足够排查问题 */
export const MEDIA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 清掉过期的入站附件。目录形状是 `media/<chatId>/<file>`：只删文件，
 * 顺手把空掉的 chat 目录收走。
 *
 * 不做定时器：这些文件只在有人发图/发文件时才增长，daemon 启动时扫一次就够
 * （每天至少重启一次的场景下，效果和定时跑一样，代价是零）。
 */
export async function pruneMedia(
  dir = paths.mediaDir(),
  maxAgeMs = MEDIA_MAX_AGE_MS,
  now = Date.now(),
): Promise<number> {
  let removed = 0;
  const chats = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const chat of chats) {
    if (!chat.isDirectory()) continue;
    const chatDir = join(dir, chat.name);
    const files = await readdir(chatDir, { withFileTypes: true }).catch(() => []);
    let kept = 0;
    for (const file of files) {
      if (!file.isFile()) {
        kept += 1;
        continue;
      }
      const path = join(chatDir, file.name);
      const info = await stat(path).catch(() => undefined);
      if (!info) continue;
      if (now - info.mtimeMs > maxAgeMs) {
        await rm(path, { force: true }).catch(() => undefined);
        removed += 1;
      } else {
        kept += 1;
      }
    }
    if (kept === 0 && files.length > 0) {
      await rm(chatDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return removed;
}
