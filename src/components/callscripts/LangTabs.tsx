import { useTranslation } from 'react-i18next';
import { type AppLanguage } from '@/i18n';
import { BASE_SCRIPT_LANG, SCRIPT_LANGS } from '@/lib/callScripts';
import { FlagIcon } from '@/components/LanguageSwitcher';
import { cn } from '@/lib/utils';

/**
 * Editor languages: Macedonian base first, then Albanian. Deliberately NOT
 * SUPPORTED_LANGUAGES — Macedonia writes scripts in exactly these two (operator
 * rule 2026-08-12), and offering en/bg tabs only invites half-written scripts in
 * languages no customer here is ever read to.
 */
export const EDITOR_LANGS: AppLanguage[] = [...SCRIPT_LANGS];

/**
 * Compact language switch used inside the Call Scripts editors (and the Promo
 * tab). `present` marks non-base languages that already have content with a
 * small green dot, for at-a-glance review of what still needs translating.
 */
export function LangTabs({
  value,
  onChange,
  present,
}: {
  value: AppLanguage;
  onChange: (l: AppLanguage) => void;
  present?: string[];
}) {
  const { t } = useTranslation();
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-muted/30 p-0.5">
      {EDITOR_LANGS.map(l => {
        const active = l === value;
        const isBase = l === BASE_SCRIPT_LANG;
        return (
          <button
            key={l}
            type="button"
            onClick={() => onChange(l)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              active ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <FlagIcon lang={l} className="h-2.5 w-5" />
            <span>{t('languages.' + l)}</span>
            {isBase && <span className="text-[9px] text-muted-foreground/70">({t('callScripts.baseLabel')})</span>}
            {!isBase && present?.includes(l) && (
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" title={t('callScripts.hasTranslation')} />
            )}
          </button>
        );
      })}
    </div>
  );
}
