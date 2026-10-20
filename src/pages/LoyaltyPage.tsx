import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Medal, Store, X } from 'lucide-react';
import { AppLayout } from '@/layouts/AppLayout';
import { EmptyState } from '@/components/EmptyState';
import { LoadError } from '@/components/insights/shared/LoadError';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { dm, useOverviewFormat } from '@/components/insights/overview/useOverviewFormat';
import { useLoyaltyAccess } from '@/components/loyalty/useLoyaltyAccess';
import {
  apiGetLoyaltyPage, apiGetLoyaltyPhone, apiGetLoyaltyWebPage, isPhone8,
  type LoyaltyPhone, type LoyaltyRow, type LoyaltyWebRow,
} from '@/lib/loyaltyApi';
import { formatSkopje } from '@/lib/skopjeTime';
import { apiErrorText } from '@/i18n/apiErrors';
import { cn } from '@/lib/utils';

type LoyaltyTab = 'crm' | 'web';

/**
 * /loyalty "Лојалност", two tabs (owner 20.10.2026: "се да биде од едно место"):
 *  - CRM поени: sure points for delivered Teleshop Out parcels from 01.03.2026,
 *    NaturaTherapy lines only (migrations 20261006120000 / 20261020120000).
 *  - Веб поени (?tab=web): the naturatherapy.mk shop's own balance, mirrored hourly
 *    (20261020130000). Shown next to the CRM points, never added to them.
 * Owners, admins and managers. Insights card language, a table from md and cards below it.
 */
