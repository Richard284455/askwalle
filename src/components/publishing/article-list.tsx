import type { DraftLanguage } from "@prisma/client";

import type { PublicAttribution } from "@/lib/content/publishing/attribution";
import type { PublishedCard } from "@/lib/content/publishing/query";

import { AttributionFooter } from "./attribution-footer";

/**
 * 精选资讯 / 每日简报的列表页。
 *
 * 卡片只展示本站产出的标题、摘要与日期。**不展示实际来源名称，也不带来源徽标** ——
 * 出处由页面底部一处统一声明，与详情页同一口径。
 *
 * 组件拿到的数据里根本没有来源名与来源地址（查询层就不返回），
 * 所以不存在「渲染时忘了隐藏」这种失误的空间。
 */

type Copy = {
  title: string;
  intro: string;
  empty: string;
  published: string;
  sourceDate: string;
  read: string;
  signal: string;
};

const UPDATES_UI: Record<string, Copy> = {
  EN_US: {
    title: "AI updates",
    intro: "Short briefs on what shipped, changed, or was announced across AI — rewritten in our own words.",
    empty: "No updates published yet.",
    published: "Published", sourceDate: "Original date", read: "Read", signal: "Signal brief",
  },
  ES_ES: {
    title: "Novedades de IA",
    intro: "Resúmenes breves de lo que se ha lanzado, cambiado o anunciado en IA, redactados con nuestras propias palabras.",
    empty: "Todavía no hay novedades publicadas.",
    published: "Publicado", sourceDate: "Fecha original", read: "Leer", signal: "Resumen de señal",
  },
  PT_BR: {
    title: "Novidades de IA",
    intro: "Resumos curtos do que foi lançado, alterado ou anunciado em IA, escritos com nossas próprias palavras.",
    empty: "Ainda não há novidades publicadas.",
    published: "Publicado", sourceDate: "Data original", read: "Ler", signal: "Resumo de sinal",
  },
  JA_JP: {
    title: "AI アップデート",
    intro: "AI 分野でのリリース・変更・発表を、独自の言葉で短くまとめています。",
    empty: "公開済みのアップデートはまだありません。",
    published: "公開", sourceDate: "元の日付", read: "読む", signal: "シグナル要約",
  },
};

const DAILY_UI: Record<string, Copy> = {
  EN_US: {
    title: "Daily briefings",
    intro: "One roundup per day, keeping the original running order of the source feed.",
    empty: "No briefings published yet.",
    published: "Published", sourceDate: "Briefing date", read: "Read", signal: "Signal brief",
  },
  ES_ES: {
    title: "Informes diarios",
    intro: "Un resumen por día, conservando el orden original de las secciones.",
    empty: "Todavía no hay informes publicados.",
    published: "Publicado", sourceDate: "Fecha del informe", read: "Leer", signal: "Resumen de señal",
  },
  PT_BR: {
    title: "Boletins diários",
    intro: "Um resumo por dia, mantendo a ordem original das seções.",
    empty: "Ainda não há boletins publicados.",
    published: "Publicado", sourceDate: "Data do boletim", read: "Ler", signal: "Resumo de sinal",
  },
  JA_JP: {
    title: "デイリーブリーフィング",
    intro: "1 日 1 本のまとめ。元の掲載順をそのまま保っています。",
    empty: "公開済みのブリーフィングはまだありません。",
    published: "公開", sourceDate: "対象日", read: "読む", signal: "シグナル要約",
  },
};

const TAG: Record<string, string> = {
  EN_US: "en-US", ES_ES: "es-ES", PT_BR: "pt-BR", JA_JP: "ja-JP",
};

function day(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(TAG[locale] ?? "en-US", {
    year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
  }).format(d);
}

export function ArticleList({
  cards, attribution, locale, variant,
}: {
  cards: PublishedCard[];
  attribution: PublicAttribution;
  locale: DraftLanguage;
  variant: "UPDATES" | "DAILY";
}) {
  const table = variant === "DAILY" ? DAILY_UI : UPDATES_UI;
  const t = table[locale] ?? table.EN_US;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 lg:py-14">
      <h1 className="text-3xl font-semibold text-slate-950 dark:text-foreground sm:text-4xl">{t.title}</h1>
      <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600 dark:text-muted-foreground">{t.intro}</p>

      {cards.length === 0 ? (
        <p className="mt-10 text-sm text-slate-500 dark:text-muted-foreground">{t.empty}</p>
      ) : (
        <ul className="mt-8 space-y-4">
          {cards.map((c) => (
            <li key={c.path}
                className="rounded-xl border border-border/80 bg-white p-5 shadow-sm shadow-slate-900/[0.03] dark:bg-card">
              <div className="flex flex-wrap items-center gap-2">
                {c.categorySlug ? (
                  <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
                    {c.categorySlug}
                  </span>
                ) : null}
                {c.hotTopicMode === "SIGNAL" ? (
                  <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {t.signal}
                  </span>
                ) : null}
              </div>

              <h2 className="mt-2 text-lg font-semibold text-slate-950 dark:text-foreground">
                <a href={c.path} className="hover:underline">{c.headline}</a>
              </h2>

              {c.summary ? (
                <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-muted-foreground">{c.summary}</p>
              ) : null}

              <p className="mt-3 text-xs text-slate-500 dark:text-muted-foreground">
                {c.sourcePublishedAt ? `${t.sourceDate} ${day(c.sourcePublishedAt, locale)} · ` : ""}
                {t.published} {day(c.sitePublishedAt, locale)}
              </p>

              <div className="mt-3 text-sm">
                <a href={c.path} className="font-medium text-primary hover:underline">{t.read} →</a>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AttributionFooter attribution={attribution} />
    </div>
  );
}
