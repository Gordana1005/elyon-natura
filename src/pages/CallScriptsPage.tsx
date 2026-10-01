import { useState, useEffect } from 'react';
import { apiErrorText } from '@/i18n/apiErrors';
import { useTranslation } from 'react-i18next';
import { AppLayout } from '@/layouts/AppLayout';
import { FileText, Save, Loader2, Clock, Plus, Pencil, Trash2, ChevronDown, ChevronRight, Package, Copy, Flame } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import i18n, { SUPPORTED_LANGUAGES, type AppLanguage } from '@/i18n';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { BASE_SCRIPT_LANG, translatedLanguages } from '@/lib/callScripts';
import { FlagIcon } from '@/components/LanguageSwitcher';
import { LangTabs } from '@/components/callscripts/LangTabs';
import { PromoOfTheDayTab } from '@/components/callscripts/PromoOfTheDayTab';
import {
  apiGetCallScript, apiUpdateCallScript,
  apiGetAllCallScripts, apiCreateProductScript, apiUpdateProductScript, apiDeleteProductScript,
  type CallScript, type CallScriptHelper, type CallScriptTranslation,
} from '@/lib/api';
import { formatSkopje } from '@/lib/skopjeTime';

type ProductScriptInput = {
  title: string;
  description: string;
  script_text: string;
  helpers: CallScriptHelper[];
  translations: Record<string, CallScriptTranslation>;
};

// Drop empty fields / blank helper rows / empty language entries before persisting,
// so the translations blob stays clean and resolveScript's per-field fallback works.
function cleanTranslations(translations: Record<string, CallScriptTranslation>): Record<string, CallScriptTranslation> {
  const out: Record<string, CallScriptTranslation> = {};
  for (const [lang, tr] of Object.entries(translations || {})) {
    if (!tr) continue;
    const entry: CallScriptTranslation = {};
    if (tr.title?.trim()) entry.title = tr.title.trim();
    if (tr.description?.trim()) entry.description = tr.description.trim();
    if (tr.script_text?.trim()) entry.script_text = tr.script_text.trim();
    const helpers = (tr.helpers || [])
      .map(h => ({ title: (h.title || '').trim(), content: (h.content || '').trim(), category: h.category?.trim() || null }))
      .filter(h => h.title || h.content);
    if (helpers.length) entry.helpers = helpers;
    if (Object.keys(entry).length) out[lang] = entry;
  }
  return out;
}

// Labels resolved at render via t(labelKey).
const LEGACY_SCRIPT_TYPES = [
  { key: 'prediction_lead', labelKey: 'callScripts.predictionLeadScript' },
  { key: 'order', labelKey: 'callScripts.orderScript' },
];

const DEFAULT_LEAD_SCRIPT = `Hello [Customer Name], this is [Agent Name] from Elyon CRM.

I'm calling to discuss an opportunity that I believe could benefit you.

[Introduce Product/Service]

Would you be interested in learning more about [Product]?

[If interested] Great! Let me share some details with you...
[If not interested] I understand, thank you for your time.

Thank you for your time, [Customer Name]. Have a great day!`;

const DEFAULT_ORDER_SCRIPT = `Hello [Customer Name], this is [Agent Name] from Elyon CRM.

I'm calling regarding your order [Order ID].

[Verify order details with customer]

Your order includes [Product] and the total is [Price].

Can you please confirm your delivery address?
Address: [Address]
City: [City]

[If confirmed] Excellent! Your order will be processed shortly.
[If changes needed] Let me update that for you.

Thank you, [Customer Name]. Have a great day!`;

const TEMPLATE_VARIABLES = [
  { var: '[Customer Name]', descKey: 'callScripts.varCustomerName' },
  { var: '[Product]', descKey: 'callScripts.varProduct' },
  { var: '[Order ID]', descKey: 'callScripts.varOrderId' },
  { var: '[Agent Name]', descKey: 'callScripts.varAgentName' },
  { var: '[Price]', descKey: 'callScripts.varPrice' },
  { var: '[Address]', descKey: 'callScripts.varAddress' },
  { var: '[City]', descKey: 'callScripts.varCity' },
];

