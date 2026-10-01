import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { formatSkopje } from '@/lib/skopjeTime';
import type { StockMovementRow } from '@/lib/stockV2Types';
import { cn } from '@/lib/utils';
import { Pill } from './shared';
import { fmtQty, fmtSigned } from './stockV2Model';

export const kindLabel = (f: InsightsFormat, k: string) => f.t(`stock2.kind.${k}`, { defaultValue: k });
export const sourceLabel = (f: InsightsFormat, s: string) => f.t(`stock2.source.${s}`, { defaultValue: s });

/** dd.MM.yyyy HH:mm on the Skopje clock. */
export const moment = (iso: string | null | undefined) => formatSkopje(iso, 'dd.MM.yyyy HH:mm');

/** What the move points at: the parcel or the Sigma document (a count / a manual move is its source already). */
export function moveRef(f: InsightsFormat, m: StockMovementRow): string | null {
  const { t } = f;
  if (m.tracking_id) return t('stock2.moves.refParcel', { id: m.tracking_id });
  if (m.sigma_doc) return t('stock2.moves.refSigma', { doc: m.sigma_doc.replace(/\|/g, ' · ') });
  if (m.count_id || m.manual_id) return null;
  return m.source_key;
}

/** "MEX · пратка 9110…" · "Сигма · документ 2026 · ПРИ · 73" · "Попис". */
export const sourceRef = (f: InsightsFormat, m: StockMovementRow) =>
  [sourceLabel(f, m.source), moveRef(f, m)].filter(Boolean).join(' · ');

/** The badges a move can carry: entered late · re-dated in Sigma · a correction · provisional. */
export function MoveBadges({ m, f }: { m: StockMovementRow; f: InsightsFormat }) {
  const { t } = f;
  const late = m.late_days > 0;
  const redated = (m.sigma_versions ?? 0) > 1;
  if (!late && !redated && !m.correction && !m.provisional) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {late && <Pill tone="amber" title={t('stock2.moves.recordedAt', { at: moment(m.recorded_at) })}>{t('stock2.moves.late', { count: m.late_days })}</Pill>}
      {redated && <Pill tone="blue" title={t('stock2.moves.redatedHint', { n: m.sigma_versions })}>{t('stock2.moves.redated')}</Pill>}
      {m.correction && <Pill tone="red" title={t('stock2.moves.correctionHint')}>{t('stock2.moves.correction')}</Pill>}
      {m.provisional && <Pill tone="slate" title={t('stock2.moves.provisionalHint')}>{t('stock2.moves.provisional')}</Pill>}
    </span>
  );
}

export const qtyTone = (q: number) => (q > 0 ? 'text-emerald-700 dark:text-emerald-400' : q < 0 ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground');

/** One move as a card (phones, the article drawer). */
export function MoveCard({ m, f, showArticle = true, showWarehouse = true }: { m: StockMovementRow; f: InsightsFormat; showArticle?: boolean; showWarehouse?: boolean }) {
  const { t } = f;
  return (
    <li className="space-y-1 rounded-xl border bg-card p-3 text-sm shadow-sm" data-testid="stock2-move-card">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium">{kindLabel(f, m.kind)}</p>
          <p className="text-[11px] tabular-nums text-muted-foreground">{moment(m.event_at)}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className={cn('font-semibold tabular-nums', qtyTone(m.qty))}>{fmtSigned(m.qty, f.lang)}</p>
          {m.balance_after != null && <p className="text-[11px] tabular-nums text-muted-foreground">{t('stock2.moves.balanceShort', { n: fmtQty(m.balance_after, f.lang) })}</p>}
        </div>
      </div>
      {showArticle && <p className="break-words text-xs"><span className="font-medium">{m.article_name}</span> <span className="text-muted-foreground">{m.article_code}</span></p>}
      <p className="break-all text-[11px] text-muted-foreground">
        {sourceRef(f, m)}{showWarehouse ? ` · ${f.t(`stock2.wh.${m.warehouse_code}`, { defaultValue: m.warehouse_code })}` : ''}
      </p>
      <MoveBadges m={m} f={f} />
    </li>
  );
}
