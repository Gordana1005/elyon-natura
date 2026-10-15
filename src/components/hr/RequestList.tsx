import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { Check, Loader2, X, Ban } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/hooks/use-toast';
import { formatDmy } from '@/components/insights/shared/period';
import { apiHrCancel, apiHrDecide, type HrRequest } from '@/lib/hrApi';
import { STATUS_TONE, daysText, hrErrorText, rangeText, statusLabel, typeLabel } from './labels';

type Pending = { req: HrRequest; action: 'reject' | 'cancel' } | null;

/**
 * Requests as cards (every screen): who, what, when, how many days, the stage, who decided — and
 * the buttons the viewer may use (the api decides again). Reject and a manager's cancel ask for a
 * note (≥ 3 characters).
 */
export function RequestList({ requests, showName, viewerFinal = false, emptyText, onChanged }: {
  requests: HrRequest[];
  showName: boolean;
  /** The viewer decides at the manager step (the button says "Одобри", not "Одобри (тим)"). */
  viewerFinal?: boolean;
  emptyText: string;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [pending, setPending] = useState<Pending>(null);
  const [note, setNote] = useState('');

  const done = (msg: string) => { toast({ title: msg }); setPending(null); setNote(''); onChanged(); };
  const fail = (e: unknown) => toast({ title: t('common.error'), description: hrErrorText(e), variant: 'destructive' });
  const approve = useMutation({
    mutationFn: (r: HrRequest) => apiHrDecide(r.id, 'approve'),
    onSuccess: (r) => done(r.stage === 'approved' ? t('hrPage.actions.approvedToast') : t('hrPage.actions.teamApprovedToast')),
    onError: fail,
  });
  const reject = useMutation({
    mutationFn: ({ r, n }: { r: HrRequest; n: string }) => apiHrDecide(r.id, 'reject', n),
    onSuccess: () => done(t('hrPage.actions.rejectedToast')),
    onError: fail,
  });
  const cancel = useMutation({
    mutationFn: ({ r, n }: { r: HrRequest; n: string | null }) => apiHrCancel(r.id, n),
    onSuccess: (r) => done(r.shifts_restored ? t('hrPage.actions.cancelledRestored', { count: r.shifts_restored }) : t('hrPage.actions.cancelledToast')),
    onError: fail,
  });
  const busy = approve.isPending || reject.isPending || cancel.isPending;

  if (!requests.length) return <EmptyState title={emptyText} size="sm" className="rounded-xl shadow-sm" />;

  const ownCancel = (r: HrRequest) => r.can_cancel && !r.can_decide && r.status !== 'approved';
  const needsNote = pending?.action === 'reject' || (pending?.action === 'cancel' && !ownCancel(pending.req));

  return (
    <>
      <ul className="grid gap-2 lg:grid-cols-2" data-testid="hr-requests">
        {requests.map((r) => (
          <li key={r.id} className="min-w-0 rounded-xl border bg-card p-3 shadow-sm" data-status={r.status}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                {showName && <p className="truncate text-sm font-semibold">{r.employee_name}</p>}
                <p className={cn('text-sm', showName ? 'text-muted-foreground' : 'font-semibold')}>
                  {typeLabel(t, r.type)} · <span className="tabular-nums">{rangeText(r.date_from, r.date_to)}</span>
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {t('hrPage.list.days', { n: daysText(r.days) })}
                  {r.doc_ref ? ` · ${t('hrPage.list.doc', { ref: r.doc_ref })}` : ''}
                </p>
              </div>
              <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium', STATUS_TONE[r.status])}>
                {statusLabel(t, r.status)}
              </span>
            </div>
            {r.note && <p className="mt-2 break-words text-xs">{r.note}</p>}
            <dl className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
              <div>{t('hrPage.list.asked', { who: r.requested_by_name ?? '—', at: formatDmy(r.requested_at.slice(0, 10)) })}</div>
              {r.team_by && <div>{t('hrPage.list.team', { who: r.team_by_name ?? '—' })}{r.team_note ? ` — ${r.team_note}` : ''}</div>}
              {r.decided_by && (r.status === 'approved' || r.status === 'rejected') && (
                <div>{t(r.status === 'approved' ? 'hrPage.list.approvedBy' : 'hrPage.list.rejectedBy', { who: r.decided_by_name ?? '—' })}
                  {r.decision_note ? ` — ${r.decision_note}` : ''}</div>
              )}
              {r.status === 'cancelled' && r.cancel_note && <div>{t('hrPage.list.cancelNote', { note: r.cancel_note })}</div>}
            </dl>
            {(r.can_decide || r.can_cancel) && (
              <div className="mt-3 flex flex-wrap gap-2">
                {r.can_decide && (
                  <>
                    <Button type="button" size="sm" className="h-9" disabled={busy} onClick={() => approve.mutate(r)}>
                      {approve.isPending && approve.variables?.id === r.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
                      {r.status === 'pending_team' && !viewerFinal ? t('hrPage.actions.approveTeam') : t('hrPage.actions.approve')}
                    </Button>
                    <Button type="button" size="sm" variant="outline" className="h-9" disabled={busy} onClick={() => { setNote(''); setPending({ req: r, action: 'reject' }); }}>
                      <X className="h-4 w-4" aria-hidden /> {t('hrPage.actions.reject')}
                    </Button>
                  </>
                )}
                {r.can_cancel && (
                  <Button type="button" size="sm" variant="ghost" className="h-9" disabled={busy}
                    onClick={() => { setNote(''); setPending({ req: r, action: 'cancel' }); }}>
                    <Ban className="h-4 w-4" aria-hidden /> {t('hrPage.actions.cancel')}
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      <Dialog open={!!pending} onOpenChange={(v) => { if (!v) setPending(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{pending?.action === 'reject' ? t('hrPage.actions.rejectTitle') : t('hrPage.actions.cancelTitle')}</DialogTitle>
            <DialogDescription>
              {pending ? `${pending.req.employee_name} · ${typeLabel(t, pending.req.type)} · ${rangeText(pending.req.date_from, pending.req.date_to)}` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="hr-decide-note">{needsNote ? t('hrPage.actions.noteRequired') : t('hrPage.actions.noteOptional')}</Label>
            <Textarea id="hr-decide-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={() => setPending(null)}>{t('common.close')}</Button>
            <Button type="button" variant="destructive" disabled={busy || (needsNote && note.trim().length < 3)}
              onClick={() => {
                if (!pending) return;
                if (pending.action === 'reject') reject.mutate({ r: pending.req, n: note.trim() });
                else cancel.mutate({ r: pending.req, n: note.trim() || null });
              }}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {pending?.action === 'reject' ? t('hrPage.actions.reject') : t('hrPage.actions.cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
