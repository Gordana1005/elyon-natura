import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Lock, Unlock, Loader2, ChevronDown, Phone, ListChecks, ArrowRight } from 'lucide-react';
import { formatDate, formatDistanceToNow } from '@/i18n/dates';
import { useAuth } from '@/contexts/AuthContext';
import {
  apiCreatePersonalHold, apiLookupPersonalHold, apiReleasePersonalHold,
  apiGetMyPersonalHolds, apiGetAppSettings,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { hoverLift } from '@/lib/design-utils';

interface Props {
  /** Phone of the customer currently focused on the Calls page (optional). */
  phone?: string;
  /** Best-known name to seed the hold record. */
  customerName?: string;
  /** Fired after the current customer is successfully claimed — the Calls
   *  page advances to the next queue customer (the talk is finished). */
  onClaimed?: (phone: string) => void;
  className?: string;
}

/**
 * Split-button: the left side acts on the current customer (claim if free,
 * release if mine, "held by" badge if someone else's), the right chevron
 * opens a popover listing every customer in this agent's Personal List.
 *
 * Designed to live in the Calls page header next to "+ Create Order" so
 * the agent always sees their list at a glance.
 */
export function PersonalListButton({ phone, customerName, onClaimed, className }: Props) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [popOpen, setPopOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [followUpBy, setFollowUpBy] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [busyPhoneAction, setBusyPhoneAction] = useState<string | null>(null);

  const phoneEnabled = !!phone && phone.replace(/\D/g, '').length >= 6;

  const { data: hold } = useQuery({
    queryKey: ['personal-hold', phone],
    queryFn: () => apiLookupPersonalHold(phone!),
    enabled: phoneEnabled,
    staleTime: 15_000,
  });

  const { data: myHolds } = useQuery({
    queryKey: ['my-personal-holds'],
    queryFn: apiGetMyPersonalHolds,
    refetchInterval: 60_000,
  });

  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: apiGetAppSettings,
    staleTime: 5 * 60_000,
  });
  const cap = appSettings?.personal_list_max_holds ?? 50;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['personal-hold', phone] });
    qc.invalidateQueries({ queryKey: ['personal-hold'] });
    qc.invalidateQueries({ queryKey: ['my-personal-holds'] });
  };

  const submit = async () => {
    if (!phone || !reason.trim()) return;
    setSubmitting(true);
    try {
      await apiCreatePersonalHold({
        customer_phone: phone,
        customer_name: customerName,
        reason: reason.trim(),
        follow_up_by: followUpBy || undefined,
      });
      toast({ title: t('personalList.addedTitle'), description: t('personalList.addedDesc') });
      setDialogOpen(false);
      setReason('');
      setFollowUpBy('');
      refresh();
      // The talk is finished — tell the Calls page to bring up the next customer.
      if (phone) onClaimed?.(phone);
    } catch (err: any) {
      toast({ title: t('personalList.claimFailed'), description: err?.message || t('common.unknownError'), variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  const releaseHold = async (id: string, label: string) => {
    setBusyPhoneAction(id);
    try {
      await apiReleasePersonalHold(id);
      toast({ title: t('personalList.releasedTitle'), description: label });
      refresh();
    } catch (err: any) {
      toast({ title: t('personalList.releaseFailed'), description: err?.message || t('common.unknownError'), variant: 'destructive' });
    } finally { setBusyPhoneAction(null); }
  };

  // ── Action button (left half of the split button) ──
  // Variant depends on the current customer's hold state.
  const actionButton = (() => {
    if (!phoneEnabled) {
      return (
        <Button size="sm" variant="outline" disabled className="h-8 gap-1.5 text-xs rounded-r-none border-r-0">
          <Lock className="h-3 w-3" /> {t('nav.personalList')}
        </Button>
      );
    }
    if (hold && hold.agent_id !== user?.id) {
      return (
        <Button
          size="sm" variant="outline" disabled
          className="h-8 gap-1.5 text-xs rounded-r-none border-r-0 border-[hsl(var(--warning))]/30 bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))] disabled:opacity-100"
          title={`${hold.agent_name}: ${hold.reason}`}
        >
          <Lock className="h-3 w-3" /> {t('personalList.heldBy', { name: hold.agent_name })}
        </Button>
      );
    }
    if (hold && hold.agent_id === user?.id) {
      return (
        <Button
          size="sm" variant="outline"
          onClick={() => releaseHold(hold.id, customerName || phone!)}
          disabled={busyPhoneAction === hold.id}
          className="h-8 gap-1.5 text-xs rounded-r-none border-r-0 border-[hsl(var(--success))]/30 bg-[hsl(var(--success))]/10 text-[hsl(var(--success))] hover:bg-[hsl(var(--success))]/20 hover:text-[hsl(var(--success))]"
        >
          {busyPhoneAction === hold.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlock className="h-3 w-3" />}
          {t('personalList.releaseExpires', { date: formatDate(hold.expires_at, 'd MMM') })}
        </Button>
      );
    }
    return (
      <Button
        size="sm" variant="outline" onClick={() => setDialogOpen(true)}
        className="h-8 gap-1.5 text-xs rounded-r-none border-r-0 border-[hsl(var(--success))]/30 text-[hsl(var(--success))] hover:bg-[hsl(var(--success))]/10 hover:text-[hsl(var(--success))]"
      >
        <Lock className="h-3 w-3" /> {t('personalList.addTo')}
      </Button>
    );
  })();

  return (
    <div className={cn('inline-flex', className)}>
      {actionButton}
      {/* Chevron half — opens popover with full personal list */}
      <Popover open={popOpen} onOpenChange={setPopOpen}>
        <PopoverTrigger asChild>
          <Button
            size="sm" variant="outline"
            className="h-8 px-1.5 rounded-l-none border-l border-emerald-300/60 text-emerald-800 hover:bg-emerald-50 hover:text-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-300 relative"
            title={t('personalList.myList')}
          >
            <ChevronDown className="h-3.5 w-3.5" />
            {(myHolds?.length ?? 0) > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-emerald-600 text-white text-[9px] font-bold flex items-center justify-center">
                {myHolds!.length}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[360px] p-0">
          <div className="px-3 py-2 border-b flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <ListChecks className="h-3 w-3" /> {t('personalList.myList')}
              <span className="font-normal normal-case">({myHolds?.length ?? 0}/{cap})</span>
            </div>
            <button
              onClick={() => { setPopOpen(false); navigate('/personal-list'); }}
              className="text-[11px] text-[hsl(var(--success))] hover:underline font-medium flex items-center gap-1"
            >
              {t('personalList.viewAll')} <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          {!myHolds || myHolds.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              <Lock className="h-5 w-5 mx-auto mb-1.5 opacity-40" />
              {t('personalList.emptyList')}
            </div>
          ) : (
            <div className="max-h-[360px] overflow-y-auto py-1">
              {myHolds.map(h => {
                const expired = new Date(h.expires_at) < new Date();
                return (
                  <div key={h.id} className={cn('group px-3 py-2 hover:bg-muted/50 border-b last:border-0', expired && 'bg-destructive/5')}>
                    <div className="flex items-center justify-between gap-2">
                      <button
                        onClick={() => { setPopOpen(false); navigate(`/calls?phone=${encodeURIComponent(h.customer_phone)}`); }}
                        className="text-left flex-1 min-w-0"
                      >
                        <div className="text-xs font-medium truncate">{h.customer_name || h.customer_phone}</div>
                        <div className="text-[10px] font-mono text-muted-foreground truncate">{h.customer_phone}</div>
                      </button>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => { setPopOpen(false); navigate(`/calls?phone=${encodeURIComponent(h.customer_phone)}`); }}
                          className="p-1 rounded hover:bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]"
                          title={t('personalList.openInCalls')}
                        >
                          <Phone className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => releaseHold(h.id, h.customer_name || h.customer_phone)}
                          disabled={busyPhoneAction === h.id}
                          className="p-1 rounded hover:bg-rose-100 text-rose-700 dark:text-rose-300 dark:hover:bg-rose-500/15"
                          title={t('personalList.release')}
                        >
                          {busyPhoneAction === h.id
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <Unlock className="h-3 w-3" />}
                        </button>
                      </div>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1 truncate" title={h.reason}>
                      {h.reason}
                    </div>
                    <div className={cn('text-[10px] mt-0.5', expired ? 'text-red-700 font-semibold' : 'text-muted-foreground')}>
                      {expired ? t('personalList.expiredPrefix') : ''}{formatDistanceToNow(new Date(h.expires_at), { addSuffix: true })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* Claim dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('personalList.claimTitle', { name: customerName || phone })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="hold-reason" className="text-xs">{t('personalList.whyReserve')}</Label>
              <Textarea
                id="hold-reason"
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder={t('personalList.reasonPlaceholder')}
                className="min-h-[90px] mt-1 text-sm"
                maxLength={1000}
              />
            </div>
            <div>
              <Label htmlFor="hold-followup" className="text-xs">{t('personalList.followUpLabel')}</Label>
              <Input
                id="hold-followup"
                type="date"
                value={followUpBy}
                onChange={e => setFollowUpBy(e.target.value)}
                className="mt-1 text-sm"
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t('personalList.holdLasts')}
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={submitting}>{t('common.cancel')}</Button>
            <Button onClick={submit} disabled={!reason.trim() || submitting} className="bg-emerald-600 hover:bg-emerald-700">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Lock className="h-4 w-4 mr-1.5" />}
              {t('personalList.claimFor10')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
