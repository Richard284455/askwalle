import type { PublishedPage } from "@/lib/content/publishing/query";
import { LOCALE_SEGMENT, LOCALES } from "@/lib/content/publishing/types";

import { AttributionFooter } from "./attribution-footer";

/**
 * 已发布多语言内容的公开渲染。
 *
 * 页面**不展示实际信源名称**，顶部也不做来源归因。
 * 出处只由底部的 AttributionFooter 统一声明。
 *
 * 这个组件拿到的 PublishedPage 里根本没有实际来源字段 ——
 * 不是「有但不渲染」，是投影层就没放进来，所以 HTML、RSC payload、
 * 序列化 props 里都不会带出去。
 */

const UI: Record<string, {
  published: string; sourceDate: string; languages: string;
  disclaimer: string; signalBadge: string; signalNotice: string;
}> = {
  EN_US: {
    published: "Published", sourceDate: "Original publication date",
    languages: "Read in other languages",
    disclaimer: "This article was written by AskWalle based on publicly reported information. Facts are as stated by the underlying report; we do not independently verify them.",
    signalBadge: "Real-time trending signal",
    signalNotice: "This is a trending-signal brief, not a full news report. It reflects only what the trending feed provides — the topic and how widely it is being tracked. It does not describe event details, and none have been added.",
  },
  ES_ES: {
    published: "Publicado", sourceDate: "Fecha de publicación original",
    languages: "Leer en otros idiomas",
    disclaimer: "Este artículo fue redactado por AskWalle a partir de información publicada. Los hechos son los que declara el informe subyacente; no los verificamos de forma independiente.",
    signalBadge: "Señal de tendencia en tiempo real",
    signalNotice: "Este es un resumen de señal de tendencia, no un reportaje completo. Refleja únicamente lo que ofrece el listado de tendencias: el tema y con qué amplitud se está siguiendo. No describe detalles del evento ni se ha añadido ninguno.",
  },
  PT_BR: {
    published: "Publicado", sourceDate: "Data de publicação original",
    languages: "Ler em outros idiomas",
    disclaimer: "Este artigo foi escrito pela AskWalle com base em informações publicadas. Os fatos são os declarados pelo relato subjacente; não os verificamos de forma independente.",
    signalBadge: "Sinal de tendência em tempo real",
    signalNotice: "Este é um resumo de sinal de tendência, não uma reportagem completa. Reflete apenas o que a listagem de tendências fornece: o tema e a amplitude com que está sendo acompanhado. Não descreve detalhes do evento, e nenhum foi acrescentado.",
  },
  JA_JP: {
    published: "掲載日", sourceDate: "元の公開日",
    languages: "他の言語で読む",
    disclaimer: "本記事は公開された情報に基づき AskWalle が独自に執筆しました。事実関係は元の報道の記載に依拠しており、当サイトによる独自検証は行っていません。",
    signalBadge: "リアルタイム・トレンドシグナル",
    signalNotice: "本記事はトレンドシグナルの要約であり、完全な報道記事ではありません。トレンド一覧が提供する情報（話題と、それがどの程度広く追跡されているか）のみを反映しています。出来事の詳細は記載しておらず、補足も行っていません。",
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
      <div className="flex flex-wrap items-center gap-2">
        {page.categorySlug ? (
          <p className="text-sm font-medium uppercase tracking-wide text-primary">{page.categorySlug}</p>
        ) : null}
        {/* 热点必须一眼看出是榜单信号，不能被当成完整报道 */}
        {page.hotTopicMode === "SIGNAL" ? (
          <span className="rounded-full border border-amber-400/60 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            {t.signalBadge}
          </span>
        ) : null}
      </div>

      <h1 className="mt-2 text-3xl font-semibold leading-tight text-slate-950 dark:text-foreground sm:text-4xl">
        {page.headline}
      </h1>

      <p className="mt-4 text-lg leading-8 text-slate-600 dark:text-muted-foreground">{page.summary}</p>

      {/* 日期不带来源名：只说「原文发布于何时」与「本站何时发布」 */}
      <dl className="mt-6 flex flex-wrap gap-x-6 gap-y-2 border-y border-border/70 py-4 text-sm text-slate-600 dark:text-muted-foreground">
        {page.sourcePublishedAt ? (
          <div className="flex gap-2">
            <dt className="font-medium">{t.sourceDate}:</dt>
            <dd>{fmt(page.sourcePublishedAt, page.locale)}</dd>
          </div>
        ) : null}
        <div className="flex gap-2">
          <dt className="font-medium">{t.published}:</dt>
          <dd>{fmt(page.sitePublishedAt, page.locale)}</dd>
        </div>
      </dl>

      {/* 日报按原始栏目顺序渲染；顺序是信源的编辑判断，不重排 */}
      {page.sections?.length ? (
        <div className="mt-8 space-y-8">
          {page.sections.map((s, i) => (
            <section key={`${i}-${s.label}`}>
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
        {page.hotTopicMode === "SIGNAL" ? t.signalNotice : t.disclaimer}
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

      <AttributionFooter attribution={page.attribution} />
    </article>
  );
}
