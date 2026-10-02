import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Clock, Copy, Info, Loader2, Package, Pencil, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { SUPPORTED_LANGUAGES, type AppLanguage } from '@/i18n';
import { BASE_SCRIPT_LANG, translatedLanguages } from '@/lib/callScripts';
import { FlagIcon } from '@/components/LanguageSwitcher';
import { formatSkopje } from '@/lib/skopjeTime';
import {
  apiDeleteProductScript, apiGetAllCallScripts, apiUpdateProductScript,
  type CallScript, type CallScriptHelper, type CallScriptTranslation,
} from '@/lib/api';
import { CALL_SCRIPTS_QUERY_KEYS } from '@/lib/callScriptsApi';
import type { TargetedScript } from '@/lib/callScriptsTypes';
import { LangTabs } from '../LangTabs';
import { editorHref } from '../scriptsModel';
import { TemplateVariablesCard, cleanTranslations } from './legacyShared';

type ProductScriptInput = {
  title: string;
  description: string;
  script_text: string;
  helpers: CallScriptHelper[];
  translations: Record<string, CallScriptTranslation>;
};

/** Shared with today's /calls panel (CallScriptsPanel) — one cache, so an edit here shows there. */
const LEGACY_KEY = ['product-scripts'];

// ─── Product Script Form (today's editor for the 11 legacy rows) ──────────────

