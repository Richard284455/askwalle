import { ExtractedText } from "./text-blocks";
import { sameRegistrableDomain } from "./registrable-domain";

/**
 * parked / soft_404 签名（契约 §3 / §4）。
 *
 * 全部匹配都逐块进行 —— 调用方传进来的是 blocks 数组，函数内部**永远不 join**。
 */

export type SignatureHit = {
  ruleId: string;
  layer: "L1" | "L2" | "L2-CN" | "L3";
  source: "host" | "ns" | "header" | "body";
  blockIndex: number | null;
  matchedText: string;
};

// ── L1：停放服务商（强证据，单次即 dead）────────────────────────────────────

export const PARKING_HOST_SUFFIXES = [
  "sedoparking.com", "sedo.com", "parkingcrew.net", "parkingcrew.com", "bodis.com",
  "afternic.com", "cashparking.com", "dan.com", "hugedomains.com", "undeveloped.com",
  "above.com", "parklogic.com", "skenzo.com", "domainmarket.com", "buydomains.com",
  "squadhelp.com", "atom.com", "efty.com", "uniregistry.com", "voodoo.com",
  "smartname.com", "dnsowl.com", "fabulous.com", "brandbucket.com", "namesilo.com/parked",
  "4.cn", "juming.com", "ename.net", "22.cn",
];

export const PARKING_NS_SUFFIXES = [
  "sedoparking.com", "parkingcrew.net", "bodis.com", "above.com", "dan.com",
  "hugedomains.com", "afternic.com", "encirca.net", "parklogic.com", "dnsowl.com",
];

const PARKING_HEADER_MARKERS: { header: string; pattern: RegExp; ruleId: string }[] = [
  { header: "server", pattern: /sedo\s*parking/i, ruleId: "L1.header.sedo" },
  { header: "x-parking-provider", pattern: /.+/, ruleId: "L1.header.provider" },
  { header: "x-served-by", pattern: /bodis/i, ruleId: "L1.header.bodis" },
];

// ── L2：强关键词（需配合结构条件）──────────────────────────────────────────

const L2_PATTERNS: { ruleId: string; re: RegExp }[] = [
  { ruleId: "L2.this_domain_for_sale", re: /this\s+domain\s+(name\s+)?is\s+for\s+sale/i },
  { ruleId: "L2.buy_this_domain", re: /buy\s+this\s+domain/i },
  { ruleId: "L2.domain_name_for_sale", re: /domain\s+name\s+is\s+for\s+sale/i },
  { ruleId: "L2.inquire_about_domain", re: /inquire\s+about\s+this\s+domain/i },
  { ruleId: "L2.make_offer_domain", re: /make\s+an\s+offer\s+on\s+this\s+domain/i },
  { ruleId: "L2.may_be_for_sale", re: /this\s+domain\s+may\s+be\s+for\s+sale/i },
  { ruleId: "L2.get_this_domain", re: /get\s+this\s+domain/i },
  { ruleId: "L2.generated_by_owner", re: /this\s+(web)?page\s+was\s+generated\s+by\s+the\s+domain\s+owner/i },
  { ruleId: "L2.domain_for_sale", re: /\bdomain\s+for\s+sale\b/i },
];

const L2_CN_PATTERNS: { ruleId: string; re: RegExp }[] = [
  { ruleId: "L2CN.dai_shou", re: /该域名待售|此域名待售|本域名待售/ },
  { ruleId: "L2CN.chu_shou", re: /本域名出售|域名出售中|该域名正在出售|此域名正在出售|域名出售/ },
  { ruleId: "L2CN.zhuan_rang", re: /域名转让|域名可议价转让/ },
  { ruleId: "L2CN.ting_fang", re: /域名停放/ },
  { ruleId: "L2CN.owner_page", re: /此页面由域名持有者生成/ },
  { ruleId: "L2CN.qiu_gou", re: /域名求购|高价收购此域名|购买此域名/ },
];

// 同块内共现才算（不是分别出现在两个块）
const L2_COOCCUR: { ruleId: string; all: RegExp[] }[] = [
  {
    ruleId: "L2.related_searches_sponsored",
    all: [/related\s+searches/i, /sponsored\s+listings/i],
  },
];

// ── L3：弱关键词（永不单独构成 parked）────────────────────────────────────