export default function LoyaltyPage() {
  const { t } = useTranslation();
  const f = useOverviewFormat();
  const access = useLoyaltyAccess();
  const [sp, setSp] = useSearchParams();
  const tab: LoyaltyTab = sp.get('tab') === 'web' ? 'web' : 'crm';
  const qParam = (sp.get('q') ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const page = Math.max(1, Number(sp.get('page')) || 1);
  const phone = sp.get('phone');
  const phone8 = isPhone8(phone) ? phone : null;

  const list = useQuery({
    queryKey: ['loyalty', 'page', qParam, page],
    queryFn: ({ signal }) => apiGetLoyaltyPage(qParam, page, signal),
    enabled: access.any && tab === 'crm',
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const web = useQuery({
    queryKey: ['loyalty', 'web', qParam, page],
    queryFn: ({ signal }) => apiGetLoyaltyWebPage(qParam, page, signal),
    enabled: access.any && tab === 'web',
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const detail = useQuery({
    queryKey: ['loyalty', 'phone', phone8],
    queryFn: ({ signal }) => apiGetLoyaltyPhone(phone8 as string, signal),
    enabled: access.any && !!phone8,
    staleTime: 30_000,
  });

  if (!access.any) {
    return (
      <AppLayout title={t('nav.loyalty')}>
        <EmptyState icon={<Medal className="h-5 w-5" />} title={t('loyalty.noAccess')} description={t('loyalty.noAccessDesc')} />
      </AppLayout>
    );
  }

  const summary = list.data?.summary;
  const rows = list.data?.rows ?? [];
  const webSummary = web.data?.summary;
  const webRows = web.data?.rows ?? [];
  const active = tab === 'web' ? web : list;
  const total = active.data?.total ?? 0;
  const size = active.data?.size ?? 50;
  const pages = Math.max(1, Math.ceil(total / size));

  const open = (p8: string) => {
    setSp((prev) => {
      const n = new URLSearchParams(prev);
      n.set('phone', p8);
      return n;
    });
  };
  const switchTab = (next: string) => {
    setSp((prev) => {
      const n = new URLSearchParams(prev);
      if (next === 'web') n.set('tab', 'web');
      else n.delete('tab');
      n.delete('q');
      n.delete('page');
      return n;
    });
  };
  const close = () => {
    setSp((prev) => {
      const n = new URLSearchParams(prev);
      n.delete('phone');
      return n;
    }, { replace: true });
  };
  const go = (next: number) => {
    setSp((prev) => {
      const n = new URLSearchParams(prev);
      if (next <= 1) n.delete('page');
      else n.set('page', String(next));
      return n;
    });
  };

  return (
    <AppLayout title={t('nav.loyalty')}>
      <div className="mx-auto min-w-0 max-w-[1680px] space-y-4">
        <Tabs value={tab} onValueChange={switchTab}>
          <TabsList className="w-full justify-start sm:w-auto">
            <TabsTrigger value="crm">{t('loyalty.tab.crm')}</TabsTrigger>
            <TabsTrigger value="web">{t('loyalty.tab.web')}</TabsTrigger>
          </TabsList>
        </Tabs>

        <p className="text-sm text-muted-foreground">{t(tab === 'web' ? 'loyalty.webIntro' : 'loyalty.intro')}</p>

        {tab === 'web' ? (
          <ul
            className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4"
            aria-label={webSummary ? t('loyalty.webSummary', {
              customers: f.int(webSummary.customers),
              points: f.int(webSummary.points),
            }) : t('loyalty.tab.web')}
          >
            <Kpi label={t('loyalty.webTile.customers')} value={webSummary ? f.int(webSummary.customers) : '—'} />
            <Kpi label={t('loyalty.webTile.points')} value={webSummary ? f.int(webSummary.points) : '—'} />
            <Kpi label={t('loyalty.webTile.withCrm')} value={webSummary ? f.int(webSummary.with_crm) : '—'} />
            <Kpi
              label={t('loyalty.webTile.synced')}
              value={webSummary?.synced_at ? formatSkopje(webSummary.synced_at, 'dd.MM. HH:mm') : '—'}
            />
          </ul>
        ) : (
          <ul
            className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4"
            aria-label={summary ? t('loyalty.summary', {
              customers: f.int(summary.customers),
              points: f.int(summary.points),
              orders: f.int(summary.orders),
            }) : t('nav.loyalty')}
          >
            <Kpi label={t('loyalty.tile.customers')} value={summary ? f.int(summary.customers) : '—'} />
            <Kpi label={t('loyalty.tile.points')} value={summary ? f.int(summary.points) : '—'} />
            <Kpi label={t('loyalty.tile.orders')} value={summary ? f.int(summary.orders) : '—'} />
            <Kpi label={t('loyalty.tile.onShop')} value={summary ? f.int(summary.on_shop) : '—'} />
          </ul>
        )}

        <SearchBox key={tab} value={qParam} placeholder={t(tab === 'web' ? 'loyalty.webSearch' : 'loyalty.search')} />

        {phone8 && (
          <Detail
            data={detail.data}
            loading={detail.isLoading}
            error={detail.error}
            onRetry={() => void detail.refetch()}
            onClose={close}
            f={f}
          />
        )}

        {active.isLoading && !active.data ? (
          <div className="flex justify-center py-12" role="status">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden />
          </div>
        ) : active.isError ? (
          <LoadError text={errorText(active.error, (key) => t(key))} onRetry={() => void active.refetch()} />
        ) : (tab === 'web' ? webRows.length : rows.length) === 0 ? (
          <EmptyState icon={<Medal className="h-5 w-5" />} title={t('loyalty.empty')} size="sm" />
        ) : tab === 'web' ? (
          <WebList rows={webRows} onOpen={open} active={phone8} f={f} />
        ) : (
          <CustomerList rows={rows} onOpen={(r) => open(r.phone8)} active={phone8} f={f} />
        )}

        {total > size && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs tabular-nums text-muted-foreground">{t('loyalty.page', { page: f.int(page), pages: f.int(pages) })}</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="min-h-9" disabled={page <= 1} onClick={() => go(page - 1)}>{t('loyalty.prev')}</Button>
              <Button variant="outline" size="sm" className="min-h-9" disabled={page >= pages} onClick={() => go(page + 1)}>{t('loyalty.next')}</Button>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex min-w-0 flex-col rounded-xl border bg-card p-3 shadow-sm sm:p-4">
      <span className="text-xs font-medium leading-tight text-muted-foreground">{label}</span>
      <span className="mt-1 break-words text-lg font-semibold leading-tight tabular-nums text-card-foreground sm:text-xl 2xl:text-2xl">{value}</span>
    </li>
  );
}

function SearchBox({ value, placeholder }: { value: string; placeholder: string }) {
  const [, setSp] = useSearchParams();
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => {
    const handle = setTimeout(() => {
      const next = draft.replace(/\s+/g, ' ').trim().slice(0, 80);
      if (next === value) return;
      setSp((prev) => {
        const n = new URLSearchParams(prev);
        if (next) n.set('q', next);
        else n.delete('q');
        n.delete('page');
        return n;
      }, { replace: true });
    }, 300);
    return () => clearTimeout(handle);
  }, [draft, value, setSp]);

  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      maxLength={80}
      className="min-h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm sm:max-w-sm"
    />
  );
}

/** The web side of a CRM row: the shop's points when there are any, else the profile badge. */
function ShopBadge({ profiles, points = 0 }: { profiles: number; points?: number }) {
  const { t } = useTranslation();
  const f = useOverviewFormat();
  if (profiles <= 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-950 dark:bg-amber-950/60 dark:text-amber-100"
      title={t('loyalty.hint')}
    >
      <Store className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate tabular-nums">
        {points > 0 ? `${f.int(points)} ${t('loyalty.col.web').toLowerCase()}` : t('loyalty.badge')}
      </span>
    </span>
  );
}

function WebList({
  rows, onOpen, active, f,
}: {
  rows: LoyaltyWebRow[];
  onOpen: (phone8: string) => void;
  active: string | null;
  f: ReturnType<typeof useOverviewFormat>;
}) {
  const { t } = f;
  const crm = (n: number) => (n > 0 ? f.int(n) : '—');
  return (
    <>
      <div className="hidden min-w-0 rounded-xl border bg-card shadow-sm md:block">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('loyalty.tab.web')}</caption>
          <thead>
            <tr className="border-b bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-3 py-2 font-medium">{t('loyalty.col.customer')}</th>
              <th scope="col" className="px-2 py-2 font-medium">{t('loyalty.col.phone')}</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">{t('loyalty.col.web')}</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">{t('loyalty.col.webOrders')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('loyalty.col.crm')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const p8 = r.phone8;
              return (
                <tr
                  key={r.key}
                  className={cn(
                    'border-b last:border-0',
                    p8 && 'cursor-pointer hover:bg-muted/40',
                    p8 && active === p8 && 'bg-muted/60',
                  )}
                  onClick={p8 ? () => onOpen(p8) : undefined}
                >
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    {p8 ? (
                      <button type="button" className="block max-w-full text-left" onClick={() => onOpen(p8)}>
                        <span className="block truncate">{r.name || '—'}</span>
                        {r.city && <span className="block truncate text-xs font-normal text-muted-foreground">{r.city}</span>}
                      </button>
                    ) : (
                      <>
                        <span className="block truncate">{r.name || '—'}</span>
                        {r.city && <span className="block truncate text-xs font-normal text-muted-foreground">{r.city}</span>}
                      </>
                    )}
                  </th>
                  <td className="whitespace-nowrap px-2 py-2 tabular-nums">{r.phone || '—'}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right font-semibold tabular-nums">{f.int(r.points)}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted-foreground">{f.int(r.orders)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground">{crm(r.crm_points)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="grid grid-cols-1 gap-2 md:hidden">
        {rows.map((r) => {
          const p8 = r.phone8;
          const body = (
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-medium">{r.name || '—'}</div>
                <div className="truncate text-xs text-muted-foreground">{[r.phone, r.city].filter(Boolean).join(' · ') || '—'}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-base font-semibold tabular-nums">{f.int(r.points)}</div>
                <div className="text-xs tabular-nums text-muted-foreground">{t('loyalty.col.webOrders')} {f.int(r.orders)}</div>
                {r.crm_points > 0 && (
                  <div className="text-xs tabular-nums text-muted-foreground">{t('loyalty.col.crm')} {f.int(r.crm_points)}</div>
                )}
              </div>
            </div>
          );
          const cls = cn('w-full min-w-0 rounded-xl border bg-card p-3 text-left shadow-sm', p8 && active === p8 && 'border-primary');
          return (
            <li key={r.key} className="min-w-0">
              {p8 ? <button type="button" onClick={() => onOpen(p8)} className={cls}>{body}</button> : <div className={cls}>{body}</div>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function CustomerList({
  rows, onOpen, active, f,
}: {
  rows: LoyaltyRow[];
  onOpen: (row: LoyaltyRow) => void;
  active: string | null;
  f: ReturnType<typeof useOverviewFormat>;
}) {
  const { t } = f;
  return (
    <>
      <div className="hidden min-w-0 rounded-xl border bg-card shadow-sm md:block">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('nav.loyalty')}</caption>
          <thead>
            <tr className="border-b bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-3 py-2 font-medium">{t('loyalty.col.customer')}</th>
              <th scope="col" className="px-2 py-2 font-medium">{t('loyalty.col.phone')}</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">{t('loyalty.col.points')}</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">{t('loyalty.col.orders')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('loyalty.col.shop')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.phone8}
                className={cn('cursor-pointer border-b last:border-0 hover:bg-muted/40', active === r.phone8 && 'bg-muted/60')}
                onClick={() => onOpen(r)}
              >
                <th scope="row" className="px-3 py-2 text-left font-medium">
                  <button type="button" className="block max-w-full text-left" onClick={() => onOpen(r)}>
                    <span className="block truncate">{r.name || '—'}</span>
                    {r.city && <span className="block truncate text-xs font-normal text-muted-foreground">{r.city}</span>}
                  </button>
                </th>
                <td className="whitespace-nowrap px-2 py-2 tabular-nums">{r.phone || '—'}</td>
                <td className="whitespace-nowrap px-2 py-2 text-right font-semibold tabular-nums">{f.int(r.points)}</td>
                <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted-foreground">{f.int(r.orders)}</td>
                <td className="px-3 py-2"><ShopBadge profiles={r.shop_profiles} points={r.web_points} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="grid grid-cols-1 gap-2 md:hidden">
        {rows.map((r) => (
          <li key={r.phone8} className="min-w-0">
            <button
              type="button"
              onClick={() => onOpen(r)}
              className={cn(
                'w-full min-w-0 rounded-xl border bg-card p-3 text-left shadow-sm',
                active === r.phone8 && 'border-primary',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{r.name || '—'}</div>
                  <div className="truncate text-xs text-muted-foreground">{[r.phone, r.city].filter(Boolean).join(' · ') || '—'}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-base font-semibold tabular-nums">{f.int(r.points)}</div>
                  <div className="text-xs tabular-nums text-muted-foreground">{t('loyalty.col.orders')} {f.int(r.orders)}</div>
                </div>
              </div>
              {r.shop_profiles > 0 && <div className="mt-2"><ShopBadge profiles={r.shop_profiles} points={r.web_points} /></div>}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function Detail({
  data, loading, error, onRetry, onClose, f,
}: {
  data: LoyaltyPhone | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onClose: () => void;
  f: ReturnType<typeof useOverviewFormat>;
}) {
  const { t } = f;
  const missing = error instanceof Error && /\b404\b|not found/i.test(error.message);
  return (
    <section aria-labelledby="loyalty-detail" className="min-w-0 space-y-3 rounded-xl border bg-card p-3 shadow-sm sm:p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="loyalty-detail" className="text-base font-semibold">{t('loyalty.detailTitle')}</h2>
          {data && (
            <p className="truncate text-xs text-muted-foreground">
              {[data.name, data.phone, data.city].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" className="min-h-9 shrink-0" onClick={onClose}>
          <X className="h-3.5 w-3.5" aria-hidden />{t('loyalty.close')}
        </Button>
      </div>
      {loading && !data ? (
        <div className="flex justify-center py-6" role="status">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden />
        </div>
      ) : missing ? (
        <p className="text-sm text-muted-foreground">{t('loyalty.missing')}</p>
      ) : error ? (
        <LoadError text={errorText(error, (key) => t(key))} onRetry={onRetry} />
      ) : data ? (
        <>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm tabular-nums">
            <span><span className="font-semibold">{f.int(data.points)}</span> <span className="text-muted-foreground">{t('loyalty.tile.points')}</span></span>
            <span className="text-muted-foreground">{t('loyalty.col.orders')} {f.int(data.orders)}</span>
            <span className="text-muted-foreground">{f.den(data.nt_mkd)}</span>
            {data.shop_profiles > 0 && data.web_points <= 0 && <ShopBadge profiles={data.shop_profiles} />}
          </div>
          {data.web_points > 0 && (
            <p className="flex items-center gap-1.5 text-sm tabular-nums">
              <Store className="h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
              {t('loyalty.webLine', { points: f.int(data.web_points), orders: f.int(data.web_orders) })}
            </p>
          )}
          {data.shop_profiles > 0 && (
            <p className="text-xs text-muted-foreground">{t('loyalty.hint')}</p>
          )}
          {data.grants.length === 0
            ? <p className="text-sm text-muted-foreground">{t('loyalty.noCrm')}</p>
            : <GrantTable grants={data.grants} f={f} />}
        </>
      ) : null}
    </section>
  );
}

function GrantTable({ grants, f }: { grants: LoyaltyPhone['grants']; f: ReturnType<typeof useOverviewFormat> }) {
  const { t } = f;
  if (!grants.length) return <p className="text-sm text-muted-foreground">{t('loyalty.empty')}</p>;
  return (
    <>
      <div className="hidden md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-2 py-1.5 font-medium">{t('loyalty.col.day')}</th>
              <th scope="col" className="px-2 py-1.5 font-medium">{t('loyalty.col.order')}</th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('loyalty.col.nt')}</th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('loyalty.col.points')}</th>
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr key={`${g.sale_day}-${g.display_id ?? ''}-${g.mex_tracking_id}`} className="border-b last:border-0">
                <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{g.sale_day ? dm(g.sale_day, true) : '—'}</td>
                <td className="px-2 py-1.5 font-mono text-xs">{g.display_id || g.mex_tracking_id}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{f.den(g.nt_mkd)}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right font-semibold tabular-nums">{f.int(g.points)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {grants.map((g) => (
          <li key={`${g.sale_day}-${g.display_id ?? ''}-${g.mex_tracking_id}`} className="rounded-lg border p-3 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium tabular-nums">{g.sale_day ? dm(g.sale_day, true) : '—'}</span>
              <span className="font-semibold tabular-nums">{f.int(g.points)}</span>
            </div>
            <div className="mt-0.5 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
              <span className="min-w-0 truncate font-mono">{g.display_id || g.mex_tracking_id}</span>
              <span className="shrink-0 tabular-nums">{f.den(g.nt_mkd)}</span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function errorText(error: unknown, t: (k: string) => string): string {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  if (/^forbidden$/i.test(msg.trim())) return t('loyalty.noAccess');
  return apiErrorText(error);
}
