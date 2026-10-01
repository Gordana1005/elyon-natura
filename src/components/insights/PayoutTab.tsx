// Admin PAYOUT tab — settle agent commissions, history, print report.
import { useTranslation } from 'react-i18next';
import { apiErrorText } from '@/i18n/apiErrors';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Loader2, Banknote, Printer, CheckCircle2, XCircle, Users, Pencil, RotateCcw } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { EmptyState } from '@/components/EmptyState';
import {
  apiGetAgents,
  apiGetAgentPayoutSummary,
  apiGetAgentPayouts,
  apiPreviewAgentPayout,
  apiCreateAgentPayout,
  apiUpdateAgentPayout,
  apiVoidAgentPayout,
  apiGetAgentPayoutReport,
  type AgentPayoutSummaryRow,
  type AgentPayoutSettlement,
  type AgentPayoutPreview,
} from '@/lib/api';
import { formatMoney, formatPriceInline, eurToDen, denToEur } from '@/lib/currency';
import { formatDate, formatDayDmy } from '@/i18n/dates';
import { skopjeToday } from '@/components/insights/shared/period';

// DISPLAY ONLY — the payout maths (earned / settled / unpaid, the settlement
// amount) is untouched and stays in the stored EUR; every figure on screen and
// in the printed report is денари via formatMoney.

/** A YYYY-MM-DD (or timestamp) day as dd.mm.yyyy; '—' when missing. */
const dmy = (v: string | null | undefined) =>
  v ? String(v).slice(0, 10).split('-').reverse().join('.') : '—';

