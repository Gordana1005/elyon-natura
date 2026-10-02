import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FileText, Loader2, Package, PenLine, Star, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FlagIcon } from '@/components/LanguageSwitcher';
import { ScriptBody } from '@/components/callscripts/ScriptBody';
import { listLabel } from '@/components/insights/lists/listModel';
import { CALL_SCRIPTS_QUERY_KEYS } from '@/lib/callScriptsApi';
import {
  resolveTargetedScript, type MatchedTargetedScript, type TargetedScript,
} from '@/lib/callScriptsTypes';
import { persistScriptLang, SCRIPT_LANGS, storedScriptLang, type ScriptLang } from '@/lib/callScripts';
import { formatSkopje } from '@/lib/skopjeTime';
import { cn } from '@/lib/utils';
import { ScriptSearch } from './ScriptSearch';
import { WhyPopover } from './WhyPopover';
import { useCallScriptsForCall, useCallScriptsMode, usePickedScript, type CallScriptCtx } from './useCallScripts';
import { groupDot, readDockOpen, scriptCallKey, writeDockOpen, writeScriptHref } from './scriptDockModel';

const PICKED = '__picked__';

const chip = 'inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-muted/30 px-2.5 text-xs';

export function PreviewBadge() {
  const { t } = useTranslation();
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
      title={t('scriptDock.previewHint')}
      data-testid="preview-badge"
    >
      {t('scriptDock.preview')}
    </span>
  );
}

function LangFlags({ lang, onChange }: { lang: ScriptLang; onChange: (l: ScriptLang) => void }) {
  const { t } = useTranslation();
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border/60 bg-muted/30 p-0.5" role="group">
      {SCRIPT_LANGS.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => onChange(l)}
          aria-pressed={l === lang}
          title={t('scriptDock.lang', { lang: t(`languages.${l}`) })}
          aria-label={t('scriptDock.lang', { lang: t(`languages.${l}`) })}
          className={cn(
            'inline-flex h-7 items-center rounded px-1.5 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            l === lang ? 'bg-background opacity-100 shadow-sm ring-1 ring-primary/30' : 'opacity-45 hover:opacity-80',
          )}
          data-lang={l}
        >
          <FlagIcon lang={l} className="h-2.5 w-5" />
        </button>
      ))}
    </div>
  );
}

export interface ScriptDockPanelProps {
  phone: string;
  context: CallScriptCtx;
  /** dock = the desktop card (collapsible, 60vh own scroll) · sheet = the phone's bottom sheet. */
  variant: 'dock' | 'sheet';
  open?: boolean;
  onToggle?: () => void;
}

/**
 * The script for the client on screen: header (title, mk/sq, search, "Преглед"), the call's
 * group + product chips, "Зошто?", the version, the alternatives as tabs and the ScriptBody.
 * Shared by the desktop dock and the phone sheet — one query (useCallScriptsForCall) feeds both.
 */