const L3_PATTERNS: { ruleId: string; re: RegExp }[] = [
  { ruleId: "L3.parked", re: /\bparked\b/i },
  { ruleId: "L3.coming_soon", re: /coming\s+soon/i },
  { ruleId: "L3.under_construction", re: /under\s+construction/i },
  { ruleId: "L3.cn_building", re: /建设中|敬请期待|即将上线/ },
];

function excerpt(block: string, re: RegExp): string {
  const m = re.exec(block);
  if (!m) return block.slice(0, 120);
  const start = Math.max(0, (m.index ?? 0) - 20);
  return block.slice(start, start + 120);
}

export function matchParkingHost(host: string): SignatureHit | null {
  const lower = host.toLowerCase();
  for (const suffix of PARKING_HOST_SUFFIXES) {
    const bare = suffix.split("/")[0];
    if (lower === bare || lower.endsWith(`.${bare}`)) {
      return {
        ruleId: `L1.host.${bare}`,
        layer: "L1",
        source: "host",
        blockIndex: null,
        matchedText: host.slice(0, 120),
      };
    }
  }
  return null;
}

export function matchParkingNs(nsRecords: string[]): SignatureHit | null {
  for (const ns of nsRecords) {
    const lower = ns.toLowerCase().replace(/\.$/, "");
    for (const suffix of PARKING_NS_SUFFIXES) {
      if (lower === suffix || lower.endsWith(`.${suffix}`)) {
        return {
          ruleId: `L1.ns.${suffix}`,
          layer: "L1",
          source: "ns",
          blockIndex: null,
          matchedText: ns.slice(0, 120),
        };
      }
    }
  }
  return null;
}

export function matchParkingHeaders(headers: Record<string, string>): SignatureHit | null {
  for (const marker of PARKING_HEADER_MARKERS) {
    const value = headers[marker.header];
    if (value && marker.pattern.test(value)) {
      return {
        ruleId: marker.ruleId,
        layer: "L1",
        source: "header",
        blockIndex: null,
        matchedText: `${marker.header}: ${value}`.slice(0, 120),
      };
    }
  }
  return null;
}

/** L2 / L2-CN / L3 逐块匹配；多词签名必须完整落在单块内 */
export function matchBodySignatures(blocks: string[]): {
  strongBody: SignatureHit[];
  weakSignals: SignatureHit[];
} {
  const strongBody: SignatureHit[] = [];
  const weakSignals: SignatureHit[] = [];

  blocks.forEach((block, index) => {
    for (const { ruleId, re } of L2_PATTERNS) {
      if (re.test(block)) {
        strongBody.push({ ruleId, layer: "L2", source: "body", blockIndex: index, matchedText: excerpt(block, re) });
      }
    }
    for (const { ruleId, re } of L2_CN_PATTERNS) {
      if (re.test(block)) {
        strongBody.push({ ruleId, layer: "L2-CN", source: "body", blockIndex: index, matchedText: excerpt(block, re) });
      }
    }
    for (const { ruleId, all } of L2_COOCCUR) {
      if (all.every((re) => re.test(block))) {
        strongBody.push({ ruleId, layer: "L2", source: "body", blockIndex: index, matchedText: block.slice(0, 120) });
      }
    }
    for (const { ruleId, re } of L3_PATTERNS) {
      if (re.test(block)) {
        weakSignals.push({ ruleId, layer: "L3", source: "body", blockIndex: index, matchedText: excerpt(block, re) });
      }
    }
  });

  return { strongBody, weakSignals };
}

// ── 结构条件与排除项 ──────────────────────────────────────────────────────

export const PARKED_STRUCTURE = {
  maxTextLength: 500,
  maxInternalLinks: 5,
  maxBlocks: 15,
} as const;

export function countInternalLinks(
  text: ExtractedText,
  finalUrl: string
): number {
  let host: string;
  try {
    host = new URL(finalUrl).hostname;
  } catch {
    return 0;
  }
  let count = 0;
  for (const href of text.hrefs) {
    if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) {
      continue;
    }
    if (href.startsWith("/") || !/^[a-z]+:/i.test(href)) {
      count++;
      continue;
    }
    try {
      if (sameRegistrableDomain(new URL(href, finalUrl).hostname, host)) count++;
    } catch {
      /* 忽略畸形 href */
    }
  }
  return count;
}

