import { parse } from "tldts";

/**
 * registrable domain（eTLD+1）统一入口。
 *
 * 「同域」判定贯穿 HEAD 短路、跨域跳转、内链计数三处。用「取最后两段」这种土办法
 * 在 .co.uk / .com.cn 上必错——foo.bar.co.uk 会被算成 co.uk，于是任意两个英国站
 * 都成了「同域」。必须走 Public Suffix List。
 *
 * tldts 版本在 package.json 里锁死（--save-exact）：PSL 数据随版本走，浮动版本
 * 会让同一个 URL 在不同时间得出不同的域，历史证据就无法重放了。
 */
export const PSL_LIBRARY = "tldts@6.1.58";

export type HostInfo = {
  hostname: string;
  /** eTLD+1；IP 字面量或无效主机名时为 null */
  registrableDomain: string | null;
  isIp: boolean;
  publicSuffix: string | null;
};

export function hostInfo(hostname: string): HostInfo {
  const parsed = parse(hostname, { allowPrivateDomains: false });
  return {
    hostname: parsed.hostname ?? hostname,
    registrableDomain: parsed.domain,
    isIp: parsed.isIp === true,
    publicSuffix: parsed.publicSuffix,
  };
}

export function registrableDomainOf(hostnameOrUrl: string): string | null {
  return parse(hostnameOrUrl, { allowPrivateDomains: false }).domain;
}

/**
 * 两个主机是否属于同一 registrable domain。
 * www ↔ apex、任意子域之间都算同域；IP 字面量按精确相等处理。
 */
export function sameRegistrableDomain(a: string, b: string): boolean {
  const ia = hostInfo(a);
  const ib = hostInfo(b);
  if (ia.isIp || ib.isIp) return ia.hostname === ib.hostname;
  if (!ia.registrableDomain || !ib.registrableDomain) {
    return ia.hostname === ib.hostname;
  }
  return ia.registrableDomain === ib.registrableDomain;
}
