import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, User, Loader2, X } from 'lucide-react';
import { apiSearchPrediction } from '@/lib/api';
import { CustomerSearchModal } from './CustomerSearchModal';
import { useMaxWidth } from '@/hooks/use-mobile';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface CustomerHit { phone: string; name: string; count: number; }

// Collapse the matched orders into distinct customers, keyed by the last 8
// phone digits (same normalisation the backend uses). Orders arrive newest
// first, so the first occurrence carries the freshest name.
function groupByCustomer(orders: any[]): CustomerHit[] {
  const map = new Map<string, CustomerHit>();
  for (const o of orders) {
    const phone = o.customer_phone || '';
    if (!phone) continue;
    const key = phone.replace(/\D/g, '').slice(-8) || phone;
    if (!map.has(key)) map.set(key, { phone, name: o.customer_name || '', count: 0 });
    const e = map.get(key)!;
    e.count++;
    if (!e.name && o.customer_name) e.name = o.customer_name;
  }
  return [...map.values()];
}

/**
 * Topbar global search. Debounced lookups against /search-prediction (phone /
 * name / order-ID), shown as a dropdown of matching customers + leads. Picking
 * one opens a detail modal with their full order history and a Call button.
 */
export function GlobalSearch() {
  const { t } = useTranslation();
  // phone AND tablet (below lg): an icon that opens the search dialog — the top bar has no room for the
  // wide input there (768 px cut the avatar off, 30.09.2026)
  const isMobile = useMaxWidth(1023);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [customers, setCustomers] = useState<CustomerHit[]>([]);
  const [leads, setLeads] = useState<any[]>([]);
  const [modal, setModal] = useState<{ phone: string; name: string } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);

  // Debounced search — ignores out-of-order responses via reqId.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setCustomers([]); setLeads([]); setOpen(false); setLoading(false); return; }
    const id = ++reqId.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const data = await apiSearchPrediction(term);
        if (id !== reqId.current) return;
        setCustomers(groupByCustomer(data.orders).slice(0, 6));
        setLeads((data.leads || []).slice(0, 4));
        setOpen(true);
      } catch {
        if (id === reqId.current) { setCustomers([]); setLeads([]); }
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  // Close the dropdown on outside click.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const pickCustomer = (c: CustomerHit) => { setModal({ phone: c.phone, name: c.name }); setOpen(false); };
  const pickLead = (l: any) => { setModal({ phone: l.telephone, name: l.name || '' }); setOpen(false); };

  const hasResults = customers.length > 0 || leads.length > 0;

  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

  const openMobileSearch = () => {
    setMobileSearchOpen(true);
    setQ('');
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      {isMobile ? (
        <>
          <Button variant="ghost" size="icon" className="h-9 w-9" onClick={openMobileSearch} aria-label={t('common.search')}>
            <Search className="h-4 w-4" />
          </Button>
          <Dialog open={mobileSearchOpen} onOpenChange={setMobileSearchOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>{t('common.search')}</DialogTitle>
              </DialogHeader>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && customers[0]) {
                      pickCustomer(customers[0]);
                      setMobileSearchOpen(false);
                    }
                  }}
                  placeholder={t('search.placeholder')}
                  className="h-9 w-full rounded-lg border bg-background pl-9 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  autoFocus
                />
                {loading && <Loader2 className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />}
              </div>
              {open && hasResults && (
                <div className="max-h-[60vh] overflow-y-auto py-1 border-t mt-2">
                  {/* results content same as below, but to avoid duplication, we can render results here too */}
                  {customers.length > 0 && (
                    <div>
                      <div className="px-3 py-1 text-xs font-semibold text-muted-foreground">{t('search.customers')}</div>
                      {customers.map(c => (
                        <button key={c.phone} onClick={() => { pickCustomer(c); setMobileSearchOpen(false); }} className="w-full text-left px-3 py-2 hover:bg-muted flex items-center gap-2 text-sm">
                          <User className="h-4 w-4" /> {c.name || c.phone} <span className="text-muted-foreground text-xs">({c.count})</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {leads.length > 0 && (
                    <div>
                      <div className="px-3 py-1 text-xs font-semibold text-muted-foreground">{t('search.leads')}</div>
                      {leads.map(l => (
                        <button key={l.telephone} onClick={() => { pickLead(l); setMobileSearchOpen(false); }} className="w-full text-left px-3 py-2 hover:bg-muted flex items-center gap-2 text-sm">
                          <User className="h-4 w-4" /> {l.name || l.telephone}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </DialogContent>
          </Dialog>
        </>
      ) : (
        <>
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => { if (hasResults) setOpen(true); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && customers[0]) pickCustomer(customers[0]);
              if (e.key === 'Escape') setOpen(false);
            }}
            placeholder={t('search.placeholder')}
            className="h-9 w-72 rounded-lg border bg-background pl-9 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {loading && <Loader2 className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />}
        </>
      )}

      {open && (
        <div className="absolute right-0 z-50 mt-1 w-96 rounded-lg border bg-popover text-popover-foreground shadow-lg overflow-hidden">
          {!hasResults ? (
            <div className="px-3 py-4 text-sm text-muted-foreground text-center">
              {loading ? t('search.searching') : t('search.noMatches')}
            </div>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto py-1">
              {customers.length > 0 && (
                <>
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">{t('search.customers')}</div>
                  {customers.map((c) => (
                    <button
                      key={c.phone}
                      onClick={() => pickCustomer(c)}
                      className="w-full text-left px-3 py-2 hover:bg-muted transition-colors flex items-center gap-2"
                    >
                      <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{c.name || t('common.unknown')}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{c.phone}</div>
                      </div>
                      <span className="text-[10px] text-muted-foreground shrink-0">{t('historyDialog.nOrders', { count: c.count })}</span>
                    </button>
                  ))}
                </>
              )}
              {leads.length > 0 && (
                <>
                  <div className="px-3 py-1 mt-1 text-[10px] uppercase tracking-wider text-muted-foreground border-t">{t('search.leads')}</div>
                  {leads.map((l) => (
                    <button
                      key={l.id}
                      onClick={() => pickLead(l)}
                      className="w-full text-left px-3 py-2 hover:bg-muted transition-colors flex items-center gap-2"
                    >
                      <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{l.name || t('common.unknown')}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{l.telephone}</div>
                      </div>
                      <span className="text-[10px] text-muted-foreground shrink-0">{l.status ? t(`leadStatus.${l.status}`, { defaultValue: l.status.replace(/_/g, ' ') }) : ''}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}

      <CustomerSearchModal
        phone={modal?.phone ?? null}
        seedName={modal?.name}
        open={!!modal}
        onClose={() => setModal(null)}
      />
    </div>
  );
}
