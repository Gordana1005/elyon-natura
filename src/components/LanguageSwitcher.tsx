import { useTranslation } from 'react-i18next';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/contexts/LanguageContext';
import { SUPPORTED_LANGUAGES, type AppLanguage } from '@/i18n';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';

// Inline SVGs instead of emoji flags — Windows renders 🇬🇧/🇲🇰 as plain
// letters, and most agents are on Windows.
function UkFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 60 30" className={className} aria-hidden="true">
      <rect width="60" height="30" fill="#012169" />
      <path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" strokeWidth="6" />
      <path d="M0,0 L60,30 M60,0 L0,30" stroke="#C8102E" strokeWidth="3" />
      <path d="M30,0 V30 M0,15 H60" stroke="#fff" strokeWidth="10" />
      <path d="M30,0 V30 M0,15 H60" stroke="#C8102E" strokeWidth="6" />
    </svg>
  );
}

// Albanian flag — red field with the black double-headed eagle. The eagle is one
// half-silhouette mirrored across the centre (x=30) so it stays symmetric and
// recognisable even at the tiny switcher size.
function AlFlag({ className }: { className?: string }) {
  const half = 'M30 9 L33 7 L36 7 L38 8.5 L35.5 9 L37 10.5 L41 10 L48 12 L46 13 L40 13 L42 16 L39 15 L39 19 L41 22 L38 22 L37 20 L37 24 L35 25 L34 20 L32 13 L30 11 Z';
  return (
    <svg viewBox="0 0 60 30" className={className} aria-hidden="true">
      <rect width="60" height="30" fill="#E41E20" />
      <path d={half} fill="#000" />
      <path d={half} fill="#000" transform="translate(60,0) scale(-1,1)" />
    </svg>
  );
}

// Macedonian flag — the golden sun on red: a central disc with eight rays
// broadening out to the four corners and the middle of each edge. Drawn as a
// triangle fan from the centre with the disc painted over the convergence, so
// it stays clean at the 24×12px switcher size.
function MkFlag({ className }: { className?: string }) {
  const rays = [
    '30,15 60,10.5 60,19.5',   // right
    '30,15 0,10.5 0,19.5',     // left
    '30,15 24,0 36,0',         // up
    '30,15 24,30 36,30',       // down
    '30,15 52,0 60,0 60,4',    // top-right corner
    '30,15 8,0 0,0 0,4',       // top-left corner
    '30,15 52,30 60,30 60,26', // bottom-right corner
    '30,15 8,30 0,30 0,26',    // bottom-left corner
  ];
  return (
    <svg viewBox="0 0 60 30" className={className} aria-hidden="true">
      <rect width="60" height="30" fill="#D20000" />
      {rays.map(points => (
        <polygon key={points} points={points} fill="#F8E71C" />
      ))}
      <circle cx="30" cy="15" r="4.6" fill="#F8E71C" stroke="#D20000" strokeWidth="1.2" />
    </svg>
  );
}

const FLAGS: Record<AppLanguage, (p: { className?: string }) => JSX.Element> = {
  en: UkFlag,
  sq: AlFlag,
  mk: MkFlag,
};

/** Flag for a language, shared by the top-bar switcher and Settings → Appearance. */
export function FlagIcon({ lang, className }: { lang: AppLanguage; className?: string }) {
  const Flag = FLAGS[lang];
  return <Flag className={cn('rounded-[2px] shadow-sm', className)} />;
}

/** Top-bar language picker — visible to every role, lives next to the Break button.
 *  Compact: the trigger shows only the ACTIVE flag + chevron; clicking opens the
 *  full list (flag + native name, active one checked). Stays small in the top bar
 *  and scales past two languages without crowding it. */
export function LanguageSwitcher() {
  const { t } = useTranslation();
  const { language, setLanguage } = useLanguage();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('common.language')}
        title={t(`languages.${language}`)}
        className="flex h-8 items-center gap-1 rounded-md border bg-background px-1.5 outline-none transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-primary/40 data-[state=open]:bg-accent"
      >
        <FlagIcon lang={language} className="h-3 w-6" />
        <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[10rem]">
        {SUPPORTED_LANGUAGES.map(lang => (
          <DropdownMenuItem
            key={lang}
            onSelect={() => setLanguage(lang)}
            aria-current={lang === language}
            className="gap-2"
          >
            <FlagIcon lang={lang} className="h-3 w-6" />
            <span className={cn('flex-1', lang === language && 'font-medium')}>
              {t(`languages.${lang}`)}
            </span>
            {lang === language && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
