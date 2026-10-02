import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, Copy, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import type { AppLanguage } from '@/i18n';
import { cn } from '@/lib/utils';
import { BASE_SCRIPT_LANG } from '@/lib/callScripts';
import { formatSkopje } from '@/lib/skopjeTime';
import { apiGetCallScript, apiUpdateCallScript, type CallScript, type CallScriptTranslation } from '@/lib/api';
import { LangTabs } from '../LangTabs';
import { chip, chipOff, chipOn } from '../parts';
import { TemplateVariablesCard, cleanTranslations } from './legacyShared';

const KINDS = [
  { key: 'order', labelKey: 'callScripts.orderScript' },
  { key: 'prediction_lead', labelKey: 'callScripts.predictionLeadScript' },
] as const;
type Kind = typeof KINDS[number]['key'];

function LegacyScriptEditor({ kind, canEdit }: { kind: Kind; canEdit: boolean }) {
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
    apiGetCallScript(kind)
      .then((data) => {
        setScript(data);
        setBaseText(data?.script_text || '');
        setTranslations((data?.translations as Record<string, CallScriptTranslation>) || {});
      })
      .catch(() => { setScript(null); setBaseText(''); setTranslations({}); })
      .finally(() => setLoading(false));
  }, [kind]);

  const isBase = activeLang === BASE_SCRIPT_LANG;
  const curText = isBase ? baseText : (translations[activeLang]?.script_text ?? '');
  const setCurText = (v: string) => {
    if (isBase) setBaseText(v);
    else setTranslations((prev) => ({ ...prev, [activeLang]: { ...(prev[activeLang] || {}), script_text: v } }));
  };
  const copyBaseToActive = () => {
    if (isBase) return;
    setTranslations((prev) => {
      const existing = prev[activeLang] || {};
      return { ...prev, [activeLang]: { ...existing, script_text: existing.script_text?.trim() ? existing.script_text : baseText } };
    });
  };
  const handleSave = async () => {
    setSaving(true);
    try {
      const data = await apiUpdateCallScript(kind, { script_text: baseText, translations: cleanTranslations(translations) });
      setScript(data);
      setBaseText(data?.script_text || '');
      setTranslations((data?.translations as Record<string, CallScriptTranslation>) || {});
      toast({ title: t('callScripts.scriptSaved') });
    } catch (err) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const origBase = script?.script_text || '';
  const origTr = JSON.stringify(cleanTranslations((script?.translations as Record<string, CallScriptTranslation>) || {}));
  const hasChanges = baseText !== origBase || JSON.stringify(cleanTranslations(translations)) !== origTr;
  const present = Object.keys(translations).filter((l) => (translations[l]?.script_text || '').trim());

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-3">
        <CardTitle className="text-base font-semibold">{t(KINDS.find((k) => k.key === kind)!.labelKey)}</CardTitle>
        {script?.updated_at && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />{t('callScripts.lastUpdated', { date: formatSkopje(script.updated_at, 'dd.MM.yyyy HH:mm') })}
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <LangTabs value={activeLang} onChange={setActiveLang} present={present} />
          {canEdit && !isBase && (
            <Button type="button" variant="outline" size="sm" onClick={copyBaseToActive} className="h-9 gap-1 text-xs">
              <Copy className="h-3.5 w-3.5" /> {t('callScripts.copyBase')}
            </Button>
          )}
        </div>
        {!isBase && <p className="text-[11px] text-muted-foreground">{t('callScripts.translatingHint', { lang: t('languages.' + activeLang) })}</p>}
        {canEdit ? (
          <>
            <Textarea value={curText} onChange={(e) => setCurText(e.target.value)} className="min-h-[400px] font-mono text-base leading-relaxed md:text-sm"
              placeholder={t('callScripts.enterScript')} data-testid="order-script-text" />
            {!isBase && baseText && (
              <details className="text-[11px] text-muted-foreground">
                <summary className="cursor-pointer select-none">{t('callScripts.showBaseReference')}</summary>
                <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/40 bg-muted/30 p-2 leading-relaxed">{baseText}</div>
              </details>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Button onClick={handleSave} disabled={saving || !hasChanges} className="gap-2" data-testid="order-script-save">
                <Save className="h-4 w-4" />{saving ? t('callScripts.savingDots') : t('callScripts.saveScript')}
              </Button>
              {hasChanges && (
                <Button variant="outline" onClick={() => { setBaseText(origBase); setTranslations((script?.translations as Record<string, CallScriptTranslation>) || {}); }}>
                  {t('callScripts.discardChanges')}
                </Button>
              )}
            </div>
          </>
        ) : (
          <div className="min-h-[300px] whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-4 font-mono text-sm leading-relaxed sm:p-5">
            {curText || baseText || t('callScripts.noScriptConfigured')}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Скрипта за нарачка — the script in the ORDER WINDOW (OrderModal: "order" for an order,
 * "prediction_lead" for a prediction lead). Unchanged by targeting; edited as before.
 */
export function OrderScriptTab({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<Kind>('order');
  return (
    <div className="space-y-3" data-testid="cs-order">
      <p className="text-xs text-muted-foreground">{t('callScripts.legacy.orderHint')}</p>
      <div role="group" aria-label={t('callScripts.legacy.orderKinds')} className="flex flex-wrap gap-1.5">
        {KINDS.map((k) => (
          <button key={k.key} type="button" aria-pressed={kind === k.key} onClick={() => setKind(k.key)} className={cn(chip, kind === k.key ? chipOn : chipOff)}>
            {t(k.labelKey)}
          </button>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2"><LegacyScriptEditor key={kind} kind={kind} canEdit={canEdit} /></div>
        <div className="min-w-0"><TemplateVariablesCard /></div>
      </div>
    </div>
  );
}
