import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Copy, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import type { AppLanguage } from '@/i18n';
import { CallScriptsError } from '@/lib/callScriptsApi';
import { lintScript, type ScriptStatus, type TargetedScript } from '@/lib/callScriptsTypes';
import { LangTabs } from '../LangTabs';
import {
  draftScript, editorDirty, editorHref, editorStateFrom, editorStateToPatch, lintSectionId, parseGroupsParam,
  parseProductsParam, publishBlockers, twinsOf, withTwins, type EditorState, type ScriptsTab,
} from '../scriptsModel';
import { StatusBadge, card, useScriptLabels } from '../parts';
import {
  useProductIndex, useScriptItem, useScriptsCoverage, useScriptsLibrary, useScriptsWrites, type ScriptsPerms,
} from '../useCallScriptsAdmin';
import { scriptsErrorText } from '../errors';
import { TargetingCard } from './TargetingCard';
import { SectionsEditor } from './SectionsEditor';
import { HelpersEditor } from './HelpersEditor';
import { VariableMenu, useCursorInsert } from './VariableMenu';
import { ScriptPreview } from './ScriptPreview';
import { WhereItWins } from './WhereItWins';
import { LintList } from './LintList';
import { EditorStatusBar, type EditorAction } from './EditorStatusBar';
import { DuplicateDialog } from './DuplicateDialog';
import { HistoryDrawer } from './HistoryDrawer';

const STATUS_OF: Partial<Record<EditorAction, ScriptStatus>> = {
  publish: 'published', unpublish: 'draft', archive: 'archived', to_draft: 'draft',
};

/**
 * The script editor (?script=<id>, or ?new=1&group=…&product=… from a coverage cell): two columns
 * from lg (the writing on the left, the live preview / lint / "where it wins" on the right),
 * stacked below. Every save sends the version it was based on — a 409 `stale` means someone else
 * saved first, and the writer reloads before saving again (nothing is silently overwritten).
 */
