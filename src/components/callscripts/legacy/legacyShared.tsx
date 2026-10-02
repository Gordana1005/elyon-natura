import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { CallScriptTranslation } from '@/lib/api';

/**
 * Drop empty fields / blank helper rows / empty language entries before persisting, so the
 * translations blob stays clean and resolveScript's per-field fallback works.
 */
export function cleanTranslations(translations: Record<string, CallScriptTranslation>): Record<string, CallScriptTranslation> {
  const out: Record<string, CallScriptTranslation> = {};
  for (const [lang, tr] of Object.entries(translations || {})) {
    if (!tr) continue;
    const entry: CallScriptTranslation = {};
    if (tr.title?.trim()) entry.title = tr.title.trim();
    if (tr.description?.trim()) entry.description = tr.description.trim();
    if (tr.script_text?.trim()) entry.script_text = tr.script_text.trim();
    const helpers = (tr.helpers || [])
      .map((h) => ({ title: (h.title || '').trim(), content: (h.content || '').trim(), category: h.category?.trim() || null }))
      .filter((h) => h.title || h.content);
    if (helpers.length) entry.helpers = helpers;
    if (Object.keys(entry).length) out[lang] = entry;
  }
  return out;
}

const TEMPLATE_VARIABLES = [
  { v: '[Customer Name]', descKey: 'callScripts.varCustomerName' },
  { v: '[Product]', descKey: 'callScripts.varProduct' },
  { v: '[Order ID]', descKey: 'callScripts.varOrderId' },
  { v: '[Agent Name]', descKey: 'callScripts.varAgentName' },
  { v: '[Price]', descKey: 'callScripts.varPrice' },
  { v: '[Address]', descKey: 'callScripts.varAddress' },
  { v: '[City]', descKey: 'callScripts.varCity' },
];

/** The old [Placeholder] form the legacy scripts use (the targeted editor has its own variable menu). */
export function TemplateVariablesCard() {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">{t('callScripts.templateVariables')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">{t('callScripts.templateVarsDesc')}</p>
        <div className="space-y-2">
          {TEMPLATE_VARIABLES.map((x) => (
            <div key={x.v} className="flex flex-wrap items-start gap-2 rounded-lg bg-muted/50 p-2">
              <code className="whitespace-nowrap rounded bg-primary/10 px-1.5 py-0.5 text-xs font-bold text-primary">{x.v}</code>
              <span className="min-w-0 text-xs text-muted-foreground">{t(x.descKey)}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
