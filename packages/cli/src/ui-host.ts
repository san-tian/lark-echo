import { execFileSync } from 'node:child_process';

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export interface TailscaleInfo {
  ip?: string;
  dnsName?: string;
}

/** 取 tailnet 地址与 MagicDNS 名（决策 18）。拿不到就返回空对象。 */
export function tailscaleInfo(): TailscaleInfo {
  const sh = (cmd: string, args: string[]): string | undefined => {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 }).trim();
    } catch {
      return undefined;
    }
  };
  const ip = sh('tailscale', ['ip', '-4'])?.split('\n')[0]?.trim();
  let dnsName: string | undefined;
  const raw = sh('tailscale', ['status', '--json']);
  if (raw) {
    try {
      dnsName = (JSON.parse(raw) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(
        /\.$/,
        '',
      );
    } catch {
      /* tailscale 输出不是预期的 JSON —— 当作没有 */
    }
  }
  return { ...(ip ? { ip } : {}), ...(dnsName ? { dnsName } : {}) };
}

export interface HostPlan {
  host: string;
  /** 需要额外加进 Host 白名单的名字（loopback 不需要） */
  allowHosts: string[];
}

/**
 * 决定配置台绑哪个地址（决策 20）：
 * - 显式 `--host`：照办；非 loopback 的要进白名单
 * - 没给：有 tailnet 就绑 tailnet（IP 与 MagicDNS 名都进白名单），否则 loopback
 *
 * 抽成纯函数（tailscale 探测结果由外部传入）才能测。
 */
export function planHost(explicitHost: string | undefined, ts: TailscaleInfo): HostPlan {
  if (explicitHost) {
    return {
      host: explicitHost,
      allowHosts: LOOPBACK_HOSTS.has(explicitHost) ? [] : [explicitHost],
    };
  }
  if (ts.ip) {
    return { host: ts.ip, allowHosts: ts.dnsName ? [ts.ip, ts.dnsName] : [ts.ip] };
  }
  return { host: '127.0.0.1', allowHosts: [] };
}
