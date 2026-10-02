import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  resolveTargetedScript, trimWs, type ScriptLanguage, type ScriptVars, type SectionKey, type TranslatableScript,
} from '@/lib/callScriptsTypes';
import { cn } from '@/lib/utils';
import { QuickAnswers } from './QuickAnswers';
import { ScriptText } from './ScriptText';

export interface ScriptBodyProps {
  /** A TargetedScript (or anything with title / description / sections / helpers / translations). */
  script: TranslatableScript;
  /** The call's values; null = a template (the editor preview) — every variable is a chip. */
  vars: ScriptVars | null;
  /** The language the agent reads the script in (mk | sq), not the UI language. */
  lang: ScriptLanguage;
  /** Narrow places (the phone sheet, the editor preview): one column, smaller text. */
  compact?: boolean;
  /** The description line above the sections (default shown). */
  hideDescription?: boolean;
  /** The quick answers at the end (default shown when the script has any). */
  hideQuickAnswers?: boolean;
  className?: string;
}

/** The section dot follows the key — the same tone everywhere a section is named. */
const KEY_DOT: Record<SectionKey, string> = {
  opening: 'bg-sky-500',
  pitch: 'bg-violet-500',
  objections: 'bg-amber-500',
  closing: 'bg-emerald-500',
  custom: 'bg-zinc-400 dark:bg-zinc-500',
};

const QUICK = '__quick__';

/**
 * A targeted script, resolved for a language (sq falls back to mk PER SECTION — those sections
 * carry a small "МК" mark), as ordered sections with anchors, sticky section chips
 * (Отворање · Презентација · Приговори · Затворање · custom titles · Брзи одговори (n)) and the
 * variables filled from the call (ScriptText: segments, never HTML). Shared by the /calls dock
 * and the /call-scripts editor preview.
 *
 * The chips stick to the top of the nearest scrolling box; a chip scrolls its section into view
 * and the chip of the section being read lights up.
 */
export function ScriptBody({ script, vars, lang, compact, hideDescription, hideQuickAnswers, className }: ScriptBodyProps) {
  const { t } = useTranslation();
  const uid = useId();
  const r = useMemo(() => resolveTargetedScript(script, lang), [script, lang]);
  const sections = useMemo(() => r.sections.filter((s) => trimWs(s.text).length > 0), [r.sections]);
  const fallback = useMemo(() => new Set(r.fallback_section_ids), [r.fallback_section_ids]);
  const helpers = hideQuickAnswers ? [] : r.helpers;

  const anchor = (id: string) => `${uid}-s-${id}`;
  const headingOf = (key: SectionKey, title: string | null | undefined) =>
    key === 'custom' ? trimWs(title) || t('callScripts.sections.custom') : t(`callScripts.sections.${key}`);

  const chips = useMemo(() => {
    const out = sections.map((s) => ({ id: s.id, key: s.key as SectionKey, label: headingOf(s.key as SectionKey, s.title) }));
    if (helpers.length > 0) out.push({ id: QUICK, key: 'custom', label: t('scriptDock.quick.chip', { count: helpers.length }) });
    return out;
  }, [sections, helpers.length, t]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll-spy: the first section (in order) that is on screen lights its chip.
  const [active, setActive] = useState<string | null>(chips[0]?.id ?? null);
  const visible = useRef(new Set<string>());
  const chipIds = chips.map((c) => c.id).join('|');
  useEffect(() => {
    visible.current = new Set();
    setActive(chips[0]?.id ?? null);
    if (typeof IntersectionObserver === 'undefined' || chips.length < 2) return;
    const byEl = new Map<Element, string>();
    for (const c of chips) {
      const el = document.getElementById(anchor(c.id));
      if (el) byEl.set(el, c.id);
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = byEl.get(e.target);
        if (!id) continue;
        if (e.isIntersecting) visible.current.add(id); else visible.current.delete(id);
      }
      const first = chips.find((c) => visible.current.has(c.id));
      if (first) setActive(first.id);
    }, { rootMargin: '-48px 0px -45% 0px' });
    for (const el of byEl.keys()) io.observe(el);
    return () => io.disconnect();
  }, [chipIds, uid]); // eslint-disable-line react-hooks/exhaustive-deps

  const jump = (id: string) => {
    setActive(id);
    document.getElementById(anchor(id))?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  const textCls = compact ? 'text-sm leading-6' : 'text-[15px] leading-7';

  return (
    <div className={cn('min-w-0', className)} data-testid="script-body" lang={r.lang}>
      {chips.length > 1 && (
        <nav
          aria-label={t('scriptDock.body.nav')}
          className="sticky top-0 z-10 -mx-1 mb-2 bg-card/95 px-1 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-card/80"
        >
          <div className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:thin]" data-testid="section-chips">
            {chips.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => jump(c.id)}
                aria-current={active === c.id ? 'true' : undefined}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
                  'min-h-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active === c.id
                    ? 'border-primary/40 bg-primary/10 text-foreground'
                    : 'border-border/60 bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {c.id !== QUICK && <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', KEY_DOT[c.key])} aria-hidden />}
                <span className="max-w-[12rem] truncate">{c.label}</span>
              </button>
            ))}
          </div>
        </nav>
      )}

      {!hideDescription && r.description && trimWs(r.description) && (
        <p className="mb-3 break-words text-xs text-muted-foreground">{r.description}</p>
      )}

      <div className={cn(!compact && helpers.length > 0 && 'xl:grid xl:grid-cols-[minmax(0,7fr)_minmax(0,3fr)] xl:items-start xl:gap-4')}>
        <div className="min-w-0 space-y-3">
          {sections.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-xs italic text-muted-foreground">
              {t('scriptDock.body.empty')}
            </p>
          ) : sections.map((s) => (
            <section
              key={s.id}
              id={anchor(s.id)}
              aria-labelledby={`${anchor(s.id)}-h`}
              className={cn('scroll-mt-14 rounded-lg border border-border/40 bg-muted/20', compact ? 'p-2.5' : 'p-3')}
              data-section={s.id}
            >
              <h4 id={`${anchor(s.id)}-h`} className="mb-1 flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', KEY_DOT[s.key as SectionKey])} aria-hidden />
                <span className="min-w-0 break-words">{headingOf(s.key as SectionKey, s.title)}</span>
                {fallback.has(s.id) && (
                  <span
                    className="ml-auto shrink-0 rounded border border-border/60 bg-background px-1 text-[9px] font-semibold normal-case tracking-normal text-muted-foreground"
                    title={t('scriptDock.body.fallbackHint')}
                    aria-label={t('scriptDock.body.fallbackHint')}
                    data-testid="fallback-mk"
                  >
                    {t('scriptDock.body.fallbackBadge')}
                  </span>
                )}
              </h4>
              <p className={cn('whitespace-pre-wrap break-words text-foreground/90', textCls)}>
                <ScriptText text={s.text} vars={vars} lang={r.lang} />
              </p>
            </section>
          ))}
        </div>

        {helpers.length > 0 && (
          <section
            id={anchor(QUICK)}
            className={cn('scroll-mt-14 mt-3', !compact && 'xl:sticky xl:top-12 xl:mt-0')}
            aria-label={t('scriptDock.quick.title')}
          >
            <QuickAnswers helpers={helpers} vars={vars} lang={r.lang} />
          </section>
        )}
      </div>
    </div>
  );
}
