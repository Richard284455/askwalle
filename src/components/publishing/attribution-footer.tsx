import type { PublicAttribution } from "@/lib/content/publishing/attribution";

/**
 * 页面底部的统一归因。
 *
 * 这是公开页上**唯一**的出处声明：标题、导语、正文、卡片里都不再出现。
 * 四种语言共用同一句英文品牌文案 —— 品牌名不翻译。
 *
 * `Original source` 只写通用文字，**不写实际来源名称**：
 * 名称留在数据库与后台，读者点得进去，但页面不替信源做署名。
 *
 * nofollow 是必须的：这是聚合来源的外链，不是本站的推荐背书。
 */
export function AttributionFooter({ attribution }: { attribution: PublicAttribution }) {
  return (
    <footer className="mt-10 border-t border-border/60 pt-4 text-xs leading-5 text-slate-500 dark:text-muted-foreground">
      <a
        href={attribution.providerUrl}
        target="_blank"
        rel="nofollow noopener noreferrer"
        className="hover:underline"
      >
        {attribution.poweredByLabel}
      </a>
      {attribution.originalHref ? (
        <>
          <span aria-hidden="true"> · </span>
          <a
            href={attribution.originalHref}
            target="_blank"
            rel="nofollow noopener noreferrer"
            className="hover:underline"
          >
            Original source
          </a>
        </>
      ) : null}
    </footer>
  );
}
