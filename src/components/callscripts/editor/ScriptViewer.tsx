import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/EmptyState';
import { ScriptBody } from '../ScriptBody';
import { GroupBadges, ProductNames, StatusBadge, card, chip, chipOff, chipOn, groupLabelCls, useScriptLabels } from '../parts';
import { useProductIndex, useScriptItem, useScriptsLibrary } from '../useCallScriptsAdmin';
import { scriptsErrorText } from '../errors';

/** An agent opening a script from the library: read-only, as /calls shows it (template chips). */
export function ScriptViewer({ id, backHref }: { id: string; backHref: string }) {
  const L = useScriptLabels();
  const { t } = L;
  const item = useScriptItem(id);
  const lib = useScriptsLibrary();
  const idx = useProductIndex(lib.data);
  const [lang, setLang] = useState<'mk' | 'sq'>('mk');
  const s = item.data;
  return (
    <div className="space-y-3" data-testid="script-viewer">
      <Link to={backHref} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden />{t('callScripts.editor.back')}
      </Link>
      {item.isLoading && !s ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden /></div>
      ) : !s ? (
        <EmptyState title={t('callScripts.errors.notFound')} description={item.error ? scriptsErrorText(item.error, t) : undefined} />
      ) : (
        <article className={cn(card, 'space-y-3 p-3 sm:p-4')}>
          <div className="flex flex-wrap items-start gap-2">
            <h2 className="min-w-0 flex-1 break-words text-base font-semibold">{lang === 'sq' && s.translations?.sq?.title ? s.translations.sq.title : s.title}</h2>
            <StatusBadge script={s} />
            <div role="group" aria-label={t('callScripts.editor.previewLang')} className="flex gap-1">
              {(['mk', 'sq'] as const).map((l) => (
                <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)} className={cn(chip, 'h-8 px-2.5', lang === l ? chipOn : chipOff)}>
                  {t(`languages.${l}`)}
                </button>
              ))}
            </div>
          </div>
          {s.context_type === 'targeted' && (
            <dl className="grid gap-2 text-xs sm:grid-cols-2">
              <div className="min-w-0"><dt className={groupLabelCls}>{t('callScripts.library.colGroups')}</dt><dd className="mt-0.5"><GroupBadges groups={s.groups} max={12} /></dd></div>
              <div className="min-w-0"><dt className={groupLabelCls}>{t('callScripts.library.colProducts')}</dt><dd className="mt-0.5"><ProductNames ids={s.product_ids} name={idx.name} max={20} /></dd></div>
            </dl>
          )}
          {s.context_type === 'targeted'
            ? <ScriptBody script={s} vars={null} lang={lang} />
            : <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{lang === 'sq' && s.translations?.sq?.script_text ? s.translations.sq.script_text : s.script_text}</p>}
        </article>
      )}
    </div>
  );
}
