import { useMemo } from 'react';
import i18n from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/EmptyState';
import { formatMoney } from '@/lib/currency';

// ── Reusable list card (top-N with bars) ──
export function ListCard({ title, icon: Icon, rows, nameKey, cols, transformName, note }: {
  title: string; icon: any; rows: any[]; nameKey: string;
  cols: { k: string; label: string; money?: boolean }[];
  transformName?: (s: string) => string; note?: string;
}) {
  const max = useMemo(() => Math.max(1, ...rows.map(r => Number(r[cols[cols.length - 1].k] || 0))), [rows, cols]);
  const valKey = cols[cols.length - 1].k;
  const valMoney = cols[cols.length - 1].money;
  return (
    <Card>
      <CardHeader><CardTitle className="text-base flex items-center gap-2"><Icon className="h-4 w-4" /> {title}</CardTitle></CardHeader>
      <CardContent>
        {rows.length === 0 ? <EmptyState title={i18n.t('insights.noData')} size="sm" /> : (
          <div className="space-y-1.5 max-h-[340px] overflow-y-auto pr-1">
            {rows.slice(0, 20).map((r, i) => {
              const v = Number(r[valKey] || 0);
              const name = transformName ? transformName(String(r[nameKey])) : String(r[nameKey]);
              return (
                <div key={i} className="relative">
                  <div className="absolute inset-y-0 left-0 rounded bg-primary/10" style={{ width: `${(v / max) * 100}%` }} />
                  <div className="relative flex items-center justify-between gap-2 px-2 py-1 text-xs">
                    <span className="truncate" title={name}>{name}</span>
                    <span className="tabular-nums font-medium shrink-0">{valMoney ? formatMoney(v) : v.toLocaleString()}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {note && <p className="text-[10px] text-muted-foreground mt-2 italic">{note}</p>}
      </CardContent>
    </Card>
  );
}
