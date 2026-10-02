import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { scopeTeamLabel } from '@/lib/deptScope';

/**
 * "Тим Центар" / "Тим Маџари" — the departments a dept_admin's money is limited to (access
 * levels, 20260947001600). Shown beside a page's tabs or period so a figure is never read as
 * company-wide. Renders nothing for an empty scope. Display only: the api narrows the data.
 */
export function DeptScopeBadge({ keys, className }: { keys: readonly string[] | null | undefined; className?: string }) {
  const { t } = useTranslation();
  const label = scopeTeamLabel(keys, t);
  if (!label) return null;
  const title = t('access.scope.title', { team: label });
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-0.5 text-xs font-medium text-foreground',
        className,
      )}
      title={title}
      aria-label={title}
      data-testid="dept-scope-badge"
    >
      <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}
