import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface McpServerConfig {
  lifecycle?: 'eager' | 'lazy';
  auth?: unknown;
  [key: string]: unknown;
}

/**
 * 读取 pi-mcp-extension 的配置。
 * 注意：该扩展**硬编码** `homedir()/.pi/agent/mcp.json`，不认 PI_CODING_AGENT_DIR，
 * 所以这里也按同样的路径读，保证与 agent 进程看到的一致。
 * 项目级 `<cwd>/.pi/mcp.json` 按 key 浅覆盖全局（扩展自己的规则）。
 */
export function readMcpServers(cwd: string, home = homedir()): Record<string, McpServerConfig> {
  const global = readJson(join(home, '.pi', 'agent', 'mcp.json'));
  const project = readJson(join(cwd, '.pi', 'mcp.json'));
  return { ...(global?.mcpServers ?? {}), ...(project?.mcpServers ?? {}) };
}

function readJson(file: string): { mcpServers?: Record<string, McpServerConfig> } | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as {
      mcpServers?: Record<string, McpServerConfig>;
    };
  } catch {
    return undefined;
  }
}

/** 非 eager 的 server 需要 `/mcp:start` 才会注册工具 */
export function lazyServers(servers: Record<string, McpServerConfig>): string[] {
  return Object.entries(servers)
    .filter(([, cfg]) => cfg.lifecycle !== 'eager')
    .map(([name]) => name);
}

/** eager + OAuth：headless 下必然要浏览器授权，会阻塞 session_start（见 spike 1） */
export function blockingServers(servers: Record<string, McpServerConfig>): string[] {
  return Object.entries(servers)
    .filter(([, cfg]) => cfg.lifecycle === 'eager' && cfg.auth !== undefined)
    .map(([name]) => name);
}
