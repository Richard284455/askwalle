import { ArrowUpRight } from "lucide-react";

import type { PublishedPage } from "@/lib/content/publishing/query";
import { LOCALE_SEGMENT, LOCALES } from "@/lib/content/publishing/types";

/**
 * 已发布多语言内容的公开渲染。
 *
 * 归因是硬要求，不是装饰：读者必须能看到内容从哪来、原始来源是谁、
 * 以及「本站只做忠实转述，不为信源的事实背书」。
 *
 * 这个组件**只接收已经过滤好的公开字段** —— QA 详情、prompt、
 * provider 载荷根本不在 PublishedPage 里，所以没有泄露的可能。
 */

const UI: Record<string, {
  discoveredVia: string; originalSource: string; sourcePublished: string;
  sitePublished: string; readOn: string; languages: string; disclaimer: string;
}> = {
  EN_US: {
    discoveredVia: "Discovered via", originalSource: "Original source",
    sourcePublished: "Source published", sitePublished: "Published on AskWalle",
    readOn: "Read on", languages: "Read in other languages",
    disclaimer: "This article was written by AskWalle based on what the source published. Facts are as stated by the source; we do not independently verify them.",
  },
  ES_ES: {
    discoveredVia: "Descubierto vía", originalSource: "Fuente original",
    sourcePublished: "Publicado por la fuente", sitePublished: "Publicado en AskWalle",
    readOn: "Leer en", languages: "Leer en otros idiomas",
    disclaimer: "Este artículo fue redactado por AskWalle a partir de lo publicado por la fuente. Los hechos son los que declara la fuente; no los verificamos de forma independiente.",
  },
  PT_BR: {
    discoveredVia: "Descoberto via", originalSource: "Fonte original",
    sourcePublished: "Publicado pela fonte", sitePublished: "Publicado no AskWalle",
    readOn: "Ler em", languages: "Ler em outros idiomas",
    disclaimer: "Este artigo foi escrito pela AskWalle com base no que a fonte publicou. Os fatos são os declarados pela fonte; não os verificamos de forma independente.",
  },
  JA_JP: {
    discoveredVia: "発見元", originalSource: "一次情報源",
    sourcePublished: "情報源の公開日", sitePublished: "AskWalle 掲載日",
    readOn: "元記事を読む", languages: "他の言語で読む",
    disclaimer: "本記事は情報源が公開した内容に基づき AskWalle が独自に執筆しました。事実関係は情報源の記載に依拠しており、当サイトによる独自検証は行っていません。",
  },
};

const LOCALE_NAME: Record<string, string> = {
  EN_US: "English", ES_ES: "Español", PT_BR: "Português (BR)", JA_JP: "日本語",
};

function fmt(d: Date | null, locale: string): string {
  if (!d) return "—";
  const tag = { EN_US: "en-US", ES_ES: "es-ES", PT_BR: "pt-BR", JA_JP: "ja-JP" }[locale] ?? "en-US";
  return new Intl.DateTimeFormat(tag, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(d);
}

export function PublishedArticle({ page }: { page: PublishedPage }) {
  const t = UI[page.locale] ?? UI.EN_US;

  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 lg:py-14">
      {page.categorySlug ? (
        <p className="text-sm font-medium uppercase tracking-wide text-primary">{page.categorySlug}</p>
      ) : null}

      <h1 className="mt-2 text-3xl font-semibold leading-tight text-slate-950 dark:text-foreground sm:text-4xl">
        {page.headline}
      </h1>

      <p className="mt-4 text-lg leading-8 text-slate-600 dark:text-muted-foreground">{page.summary}</p>

      <dl className="mt-6 flex flex-wrap gap-x-6 gap-y-2 border-y border-border/70 py-4 text-sm text-slate-600 dark:text-muted-foreground">
        <div className="flex gap-2">
          <dt className="font-medium">{t.discoveredVia}:</dt>
          <dd>
            <a href={page.attributionUrl} target="_blank" rel="noopener noreferrer"
               className="inline-flex items-center gap-1 text-primary hover:underline">
              {page.attributionName}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </a>
          </dd>
        </div>
        {page.originalSourceName ? (
          <div className="flex gap-2">
            <dt className="font-medium">{t.originalSource}:</dt>
            <dd>
              {page.originalSourceUrl ? (
                <a href={page.originalSourceUrl} target="_blank" rel="noopener noreferrer"
                   className="inline-flex items-center gap-1 text-primary hover:underline">
                  {page.originalSourceName}
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </a>
              ) : (
                <span>{page.originalSourceName}</span>
              )}
            </dd>
          </div>
        ) : null}
        {page.sourcePublishedAt ? (
          <div className="flex gap-2">
            <dt className="font-medium">{t.sourcePublished}:</dt>
            <dd>{fmt(page.sourcePublishedAt, page.locale)}</dd>
          </div>
        ) : null}
        <div className="flex gap-2">
          <dt className="font-medium">{t.sitePublished}:</dt>
          <dd>{fmt(page.sitePublishedAt, page.locale)}</dd>
        </div>
      </dl>

      {/* 日报按 AI HOT 的原始栏目顺序渲染；顺序是信源的编辑判断，不重排 */}
      {page.sections?.length ? (
        <div className="mt-8 space-y-8">
          {page.sections.map((s, i) => (
            <section key={`${i}-${s.label}`}>
              {/* 导语没有栏目名，此时不该凭空造一个空标题 */}
              {s.label ? (
                <h2 className="text-xl font-semibold text-slate-950 dark:text-foreground">{s.label}</h2>
              ) : null}
              <div className="mt-2 space-y-3 leading-7 text-slate-700 dark:text-muted-foreground">
                {s.body.split(/\n{2,}/).map((p, j) => <p key={j}>{p}</p>)}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="mt-8 space-y-4 leading-7 text-slate-700 dark:text-muted-foreground">
          {page.body.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
        </div>
      )}

      <p className="mt-10 rounded-lg border border-border/70 bg-muted/40 p-4 text-sm leading-6 text-slate-600 dark:text-muted-foreground">
        {t.disclaimer}
      </p>

      {page.alternates.length > 1 ? (
        <nav className="mt-8" aria-label={t.languages}>
          <h2 className="text-sm font-medium text-slate-950 dark:text-foreground">{t.languages}</h2>
          <ul className="mt-2 flex flex-wrap gap-3 text-sm">
            {LOCALES.filter((l) => l !== page.locale)
              .map((l) => page.alternates.find((a) => a.locale === l))
              .filter((a): a is NonNullable<typeof a> => Boolean(a))
              .map((a) => (
                <li key={a.locale}>
                  <a href={new URL(a.href).pathname} hrefLang={a.hreflang}
                     className="rounded-full border border-border/80 px-3 py-1 text-primary hover:underline">
                    {LOCALE_NAME[a.locale] ?? LOCALE_SEGMENT[a.locale]}
                  </a>
                </li>
              ))}
          </ul>
        </nav>
      ) : null}
    </article>
  );
}
