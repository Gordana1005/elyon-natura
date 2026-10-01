import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarOff, KeyRound, Loader2, Send } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { apiErrorText } from '@/i18n/apiErrors';
import { apiGetMexPushSettings, apiPatchMexPushSettings, MEX_ACCOUNTS, type MexAccount } from '@/lib/warehouseApi';
import { accountName } from './warehouseText';

type Change = { kind: 'global'; on: boolean } | { kind: 'account'; account: MexAccount; on: boolean };

/**
 * Admin only: the "MEX праќање" switch (app_settings.mex_push) — global and per account.
 * Every flip asks first and is written to audit_log by the server. The 11:00 auto-send
 * is built but not scheduled (owner 30.09.2026) — said here, not offered.
 */
export function MexPushSettingsCard({ f }: { f: InsightsFormat }) {
  const { t } = f;
  const { toast } = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['mex-push-settings'], queryFn: apiGetMexPushSettings, staleTime: 30_000 });
  const [pending, setPending] = useState<Change | null>(null);
  const m = useMutation({
    mutationFn: (c: Change) => apiPatchMexPushSettings(c.kind === 'global' ? { enabled: c.on } : { accounts: { [c.account]: c.on } }),
    onSuccess: (res) => {
      qc.setQueryData(['mex-push-settings'], res);
      void qc.invalidateQueries({ queryKey: ['warehouse-queue'] });
      toast({ title: t('warehousePage.settings.saved') });
    },
    onError: (e) => toast({ title: t('warehousePage.settings.saveFailed'), description: apiErrorText(e), variant: 'destructive' }),
  });

  if (!q.data?.can_toggle) return null;
  const s = q.data.settings;
  const keys = q.data.keys;

  return (
    <section aria-labelledby="mex-push-settings" className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
      <div className="space-y-0.5">
        <h3 id="mex-push-settings" className="flex items-center gap-2 text-sm font-semibold"><Send className="h-4 w-4" aria-hidden />{t('warehousePage.settings.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('warehousePage.settings.desc')}</p>
      </div>
      <ul className="divide-y rounded-lg border">
        <li className="flex items-center justify-between gap-3 px-3 py-2">
          <span className="text-sm font-medium">{t('warehousePage.settings.global')}</span>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {s.enabled ? t('warehousePage.settings.on') : t('warehousePage.settings.off')}
            <Switch checked={s.enabled} disabled={m.isPending} aria-label={t('warehousePage.settings.global')}
              onCheckedChange={(on) => setPending({ kind: 'global', on })} />
          </span>
        </li>
        {MEX_ACCOUNTS.map((a) => (
          <li key={a} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
            <span className="text-sm">
              {t('warehousePage.settings.account', { account: accountName(a) })}
              {!keys[a] && <span className="ml-2 inline-flex items-center gap-1 text-xs text-red-700 dark:text-red-400"><KeyRound className="h-3 w-3" aria-hidden />{t('warehousePage.settings.noKey')}</span>}
            </span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              {s.accounts[a] ? t('warehousePage.settings.on') : t('warehousePage.settings.off')}
              <Switch checked={s.accounts[a]} disabled={m.isPending} aria-label={t('warehousePage.settings.account', { account: accountName(a) })}
                onCheckedChange={(on) => setPending({ kind: 'account', account: a, on })} />
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{t('warehousePage.settings.max', { n: s.max_per_send })}</p>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><CalendarOff className="h-3.5 w-3.5" aria-hidden />{t('warehousePage.settings.autoSend')}</p>

      <AlertDialog open={!!pending} onOpenChange={(o) => { if (!o) setPending(null); }}>
        <AlertDialogContent className="w-[calc(100%-1rem)] max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.on ? t('warehousePage.settings.confirmOnTitle') : t('warehousePage.settings.confirmOffTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === 'account' ? `${t('warehousePage.settings.account', { account: accountName(pending.account) })} — ` : ''}
              {pending?.on ? t('warehousePage.settings.confirmOn') : t('warehousePage.settings.confirmOff')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (pending) m.mutate(pending); setPending(null); }}>
              {m.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />}{t('warehousePage.settings.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
