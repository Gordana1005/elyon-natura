import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * One line above figures that are the WHOLE company's counts, shown to a department-scoped
 * viewer (a dept_admin, access levels 20260947001600): GET /insights/sales?part=detail answers
 * them meta.company_wide = true — products, cities, buyers, basket and the MEX channels /
 * timing are counted company-wide, without money. Without the line they would read as their
 * own departments' numbers.
 */
export function CompanyWideNote({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <p role="note" className={cn(
      'flex items-start gap-1.5 text-muted-foreground',
      compact ? 'text-[11px] leading-snug' : 'rounded-lg border bg-muted/40 px-3 py-2 text-xs',
      className,
    )}>
      <Info className={cn('mt-px shrink-0', compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} aria-hidden />
      <span>{t('access.companyWide')}</span>
    </p>
  );
}
