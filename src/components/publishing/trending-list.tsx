import type { DraftLanguage } from "@prisma/client";

import type { TrendingListing } from "@/lib/content/publishing/trending";

import { AttributionFooter } from "./attribution-footer";

/**
 * 实时热点榜单。
 *
 * 卡片只展示话题、名次与追踪广度。**不展示实际来源名称，也不带来源徽标** ——
 * 出处由页面底部一处统一声明。
 *
 * 组件拿到的数据里根本没有来源名单与条目地址，所以不存在「渲染时忘了隐藏」
 * 这种失误的空间。
 */

const UI: Record<string, {
  title: string; intro: string; rank: string; sources: string; signals: string;
  captured: string; readBrief: string; briefPending: string; signalNote: string;
}> = {
  EN_US: {
    title: "Trending now",
    intro: "A live view of the topics currently drawing the most coverage. Counts reflect how widely each topic is being tracked.",
    rank: "Rank", sources: "sources", signals: "signals", captured: "Updated",
    readBrief: "Read the brief", briefPending: "Brief not published yet",
    signalNote: "Signal brief — reflects only what the trending feed provides.",
  },
  ES_ES: {
    title: "Tendencias ahora",
    intro: "Vista en vivo de los temas que más cobertura están recibiendo. Los recuentos reflejan con qué amplitud se sigue cada tema.",
    rank: "Puesto", sources: "fuentes", signals: "señales", captured: "Actualizado",
    readBrief: "Leer el resumen", briefPending: "Resumen aún no publicado",
    signalNote: "Resumen de señal: refleja únicamente lo que ofrece el listado de tendencias.",
  },
  PT_BR: {
    title: "Em alta agora",
    intro: "Uma visão ao vivo dos temas que mais estão recebendo cobertura. As contagens refletem a amplitude com que cada tema é acompanhado.",
    rank: "Posição", sources: "fontes", signals: "sinais", captured: "Atualizado",
    readBrief: "Ler o resumo", briefPending: "Resumo ainda não publicado",
    signalNote: "Resumo de sinal: reflete apenas o que a listagem de tendências fornece.",
  },
  JA_JP: {
    title: "現在のトレンド",
    intro: "いま最も広く取り上げられている話題のライブビューです。件数は各話題がどの程度広く追跡されているかを示します。",
    rank: "順位", sources: "ソース", signals: "シグナル", captured: "更新",
    readBrief: "ブリーフを読む", briefPending: "ブリーフは未公開",
    signalNote: "シグナル要約 — トレンド一覧が提供する情報のみを反映しています。",
  },
};

function fmt(d: Date, locale: string): string {
  const tag = { EN_US: "en-US", ES_ES: "es-ES", PT_BR: "pt-BR", JA_JP: "ja-JP" }[locale] ?? "en-US";
  return new Intl.DateTimeFormat(tag, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  }).format(d);
}

export function TrendingList({ listing, locale }: { listing: TrendingListing; locale: DraftLanguage }) {
  const t = UI[locale] ?? UI.EN_US;
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 lg:py-14">
      <h1 className="text-3xl font-semibold text-slate-950 dark:text-foreground sm:text-4xl">{t.title}</h1>
      <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600 dark:text-muted-foreground">{t.intro}</p>

      <ul className="mt-8 space-y-4">
        {listing.cards.map((c) => (
          <li key={c.key}
              className="rounded-xl border border-border/80 bg-white p-5 shadow-sm shadow-slate-900/[0.03] dark:bg-card">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {c.rank !== null ? (
                <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-sm font-semibold text-primary">
                  {t.rank} {c.rank}
                </span>
              ) : null}
              <h2 className="text-lg font-semibold text-slate-950 dark:text-foreground">{c.headline}</h2>
            </div>

            <p className="mt-3 text-sm text-slate-600 dark:text-muted-foreground">
              {c.sourceCount !== null ? `${c.sourceCount} ${t.sources}` : null}
              {c.sourceCount !== null && c.signalCount !== null ? " · " : null}
              {c.signalCount !== null ? `${c.signalCount} ${t.signals}` : null}
              {" · "}{t.captured} {fmt(c.capturedAt, locale)}
            </p>

            {c.mode === "SIGNAL" ? (
              <p className="mt-2 text-xs text-slate-500 dark:text-muted-foreground">{t.signalNote}</p>
            ) : null}

            <div className="mt-4 text-sm">
              {c.briefHref ? (
                <a href={c.briefHref} className="font-medium text-primary hover:underline">{t.readBrief} →</a>
              ) : (
                <span className="text-slate-400 dark:text-muted-foreground">{t.briefPending}</span>
              )}
            </div>
          </li>
        ))}
      </ul>

      <AttributionFooter attribution={listing.attribution} />
    </div>
  );
}
