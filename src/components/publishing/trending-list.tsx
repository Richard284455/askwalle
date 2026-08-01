import { ArrowUpRight } from "lucide-react";

import type { TrendingCard } from "@/lib/content/publishing/trending";
import type { DraftLanguage } from "@prisma/client";

/**
 * 实时热点榜单。
 *
 * 每张卡片只展示 AI HOT 榜单**确实给出**的字段：名次、来源数、信号数、
 * 来源名称、抓取时间、AI HOT 链接。本站不在卡片上添加任何解读 ——
 * 卡片是信源榜单的投影，不是编辑判断。
 */

const UI: Record<string, {
  title: string; intro: string; rank: string; sources: string; signals: string;
  captured: string; tracking: string; readBrief: string; briefPending: string;
  viewOnAihot: string; signalNote: string;
}> = {
  EN_US: {
    title: "Trending on AI HOT",
    intro: "A live view of what AI HOT is currently tracking. Counts and source names come straight from the AI HOT feed; AskWalle does not add its own ranking.",
    rank: "Rank", sources: "sources", signals: "signals", captured: "Captured",
    tracking: "Tracked by", readBrief: "Read the brief", briefPending: "Brief not published yet",
    viewOnAihot: "View on AI HOT",
    signalNote: "Signal brief — based only on what the AI HOT listing provides.",
  },
  ES_ES: {
    title: "Tendencias en AI HOT",
    intro: "Vista en vivo de lo que AI HOT está siguiendo. Los recuentos y nombres de fuentes provienen directamente del feed de AI HOT; AskWalle no añade su propia clasificación.",
    rank: "Puesto", sources: "fuentes", signals: "señales", captured: "Capturado",
    tracking: "Seguido por", readBrief: "Leer el resumen", briefPending: "Resumen aún no publicado",
    viewOnAihot: "Ver en AI HOT",
    signalNote: "Resumen de señal: basado únicamente en lo que ofrece el listado de AI HOT.",
  },
  PT_BR: {
    title: "Em alta no AI HOT",
    intro: "Uma visão ao vivo do que o AI HOT está acompanhando. As contagens e os nomes das fontes vêm direto do feed do AI HOT; a AskWalle não adiciona sua própria classificação.",
    rank: "Posição", sources: "fontes", signals: "sinais", captured: "Capturado",
    tracking: "Acompanhado por", readBrief: "Ler o resumo", briefPending: "Resumo ainda não publicado",
    viewOnAihot: "Ver no AI HOT",
    signalNote: "Resumo de sinal: baseado apenas no que a listagem do AI HOT fornece.",
  },
  JA_JP: {
    title: "AI HOT トレンド",
    intro: "AI HOT が現在追跡している話題のライブビューです。件数と情報源名は AI HOT のフィードをそのまま反映しており、AskWalle 独自の順位付けは行っていません。",
    rank: "順位", sources: "ソース", signals: "シグナル", captured: "取得時刻",
    tracking: "追跡中の情報源", readBrief: "ブリーフを読む", briefPending: "ブリーフは未公開",
    viewOnAihot: "AI HOT で見る",
    signalNote: "シグナルブリーフ — AI HOT の掲載情報のみに基づいています。",
  },
};

function fmt(d: Date, locale: string): string {
  const tag = { EN_US: "en-US", ES_ES: "es-ES", PT_BR: "pt-BR", JA_JP: "ja-JP" }[locale] ?? "en-US";
  return new Intl.DateTimeFormat(tag, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  }).format(d);
}

export function TrendingList({ cards, locale }: { cards: TrendingCard[]; locale: DraftLanguage }) {
  const t = UI[locale] ?? UI.EN_US;
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 lg:py-14">
      <h1 className="text-3xl font-semibold text-slate-950 dark:text-foreground sm:text-4xl">{t.title}</h1>
      <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600 dark:text-muted-foreground">{t.intro}</p>

      <ul className="mt-8 space-y-4">
        {cards.map((c) => (
          <li key={c.topicId}
              className="rounded-xl border border-border/80 bg-white p-5 shadow-sm shadow-slate-900/[0.03] dark:bg-card">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {c.rank !== null ? (
                <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-sm font-semibold text-primary">
                  {t.rank} {c.rank}
                </span>
              ) : null}
              <h2 className="text-lg font-semibold text-slate-950 dark:text-foreground">
                {c.localizedHeadline ?? c.sourceTitle}
              </h2>
            </div>

            {/* 本地化标题存在时，仍然把信源原始措辞列出来 */}
            {c.localizedHeadline && c.localizedHeadline !== c.sourceTitle ? (
              <p className="mt-1 text-sm text-slate-500 dark:text-muted-foreground">{c.sourceTitle}</p>
            ) : null}

            <p className="mt-3 text-sm text-slate-600 dark:text-muted-foreground">
              {c.sourceCount !== null ? `${c.sourceCount} ${t.sources}` : null}
              {c.sourceCount !== null && c.signalCount !== null ? " · " : null}
              {c.signalCount !== null ? `${c.signalCount} ${t.signals}` : null}
              {" · "}{t.captured} {fmt(c.capturedAt, locale)}
            </p>

            {c.sourceNames.length ? (
              <p className="mt-2 text-sm text-slate-500 dark:text-muted-foreground">
                <span className="font-medium">{t.tracking}:</span> {c.sourceNames.join(" · ")}
              </p>
            ) : null}

            {c.mode === "SIGNAL" ? (
              <p className="mt-2 text-xs text-slate-500 dark:text-muted-foreground">{t.signalNote}</p>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
              {c.briefHref ? (
                <a href={c.briefHref} className="font-medium text-primary hover:underline">{t.readBrief} →</a>
              ) : (
                <span className="text-slate-400 dark:text-muted-foreground">{t.briefPending}</span>
              )}
              <a href={c.aihotUrl} target="_blank" rel="noopener noreferrer"
                 className="inline-flex items-center gap-1 text-primary hover:underline">
                {t.viewOnAihot}
                <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