// ─── Legacy Script Tab ───────────────────────────────────────────────────────

function LegacyScriptTab({ scriptType, isAdmin }: { scriptType: { key: string; labelKey: string }; isAdmin: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [script, setScript] = useState<CallScript | null>(null);
  const [baseText, setBaseText] = useState('');
  const [translations, setTranslations] = useState<Record<string, CallScriptTranslation>>({});
  const [activeLang, setActiveLang] = useState<AppLanguage>(BASE_SCRIPT_LANG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    apiGetCallScript(scriptType.key)
      .then(data => {
        setScript(data);
        setBaseText(data?.script_text || '');
        setTranslations((data?.translations as Record<string, CallScriptTranslation>) || {});
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [scriptType.key]);

  const isBase = activeLang === BASE_SCRIPT_LANG;
  const curText = isBase ? baseText : (translations[activeLang]?.script_text ?? '');
  const setCurText = (v: string) => {
    if (isBase) setBaseText(v);
    else setTranslations(prev => ({ ...prev, [activeLang]: { ...(prev[activeLang] || {}), script_text: v } }));
  };
  const copyBaseToActive = () => {
    if (isBase) return;
    setTranslations(prev => {
      const existing = prev[activeLang] || {};
      return { ...prev, [activeLang]: { ...existing, script_text: existing.script_text?.trim() ? existing.script_text : baseText } };
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const data = await apiUpdateCallScript(scriptType.key, { script_text: baseText, translations: cleanTranslations(translations) });
      setScript(data);
      setBaseText(data?.script_text || '');
      setTranslations((data?.translations as Record<string, CallScriptTranslation>) || {});
      toast({ title: t('callScripts.scriptSaved') });
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const origBase = script?.script_text || '';
  const origTr = JSON.stringify(cleanTranslations((script?.translations as Record<string, CallScriptTranslation>) || {}));
  const hasChanges = baseText !== origBase || JSON.stringify(cleanTranslations(translations)) !== origTr;
  const defaults: Record<string, string> = { prediction_lead: DEFAULT_LEAD_SCRIPT, order: DEFAULT_ORDER_SCRIPT };
  const present = Object.keys(translations).filter(l => (translations[l]?.script_text || '').trim());

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-base font-semibold">{t(scriptType.labelKey)}</CardTitle>
            {script?.updated_at && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                {t('callScripts.lastUpdated', { date: formatSkopje(script.updated_at, 'dd.MM.yyyy HH:mm') })}
              </span>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <LangTabs value={activeLang} onChange={setActiveLang} present={present} />
              {isAdmin && !isBase && (
                <Button type="button" variant="outline" size="sm" onClick={copyBaseToActive} className="h-7 text-xs gap-1">
                  <Copy className="h-3.5 w-3.5" /> {t('callScripts.copyBase')}
                </Button>
              )}
            </div>
            {!isBase && (
              <p className="text-[11px] text-muted-foreground">
                {t('callScripts.translatingHint', { lang: t('languages.' + activeLang) })}
              </p>
            )}
            {isAdmin ? (
              <>
                <Textarea
                  value={curText}
                  onChange={e => setCurText(e.target.value)}
                  className="min-h-[400px] font-mono text-sm leading-relaxed"
                  placeholder={t('callScripts.enterScript')}
                />
                {!isBase && baseText && (
                  <details className="text-[11px] text-muted-foreground">
                    <summary className="cursor-pointer select-none">{t('callScripts.showBaseReference')}</summary>
                    <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/40 bg-muted/30 p-2 leading-relaxed">{baseText}</div>
                  </details>
                )}
                <div className="mt-1 flex items-center gap-2">
                  <Button onClick={handleSave} disabled={saving || !hasChanges} className="gap-2">
                    <Save className="h-4 w-4" />
                    {saving ? t('callScripts.savingDots') : t('callScripts.saveScript')}
                  </Button>
                  {hasChanges && (
                    <Button variant="outline" onClick={() => { setBaseText(origBase); setTranslations((script?.translations as Record<string, CallScriptTranslation>) || {}); }}>
                      {t('callScripts.discardChanges')}
                    </Button>
                  )}
                  {isBase && !baseText.trim() && (
                    <Button variant="ghost" onClick={() => setBaseText(defaults[scriptType.key] || '')}>
                      {t('callScripts.loadDefault')}
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <div className="rounded-lg bg-muted/50 p-5 text-sm whitespace-pre-wrap leading-relaxed font-mono min-h-[300px]">
                {curText || baseText || t('callScripts.noScriptConfigured')}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div>
        <TemplateVariablesCard />
      </div>
    </div>
  );
}

// ─── Template Variables Sidebar ───────────────────────────────────────────────

function TemplateVariablesCard() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">{i18n.t('callScripts.templateVariables')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          {i18n.t('callScripts.templateVarsDesc')}
        </p>
        <div className="space-y-2">
          {TEMPLATE_VARIABLES.map(v => (
            <div key={v.var} className="flex items-start gap-2 rounded-lg bg-muted/50 p-2">
              <code className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-bold text-primary whitespace-nowrap">{v.var}</code>
              <span className="text-xs text-muted-foreground">{i18n.t(v.descKey)}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Product Script Form ──────────────────────────────────────────────────────

interface ScriptFormProps {
  initial?: CallScript;
  onSave: (data: ProductScriptInput) => Promise<void>;
  onCancel: () => void;
}

function ScriptForm({ initial, onSave, onCancel }: ScriptFormProps) {
  const { t } = useTranslation();
  // Macedonian base
  const [title, setTitle] = useState(initial?.title || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [scriptText, setScriptText] = useState(initial?.script_text || '');
  const [helpers, setHelpers] = useState<CallScriptHelper[]>((initial?.helpers as CallScriptHelper[]) || []);
  // Other languages (en / sq)
  const [translations, setTranslations] = useState<Record<string, CallScriptTranslation>>(
    (initial?.translations as Record<string, CallScriptTranslation>) || {}
  );
  const [activeLang, setActiveLang] = useState<AppLanguage>(BASE_SCRIPT_LANG);
  const [saving, setSaving] = useState(false);

  const isBase = activeLang === BASE_SCRIPT_LANG;
  const tr = translations[activeLang] || {};

  // Fields bound to the active language (base columns for bg, translations[lang] otherwise).
  const curTitle = isBase ? title : (tr.title ?? '');
  const curDescription = isBase ? description : (tr.description ?? '');
  const curScript = isBase ? scriptText : (tr.script_text ?? '');
  const curHelpers = isBase ? helpers : (tr.helpers ?? []);

  const patchTr = (patch: Partial<CallScriptTranslation>) =>
    setTranslations(prev => ({ ...prev, [activeLang]: { ...(prev[activeLang] || {}), ...patch } }));

  const setCurTitle = (v: string) => isBase ? setTitle(v) : patchTr({ title: v });
  const setCurDescription = (v: string) => isBase ? setDescription(v) : patchTr({ description: v });
  const setCurScript = (v: string) => isBase ? setScriptText(v) : patchTr({ script_text: v });
  const setCurHelpers = (next: CallScriptHelper[]) => isBase ? setHelpers(next) : patchTr({ helpers: next });

  const addHelper = () => setCurHelpers([...curHelpers, { title: '', content: '', category: null }]);
  const updateHelper = (idx: number, patch: Partial<CallScriptHelper>) =>
    setCurHelpers(curHelpers.map((h, i) => i === idx ? { ...h, ...patch } : h));
  const removeHelper = (idx: number) => setCurHelpers(curHelpers.filter((_, i) => i !== idx));

  // Seed the active language's EMPTY fields from the Macedonian base — a starting point
  // for translating in place (also seeds helper rows: same count + category preserved).
  const copyBaseToActive = () => {
    if (isBase) return;
    setTranslations(prev => {
      const existing = prev[activeLang] || {};
      const seededHelpers = (existing.helpers && existing.helpers.length)
        ? existing.helpers
        : helpers.map(h => ({ title: h.title, content: h.content, category: h.category ?? null }));
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
      await onSave({
        title: title.trim(),
        description: description.trim(),
        script_text: scriptText,
        helpers,
        translations: cleanTranslations(translations),
      });
    } finally {
      setSaving(false);
    }
  };

  const present = Object.keys(translations).filter(l => {
    const v = translations[l];
    return !!v && ((v.title || '').trim() || (v.description || '').trim() || (v.script_text || '').trim() || (v.helpers || []).length > 0);
  });

  return (
    <div className="space-y-4 rounded-xl border border-primary/30 bg-primary/5 p-4">
      {/* Language selector — Macedonian base + EN/SQ translations */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <LangTabs value={activeLang} onChange={setActiveLang} present={present} />
        {!isBase && (
          <Button type="button" variant="outline" size="sm" onClick={copyBaseToActive} className="h-7 text-xs gap-1">
            <Copy className="h-3.5 w-3.5" /> {t('callScripts.copyBase')}
          </Button>
        )}
      </div>
      {!isBase && (
        <p className="text-[11px] text-muted-foreground">
          {t('callScripts.translatingHint', { lang: t('languages.' + activeLang) })}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="script-title" className="text-xs font-semibold">
            {t('callScripts.scriptTitle')} {isBase
              ? <span className="text-destructive">*</span>
              : <span className="text-muted-foreground font-normal">{t('callScripts.optionalSuffix')}</span>}
          </Label>
          <Input
            id="script-title"
            value={curTitle}
            onChange={e => setCurTitle(e.target.value)}
            placeholder={isBase ? t('callScripts.titlePlaceholder') : (title || t('callScripts.titlePlaceholder'))}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="script-desc" className="text-xs font-semibold">
            {t('callScripts.description')} <span className="text-muted-foreground font-normal">{t('callScripts.optionalSuffix')}</span>
          </Label>
          <Input
            id="script-desc"
            value={curDescription}
            onChange={e => setCurDescription(e.target.value)}
            placeholder={isBase ? t('callScripts.descPlaceholder') : (description || t('callScripts.descPlaceholder'))}
            className="h-9"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="script-body" className="text-xs font-semibold">{t('callScripts.scriptContent')}</Label>
        <Textarea
          id="script-body"
          value={curScript}
          onChange={e => setCurScript(e.target.value)}
          className="min-h-[260px] font-mono text-sm leading-relaxed"
          placeholder={t('callScripts.contentPlaceholder')}
        />
        {!isBase && scriptText && (
          <details className="text-[11px] text-muted-foreground">
            <summary className="cursor-pointer select-none">{t('callScripts.showBaseReference')}</summary>
            <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/40 bg-muted/30 p-2 leading-relaxed">{scriptText}</div>
          </details>
        )}
      </div>

      {/* Clean, minimalist Helpers editor (powers the 30% pane on Calls). Not stuffed. */}
      <div className="space-y-2 pt-1 border-t border-primary/20">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-semibold">{t('callScripts.helpersLabel')}</Label>
          <Button type="button" variant="outline" size="sm" onClick={addHelper} className="h-7 text-xs gap-1">
            <Plus className="h-3.5 w-3.5" /> {t('callScripts.addHelper')}
          </Button>
        </div>
        {curHelpers.length === 0 && (
          <p className="text-[11px] text-muted-foreground/70">{t('callScripts.noHelpersYet')}</p>
        )}
        <div className="space-y-2">
          {curHelpers.map((h, idx) => {
            const ref = !isBase ? helpers[idx] : undefined;
            return (
              <div key={idx} className="rounded-lg border border-border/40 bg-background/60 p-2.5 space-y-1.5">
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px_auto] gap-1.5 items-end">
                  <div>
                    <Label className="text-[10px] text-muted-foreground">{t('callScripts.helperTitle')}</Label>
                    <Input
                      value={h.title}
                      onChange={e => updateHelper(idx, { title: e.target.value })}
                      placeholder={ref?.title || t('callScripts.helperTitlePlaceholder')}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground">{t('callScripts.helperCategory')}</Label>
                    <Input
                      value={h.category || ''}
                      onChange={e => updateHelper(idx, { category: e.target.value || null })}
                      placeholder={t('callScripts.helperCategoryPlaceholder')}
                      className="h-8 text-sm"
                    />
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={() => removeHelper(idx)} className="h-8 w-8 p-0 self-end text-muted-foreground hover:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div>
                  <Label className="text-[10px] text-muted-foreground">{t('callScripts.helperContent')}</Label>
                  <Textarea
                    value={h.content}
                    onChange={e => updateHelper(idx, { content: e.target.value })}
                    placeholder={ref?.content || t('callScripts.helperContentPlaceholder')}
                    className="min-h-[72px] text-sm leading-relaxed"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={saving || !title.trim()} className="gap-2">
          <Save className="h-4 w-4" />
          {saving ? t('callScripts.savingDots') : initial ? t('callScripts.saveChanges') : t('callScripts.createScript')}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

// ─── Product Script Card ──────────────────────────────────────────────────────

function ProductScriptCard({
  script,
  isAdmin,
  onEdit,
  onDelete,
}: {
  script: CallScript;
  isAdmin: boolean;
  onEdit: (s: CallScript) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const preview = script.script_text?.slice(0, 120).replace(/\n/g, ' ');
  const transLangs = translatedLanguages(script).filter((l): l is AppLanguage => (SUPPORTED_LANGUAGES as string[]).includes(l));

  return (
    <Card className="overflow-hidden transition-shadow hover:shadow-md">
      <div
        className="flex items-start justify-between gap-3 p-4 cursor-pointer select-none"
        onClick={() => setExpanded(p => !p)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="shrink-0 mt-0.5">
            {expanded
              ? <ChevronDown className="h-4 w-4 text-primary" />
              : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm leading-tight">{script.title}</span>
              {transLangs.length > 0 && (
                <span className="flex items-center gap-1" title={t('callScripts.hasTranslation')}>
                  {transLangs.map(l => <FlagIcon key={l} lang={l} className="h-2.5 w-5 opacity-80" />)}
                </span>
              )}
            </div>
            {script.description && (
              <div className="text-xs text-muted-foreground mt-0.5">{script.description}</div>
            )}
            {!expanded && preview && (
              <div className="text-xs text-muted-foreground/60 mt-1 truncate max-w-[500px]">{preview}…</div>
            )}
          </div>
        </div>

        {isAdmin && (
          <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
              onClick={() => onEdit(script)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('callScripts.deleteScript')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('callScripts.deleteScriptDesc', { title: script.title })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => onDelete(script.id)}
                  >
                    {t('common.delete')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </div>

      {expanded && (
        <div className="border-t px-4 pb-4 pt-3 space-y-2">
          <div className="rounded-lg bg-muted/40 p-4 text-sm whitespace-pre-wrap leading-[1.8] font-mono">
            {script.script_text || <span className="text-muted-foreground italic">{t('callScripts.noContentYet')}</span>}
          </div>

          {/* Clean preview of helpers count + first few titles (no stuffing) */}
          {Array.isArray((script as any).helpers) && (script as any).helpers.length > 0 && (
            <div className="text-[11px] text-muted-foreground/80 px-1">
              Helpers: {(script as any).helpers.length} — {(script as any).helpers.slice(0, 3).map((h: any) => h.title).join(' · ')}
              {(script as any).helpers.length > 3 && ' …'}
            </div>
          )}

          {script.updated_at && (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground/60">
              <Clock className="h-3 w-3" />
              Last updated: {formatSkopje(script.updated_at, 'dd.MM.yyyy HH:mm')}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

// ─── Product Scripts Tab ──────────────────────────────────────────────────────

function ProductScriptsTab({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [scripts, setScripts] = useState<CallScript[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingScript, setEditingScript] = useState<CallScript | null>(null);

  const loadScripts = () => {
    setLoading(true);
    apiGetAllCallScripts()
      .then(all => setScripts(all.filter(s => s.context_type === 'product')))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadScripts(); }, []);

  const handleCreate = async (data: ProductScriptInput) => {
    try {
      const created = await apiCreateProductScript(data);
      setScripts(prev => [...prev, created]);
      setShowAddForm(false);
      toast({ title: t('callScripts.scriptCreated') });
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    }
  };

  const handleUpdate = async (data: ProductScriptInput) => {
    if (!editingScript) return;
    try {
      const updated = await apiUpdateProductScript(editingScript.id, data);
      setScripts(prev => prev.map(s => s.id === updated.id ? updated : s));
      setEditingScript(null);
      toast({ title: t('callScripts.scriptUpdated') });
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiDeleteProductScript(id);
      setScripts(prev => prev.filter(s => s.id !== id));
      toast({ title: t('callScripts.scriptDeleted') });
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2 space-y-4">
        {/* Header row */}
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">{t('callScripts.productScriptsHelpers')}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('callScripts.productScriptsDesc')}
            </p>
          </div>
          {isAdmin && !showAddForm && (
            <Button onClick={() => { setShowAddForm(true); setEditingScript(null); }} className="gap-2" size="sm">
              <Plus className="h-4 w-4" />
              {t('callScripts.addScript')}
            </Button>
          )}
        </div>

        {/* Add form */}
        {showAddForm && (
          <ScriptForm
            onSave={handleCreate}
            onCancel={() => setShowAddForm(false)}
          />
        )}

        {/* Script cards */}
        {scripts.length === 0 && !showAddForm ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Package className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="font-medium text-sm text-muted-foreground">{t('callScripts.noProductScripts')}</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                {isAdmin
                  ? t('callScripts.clickAddFirst')
                  : t('callScripts.contactAdminScripts')}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {scripts.map(s => (
              editingScript?.id === s.id ? (
                <ScriptForm
                  key={s.id}
                  initial={s}
                  onSave={handleUpdate}
                  onCancel={() => setEditingScript(null)}
                />
              ) : (
                <ProductScriptCard
                  key={s.id}
                  script={s}
                  isAdmin={isAdmin}
                  onEdit={setEditingScript}
                  onDelete={handleDelete}
                />
              )
            ))}
          </div>
        )}
      </div>

      <div>
        <TemplateVariablesCard />
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function CallScriptsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isAdmin = !!user?.isAdmin;
  const [activeTab, setActiveTab] = useState(LEGACY_SCRIPT_TYPES[0].key);

  return (
    <AppLayout title={t('nav.callSupportCenter')}>
      <p className="mb-6 text-sm text-muted-foreground">
        {isAdmin
          ? t('callScripts.manageDesc')
          : t('callScripts.viewDesc')}
      </p>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-6">
          {LEGACY_SCRIPT_TYPES.map(st => (
            <TabsTrigger key={st.key} value={st.key} className="gap-2">
              <FileText className="h-4 w-4" />
              {t(st.labelKey)}
            </TabsTrigger>
          ))}
          <TabsTrigger value="product" className="gap-2">
            <Package className="h-4 w-4" />
            {t('callScripts.scriptsHelpersTab')}
          </TabsTrigger>
          <TabsTrigger value="promo" className="gap-2">
            <Flame className="h-4 w-4" />
            {t('promo.tab')}
          </TabsTrigger>
        </TabsList>

        {LEGACY_SCRIPT_TYPES.map(st => (
          <TabsContent key={st.key} value={st.key}>
            <LegacyScriptTab scriptType={st} isAdmin={isAdmin} />
          </TabsContent>
        ))}

        <TabsContent value="product">
          <ProductScriptsTab isAdmin={isAdmin} />
        </TabsContent>

        <TabsContent value="promo">
          <PromoOfTheDayTab isAdmin={isAdmin} />
        </TabsContent>
      </Tabs>
    </AppLayout>
  );
}
