// Поставки → Курир MEX (owners only; Phase 10, 2026-10-01). What one MEX parcel
// costs us — the delivery and return cost lines of Pure Profit. MEX is the
// carrier (150 ден per parcel, 0 on return); an order with no courier on it is
// priced as MEX. The Bulgarian Econt / Speedy rows stay in courier_rates (old
// reports still price them) but are not shown. Stored in EUR with 4 decimals
// (150 ден = 2,4390 €), entered in денари; saving asks first (it re-prices the
// profit reports) and is audited (PATCH /api/courier-rates, owners only).
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { eurToDen, MKD_PER_EUR } from '@/lib/currency';
import { apiGetCourierRates, apiGetSettingsMeta, apiUpdateCourierRates, type CourierRate } from '@/lib/api';
import { ConfirmDialog, LastChanged, SectionHeader, SettingsCard, settingsErrorText } from './settingsUi';

const MEX_ROWS: { service: 'door' | 'office'; labelKey: string }[] = [
  { service: 'door', labelKey: 'settings.courierRow.mexDoor' },
  { service: 'office', labelKey: 'settings.courierRow.mexOffice' },
];

/** Denari → EUR kept to 4 decimals, so 150 ден stays exactly the stored 2,4390 € (denToEur rounds to cents). */
export const denToEur4 = (den: number): number => Math.round((den / MKD_PER_EUR) * 10_000) / 10_000;

type Draft = Record<'door' | 'office', { deliver: string; ret: string }>;

export function CourierSection() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const ratesQ = useQuery({ queryKey: ['courier-rates'], queryFn: apiGetCourierRates });
  const metaQ = useQuery({ queryKey: ['settings-meta'], queryFn: apiGetSettingsMeta, retry: 0 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const rateOf = (service: 'door' | 'office'): CourierRate | undefined =>
    (ratesQ.data ?? []).find((r) => r.courier === 'mex' && r.service === service);

  useEffect(() => {
    if (!ratesQ.data) return;
    const d = (s: 'door' | 'office') => ({
      deliver: String(eurToDen(rateOf(s)?.deliver_cost ?? 0)),
      ret: String(eurToDen(rateOf(s)?.return_cost ?? 0)),
    });
    setDraft({ door: d('door'), office: d('office') });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratesQ.data]);

  const valid = draft && MEX_ROWS.every(({ service }) => {
    const a = Number(draft[service].deliver); const b = Number(draft[service].ret);
    return draft[service].deliver !== '' && draft[service].ret !== '' && Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= 0 && a <= 5000 && b <= 5000;
  });
  const dirty = draft && MEX_ROWS.some(({ service }) =>
    Number(draft[service].deliver) !== eurToDen(rateOf(service)?.deliver_cost ?? 0)
    || Number(draft[service].ret) !== eurToDen(rateOf(service)?.return_cost ?? 0));

  const save = async () => {
    if (!draft || !valid) return;
    setSaving(true);
    try {
      await apiUpdateCourierRates(MEX_ROWS.map(({ service }) => ({
        courier: 'mex' as const, service,
        deliver_cost: denToEur4(Number(draft[service].deliver)),
        return_cost: denToEur4(Number(draft[service].ret)),
      })));
      toast({ title: t('settingsPage.courier.saved') });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['courier-rates'] }),
        qc.invalidateQueries({ queryKey: ['settings-meta'] }),
      ]);
    } catch (err) {
      toast({ title: t('common.error'), description: settingsErrorText(err), variant: 'destructive' });
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  };

  const setField = (service: 'door' | 'office', field: 'deliver' | 'ret', v: string) =>
    setDraft((d) => (d ? { ...d, [service]: { ...d[service], [field]: v } } : d));

  return (
    <div className="space-y-4">
      <SectionHeader icon={Truck} title={t('settingsPage.courier.title')} desc={t('settingsPage.courier.desc')} />

      <SettingsCard labelledBy="courier-mex" title={t('settingsPage.courier.cardTitle')} desc={t('settingsPage.courier.cardDesc')}>
        {ratesQ.isLoading || !draft ? (
          ratesQ.isError
            ? <p className="text-sm text-destructive">{settingsErrorText(ratesQ.error)}</p>
            : <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading')}</div>
        ) : (
          <div className="space-y-3">
            <ul className="grid gap-3 sm:grid-cols-2" aria-labelledby="courier-mex">
              {MEX_ROWS.map(({ service, labelKey }) => (
                <li key={service} className="space-y-2 rounded-lg border p-3">
                  <p className="text-sm font-medium">{t(labelKey)}</p>
                  <div className="flex flex-wrap gap-3">
                    <label className="space-y-1">
                      <span className="block text-[11px] font-medium text-muted-foreground">{t('settings.colDeliver')}</span>
                      <Input type="number" inputMode="numeric" min={0} step={1} className="h-9 w-28 text-right tabular-nums"
                        value={draft[service].deliver} onChange={(e) => setField(service, 'deliver', e.target.value)} />
                    </label>
                    <label className="space-y-1">
                      <span className="block text-[11px] font-medium text-muted-foreground">{t('settings.colReturn')}</span>
                      <Input type="number" inputMode="numeric" min={0} step={1} className="h-9 w-28 text-right tabular-nums"
                        value={draft[service].ret} onChange={(e) => setField(service, 'ret', e.target.value)} />
                    </label>
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" className="h-9" onClick={() => setConfirming(true)} disabled={!dirty || !valid || saving}>
                <Check className="mr-1 h-4 w-4" /> {t('settingsPage.courier.save')}
              </Button>
              <LastChanged entry={metaQ.data?.audit['settings.courier_rates']} />
            </div>
          </div>
        )}
      </SettingsCard>

      <p className="text-[11px] text-muted-foreground">{t('settingsPage.courier.hiddenNote')}</p>

      <ConfirmDialog
        open={confirming}
        title={t('settingsPage.courier.confirmTitle')}
        body={(
          <>
            <p>{t('settingsPage.courier.confirmBody')}</p>
            {draft && (
              <ul className="list-disc pl-5">
                {MEX_ROWS.map(({ service, labelKey }) => (
                  <li key={service}>{t('settingsPage.courier.confirmRow', { row: t(labelKey), deliver: draft[service].deliver, ret: draft[service].ret })}</li>
                ))}
              </ul>
            )}
          </>
        )}
        confirmLabel={t('settingsPage.courier.confirm')}
        busy={saving}
        onConfirm={() => { void save(); }}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
