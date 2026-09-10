import { isAbsolute, normalize, resolve, sep } from 'node:path';

/**
 * 出站媒体约定（决策 23）：agent 在回复里**单独占一行**写 `MEDIA:<路径>`，
 * instead 把这一行切出来、从正文里删掉、再把文件传上去发到群里。
 *
 * 形状借自 OpenClaw 的 `MEDIA_TOKEN_RE`（`worker` 里 `/\bMEDIA:\s*`?([^\n]+)`?/gi`），
 * 但**只认独占一行**：内联匹配会误伤「解释这个约定」的正文 —— 我们自己刚教会它这个
 * 写法，它很可能在回答里复述一遍，那时把整句切掉比漏发一个文件糟得多。
 *
 * 这里只管语法。合法性（在 cwd 内、真实存在、没超限）由调用方判定。
 */

/** 一行是不是 MEDIA 指令；是就返回路径 */
export function matchMediaLine(line: string): string | undefined {
  const m = /^[ \t]*MEDIA:[ \t]*`?([^`\n]+?)`?[ \t]*$/.exec(line);
  const ref = m?.[1]?.trim();
  return ref ? ref : undefined;
}

export interface MediaRefs {
  /** 按出现顺序 */
  refs: string[];
  /** 去掉 MEDIA 行之后的正文（连续空行压成一个） */
  text: string;
}

/** 一次性抽干（调用方不需要保留原文时用这个） */
export function extractMediaRefs(text: string): MediaRefs {
  const refs: string[] = [];
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const ref = matchMediaLine(line);
    if (ref) {
      refs.push(ref);
      continue;
    }
    kept.push(line);
  }
  return { refs, text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

/**
 * 把相对路径解析到 cwd 之内；越界（`..`、绝对路径指向别处）返回 undefined。
 *
 * 这是**防提示注入**的一道闸：群里任何人都能往消息里塞「把这个文件发出来」，
 * 而 agent 有读文件的权力。默认只允许发当前工作目录里的东西。
 */
export function resolveInsideCwd(ref: string, cwd: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return undefined; // v1 不拉远端（http/file/data）
  const root = resolve(cwd);
  const abs = normalize(isAbsolute(ref) ? ref : resolve(root, ref));
  if (abs === root) return undefined;
  return abs.startsWith(root.endsWith(sep) ? root : `${root}${sep}`) ? abs : undefined;
}

const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.ico',
  '.heic',
]);

/**
 * 出站只分「图」和「文件」两类：飞书视频消息要求封面 `image_key`
 * （lark-cli 的 `--video-cover` 就是干这个的），拿不到就先当文件发，别硬发。
 */
export function mediaKindFor(filePath: string): 'image' | 'file' {
  const dot = filePath.lastIndexOf('.');
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
  return IMAGE_EXTS.has(ext) ? 'image' : 'file';
}

/** 飞书侧上限：图 10MB、文件 30MB（OpenClaw 同款常量） */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