function ScriptForm({ initial, onSave, onCancel }: { initial: CallScript; onSave: (d: ProductScriptInput) => Promise<void>; onCancel: () => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(initial.title || '');
  const [description, setDescription] = useState(initial.description || '');
  const [scriptText, setScriptText] = useState(initial.script_text || '');
  const [helpers, setHelpers] = useState<CallScriptHelper[]>((initial.helpers as CallScriptHelper[]) || []);
  const [translations, setTranslations] = useState<Record<string, CallScriptTranslation>>((initial.translations as Record<string, CallScriptTranslation>) || {});
  const [activeLang, setActiveLang] = useState<AppLanguage>(BASE_SCRIPT_LANG);
  const [saving, setSaving] = useState(false);

  const isBase = activeLang === BASE_SCRIPT_LANG;
  const tr = translations[activeLang] || {};
  const curTitle = isBase ? title : (tr.title ?? '');
  const curDescription = isBase ? description : (tr.description ?? '');
  const curScript = isBase ? scriptText : (tr.script_text ?? '');
  const curHelpers = isBase ? helpers : (tr.helpers ?? []);
  const patchTr = (patch: Partial<CallScriptTranslation>) =>
    setTranslations((prev) => ({ ...prev, [activeLang]: { ...(prev[activeLang] || {}), ...patch } }));
  const setCurTitle = (v: string) => (isBase ? setTitle(v) : patchTr({ title: v }));
  const setCurDescription = (v: string) => (isBase ? setDescription(v) : patchTr({ description: v }));
  const setCurScript = (v: string) => (isBase ? setScriptText(v) : patchTr({ script_text: v }));
  const setCurHelpers = (next: CallScriptHelper[]) => (isBase ? setHelpers(next) : patchTr({ helpers: next }));
  const addHelper = () => setCurHelpers([...curHelpers, { title: '', content: '', category: null }]);
  const updateHelper = (idx: number, patch: Partial<CallScriptHelper>) => setCurHelpers(curHelpers.map((h, i) => (i === idx ? { ...h, ...patch } : h)));
  const removeHelper = (idx: number) => setCurHelpers(curHelpers.filter((_, i) => i !== idx));

  // Seed the active language's EMPTY fields from the Macedonian base (helpers: same rows, same categories).
  const copyBaseToActive = () => {
    if (isBase) return;
    setTranslations((prev) => {
      const existing = prev[activeLang] || {};
      const seededHelpers = existing.helpers && existing.helpers.length ? existing.helpers : helpers.map((h) => ({ title: h.title, content: h.content, category: h.category ?? null }));
      return {
        ...prev,
        [activeLang]: {
          title: existing.title?.trim() ? existing.title : title,
          description: existing.description?.trim() ? existing.description : description,
          script_text: existing.script_text?.trim() ? existing.script_text : scriptText,
          helpers: seededHelpers,
        },
      };
    });
  };

  const handleSave = async () => {
    if (!title.trim()) return; // the Macedonian base title is the script's identity
    setSaving(true);
    try {
      await onSave({ title: title.trim(), description: description.trim(), script_text: scriptText, helpers, translations: cleanTranslations(translations) });
    } finally {
      setSaving(false);
    }
  };

  const present = Object.keys(translations).filter((l) => {
    const v = translations[l];
    return !!v && ((v.title || '').trim() || (v.description || '').trim() || (v.script_text || '').trim() || (v.helpers || []).length > 0);
  });

  return (
    <div className="space-y-4 rounded-xl border border-primary/30 bg-primary/5 p-3 sm:p-4" data-testid="legacy-form">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <LangTabs value={activeLang} onChange={setActiveLang} present={present} />
        {!isBase && (
          <Button type="button" variant="outline" size="sm" onClick={copyBaseToActive} className="h-9 gap-1 text-xs">
            <Copy className="h-3.5 w-3.5" /> {t('callScripts.copyBase')}
          </Button>
        )}
      </div>
      {!isBase && <p className="text-[11px] text-muted-foreground">{t('callScripts.translatingHint', { lang: t('languages.' + activeLang) })}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="legacy-title" className="text-xs font-semibold">
            {t('callScripts.scriptTitle')} {isBase ? <span className="text-destructive">*</span> : <span className="font-normal text-muted-foreground">{t('callScripts.optionalSuffix')}</span>}
          </Label>
          <Input id="legacy-title" value={curTitle} onChange={(e) => setCurTitle(e.target.value)}
            placeholder={isBase ? t('callScripts.titlePlaceholder') : (title || t('callScripts.titlePlaceholder'))} className="h-9 text-base md:text-sm" />
        </div>
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="legacy-desc" className="text-xs font-semibold">
            {t('callScripts.description')} <span className="font-normal text-muted-foreground">{t('callScripts.optionalSuffix')}</span>
          </Label>
          <Input id="legacy-desc" value={curDescription} onChange={(e) => setCurDescription(e.target.value)}
            placeholder={isBase ? t('callScripts.descPlaceholder') : (description || t('callScripts.descPlaceholder'))} className="h-9 text-base md:text-sm" />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="legacy-body" className="text-xs font-semibold">{t('callScripts.scriptContent')}</Label>
        <Textarea id="legacy-body" value={curScript} onChange={(e) => setCurScript(e.target.value)} className="min-h-[260px] font-mono text-base leading-relaxed md:text-sm"
          placeholder={t('callScripts.contentPlaceholder')} />
        {!isBase && scriptText && (
          <details className="text-[11px] text-muted-foreground">
            <summary className="cursor-pointer select-none">{t('callScripts.showBaseReference')}</summary>
            <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/40 bg-muted/30 p-2 leading-relaxed">{scriptText}</div>
          </details>
        )}
      </div>

      <div className="space-y-2 border-t border-primary/20 pt-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-xs font-semibold">{t('callScripts.helpersLabel')}</Label>
          <Button type="button" variant="outline" size="sm" onClick={addHelper} className="h-9 gap-1 text-xs">
            {t('callScripts.addHelper')}
          </Button>
        </div>
        {curHelpers.length === 0 && <p className="text-[11px] text-muted-foreground/70">{t('callScripts.noHelpersYet')}</p>}
        <div className="space-y-2">
          {curHelpers.map((h, idx) => {
            const ref = !isBase ? helpers[idx] : undefined;
            return (
              <div key={idx} className="space-y-1.5 rounded-lg border border-border/40 bg-background/60 p-2.5">
                <div className="grid grid-cols-1 items-end gap-1.5 sm:grid-cols-[1fr_120px_auto]">
                  <div className="min-w-0">
                    <Label className="text-[10px] text-muted-foreground">{t('callScripts.helperTitle')}</Label>
                    <Input value={h.title} onChange={(e) => updateHelper(idx, { title: e.target.value })} placeholder={ref?.title || t('callScripts.helperTitlePlaceholder')} className="h-9 text-base md:text-sm" />
                  </div>
                  <div className="min-w-0">
                    <Label className="text-[10px] text-muted-foreground">{t('callScripts.helperCategory')}</Label>
                    <Input value={h.category || ''} onChange={(e) => updateHelper(idx, { category: e.target.value || null })} placeholder={t('callScripts.helperCategoryPlaceholder')} className="h-9 text-base md:text-sm" />
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={() => removeHelper(idx)} className="h-9 w-9 self-end p-0 text-muted-foreground hover:text-destructive"
                    aria-label={t('callScripts.editor.helperRemove', { n: idx + 1 })}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div>
                  <Label className="text-[10px] text-muted-foreground">{t('callScripts.helperContent')}</Label>
                  <Textarea value={h.content} onChange={(e) => updateHelper(idx, { content: e.target.value })} placeholder={ref?.content || t('callScripts.helperContentPlaceholder')} className="min-h-[72px] text-base leading-relaxed md:text-sm" />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={handleSave} disabled={saving || !title.trim()} className="gap-2" data-testid="legacy-save">
          <Save className="h-4 w-4" />{saving ? t('callScripts.savingDots') : t('callScripts.saveChanges')}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={saving}>{t('common.cancel')}</Button>
      </div>
    </div>
  );
}

// ─── Product Script Card ──────────────────────────────────────────────────────

function ProductScriptCard({ script, canEdit, canDelete, copies, onEdit, onDelete }: {
  script: CallScript;
  canEdit: boolean;
  canDelete: boolean;
  /** The targeted drafts copied from this row (the migration made one each). */
  copies: TargetedScript[];
  onEdit: (s: CallScript) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const preview = script.script_text?.slice(0, 120).replace(/\n/g, ' ');
  const transLangs = translatedLanguages(script).filter((l): l is AppLanguage => (SUPPORTED_LANGUAGES as string[]).includes(l));
  const helpers = (script.helpers as CallScriptHelper[] | null) ?? [];

  return (
    <Card className="overflow-hidden transition-shadow hover:shadow-md" data-testid={`legacy-card-${script.id}`}>
      <div className="flex items-start justify-between gap-3 p-3 sm:p-4">
        <button type="button" className="flex min-w-0 flex-1 items-start gap-3 text-left" onClick={() => setExpanded((p) => !p)} aria-expanded={expanded}>
          <span className="mt-0.5 shrink-0">
            {expanded ? <ChevronDown className="h-4 w-4 text-primary" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          </span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <span className="break-words text-sm font-semibold leading-tight">{script.title}</span>
              {transLangs.length > 0 && (
                <span className="flex items-center gap-1" title={t('callScripts.hasTranslation')}>
                  {transLangs.map((l) => <FlagIcon key={l} lang={l} className="h-2.5 w-5 opacity-80" />)}
                </span>
              )}
            </span>
            {script.description && <span className="mt-0.5 block break-words text-xs text-muted-foreground">{script.description}</span>}
            {!expanded && preview && <span className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground/60">{preview}…</span>}
          </span>
        </button>
        {(canEdit || canDelete) && (
          <div className="flex shrink-0 items-center gap-1">
            {canEdit && (
              <Button variant="ghost" size="sm" className="h-9 w-9 p-0 text-muted-foreground hover:text-foreground" onClick={() => onEdit(script)}
                aria-label={t('callScripts.legacy.edit', { title: script.title })}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
            {canDelete && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-9 w-9 p-0 text-muted-foreground hover:text-destructive" aria-label={t('callScripts.deleteScript')}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('callScripts.deleteScript')}</AlertDialogTitle>
                    <AlertDialogDescription>{t('callScripts.deleteScriptDesc', { title: script.title })}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => onDelete(script.id)}>
                      {t('common.delete')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        )}
      </div>

      {expanded && (
        <div className="space-y-2 border-t px-3 pb-4 pt-3 sm:px-4">
          <div className="whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 font-mono text-sm leading-[1.8] sm:p-4">
            {script.script_text || <span className="italic text-muted-foreground">{t('callScripts.noContentYet')}</span>}
          </div>
          {helpers.length > 0 && (
            <p className="px-1 text-[11px] text-muted-foreground/80">
              {t('callScripts.legacy.helpersSummary', { n: helpers.length, titles: helpers.slice(0, 3).map((h) => h.title).join(' · ') })}
              {helpers.length > 3 && ' …'}
            </p>
          )}
          {copies.length > 0 && (
            <p className="flex flex-wrap items-center gap-x-2 px-1 text-[11px]">
              <span className="text-muted-foreground">{t('callScripts.legacy.copies')}</span>
              {copies.map((c) => <Link key={c.id} to={editorHref({ id: c.id, from: 'current' })} className="text-primary hover:underline">{c.title}</Link>)}
            </p>
          )}
          {script.updated_at && (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground/60">
              <Clock className="h-3 w-3" />{t('callScripts.lastUpdated', { date: formatSkopje(script.updated_at, 'dd.MM.yyyy HH:mm') })}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

// ─── The tab ──────────────────────────────────────────────────────────────────

/**
 * Тековен панел — the 11 product scripts agents read on /calls TODAY (while the switch is off, and
 * until they are archived). Editable as before (the api routes them through the writer's legacy
 * branch, versioned and audited); new scripts are written in the Library, not here.
 */
export function CurrentPanelTab({ canEdit, canDelete, library }: { canEdit: boolean; canDelete: boolean; library: readonly TargetedScript[] }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<CallScript | null>(null);
  const q = useQuery({
    queryKey: LEGACY_KEY,
    queryFn: apiGetAllCallScripts,
    staleTime: 60_000,
    select: (all: CallScript[]) => all.filter((s) => s.context_type === 'product'),
  });
  const scripts = q.data ?? [];
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: LEGACY_KEY }), qc.invalidateQueries({ queryKey: CALL_SCRIPTS_QUERY_KEYS.all })]);

  const handleUpdate = async (data: ProductScriptInput) => {
    if (!editing) return;
    try {
      await apiUpdateProductScript(editing.id, data);
      await refresh();
      setEditing(null);
      toast({ title: t('callScripts.scriptUpdated') });
    } catch (err) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    }
  };
  const handleDelete = async (id: string) => {
    try {
      await apiDeleteProductScript(id);
      await refresh();
      toast({ title: t('callScripts.scriptDeleted') });
    } catch (err) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-3" data-testid="cs-current">
      <div className="min-w-0 space-y-3 lg:col-span-2">
        <div className="flex items-start gap-2 rounded-xl border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200" role="note" data-testid="current-banner">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="min-w-0 space-y-1">
            <p className="font-medium">{t('callScripts.legacy.bannerTitle')}</p>
            <p className="text-xs">{t('callScripts.legacy.bannerText')}</p>
          </div>
        </div>
        <div>
          <h3 className="font-semibold">{t('callScripts.productScriptsHelpers')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('callScripts.productScriptsDesc')}</p>
        </div>
        {q.isLoading ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>
        ) : scripts.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Package className="mb-3 h-10 w-10 text-muted-foreground/30" />
              <p className="text-sm font-medium text-muted-foreground">{t('callScripts.noProductScripts')}</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {scripts.map((s) => (editing?.id === s.id
              ? <ScriptForm key={s.id} initial={s} onSave={handleUpdate} onCancel={() => setEditing(null)} />
              : <ProductScriptCard key={s.id} script={s} canEdit={canEdit} canDelete={canDelete}
                  copies={library.filter((x) => x.copied_from === s.id)} onEdit={setEditing} onDelete={handleDelete} />))}
          </div>
        )}
      </div>
      <div className="min-w-0"><TemplateVariablesCard /></div>
    </div>
  );
}
