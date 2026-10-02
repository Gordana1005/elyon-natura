import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { FlaskConical, Loader2, Phone, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/EmptyState';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { listLabel } from '@/components/insights/lists/listModel';
import {
  ALL_GROUPS, type CallScriptsQuery, type ScriptContext, type ScriptGroup, type ScriptMatch, type ScriptVars, type ScriptsLibrary,
  type TargetedScript,
} from '@/lib/callScriptsTypes';
import { ScriptBody } from '../ScriptBody';
import { editorHref, localMatch, sampleVars, twinsOf } from '../scriptsModel';
import { StatusBadge, card, chip, chipOff, chipOn, groupLabelCls, useScriptLabels, type ScriptLabels } from '../parts';
import { useForCallTest, useScriptSamples } from '../useCallScriptsAdmin';
import { scriptsErrorText } from '../errors';
import { ProductPicker } from '../editor/ProductPicker';
import { sampleLabel } from '../editor/ScriptPreview';

type Mode = 'phone' | 'cell';
type Source = CallScriptsQuery['source'];
const NO_GROUP = '__none__';

/** Why a script matched — the dock's own words (scriptDock.why.*), so the tester and /calls agree. */
function reasonText(r: string, L: ScriptLabels, productName: (id: string) => string | undefined): string {
  const { t } = L;
  if (r === 'all_groups') return t('scriptDock.why.allGroups');
  if (r === 'all_products') return t('scriptDock.why.allProducts');
  if (r === 'twin') return t('scriptDock.why.twin');
  if (r.startsWith('group:')) return t('scriptDock.why.group', { group: L.group(r.slice(6)) });
  if (r.startsWith('product:')) return t('scriptDock.why.product', { product: productName(r.slice(8)) ?? r.slice(8) });
  return r;
}

function MatchCard({ script, match, best, vars, lang, productName }: {
  script: TargetedScript; match: ScriptMatch; best: boolean; vars: ScriptVars | null; lang: 'mk' | 'sq';
  productName: (id: string) => string | undefined;
}) {
  const L = useScriptLabels();
  const { t } = L;
  return (
    <article className={cn(card, 'space-y-2 p-3', best && 'border-primary/40')} data-testid={best ? 'tester-best' : 'tester-alt'}>
      <div className="flex flex-wrap items-center gap-2">
        {best && <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground">{t('scriptDock.recommended')}</span>}
        <Link to={editorHref({ id: script.id, from: 'tester' })} className="min-w-0 flex-1 break-words text-sm font-semibold hover:text-primary hover:underline">{script.title}</Link>
        <StatusBadge script={script} />
      </div>
      <ul className="space-y-0.5 text-xs text-muted-foreground">
        <li className="font-medium text-foreground">{t(`scriptDock.why.tier.${match.tier}`)}</li>
        {match.reasons.map((r) => <li key={r}>{reasonText(r, L, productName)}</li>)}
        {match.tie_break && <li>{t(`scriptDock.why.tieBreak.${match.tie_break}`)}</li>}
      </ul>
      {best && (
        <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-border/40 p-2">
          <ScriptBody script={script} vars={vars} lang={lang} compact />
        </div>
      )}
    </article>
  );
}

function ContextCard({ ctx, L }: { ctx: ScriptContext; L: ScriptLabels }) {
  const { t } = L;
  const rows: [string, string][] = [
    [t('callScripts.tester.ctxSource'), t(`scriptDock.source.${ctx.source}`)],
    [t('callScripts.tester.ctxGroup'), ctx.group ? L.group(ctx.group) : t('scriptDock.noGroup')],
    [t('callScripts.tester.ctxBasis'), ctx.group_basis === 'list_name' || ctx.group_basis === 'attribution'
      ? (ctx.list_name ? t(`scriptDock.why.basis.${ctx.group_basis}`, { list: listLabel(t, ctx.list_name) }) : t('scriptDock.why.basis.attributionNoList'))
      : ctx.group_basis === 'order_status'
        ? t('scriptDock.why.basis.order_status', { status: ctx.order ? t(`status.${ctx.order.status}`) : '' })
        : t('scriptDock.why.basis.none')],
  ];
  if (ctx.order) rows.push([t('callScripts.tester.ctxOrder'), `${ctx.order.display_id ?? ctx.order.id.slice(0, 8)} · ${t(`status.${ctx.order.status}`)}`]);
  if (ctx.product) rows.push([t('callScripts.tester.ctxProduct'), ctx.product.name]);
  if (ctx.products.length > 1) rows.push([t('callScripts.tester.ctxProducts'), ctx.products.map((p) => p.name).join(', ')]);
  if (ctx.last_purchase) rows.push([t('callScripts.tester.ctxLast'), `${L.date(ctx.last_purchase.at)}${ctx.last_purchase.product_name ? ` · ${ctx.last_purchase.product_name}` : ''}`]);
  if (ctx.days_since_purchase != null) rows.push([t('callScripts.tester.ctxDays'), L.int(ctx.days_since_purchase)]);
  return (
    <dl className={cn(card, 'grid gap-x-4 gap-y-1.5 p-3 text-xs sm:grid-cols-2')} data-testid="tester-context">
      {rows.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className={groupLabelCls}>{k}</dt>
          <dd className="break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Тестер — "which script would this call get, and why": by PHONE (the real GET /calls/scripts,
 * the server decides the group and the product) or by GROUP + PRODUCT (the same matcher run here,
 * filled with a real waiting client when one exists). Drafts can compete (writers only).
 */
export function ScriptTester({ library }: { library: ScriptsLibrary | undefined }) {
  const L = useScriptLabels();
  const { t } = L;
  const { user } = useAuth();
  const [mode, setMode] = useState<Mode>('cell');
  const [drafts, setDrafts] = useState(true);
  const [lang, setLang] = useState<'mk' | 'sq'>('mk');
  // phone
  const [phone, setPhone] = useState('');
  const [source, setSource] = useState<Source>('manual');
  const [asked, setAsked] = useState<CallScriptsQuery | null>(null);
  const forCall = useForCallTest(asked);
  // group + product
  const [group, setGroup] = useState<ScriptGroup | null>('d21');
  const [product, setProduct] = useState<string | null>(null);
  const [sampleIdx, setSampleIdx] = useState<string>('0');

  const products = useMemo(() => library?.products ?? [], [library]);
  const scripts = useMemo(() => library?.scripts ?? [], [library]);
  const twins = useMemo(() => twinsOf(products), [products]);
  const productName = (id: string) => products.find((p) => p.id === id)?.name;
  const local = useMemo(() => localMatch(scripts, group, product, products, drafts), [scripts, group, product, products, drafts]);
  const samples = useScriptSamples(group, product, mode === 'cell');
  const sample = (samples.data?.samples ?? [])[Number(sampleIdx)] ?? null;
  const localVars = useMemo(() => sampleVars(sample, { agentName: user?.full_name ?? null }), [sample, user?.full_name]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 8) return;
    setAsked({ phone: phone.trim(), source, include_drafts: drafts, test: true });
  };

  const byId = new Map(scripts.map((s) => [s.id, s]));
  const res = forCall.data;

  return (
    <section className="space-y-3" aria-labelledby="cs-tester-title" data-testid="cs-tester">
      <div>
        <h2 id="cs-tester-title" className="text-base font-semibold">{t('callScripts.tester.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('callScripts.tester.subtitle')}</p>
      </div>

      <div className={cn(card, 'space-y-3 p-3')}>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label={t('callScripts.tester.mode')} className="flex flex-wrap gap-1.5">
            {(['cell', 'phone'] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={cn(chip, mode === m ? chipOn : chipOff)} data-testid={`tester-mode-${m}`}>
                {m === 'phone' ? <Phone className="h-3.5 w-3.5" aria-hidden /> : <FlaskConical className="h-3.5 w-3.5" aria-hidden />}
                {t(`callScripts.tester.mode_${m}`)}
              </button>
            ))}
          </div>
          <label className="ml-auto flex min-h-9 items-center gap-2 text-xs">
            <Switch checked={drafts} onCheckedChange={setDrafts} />{t('callScripts.tester.includeDrafts')}
          </label>
          <div role="group" aria-label={t('callScripts.editor.previewLang')} className="flex gap-1">
            {(['mk', 'sq'] as const).map((l) => (
              <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)} className={cn(chip, 'h-8 px-2.5', lang === l ? chipOn : chipOff)}>{t(`languages.${l}`)}</button>
            ))}
          </div>
        </div>

        {mode === 'phone' ? (
          <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 basis-48 space-y-1">
              <label htmlFor="tester-phone" className={groupLabelCls}>{t('callScripts.tester.phone')}</label>
              <Input id="tester-phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07X XXX XXX"
                className="h-9 text-base md:text-sm" data-testid="tester-phone" />
            </div>
            <div className="w-full space-y-1 sm:w-48">
              <label className={groupLabelCls}>{t('callScripts.tester.source')}</label>
              <Select value={source} onValueChange={(v) => setSource(v as Source)}>
                <SelectTrigger className="h-9" aria-label={t('callScripts.tester.source')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(['manual', 'lead', 'prediction'] as const).map((s) => <SelectItem key={s} value={s}>{t(`scriptDock.source.${s}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" className="h-9" disabled={phone.replace(/\D/g, '').length < 8 || forCall.isFetching} data-testid="tester-run">
              {forCall.isFetching ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Search className="mr-1.5 h-4 w-4" aria-hidden />}
              {t('callScripts.tester.run')}
            </Button>
          </form>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-full space-y-1 sm:w-56">
              <label className={groupLabelCls}>{t('callScripts.tester.group')}</label>
              <Select value={group ?? NO_GROUP} onValueChange={(v) => { setGroup(v === NO_GROUP ? null : v as ScriptGroup); setSampleIdx('0'); }}>
                <SelectTrigger className="h-9" aria-label={t('callScripts.tester.group')} data-testid="tester-group"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ALL_GROUPS.map((g) => <SelectItem key={g} value={g}>{L.group(g)}</SelectItem>)}
                  <SelectItem value={NO_GROUP}>{t('scriptDock.noGroup')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-full min-w-0 space-y-1 sm:w-72">
              <label className={groupLabelCls}>{t('callScripts.tester.product')}</label>
              <ProductPicker single products={products} twins={twins} value={product ? [product] : []} className="w-full"
                onChange={(ids) => { setProduct(ids[0] ?? null); setSampleIdx('0'); }} testId="tester-product"
                label={product ? (productName(product) ?? '') : t('callScripts.tester.noProduct')} />
            </div>
            <div className="w-full min-w-0 space-y-1 sm:flex-1 sm:basis-56">
              <label className={groupLabelCls}>{t('callScripts.tester.sample')}</label>
              <Select value={sampleIdx} onValueChange={setSampleIdx} disabled={!samples.data?.samples.length}>
                <SelectTrigger className="h-9" aria-label={t('callScripts.tester.sample')}>
                  <SelectValue placeholder={samples.isFetching ? t('common.loading') : t('callScripts.editor.sampleNone')} />
                </SelectTrigger>
                <SelectContent>
                  {(samples.data?.samples ?? []).map((s, i) => <SelectItem key={i} value={String(i)}>{sampleLabel(s, t)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </div>

      {mode === 'phone' ? (
        !asked ? (
          <p className="text-sm text-muted-foreground">{t('callScripts.tester.phoneHint')}</p>
        ) : forCall.isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden /></div>
        ) : forCall.error ? (
          <EmptyState title={t('callScripts.errors.tester')} description={scriptsErrorText(forCall.error, t)} />
        ) : res && !res.enabled ? (
          <EmptyState title={t('callScripts.tester.disabled', { mode: t(`callScripts.mode.${res.mode}`) })} description={t('callScripts.tester.disabledHint')} />
        ) : res ? (
          <div className="space-y-3">
            {res.drafts_included && <p className="text-xs text-amber-700 dark:text-amber-400">{t('scriptDock.why.drafts')}</p>}
            {res.context && <ContextCard ctx={res.context} L={L} />}
            {res.best ? (
              <>
                <MatchCard script={res.best} match={res.best.match} best vars={res.vars} lang={lang} productName={productName} />
                {res.alternatives.map((a) => <MatchCard key={a.id} script={a} match={a.match} best={false} vars={res.vars} lang={lang} productName={productName} />)}
              </>
            ) : <EmptyState title={t('scriptDock.emptyGeneric')} description={t('scriptDock.emptyHint')} />}
          </div>
        ) : null
      ) : local.best ? (
        <div className="space-y-3">
          <MatchCard script={local.best.script} match={local.best.match} best vars={sample ? localVars : null} lang={lang} productName={productName} />
          {local.alternatives.map((a) => <MatchCard key={a.script.id} script={byId.get(a.script.id) ?? a.script} match={a.match} best={false} vars={null} lang={lang} productName={productName} />)}
        </div>
      ) : (
        <EmptyState title={t('scriptDock.emptyGeneric')} description={t('callScripts.tester.emptyCell')}
          action={<Button asChild size="sm"><Link to={editorHref({ groups: group ? [group] : [], products: product ? [product] : [], from: 'tester' })}>{t('callScripts.coverage.newScript')}</Link></Button>} />
      )}
    </section>
  );
}
