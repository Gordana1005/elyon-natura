import type { ElementType } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Dark-mode steps for the light tone pairs callers pass ("bg-X-100
 * text-X-700"). A pale -100 disc on the dark card glowed and its -700 icon
 * sank into it; in dark the disc is the deep -950 step and the icon the
 * light -300 one. Literal strings so Tailwind generates them. A tone that is
 * not listed here (bg-primary/10, bg-muted, bg-destructive/10, …) is already
 * theme-aware and passes through unchanged.
 */
const KPI_DARK_TONE: Record<string, string> = {
  'bg-emerald-100 text-emerald-700': 'dark:bg-emerald-950/70 dark:text-emerald-300',
  'bg-amber-100 text-amber-700': 'dark:bg-amber-950/70 dark:text-amber-300',
  'bg-blue-100 text-blue-700': 'dark:bg-blue-950/70 dark:text-blue-300',
  'bg-indigo-100 text-indigo-700': 'dark:bg-indigo-950/70 dark:text-indigo-300',
  'bg-orange-100 text-orange-700': 'dark:bg-orange-950/70 dark:text-orange-300',
  'bg-red-100 text-red-700': 'dark:bg-red-950/70 dark:text-red-300',
  'bg-rose-100 text-rose-700': 'dark:bg-rose-950/70 dark:text-rose-300',
  'bg-sky-100 text-sky-700': 'dark:bg-sky-950/70 dark:text-sky-300',
  'bg-teal-100 text-teal-700': 'dark:bg-teal-950/70 dark:text-teal-300',
  'bg-violet-100 text-violet-700': 'dark:bg-violet-950/70 dark:text-violet-300',
  'bg-zinc-100 text-zinc-700': 'dark:bg-zinc-800 dark:text-zinc-200',
};

/** The tone with its dark-mode step added (unknown tones unchanged). */
const kpiTone = (tone: string | undefined): string => {
  const t = (tone ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return 'bg-primary/10';
  return KPI_DARK_TONE[t] ? `${t} ${KPI_DARK_TONE[t]}` : t;
};

/**
 * Shared KPI / metric card for the analytics hub (Insights tabs, etc.).
 * Single source for what used to be a `Kpi` component duplicated in
 * ManagementInsightsPage and AgentActivityPage.
 *
 * `icon` is a lucide (or any) component type — pass `Coins`, not `<Coins />`.
 */
export function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: ElementType;
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center gap-3">
          <div className={cn('rounded-full p-2.5', kpiTone(tone))}>
            <Icon className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-xl font-bold tabular-nums break-all">{value}</p>
            {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