export default function PayoutTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  // The pickers' default day is Skopje's today (the UTC date was yesterday until 02:00). The
  // settlement window itself (bare `from`, `to` + 'T23:59:59Z') is payout maths — deferred by the
  // owner, left on its UTC days on purpose until he rules on it.
  const today = skopjeToday();
  const monthStart = today.slice(0, 7) + '-01';

  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [agentFilter, setAgentFilter] = useState('all');
  const [unpaidOnly, setUnpaidOnly] = useState(true);

  const [preview, setPreview] = useState<AgentPayoutPreview | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [markBusy, setMarkBusy] = useState(false);
  const [method, setMethod] = useState('cash');
  const [notes, setNotes] = useState('');
  const [paidOn, setPaidOn] = useState(today);
  // The settlement period lives in the dialog too — the filter bar above only
  // seeds it, so the operator can settle a period other than the one on screen.
  const [dlgFrom, setDlgFrom] = useState(monthStart);
  const [dlgTo, setDlgTo] = useState(today);
  // Free-typed amount, in DENARI (the API stores EUR — converted at the edges).
  // Kept as a string so the field can be emptied while typing.
  const [amountInput, setAmountInput] = useState('');
  const [overrideReason, setOverrideReason] = useState('');

  const [editRow, setEditRow] = useState<AgentPayoutSettlement | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editAmount, setEditAmount] = useState('');
  const [editPaidOn, setEditPaidOn] = useState('');
  const [editFrom, setEditFrom] = useState('');
  const [editTo, setEditTo] = useState('');
  const [editMethod, setEditMethod] = useState('cash');
  const [editNotes, setEditNotes] = useState('');
  const [editReason, setEditReason] = useState('');

  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: apiGetAgents,
  });

  const {
    data: summary = [],
    isLoading: summaryLoading,
    refetch: refetchSummary,
  } = useQuery({
    queryKey: ['agent-payout-summary', from, to, agentFilter],
    queryFn: () => apiGetAgentPayoutSummary({
      from: from || undefined,
      to: to ? to + 'T23:59:59Z' : undefined,
      agent_id: agentFilter !== 'all' ? agentFilter : undefined,
    }),
  });

  const {
    data: history = [],
    isLoading: historyLoading,
    refetch: refetchHistory,
  } = useQuery({
    queryKey: ['agent-payouts-history', agentFilter],
    queryFn: () => apiGetAgentPayouts({
      agent_id: agentFilter !== 'all' ? agentFilter : undefined,
      status: 'all',
    }),
  });

  const rows = unpaidOnly
    ? summary.filter((r: AgentPayoutSummaryRow) => (r.payout_unpaid || 0) > 0)
    : summary;

  const totalUnpaid = summary.reduce((s, r) => s + (r.payout_unpaid || 0), 0);
  const agentsWithBalance = summary.filter((r) => (r.payout_unpaid || 0) > 0).length;

  // Re-runs the commission engine for a period. Called when the dialog opens and
  // again whenever the operator moves either period date inside the dialog.
  const loadPreview = async (agentId: string, f: string, t2: string) => {
    setPreviewBusy(true);
    try {
      const p = await apiPreviewAgentPayout({
        agent_id: agentId,
        from: f || undefined,
        to: t2 ? t2 + 'T23:59:59Z' : undefined,
      });
      setPreview(p);
      // Keep the amount field on the calculated number until it's touched.
      setAmountInput(String(eurToDen(p.amount_eur)));
      return p;
    } finally {
      setPreviewBusy(false);
    }
  };

  const openMarkPaid = async (agentId: string) => {
    try {
      setMethod('cash');
      setNotes('');
      setPaidOn(today);
      setOverrideReason('');
      setDlgFrom(from);
      setDlgTo(to);
      await loadPreview(agentId, from, to);
      setPreviewOpen(true);
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    }
  };

  const changePeriod = async (nextFrom: string, nextTo: string) => {
    setDlgFrom(nextFrom);
    setDlgTo(nextTo);
    if (!preview) return;
    try {
      await loadPreview(preview.agent_user_id, nextFrom, nextTo);
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    }
  };

  // `parsedAmount` is DENARI — the same unit the field is prefilled in, so the
  // "operator changed the calculated figure" test is an exact integer compare.
  const parsedAmount = Number(amountInput);
  const amountValid = amountInput.trim() !== '' && Number.isFinite(parsedAmount) && parsedAmount >= 0;
  const amountOverridden = !!preview && amountValid
    && Math.round(parsedAmount) !== eurToDen(preview.amount_eur);
  // An untouched field pays out the calculated EUR verbatim. Round-tripping it
  // through denars can drift by a cent, which would look like a manual override
  // of an amount nobody edited.
  const amountEur = (v: number, computedEur: number, overridden: boolean) =>
    (overridden ? denToEur(v) : computedEur);

  const confirmMarkPaid = async () => {
    if (!preview) return;
    if (!amountValid) {
      toast({ title: t('common.error'), description: t('payout.amountInvalid'), variant: 'destructive' });
      return;
    }
    setMarkBusy(true);
    try {
      await apiCreateAgentPayout({
        agent_id: preview.agent_user_id,
        from: dlgFrom || undefined,
        to: dlgTo ? dlgTo + 'T23:59:59Z' : undefined,
        paid_on: paidOn,
        method,
        notes: notes || undefined,
        amount_eur: amountEur(parsedAmount, preview.amount_eur, amountOverridden),
        override_reason: amountOverridden ? (overrideReason || undefined) : undefined,
      });
      toast({ title: t('payout.markedPaid') });
      setPreviewOpen(false);
      setPreview(null);
      refetchSummary();
      refetchHistory();
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setMarkBusy(false);
    }
  };

  const openEdit = (h: AgentPayoutSettlement) => {
    setEditRow(h);
    setEditAmount(String(eurToDen(h.amount_eur)));
    setEditPaidOn(String(h.paid_on).slice(0, 10));
    setEditFrom(String(h.period_from).slice(0, 10));
    setEditTo(String(h.period_to).slice(0, 10));
    setEditMethod(h.method || 'cash');
    setEditNotes(h.notes || '');
    setEditReason(h.override_reason || '');
    setEditOpen(true);
  };

  const saveEdit = async () => {
    if (!editRow) return;
    const amt = Number(editAmount); // denari
    if (editAmount.trim() === '' || !Number.isFinite(amt) || amt < 0) {
      toast({ title: t('common.error'), description: t('payout.amountInvalid'), variant: 'destructive' });
      return;
    }
    if (editFrom && editTo && editFrom > editTo) {
      toast({ title: t('common.error'), description: t('payout.periodInvalid'), variant: 'destructive' });
      return;
    }
    setEditBusy(true);
    try {
      await apiUpdateAgentPayout(editRow.id, {
        amount_eur: amountEur(amt, editRow.amount_eur, Math.round(amt) !== eurToDen(editRow.amount_eur)),
        paid_on: editPaidOn,
        period_from: editFrom,
        period_to: editTo,
        method: editMethod,
        notes: editNotes,
        override_reason: editReason,
      });
      toast({ title: t('payout.updated') });
      setEditOpen(false);
      setEditRow(null);
      refetchSummary();
      refetchHistory();
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setEditBusy(false);
    }
  };

  const voidSettlement = async (id: string) => {
    const reason = window.prompt(t('payout.voidReasonPrompt')) || undefined;
    try {
      await apiVoidAgentPayout(id, reason);
      toast({ title: t('payout.voided') });
      refetchSummary();
      refetchHistory();
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    }
  };

  // Escape anything interpolated into the print HTML. The print window is
  // about:blank = same origin, so an unescaped <script> in a manager-entered
  // payout note (or agent name) would run in the printing admin's session.
  const esc = (v: unknown) =>
    String(v ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

  // Stored method codes ('cash' / 'bank' / 'other') → the reader's language;
  // anything else (older free text) is shown as saved.
  const methodLabel = (m: string | null | undefined) =>
    m === 'cash' ? t('payout.methodCash') : m === 'bank' ? t('payout.methodBank')
      : m === 'other' ? t('payout.methodOther') : (m || '—');

  const printReport = async (id: string) => {
    try {
      const report = await apiGetAgentPayoutReport(id);
      const s = report.settlement;
      const lines = (s.items || []).map((it: any) =>
        `<tr>
          <td style="padding:4px 8px;border-bottom:1px solid #eee">${esc(it.display_id || it.order_id?.slice(0, 8) || '—')}</td>
          <td style="padding:4px 8px;border-bottom:1px solid #eee">${it.paid_at ? esc(formatDayDmy(it.paid_at)) : '—'}</td>
          <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${Number(it.package_units)}</td>
          <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${formatMoney(it.bonus_eur)}</td>
        </tr>`).join('');
      const html = `<!DOCTYPE html><html><head><title>${esc(t('payout.reportTitle'))}</title>
        <style>
          body{font-family:system-ui,sans-serif;padding:32px;color:#111;max-width:800px;margin:0 auto}
          h1{font-size:20px;margin:0 0 4px} h2{font-size:14px;color:#555;font-weight:500;margin:0 0 24px}
          table{width:100%;border-collapse:collapse;font-size:13px;margin-top:16px}
          th{text-align:left;padding:6px 8px;border-bottom:2px solid #333;font-size:11px;text-transform:uppercase}
          .meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;margin-bottom:16px}
          .meta b{display:inline-block;min-width:120px;color:#555}
          .totals{margin-top:20px;padding:12px;background:#f5f5f5;border-radius:8px}
          .footer{margin-top:32px;font-size:11px;color:#888}
          @media print{body{padding:0} .noprint{display:none}}
        </style></head><body>
        <h1>${esc(t('payout.reportTitle'))}</h1>
        <h2>${esc(s.agent_name || '')} · ${esc(s.status === 'voided' ? t('payout.statusVoided') : t('payout.statusPaid'))}</h2>
        <div class="meta">
          <div><b>${esc(t('payout.colPeriod'))}</b> ${esc(dmy(s.period_from))} → ${esc(dmy(s.period_to))}</div>
          <div><b>${esc(t('payout.paidOn'))}</b> ${esc(dmy(s.paid_on))}</div>
          <div><b>${esc(t('payout.colPackages'))}</b> ${Number(s.packages_count)}</div>
          <div><b>${esc(t('payout.colAmount'))}</b> ${formatMoney(s.amount_eur)}</div>
          <div><b>${esc(t('payout.method'))}</b> ${esc(methodLabel(s.method))}</div>
          <div><b>${esc(t('payout.notes'))}</b> ${esc(s.notes || '—')}</div>
          ${s.amount_source === 'manual' ? `
          <div style="grid-column:1/-1"><b>${esc(t('payout.adjustedLabel'))}</b> ${esc(t('payout.adjustedDetail', {
            calculated: formatMoney(s.computed_amount_eur ?? 0),
            paid: formatMoney(s.amount_eur),
          }))}${s.override_reason ? ` — ${esc(s.override_reason)}` : ''}</div>` : ''}
        </div>
        <table><thead><tr>
          <th>${esc(t('payout.colOrder'))}</th><th>${esc(t('payout.colPaidAt'))}</th><th style="text-align:right">${esc(t('payout.colPackages'))}</th><th style="text-align:right">${esc(t('payout.colBonus'))}</th>
        </tr></thead><tbody>${lines}</tbody></table>
        <div class="totals">
          <strong>${esc(t('payout.totalPayout', {
            amount: `${formatMoney(s.amount_eur)}`,
          }))}</strong>
        </div>
        <p class="footer">${esc(t('payout.currencyNote'))}<br/>${esc(t('payout.generatedAt', { at: report.generated_at ? formatDate(report.generated_at, 'dd.MM.yyyy HH:mm') : '' }))}<br/>${esc(t('payout.commissionLegend'))}</p>
        <p class="noprint"><button onclick="window.print()">${esc(t('payout.printSavePdf'))}</button></p>
        <script>setTimeout(function(){window.print()},400)</script>
        </body></html>`;
      const w = window.open('', '_blank');
      if (w) {
        w.document.write(html);
        w.document.close();
      } else {
        toast({ title: t('common.error'), description: t('payout.printBlocked'), variant: 'destructive' });
      }
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card/60 p-3">
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-auto text-xs" />
        <span className="text-xs text-muted-foreground">→</span>
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-auto text-xs" />
        <Select value={agentFilter} onValueChange={setAgentFilter}>
          <SelectTrigger className="w-44 h-8 text-xs"><SelectValue placeholder={t('agentsTab.allAgents')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('agentsTab.allAgents')}</SelectItem>
            {agents.map((a: any) => (
              <SelectItem key={a.user_id} value={a.user_id}>{a.full_name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={unpaidOnly} onChange={(e) => setUnpaidOnly(e.target.checked)} />
          {t('payout.unpaidOnly')}
        </label>
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => { refetchSummary(); refetchHistory(); }}>
          {t('agentsTab.apply')}
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card className="border-none shadow-sm">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600">
              <Banknote className="h-5 w-5 text-white" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('payout.totalUnpaid')}</p>
              <p className="text-lg font-bold text-emerald-700">{formatPriceInline(totalUnpaid)}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-none shadow-sm">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary">
              <Users className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('payout.agentsWithBalance')}</p>
              <p className="text-lg font-bold">{agentsWithBalance}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-none shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">{t('payout.hint')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('payout.settledHint')}</p>
          </CardContent>
        </Card>
      </div>

      {summaryLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<Banknote className="h-5 w-5" />} title={t('payout.noBalances')} size="md" />
      ) : (
        <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30 text-muted-foreground">
                <th className="text-left px-3 py-3 font-medium">{t('agentsTab.colAgent')}</th>
                <th className="text-right px-3 py-3 font-medium">{t('payout.colPackagesSold')}</th>
                <th className="text-right px-3 py-3 font-medium">{t('payout.colAwaiting')}</th>
                <th className="text-right px-3 py-3 font-medium">{t('payout.colEarned')}</th>
                <th className="text-right px-3 py-3 font-medium">{t('payout.colSettled')}</th>
                <th className="text-right px-3 py-3 font-medium">{t('payout.colUnpaid')}</th>
                <th className="text-right px-3 py-3 font-medium">{t('payout.colLastPaid')}</th>
                <th className="text-right px-3 py-3 font-medium">{t('payout.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.agent_user_id} className="border-b last:border-0 hover:bg-muted/10">
                  <td className="px-3 py-3">
                    <p className="font-medium">{r.full_name}</p>
                    <p className="text-xs text-muted-foreground">{r.email}</p>
                  </td>
                  <td className="px-3 py-3 text-right">{r.packages_sold}</td>
                  <td className="px-3 py-3 text-right text-muted-foreground">{r.packages_awaiting}</td>
                  <td className="px-3 py-3 text-right">{formatMoney(r.payout_earned)}</td>
                  <td className="px-3 py-3 text-right text-muted-foreground">{formatMoney(r.payout_settled)}</td>
                  <td className="px-3 py-3 text-right font-semibold text-emerald-600">{formatMoney(r.payout_unpaid)}</td>
                  <td className="px-3 py-3 text-right text-xs">{dmy(r.last_paid_on)}</td>
                  <td className="px-3 py-3 text-right">
                    <Button
                      size="sm"
                      className="h-7 text-xs"
                      disabled={(r.payout_unpaid || 0) <= 0}
                      onClick={() => openMarkPaid(r.agent_user_id)}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                      {t('payout.markPaid')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t('payout.history')}</CardTitle>
        </CardHeader>
        <CardContent>
          {historyLoading ? (
            <Loader2 className="h-6 w-6 animate-spin mx-auto my-8" />
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">{t('payout.noHistory')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground text-xs">
                    <th className="text-left py-2">{t('agentsTab.colAgent')}</th>
                    <th className="text-left py-2">{t('payout.colPeriod')}</th>
                    <th className="text-right py-2">{t('payout.colPackages')}</th>
                    <th className="text-right py-2">{t('payout.colAmount')}</th>
                    <th className="text-right py-2">{t('payout.colPaidOn')}</th>
                    <th className="text-left py-2 pl-3">{t('payout.method')}</th>
                    <th className="text-left py-2">{t('payout.notes')}</th>
                    <th className="text-right py-2">{t('payout.colStatus')}</th>
                    <th className="text-right py-2">{t('payout.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h: AgentPayoutSettlement) => (
                    <tr key={h.id} className="border-b last:border-0">
                      <td className="py-2">{h.agent_name || h.agent_user_id.slice(0, 8)}</td>
                      <td className="py-2 text-xs text-muted-foreground">
                        {dmy(h.period_from)} → {dmy(h.period_to)}
                      </td>
                      <td className="py-2 text-right">{h.packages_count}</td>
                      <td className="py-2 text-right font-semibold whitespace-nowrap">
                        {formatMoney(h.amount_eur)}
                        {h.amount_source === 'manual' && (
                          <span
                            className="ml-1 text-[10px] text-amber-600"
                            title={t('payout.adjustedFrom', {
                              amount: formatMoney(Number(h.computed_amount_eur ?? 0)),
                            })}
                          >
                            ✎
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-right text-xs">{dmy(h.paid_on)}</td>
                      <td className="py-2 pl-3 text-xs text-muted-foreground">{methodLabel(h.method)}</td>
                      <td className="py-2 text-xs text-muted-foreground max-w-[220px]">
                        <span className="block truncate" title={h.notes || undefined}>
                          {h.notes || '—'}
                        </span>
                      </td>
                      <td className="py-2 text-right">
                        <span className={h.status === 'voided' ? 'text-destructive' : 'text-emerald-600'}>
                          {h.status === 'voided' ? t('payout.statusVoided') : t('payout.statusPaid')}
                        </span>
                      </td>
                      <td className="py-2 text-right space-x-1 whitespace-nowrap">
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => openEdit(h)}>
                          <Pencil className="h-3.5 w-3.5 mr-1" />
                          {t('common.edit')}
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => printReport(h.id)}>
                          <Printer className="h-3.5 w-3.5 mr-1" />
                          {t('payout.print')}
                        </Button>
                        {h.status === 'paid' && (
                          <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => voidSettlement(h.id)}>
                            <XCircle className="h-3.5 w-3.5 mr-1" />
                            {t('payout.void')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('payout.confirmTitle', { name: preview?.full_name || '' })}</DialogTitle>
          </DialogHeader>
          {preview && (
            <div className="space-y-3 text-sm">
              <p>
                {t('payout.confirmBody', {
                  packages: preview.packages_count,
                  orders: preview.order_count,
                  amount: formatMoney(preview.amount_eur),
                })}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">{t('payout.periodFrom')}</Label>
                  <Input
                    type="date"
                    value={dlgFrom}
                    onChange={(e) => changePeriod(e.target.value, dlgTo)}
                    className="h-8"
                  />
                </div>
                <div>
                  <Label className="text-xs">{t('payout.periodTo')}</Label>
                  <Input
                    type="date"
                    value={dlgTo}
                    onChange={(e) => changePeriod(dlgFrom, e.target.value)}
                    className="h-8"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground flex items-center gap-2">
                {previewBusy && <Loader2 className="h-3 w-3 animate-spin" />}
                {t('payout.periodHint')}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">{t('payout.paidOn')}</Label>
                  <Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className="h-8" />
                </div>
                <div>
                  <Label className="text-xs">{t('payout.method')}</Label>
                  <Select value={method} onValueChange={setMethod}>
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cash">{t('payout.methodCash')}</SelectItem>
                      <SelectItem value="bank">{t('payout.methodBank')}</SelectItem>
                      <SelectItem value="other">{t('payout.methodOther')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label className="text-xs">{t('payout.amountToPay')}</Label>
                <Input
                  type="number"
                  step="1"
                  min="0"
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  className="h-8 font-semibold"
                />
                <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {t('payout.calculatedWas', { amount: formatMoney(preview.amount_eur) })}
                  </span>
                  {amountOverridden && (
                    <button
                      type="button"
                      className="flex items-center gap-1 text-primary hover:underline"
                      onClick={() => setAmountInput(String(eurToDen(preview.amount_eur)))}
                    >
                      <RotateCcw className="h-3 w-3" />
                      {t('payout.resetAmount')}
                    </button>
                  )}
                </div>
              </div>
              {amountOverridden && (
                <div>
                  <Label className="text-xs">{t('payout.overrideReason')}</Label>
                  <Input
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    placeholder={t('payout.overrideReasonPlaceholder')}
                    className="h-8"
                  />
                </div>
              )}
              <div>
                <Label className="text-xs">{t('payout.notes')}</Label>
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="text-sm" />
              </div>
              <div className="max-h-40 overflow-y-auto rounded border text-xs">
                <table className="w-full">
                  <thead>
                    <tr className="bg-muted/40">
                      <th className="text-left p-1">{t('payout.colOrder')}</th>
                      <th className="text-right p-1">{t('payout.colPkg')}</th>
                      <th className="text-right p-1">{t('payout.colBonus')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.items.slice(0, 50).map((it) => (
                      <tr key={it.order_id} className="border-t">
                        <td className="p-1">{it.display_id || it.order_id.slice(0, 8)}</td>
                        <td className="p-1 text-right">{it.package_units}</td>
                        <td className="p-1 text-right">{formatMoney(it.bonus_eur)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.items.length > 50 && (
                  <p className="p-2 text-muted-foreground">{t('payout.andMore', { n: preview.items.length - 50 })}</p>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>{t('common.cancel')}</Button>
            <Button
              onClick={confirmMarkPaid}
              disabled={markBusy || previewBusy || !preview || preview.order_count <= 0 || !amountValid}
            >
              {markBusy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {t('payout.confirmMark')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Correct a settlement after it was marked paid. Order line items are
          untouched, so the agent's unpaid balance never shifts from an edit. */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('payout.editTitle', { name: editRow?.agent_name || '' })}</DialogTitle>
          </DialogHeader>
          {editRow && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">{t('payout.periodFrom')}</Label>
                  <Input type="date" value={editFrom} onChange={(e) => setEditFrom(e.target.value)} className="h-8" />
                </div>
                <div>
                  <Label className="text-xs">{t('payout.periodTo')}</Label>
                  <Input type="date" value={editTo} onChange={(e) => setEditTo(e.target.value)} className="h-8" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">{t('payout.paidOn')}</Label>
                  <Input type="date" value={editPaidOn} onChange={(e) => setEditPaidOn(e.target.value)} className="h-8" />
                </div>
                <div>
                  <Label className="text-xs">{t('payout.method')}</Label>
                  <Select value={editMethod} onValueChange={setEditMethod}>
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cash">{t('payout.methodCash')}</SelectItem>
                      <SelectItem value="bank">{t('payout.methodBank')}</SelectItem>
                      <SelectItem value="other">{t('payout.methodOther')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label className="text-xs">{t('payout.amountToPay')}</Label>
                <Input
                  type="number"
                  step="1"
                  min="0"
                  value={editAmount}
                  onChange={(e) => setEditAmount(e.target.value)}
                  className="h-8 font-semibold"
                />
                <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {t('payout.calculatedWas', {
                      amount: formatMoney(Number(editRow.computed_amount_eur ?? editRow.amount_eur)),
                    })}
                  </span>
                  <button
                    type="button"
                    className="flex items-center gap-1 text-primary hover:underline"
                    onClick={() =>
                      setEditAmount(String(eurToDen(editRow.computed_amount_eur ?? editRow.amount_eur)))}
                  >
                    <RotateCcw className="h-3 w-3" />
                    {t('payout.resetAmount')}
                  </button>
                </div>
              </div>
              <div>
                <Label className="text-xs">{t('payout.overrideReason')}</Label>
                <Input
                  value={editReason}
                  onChange={(e) => setEditReason(e.target.value)}
                  placeholder={t('payout.overrideReasonPlaceholder')}
                  className="h-8"
                />
              </div>
              <div>
                <Label className="text-xs">{t('payout.notes')}</Label>
                <Textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} rows={2} className="text-sm" />
              </div>
              <p className="text-xs text-muted-foreground">{t('payout.editHint')}</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={saveEdit} disabled={editBusy}>
              {editBusy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