export function ScriptEditor({ id, perms, from }: { id: string | null; perms: ScriptsPerms; from: ScriptsTab }) {
  const L = useScriptLabels();
  const { t } = L;
  const { toast } = useToast();
  const navigate = useNavigate();
  const [sp] = useSearchParams();
  const writes = useScriptsWrites();
  const lib = useScriptsLibrary();
  const coverageQ = useScriptsCoverage({ families: true, assignedOnly: false });
  const coverage = coverageQ.error ? null : coverageQ.data;
  const item = useScriptItem(id);
  const idx = useProductIndex(lib.data);
  const twins = useMemo(() => twinsOf(idx.products), [idx.products]);
  const isNew = !id;
  const script = item.data ?? null;

  const prefill = useMemo(() => {
    if (!isNew) return null;
    const groups = parseGroupsParam(sp.get('group'));
    const products = parseProductsParam(sp.get('product'));
    return { groups, products };
  }, [isNew, sp]);

  const initial = useCallback((): EditorState => {
    if (script) return editorStateFrom(script);
    const s = editorStateFrom(null, { groups: prefill?.groups ?? [], product_ids: withTwins(prefill?.products ?? [], twins) });
    const bits = [...(prefill?.groups ?? []).map(L.group), ...(prefill?.products ?? []).slice(0, 1).map((p) => idx.name(p) ?? '')].filter(Boolean);
    if (bits.length) s.title = bits.join(' — ');
    return s;
  }, [script, prefill, twins, idx, L]);

  const [state, setState] = useState<EditorState>(() => initial());
  const [baseline, setBaseline] = useState<EditorState>(() => initial());
  const loadedKey = useRef<string | null>(null);
  const [lang, setLang] = useState<'mk' | 'sq'>('mk');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<EditorAction | null>(null);
  const [stale, setStale] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const { bind, insert } = useCursorInsert();
  const dirty = editorDirty(state, baseline);

  // (Re)load the form when the script (or its version) arrives — never over unsaved edits.
  const key = isNew ? `new:${sp.get('group') ?? ''}:${sp.get('product') ?? ''}:${idx.products.length > 0}` : script ? `${script.id}@${script.version}` : null;
  useEffect(() => {
    if (!key || key === loadedKey.current) return;
    if (loadedKey.current && dirty) return;
    const s = initial();
    setState(s);
    setBaseline(s);
    loadedKey.current = key;
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!dirty) return;
    const onBefore = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, [dirty]);

  const status: ScriptStatus = script?.status ?? 'draft';
  const draft = useMemo(() => draftScript(state, script ?? { status: 'draft' }), [state, script]);
  const issues = useMemo(() => lintScript(draft), [draft]);
  const warnBySection = useMemo(() => {
    const out: Record<string, number> = {};
    for (const i of issues) if (i.severity === 'warn') { const sid = lintSectionId(i.field); if (sid) out[sid] = (out[sid] ?? 0) + 1; }
    return out;
  }, [issues]);
  const blockers = publishBlockers(state);
  const backHref = from === 'library' ? '/call-scripts' : `/call-scripts?tab=${from}`;
  const readOnly = !perms.canWrite;

  const set = <K extends keyof EditorState>(k: K, v: EditorState[K]) => setState((s) => ({ ...s, [k]: v }));
  const sqPresent = Object.values(state.sq.sections).some((x) => x.text.trim()) || !!state.sq.title.trim() ? ['sq'] : [];

  const reload = async () => {
    setStale(null);
    const r = await item.refetch();
    if (r.data) {
      const s = editorStateFrom(r.data);
      setState(s);
      setBaseline(s);
      loadedKey.current = `${r.data.id}@${r.data.version}`;
    }
  };

  const run = async (a: EditorAction) => {
    if (a === 'delete') { setConfirmDelete(true); return; }
    const patch = { ...editorStateToPatch(state) };
    const nextStatus = STATUS_OF[a];
    if (nextStatus) patch.status = nextStatus;
    setBusy(a);
    try {
      if (isNew) {
        const r = await writes.create.mutateAsync({ patch: { ...patch, status: patch.status ?? 'draft' }, note: note.trim() || undefined });
        const s = editorStateFrom(r.script);
        setState(s);
        setBaseline(s);
        loadedKey.current = `${r.script.id}@${r.script.version}`;
        toast({ title: t(a === 'publish' ? 'callScripts.editor.publishedOk' : 'callScripts.editor.createdOk') });
        navigate(editorHref({ id: r.script.id, from }), { replace: true });
      } else if (script) {
        const r = await writes.save.mutateAsync({ id: script.id, expected_version: script.version, patch, note: note.trim() || undefined });
        const s = editorStateFrom(r.script);
        setState(s);
        setBaseline(s);
        loadedKey.current = `${r.script.id}@${r.script.version}`;
        toast({ title: t(`callScripts.editor.ok_${a}`) });
      }
      setNote('');
    } catch (e) {
      if (e instanceof CallScriptsError && e.isStale) setStale(e.currentVersion ?? (script?.version ?? 0) + 1);
      else toast({ title: t('common.error'), description: scriptsErrorText(e, t), variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!script) return;
    setBusy('delete');
    try {
      await writes.remove.mutateAsync({ id: script.id, note: note.trim() || undefined });
      toast({ title: t('callScripts.editor.deletedOk') });
      setConfirmDelete(false);
      setBaseline(state);
      navigate(backHref, { replace: true });
    } catch (e) {
      toast({ title: t('common.error'), description: scriptsErrorText(e, t), variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  const jump = (l: 'mk' | 'sq', sectionId: string | null) => {
    setLang(l);
    if (sectionId) setTimeout(() => document.getElementById(`cs-sec-${sectionId}`)?.focus(), 50);
  };

  if (!isNew && item.isLoading && !script) {
    return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" aria-label={t('common.loading')} /></div>;
  }
  if (!isNew && !script) {
    return (
      <div className="space-y-3">
        <Link to={backHref} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" aria-hidden />{t('callScripts.editor.back')}</Link>
        <EmptyState title={t('callScripts.errors.notFound')} description={item.error ? scriptsErrorText(item.error, t) : undefined} />
      </div>
    );
  }
  if (script && script.context_type !== 'targeted') {
    return (
      <div className="space-y-3">
        <Link to={backHref} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" aria-hidden />{t('callScripts.editor.back')}</Link>
        <EmptyState title={t('callScripts.editor.legacyTitle')} description={t('callScripts.editor.legacyDesc')}
          action={<Button asChild size="sm"><Link to={script.context_type === 'product' ? '/call-scripts?tab=current' : '/call-scripts?tab=order'}>{t('callScripts.editor.legacyOpen')}</Link></Button>} />
      </div>
    );
  }

  const titleValue = lang === 'mk' ? state.title : state.sq.title;
  const descValue = lang === 'mk' ? state.description : state.sq.description;

  return (
    <div className="space-y-4" data-testid="script-editor">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link to={backHref} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          onClick={(e) => { if (dirty && !window.confirm(t('callScripts.editor.leaveConfirm'))) e.preventDefault(); }}>
          <ArrowLeft className="h-4 w-4" aria-hidden />{t('callScripts.editor.back')}
        </Link>
        <h2 className="min-w-0 flex-1 basis-full break-words text-base font-semibold sm:basis-auto">
          {isNew ? t('callScripts.editor.newTitle') : (state.title || t('callScripts.editor.untitled'))}
        </h2>
        {!isNew && script && (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <StatusBadge script={script} />
            <span>v{script.version}</span>
            <span>{L.date(script.updated_at)}{script.updated_by_name ? ` · ${script.updated_by_name}` : ''}</span>
            {script.copied_from && (
              <Link to={editorHref({ id: script.copied_from })} className="inline-flex items-center gap-1 hover:text-foreground">
                <Copy className="h-3 w-3" aria-hidden />{t('callScripts.editor.copiedFrom')}
              </Link>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <div className="min-w-0 space-y-4">
          <section className={cn(card, 'space-y-3 p-3 sm:p-4')} aria-label={t('callScripts.editor.details')}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <LangTabs value={lang as AppLanguage} onChange={(l) => setLang(l === 'sq' ? 'sq' : 'mk')} present={sqPresent} />
              <VariableMenu onInsert={(v) => insert(`{{${v}}}`)} disabled={readOnly} />
            </div>
            {lang === 'sq' && <p className="text-[11px] text-muted-foreground">{t('callScripts.editor.sqHint')}</p>}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="cs-title" className="text-xs font-semibold">
                  {t('callScripts.scriptTitle')}{lang === 'mk' && <span className="text-destructive"> *</span>}
                </Label>
                <Input id="cs-title" value={titleValue} maxLength={200} disabled={readOnly} data-testid="editor-title"
                  onChange={(e) => (lang === 'mk' ? set('title', e.target.value) : set('sq', { ...state.sq, title: e.target.value }))}
                  placeholder={lang === 'mk' ? t('callScripts.editor.titlePlaceholder') : (state.title || t('callScripts.editor.titlePlaceholder'))}
                  className="h-9 text-base md:text-sm" />
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="cs-desc" className="text-xs font-semibold">
                  {t('callScripts.description')} <span className="font-normal text-muted-foreground">{t('callScripts.optionalSuffix')}</span>
                </Label>
                <Input id="cs-desc" value={descValue} maxLength={500} disabled={readOnly}
                  onChange={(e) => (lang === 'mk' ? set('description', e.target.value) : set('sq', { ...state.sq, description: e.target.value }))}
                  placeholder={lang === 'mk' ? t('callScripts.editor.descPlaceholder') : (state.description || t('callScripts.editor.descPlaceholder'))}
                  className="h-9 text-base md:text-sm" />
              </div>
            </div>
          </section>

          <TargetingCard groups={state.groups} onGroups={(g) => set('groups', g)} productIds={state.product_ids} onProducts={(p) => set('product_ids', p)}
            priority={state.priority} onPriority={(n) => set('priority', n)} products={idx.products} twins={twins} productName={idx.name}
            coverage={coverageQ.isLoading ? undefined : coverage ?? null} title={state.title} disabled={readOnly} />

          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">{t('callScripts.editor.sections')}</h3>
              <p className="text-[11px] text-muted-foreground">{t('callScripts.editor.sectionsHint')}</p>
            </div>
            <SectionsEditor sections={state.sections} onSections={(s) => set('sections', s)} sq={state.sq} onSq={(sq) => set('sq', sq)}
              lang={lang} bind={bind} disabled={readOnly} warnings={warnBySection} />
          </div>

          <HelpersEditor helpers={lang === 'mk' ? state.helpers : state.sq.helpers} mkHelpers={state.helpers} lang={lang} bind={bind} disabled={readOnly}
            onHelpers={(h) => (lang === 'mk' ? set('helpers', h) : set('sq', { ...state.sq, helpers: h }))} />
        </div>

        <aside className="min-w-0 space-y-4" aria-label={t('callScripts.editor.sidebar')}>
          <ScriptPreview script={draft} group={state.groups[0] ?? null} productId={state.product_ids[0] ?? null} defaultLang={lang} />
          <LintList issues={issues} sections={state.sections} onJump={jump} />
          <WhereItWins target={draft} library={lib.data?.scripts ?? []} products={idx.products} coverage={coverage} />
        </aside>
      </div>

      {perms.canWrite && (
        <EditorStatusBar isNew={isNew} status={status} version={script?.version ?? null} dirty={dirty} busy={busy} canDelete={perms.canDelete}
          blockers={blockers} note={note} onNote={setNote} onAction={(a) => void run(a)} onDuplicate={() => setDupOpen(true)} onHistory={() => setHistOpen(true)} />
      )}

      <AlertDialog open={stale !== null} onOpenChange={(o) => { if (!o) setStale(null); }}>
        <AlertDialogContent data-testid="stale-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('callScripts.editor.staleTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('callScripts.editor.staleDesc', { version: stale ?? '' })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('callScripts.editor.staleKeep')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void reload()} data-testid="stale-reload">{t('callScripts.editor.staleReload')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={(o) => { if (busy !== 'delete') setConfirmDelete(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('callScripts.deleteScript')}</AlertDialogTitle>
            <AlertDialogDescription>{t('callScripts.editor.deleteDesc', { title: state.title })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === 'delete'}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void remove(); }} disabled={busy === 'delete'}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="delete-confirm">
              {busy === 'delete' && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />}{t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {script && (
        <>
          <DuplicateDialog open={dupOpen} onOpenChange={setDupOpen} script={script} products={idx.products} twins={twins} productName={idx.name} coverage={coverage} />
          <HistoryDrawer open={histOpen} onOpenChange={setHistOpen} script={script} productName={idx.name}
            onRestored={(r: TargetedScript) => { const s = editorStateFrom(r); setState(s); setBaseline(s); loadedKey.current = `${r.id}@${r.version}`; }} />
        </>
      )}
    </div>
  );
}
