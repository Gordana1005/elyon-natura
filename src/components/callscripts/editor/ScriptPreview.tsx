import { useMemo, useState } from 'react';
import { Eye, Loader2 } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { predictionListLabel } from '@/lib/predictionListLabel';
import type { ScriptGroup, ScriptSample, TargetedScript } from '@/lib/callScriptsTypes';
import { ScriptBody } from '../ScriptBody';
import { sampleVars } from '../scriptsModel';
import { card, chip, chipOff, chipOn, useScriptLabels } from '../parts';
import { useScriptSamples } from '../useCallScriptsAdmin';

const TEMPLATE = '__template__';

/** A sample client's line in the picker: the name (or phone), the list or "лид", the product. */
export function sampleLabel(s: ScriptSample, t: (k: string) => string): string {
  const who = s.customer_name || s.customer_phone || t('callScripts.editor.sampleHidden');
  const where = s.kind === 'lead' ? t('callScripts.editor.sampleLead') : (s.list_name ? predictionListLabel(s.list_name) : '');
  return [who, where, s.product_name].filter(Boolean).join(' · ');
}

/**
 * Преглед — the script exactly as /calls will show it (C's ScriptBody): as a template (every
 * variable a chip) or filled with a REAL waiting client of the script's first group / product
 * (GET /call-scripts/samples, privacy-filtered by the api), in Macedonian or Albanian.
 */
export function ScriptPreview({ script, group, productId, defaultLang = 'mk', samplesEnabled = true }: {
  script: TargetedScript;
  group: ScriptGroup | null;
  productId: string | null;
  defaultLang?: 'mk' | 'sq';
  samplesEnabled?: boolean;
}) {
  const L = useScriptLabels();
  const { t } = L;
  const { user } = useAuth();
  const [lang, setLang] = useState<'mk' | 'sq'>(defaultLang);
  const [pick, setPick] = useState<string>(TEMPLATE);
  const samples = useScriptSamples(group, productId, samplesEnabled);
  const list = useMemo(() => samples.data?.samples ?? [], [samples.data]);
  const sample = pick === TEMPLATE ? null : list[Number(pick)] ?? null;
  const vars = useMemo(() => (sample ? sampleVars(sample, { agentName: user?.full_name ?? null }) : null), [sample, user?.full_name]);

  return (
    <section className={cn(card, 'space-y-3 p-3 sm:p-4')} aria-labelledby="cs-preview" data-testid="script-preview">
      <div className="flex flex-wrap items-center gap-2">
        <Eye className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <h3 id="cs-preview" className="min-w-0 flex-1 text-sm font-semibold">{t('callScripts.editor.preview')}</h3>
        <div role="group" aria-label={t('callScripts.editor.previewLang')} className="flex gap-1">
          {(['mk', 'sq'] as const).map((l) => (
            <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)} className={cn(chip, 'h-8 px-2.5 lg:h-7', lang === l ? chipOn : chipOff)}>
              {t(`languages.${l}`)}
            </button>
          ))}
        </div>
      </div>
      {samplesEnabled && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={pick} onValueChange={setPick}>
            <SelectTrigger className="h-9 min-w-0 flex-1 basis-56" aria-label={t('callScripts.editor.sampleLabel')} data-testid="preview-sample">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TEMPLATE}>{t('callScripts.editor.sampleTemplate')}</SelectItem>
              {list.map((s, i) => <SelectItem key={i} value={String(i)}>{sampleLabel(s, t)}</SelectItem>)}
            </SelectContent>
          </Select>
          {samples.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />}
          {!samples.isFetching && samples.data && list.length === 0 && (
            <span className="text-[11px] text-muted-foreground">{t('callScripts.editor.sampleNone')}</span>
          )}
        </div>
      )}
      <div className="max-h-[70vh] overflow-y-auto rounded-lg border border-border/40 bg-card p-2.5">
        {script.title && <p className="mb-2 break-words text-sm font-semibold">{lang === 'sq' && script.translations?.sq?.title ? script.translations.sq.title : script.title}</p>}
        <ScriptBody script={script} vars={vars} lang={lang} compact />
      </div>
    </section>
  );
}
