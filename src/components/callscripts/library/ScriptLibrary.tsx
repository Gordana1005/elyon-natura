import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FileText, Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/hooks/use-toast';
import { useMinWidth } from '@/lib/products/useMinWidth';
import type { CoverageResponse, ScriptsLibrary, TargetedScript } from '@/lib/callScriptsTypes';
import {
  editorHref, filterLibrary, isLegacy, libraryCounts, readLibraryParams, twinsOf, writeLibraryParams, type LibraryFilters as Filters,
} from '../scriptsModel';
import { useDeletedScripts, useScriptsWrites, type ScriptsPerms } from '../useCallScriptsAdmin';
import { scriptsErrorText } from '../errors';
import { useScriptLabels } from '../parts';
import { LibraryFilters } from './LibraryFilters';
import { LibraryTable } from './LibraryTable';
import { LibraryCards } from './LibraryCards';
import { BulkBar } from './BulkBar';
import { AttachDialog } from './AttachDialog';

/**
 * Library (Библиотека): every targeted script + today's 11 product scripts (the legacy /calls
 * panel, opened on their own tab). Filters live in the URL. Writers select rows for the bulk bar
 * and open the editor; agents read the published scripts only (the api filters for them).
 */
export function ScriptLibrary({ perms, library, loading, error, coverage }: {
  perms: ScriptsPerms;
  library: ScriptsLibrary | undefined;
  loading: boolean;
  error: unknown;
  coverage?: CoverageResponse | null;
}) {
  const L = useScriptLabels();
  const { t } = L;
  const [sp, setSp] = useSearchParams();
  const wide = useMinWidth(768);
  const spKey = sp.toString();
  const f = useMemo(() => readLibraryParams(new URLSearchParams(spKey)), [spKey]);
  const onChange = useCallback((patch: Partial<Filters>) => setSp((prev) => writeLibraryParams(prev, patch), { replace: true }), [setSp]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [attachOpen, setAttachOpen] = useState(false);
  const [deletedOpen, setDeletedOpen] = useState(false);

  const scripts = useMemo(() => library?.scripts ?? [], [library]);
  const products = useMemo(() => library?.products ?? [], [library]);
  const twins = useMemo(() => twinsOf(products), [products]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products]);
  const productName = useCallback((id: string) => byId.get(id), [byId]);
  const ctx = useMemo(() => ({ twins, productName }), [twins, productName]);
  const rows = useMemo(() => filterLibrary(scripts, f, ctx), [scripts, f, ctx]);
  const counts = useMemo(() => libraryCounts(scripts, f, ctx), [scripts, f, ctx]);

  const selectable = perms.canWrite;
  const ids = [...selected].filter((id) => scripts.some((s) => s.id === id));
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = (on: boolean) => setSelected(on ? new Set(rows.filter((r) => !isLegacy(r)).map((r) => r.id)) : new Set());
  const hrefOf = (s: TargetedScript) => (isLegacy(s) ? '/call-scripts?tab=current' : editorHref({ id: s.id }));

  const listProps = { rows, selectable, selected, onToggle: toggle, onToggleAll: toggleAll, hrefOf, productName };

  return (
    <section className="space-y-3" aria-labelledby="cs-library-title" data-testid="cs-library">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="cs-library-title" className="text-base font-semibold">{t('callScripts.library.title')}</h2>
          <p className="text-xs text-muted-foreground">{perms.canWrite ? t('callScripts.library.subtitle') : t('callScripts.library.subtitleAgent')}</p>
        </div>
        {perms.canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            {perms.canDelete && (
              <Button variant="outline" size="sm" className="h-9" onClick={() => setDeletedOpen(true)} data-testid="open-deleted">
                <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />{t('callScripts.history.deletedTitle')}
              </Button>
            )}
            <Button asChild size="sm" className="h-9" data-testid="new-script">
              <Link to={editorHref({})}><Plus className="mr-1.5 h-4 w-4" aria-hidden />{t('callScripts.library.newScript')}</Link>
            </Button>
          </div>
        )}
      </div>

      <LibraryFilters f={f} onChange={onChange} counts={counts} shown={rows.length} total={scripts.length}
        products={products} twins={twins} productName={productName} canWrite={perms.canWrite} />

      {loading && !library ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" aria-label={t('common.loading')} /></div>
      ) : error && !library ? (
        <EmptyState icon={<FileText className="h-5 w-5" />} title={t('callScripts.errors.loadLibrary')} description={scriptsErrorText(error, t)} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<FileText className="h-5 w-5" />} title={scripts.length ? t('callScripts.library.noMatch') : t('callScripts.library.empty')}
          description={perms.canWrite && !scripts.length ? t('callScripts.library.emptyHint') : undefined} />
      ) : wide ? <LibraryTable {...listProps} /> : <LibraryCards {...listProps} />}

      {selectable && (
        <BulkBar ids={ids} canDelete={perms.canDelete} onAttach={() => setAttachOpen(true)} onClear={() => setSelected(new Set())} />
      )}
      {selectable && (
        <AttachDialog open={attachOpen} onOpenChange={setAttachOpen} ids={ids} library={scripts} products={products} twins={twins}
          productName={productName} coverage={coverage} onDone={() => setSelected(new Set())} />
      )}
      {perms.canDelete && <DeletedDialog open={deletedOpen} onOpenChange={setDeletedOpen} />}
    </section>
  );
}

/** Admins: the latest deleted scripts, each restorable as a draft with the same id. */
function DeletedDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const L = useScriptLabels();
  const { t } = L;
  const { toast } = useToast();
  const q = useDeletedScripts(open);
  const writes = useScriptsWrites();
  const restore = async (id: string, version: number) => {
    try {
      await writes.restore.mutateAsync({ id, version });
      toast({ title: t('callScripts.history.restoredDeleted') });
      void q.refetch();
    } catch (e) {
      toast({ title: t('common.error'), description: scriptsErrorText(e, t), variant: 'destructive' });
    }
  };
  const rows = q.data?.deleted ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('callScripts.history.deletedTitle')}</DialogTitle>
          <DialogDescription>{t('callScripts.history.deletedHint')}</DialogDescription>
        </DialogHeader>
        {q.isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" aria-hidden /></div>
        ) : q.error ? (
          <p className="text-sm text-destructive">{scriptsErrorText(q.error, t)}</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('callScripts.history.deletedEmpty')}</p>
        ) : (
          <ul className="space-y-2" data-testid="deleted-list">
            {rows.map((d) => (
              <li key={`${d.script_id}-${d.version}`} className="flex flex-wrap items-start gap-2 rounded-lg border p-2.5">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium">{d.title}</p>
                  <p className="text-[11px] text-muted-foreground">{L.date(d.deleted_at)}{d.actor_name ? ` · ${d.actor_name}` : ''}</p>
                  {d.note && <p className="mt-0.5 break-words text-xs text-muted-foreground">{d.note}</p>}
                </div>
                <Button size="sm" variant="outline" className="h-9" disabled={writes.restore.isPending} onClick={() => restore(d.script_id, d.version)}>
                  <RotateCcw className="mr-1.5 h-4 w-4" aria-hidden />{t('callScripts.history.restore')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