const PRODUCT_PATH_RE = /\/(login|signin|sign-in|signup|sign-up|pricing|dashboard|account|app)(\/|$|\?)/i;

export function hasProductPaths(text: ExtractedText): boolean {
  return text.hrefs.some((href) => PRODUCT_PATH_RE.test(href));
}

// ── soft_404 ──────────────────────────────────────────────────────────────

const TITLE_404_RE =
  /^\s*(404\b|error\s*404\b|not\s+found\b|page\s+not\s+found\b|页面不存在|页面未找到|找不到页面|404[\s\-–—|]*)/i;

const BODY_404_PATTERNS: { ruleId: string; re: RegExp }[] = [
  { ruleId: "S404.page_not_found", re: /page\s+not\s+found/i },
  { ruleId: "S404.requested_not_exist", re: /the\s+page\s+you\s+requested[\s\S]{0,40}does\s+not\s+exist/i },
  { ruleId: "S404.cant_find", re: /we\s+(can'?t|cannot|could\s+not)\s+find\s+(the\s+)?page/i },
  { ruleId: "S404.cn_not_exist", re: /此页面不存在|您访问的页面不存在|该页面不存在|页面已删除|页面走丢了/ },
];

export const SOFT_404_LIMITS = {
  titleOrH1MaxText: 1200,
  bodyMaxText: 600,
  bodyMaxInternalLinks: 10,
} as const;

export function matchSoft404(
  text: ExtractedText
): { titleHit: SignatureHit | null; h1Hit: SignatureHit | null; bodyHits: SignatureHit[] } {
  const titleHit =
    text.title && TITLE_404_RE.test(text.title)
      ? {
          ruleId: "S404.title",
          layer: "L2" as const,
          source: "body" as const,
          blockIndex: null,
          matchedText: text.title.slice(0, 120),
        }
      : null;

  const h1Hit =
    text.h1 && TITLE_404_RE.test(text.h1)
      ? {
          ruleId: "S404.h1",
          layer: "L2" as const,
          source: "body" as const,
          blockIndex: null,
          matchedText: text.h1.slice(0, 120),
        }
      : null;

  const bodyHits: SignatureHit[] = [];
  text.blocks.forEach((block, index) => {
    for (const { ruleId, re } of BODY_404_PATTERNS) {
      if (re.test(block)) {
        bodyHits.push({ ruleId, layer: "L2", source: "body", blockIndex: index, matchedText: excerpt(block, re) });
      }
    }
  });

  return { titleHit, h1Hit, bodyHits };
}

// ── blocked（WAF / CAPTCHA）────────────────────────────────────────────────

const CHALLENGE_BODY_PATTERNS: { ruleId: string; re: RegExp }[] = [
  { ruleId: "BLK.verify_human", re: /verify\s+you\s+are\s+(a\s+)?human/i },
  { ruleId: "BLK.checking_browser", re: /checking\s+your\s+browser/i },
  { ruleId: "BLK.captcha", re: /\bcaptcha\b/i },
  { ruleId: "BLK.access_denied", re: /access\s+denied/i },
  { ruleId: "BLK.request_blocked", re: /your\s+request\s+(has\s+been\s+)?blocked/i },
  { ruleId: "BLK.cn_verify", re: /请完成安全验证|安全验证|人机验证/ },
  { ruleId: "BLK.enable_js", re: /enable\s+javascript\s+and\s+cookies\s+to\s+continue/i },
];

export function matchChallenge(
  headers: Record<string, string>,
  blocks: string[]
): SignatureHit | null {
  if (headers["cf-mitigated"]) {
    return {
      ruleId: "BLK.cf_mitigated",
      layer: "L1",
      source: "header",
      blockIndex: null,
      matchedText: `cf-mitigated: ${headers["cf-mitigated"]}`.slice(0, 120),
    };
  }
  for (let i = 0; i < blocks.length; i++) {
    for (const { ruleId, re } of CHALLENGE_BODY_PATTERNS) {
      if (re.test(blocks[i])) {
        return { ruleId, layer: "L2", source: "body", blockIndex: i, matchedText: excerpt(blocks[i], re) };
      }
    }
  }
  return null;
}