export function ScriptDockPanel({ phone, context, variant, open = true, onToggle }: ScriptDockPanelProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const bodyId = useId();
  const mode = useCallScriptsMode();
  const q = useCallScriptsForCall(phone, context, mode.data?.enabled_for_me === true);
  const [lang, setLangState] = useState<ScriptLang>(storedScriptLang);
  const setLang = (l: ScriptLang) => { setLangState(l); persistScriptLang(l); };
  const [tab, setTab] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const picked = usePickedScript(pickedId);

  const data = q.data;
  // The switch went off since the mode was read → re-read it, so the card falls back to today's panel.
  useEffect(() => {
    if (data && data.enabled === false) void qc.invalidateQueries({ queryKey: CALL_SCRIPTS_QUERY_KEYS.mode() });
  }, [data, qc]);

  const candidates = useMemo<MatchedTargetedScript[]>(
    () => (data?.enabled ? [data.best, ...data.alternatives].filter((s): s is MatchedTargetedScript => !!s) : []),
    [data],
  );
  const onPicked = tab === PICKED && !!pickedId;
  const pickedScript: TargetedScript | null = onPicked ? picked.data ?? null : null;
  const matched = onPicked ? null : candidates.find((c) => c.id === tab) ?? candidates[0] ?? null;
  const active: TargetedScript | null = pickedScript ?? matched;
  const resolved = useMemo(() => (active ? resolveTargetedScript(active, lang) : null), [active, lang]);

  const ctx = data?.context ?? null;
  const preview = (data?.mode ?? mode.data?.mode) === 'preview';
  const canWrite = mode.data?.can_write === true;
  const groupLabel = ctx?.group ? t(`callScripts.groups.${ctx.group}`) : null;
  const productName = ctx?.product?.name ?? null;

  const pick = (id: string) => {
    if (candidates.some((c) => c.id === id)) { setPickedId(null); setTab(id); return; }
    setPickedId(id);
    setTab(PICKED);
  };
  const closePicked = () => { setPickedId(null); setTab(null); };

  const tabs = [
    ...candidates.map((c, i) => ({ id: c.id, title: resolveTargetedScript(c, lang).title, best: i === 0 })),
    ...(pickedId ? [{ id: PICKED, title: picked.data ? resolveTargetedScript(picked.data, lang).title : t('scriptDock.picked'), best: false }] : []),
  ];
  const activeTab = onPicked ? PICKED : matched?.id ?? null;
  const isDock = variant === 'dock';

  const titleNode = resolved?.title
    ? <span className="min-w-0 truncate text-sm font-semibold" data-testid="script-dock-title">{resolved.title}</span>
    : null;

  const controls = (
    <div className="flex shrink-0 items-center gap-1.5">
      {preview && <PreviewBadge />}
      <LangFlags lang={lang} onChange={setLang} />
      <ScriptSearch onPick={pick} />
    </div>
  );

  return (
    <div className={cn('min-w-0', !isDock && 'flex min-h-0 flex-1 flex-col')} data-testid={`script-dock-panel-${variant}`}>
      {/* Header */}
      <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1.5', isDock ? 'p-3' : 'px-4 pb-2 pt-1')}>
        {isDock ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={bodyId}
            title={open ? t('scriptDock.collapse') : t('scriptDock.expand')}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="script-dock-toggle"
          >
            {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
            <FileText className="h-4 w-4 shrink-0 text-violet-500" />
            <span className="shrink-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('scriptDock.title')}</span>
            {titleNode}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">{titleNode}</div>
        )}
        {(open || !isDock) && controls}
      </div>

      {(open || !isDock) && (
        <>
          {/* The call: group (+ the list it came from), product, why, version */}
          {ctx && (
            <div className={cn('flex flex-wrap items-center gap-1.5', isDock ? 'px-3 pb-2' : 'px-4 pb-2')} data-testid="script-dock-meta">
              <span className={chip} title={t('scriptDock.groupTitle')} data-testid="group-chip">
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', groupDot(ctx.group))} aria-hidden />
                <span className="truncate font-medium">{groupLabel ?? t('scriptDock.noGroup')}</span>
              </span>
              {/* The phone sheet keeps the header short — the list is in "Зошто?" there. */}
              {ctx.list_name && isDock && (
                <span className={cn(chip, 'bg-transparent text-muted-foreground')} title={ctx.list_name} data-testid="list-chip">
                  <span className="truncate">{listLabel(t, ctx.list_name)}</span>
                </span>
              )}
              {productName && (
                <span className={chip} title={t('scriptDock.productTitle')} data-testid="product-chip">
                  <Package className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{productName}</span>
                </span>
              )}
              {active && (
                <WhyPopover match={matched?.match ?? null} context={ctx} draftsIncluded={data?.drafts_included} picked={onPicked} />
              )}
              {active && (
                <span className="text-[11px] tabular-nums text-muted-foreground sm:ml-auto" data-testid="script-version">
                  {t('scriptDock.updated', { date: formatSkopje(active.published_at ?? active.updated_at, 'dd.MM.yyyy'), version: active.version })}
                </span>
              )}
            </div>
          )}

          {/* Alternatives (and a script picked by hand) as tabs */}
          {tabs.length > 1 && (
            <div
              role="tablist"
              aria-label={t('scriptDock.tabsLabel')}
              className={cn('flex gap-1 overflow-x-auto border-b border-border/60 [scrollbar-width:thin]', isDock ? 'px-3' : 'px-4')}
              data-testid="script-tabs"
            >
              {tabs.map((tb) => {
                const sel = tb.id === activeTab;
                return (
                  <div key={tb.id} className={cn('-mb-px flex shrink-0 items-center border-b-2', sel ? 'border-primary' : 'border-transparent')}>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={sel}
                      aria-controls={bodyId}
                      onClick={() => setTab(tb.id)}
                      className={cn(
                        'inline-flex min-h-9 max-w-[15rem] items-center gap-1 px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        sel ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {tb.best && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-500" aria-label={t('scriptDock.recommended')} />}
                      {tb.id === PICKED && <span className="shrink-0 text-[10px] uppercase text-violet-600 dark:text-violet-300">{t('scriptDock.picked')}</span>}
                      <span className="truncate">{tb.title}</span>
                    </button>
                    {tb.id === PICKED && (
                      <button
                        type="button"
                        onClick={closePicked}
                        aria-label={t('scriptDock.closePicked')}
                        title={t('scriptDock.closePicked')}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* The script */}
          <div
            id={bodyId}
            role={tabs.length > 1 ? 'tabpanel' : undefined}
            className={cn(isDock ? 'max-h-[60vh] overflow-y-auto overscroll-contain px-3 pb-3 pt-2' : 'min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 pt-2')}
            data-testid="script-dock-body"
          >
            {q.isPending || (onPicked && picked.isPending) ? (
              <div className="space-y-2 py-2" aria-busy="true" aria-label={t('scriptDock.loading')}>
                <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
                <div className="h-16 animate-pulse rounded-lg bg-muted/70" />
                <div className="h-16 animate-pulse rounded-lg bg-muted/50" />
              </div>
            ) : q.isError || (onPicked && picked.isError) ? (
              <div className="flex flex-wrap items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                <span>{onPicked ? t('scriptDock.search.loadFailed') : t('scriptDock.error')}</span>
                <Button size="sm" variant="outline" className="h-7" onClick={() => { void (onPicked ? picked.refetch() : q.refetch()); }}>
                  {q.isFetching || picked.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('scriptDock.retry')}
                </Button>
              </div>
            ) : active ? (
              <ScriptBody key={active.id} script={active} vars={data?.vars ?? null} lang={lang} compact={!isDock} />
            ) : (
              <div className="rounded-lg border border-dashed border-border/70 px-4 py-6 text-center" data-testid="script-dock-empty">
                <p className="text-sm font-medium">
                  {groupLabel || productName
                    ? t('scriptDock.empty', { what: [groupLabel, productName].filter(Boolean).join(' · ') })
                    : t('scriptDock.emptyGeneric')}
                </p>
                <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">{t('scriptDock.emptyHint')}</p>
                {canWrite && (
                  <Button asChild size="sm" variant="outline" className="mt-3 gap-1.5">
                    <Link to={writeScriptHref(ctx)} data-testid="write-script">
                      <PenLine className="h-3.5 w-3.5" /> {t('scriptDock.write')}
                    </Link>
                  </Button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * md and up: the script card right under the outcome bar on /calls — open by default, the
 * choice remembered on the device, 60vh with its own scroll so the history stays reachable.
 */
export function ScriptDock({ phone, context, className }: { phone: string; context: CallScriptCtx; className?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(readDockOpen);
  const toggle = () => { const next = !open; writeDockOpen(next); setOpen(next); };
  return (
    <section
      className={cn('rounded-xl border border-border/60 bg-card shadow-sm', className)}
      aria-label={t('scriptDock.title')}
      data-testid="script-dock"
    >
      <ScriptDockPanel key={scriptCallKey(phone, context)} phone={phone} context={context} variant="dock" open={open} onToggle={toggle} />
    </section>
  );
}
