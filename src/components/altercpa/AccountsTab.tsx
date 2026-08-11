import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  apiGetAlterCpaAccounts, apiCreateAlterCpaAccount, apiUpdateAlterCpaAccount,
  apiRunAlterCpaSync, AlterCpaAccount,
} from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/EmptyState';
import { AlertTriangle, KeyRound, Loader2, Plus, Play, Radio, RefreshCw } from 'lucide-react';
import { format } from 'date-fns';

const MIRROR_MODES = ['off', 'until_touched', 'always'] as const;
const IMPORT_SCOPES = ['pending_only', 'all'] as const;

/**
 * Accounts — one row per AlterCPA install. Several networks (cpa.moe, cpa.toys,
 * cashfactories) can run side by side with different offer catalogues and geos,
 * which is why this is data rather than configuration in code.
 */
export function AccountsTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = !!user?.isAdmin;
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AlterCpaAccount | null>(null);
  const [fName, setFName] = useState('');
  const [fBase, setFBase] = useState('https://api.cpa.moe');
  const [fSecret, setFSecret] = useState('ALTERCPA_TOKEN_MAIN');
  const [fGeos, setFGeos] = useState('MK');
  const [fMirror, setFMirror] = useState<string>('off');
  const [fScope, setFScope] = useState<string>('pending_only');
  const [fSyncFrom, setFSyncFrom] = useState('');
  const [fActive, setFActive] = useState(true);
  const [fNotes, setFNotes] = useState('');

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['altercpa-accounts'],
    queryFn: apiGetAlterCpaAccounts,
  });

  const onError = (err: any) =>
    toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['altercpa-accounts'] });

  const reset = () => {
    setEditing(null); setFName(''); setFBase('https://api.cpa.moe');
    setFSecret('ALTERCPA_TOKEN_MAIN'); setFGeos('MK'); setFMirror('off'); setFScope('pending_only');
    setFSyncFrom(''); setFActive(true); setFNotes('');
  };
  const openCreate = () => { reset(); setDialogOpen(true); };
  const openEdit = (a: AlterCpaAccount) => {
    setEditing(a); setFName(a.name); setFBase(a.api_base);
    setFSecret(a.token_secret_name); setFGeos((a.callable_geos || []).join(', '));
    setFMirror(a.status_mirror); setFScope(a.import_scope || 'pending_only'); setFSyncFrom(a.sync_from || '');
    setFActive(a.is_active); setFNotes(a.notes || '');
    setDialogOpen(true);
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const body = {
        name: fName.trim(),
        api_base: fBase.trim(),
        token_secret_name: fSecret.trim().toUpperCase(),
        callable_geos: fGeos.split(',').map((g) => g.trim().toUpperCase()).filter(Boolean),
        status_mirror: fMirror,
        import_scope: fScope,
        sync_from: fSyncFrom.trim() || null,
        is_active: fActive,
        notes: fNotes.trim() || null,
      };
      return editing ? apiUpdateAlterCpaAccount(editing.id, body) : apiCreateAlterCpaAccount(body);
    },
    onSuccess: () => { invalidate(); setDialogOpen(false); reset(); toast({ title: t('common.saved') }); },
    onError,
  });

  const syncMutation = useMutation({
    mutationFn: (v: { account: string; dry: boolean; status?: boolean }) =>
      apiRunAlterCpaSync({
        account: v.account,
        kind: v.status ? 'status' : v.dry ? 'manual' : 'rolling',
        dry: v.dry,
      }),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['altercpa-runs'] });
      queryClient.invalidateQueries({ queryKey: ['altercpa-leads'] });
      invalidate();
      const first = r?.results?.[0];
      toast({
        title: r?.dry ? t('altercpa.dryRunDone') : t('altercpa.syncDone'),
        description: first
          ? r?.kind === 'status'
            ? t('altercpa.statusSyncSummary', {
                fetched: first.fetched ?? 0,
                updated: first.orders_updated ?? 0,
              })
            : t('altercpa.syncSummary', {
                fetched: first.fetched ?? 0,
                created: first.orders_created ?? 0,
                ledger: first.ledger_new ?? 0,
              })
          : undefined,
      });
    },
    onError,
  });

  if (isLoading) {
    return <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('altercpa.accountsHint')}</p>
        {isAdmin && (
          <Button onClick={openCreate} className="gap-2">
            <Plus className="h-4 w-4" /> {t('altercpa.addAccount')}
          </Button>
        )}
      </div>

      {!accounts.length ? (
        <EmptyState
          icon={<Radio className="h-8 w-8" />}
          title={t('altercpa.noAccounts')}
          description={t('altercpa.noAccountsHint')}
          action={isAdmin ? <Button onClick={openCreate} className="gap-2"><Plus className="h-4 w-4" />{t('altercpa.addAccount')}</Button> : undefined}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {accounts.map((a) => (
            <Card key={a.id}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center justify-between gap-2 text-base">
                  <span className="truncate">{a.name}</span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {!a.is_active && <Badge variant="outline">{t('altercpa.inactive')}</Badge>}
                    {a.token_present === false && (
                      <Badge variant="outline" className="gap-1 border-destructive/30 bg-destructive/10 text-destructive">
                        <AlertTriangle className="h-3 w-3" /> {t('altercpa.noToken')}
                      </Badge>
                    )}
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {/* The single most common failure: an account configured but its
                    secret never set. The bridge then "succeeds" and imports
                    nothing, so it is called out here rather than buried. */}
                {a.token_present === false && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                    {t('altercpa.noTokenHint', { name: a.token_secret_name })}
                  </div>
                )}
                <Row label={t('altercpa.apiBase')} value={a.api_base} mono />
                <Row label={t('altercpa.tokenSecret')} value={a.token_secret_name} mono icon={<KeyRound className="h-3 w-3" />} />
                <Row
                  label={t('altercpa.callableGeos')}
                  value={(a.callable_geos || []).join(' · ') || '—'}
                />
                <Row label={t('altercpa.importScope')} value={t(`altercpa.scope_${a.import_scope || 'pending_only'}`)} />
                <Row label={t('altercpa.statusMirror')} value={t(`altercpa.mirror_${a.status_mirror}`)} />
                <Row
                  label={t('altercpa.lastSynced')}
                  value={a.last_synced_at ? format(new Date(a.last_synced_at), 'dd.MM.yyyy HH:mm') : t('altercpa.never')}
                />
                {a.notes && <p className="pt-1 text-xs text-muted-foreground">{a.notes}</p>}
                {isAdmin && (
                  <div className="flex flex-wrap gap-2 pt-2">
                    <Button size="sm" variant="outline" onClick={() => openEdit(a)}>{t('common.edit')}</Button>
                    <Button
                      size="sm" variant="outline" className="gap-1.5"
                      disabled={syncMutation.isPending || a.token_present === false}
                      onClick={() => syncMutation.mutate({ account: a.name, dry: true })}
                    >
                      <Play className="h-3.5 w-3.5" /> {t('altercpa.dryRun')}
                    </Button>
                    <Button
                      size="sm" className="gap-1.5"
                      disabled={syncMutation.isPending || a.token_present === false}
                      onClick={() => syncMutation.mutate({ account: a.name, dry: false })}
                    >
                      {syncMutation.isPending
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <RefreshCw className="h-3.5 w-3.5" />}
                      {t('altercpa.syncNow')}
                    </Button>
                    {a.status_mirror !== 'off' && (
                      <Button
                        size="sm" variant="outline" className="gap-1.5"
                        disabled={syncMutation.isPending || a.token_present === false}
                        onClick={() => syncMutation.mutate({ account: a.name, dry: false, status: true })}
                      >
                        <RefreshCw className="h-3.5 w-3.5" /> {t('altercpa.syncStatusesNow')}
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? t('altercpa.editAccount') : t('altercpa.addAccount')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>{t('altercpa.accountName')}</Label>
              <Input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="cpa.moe main" />
            </div>
            <div>
              <Label>{t('altercpa.apiBase')}</Label>
              <Input value={fBase} onChange={(e) => setFBase(e.target.value)} className="font-mono text-sm" />
            </div>
            <div>
              <Label>{t('altercpa.tokenSecret')}</Label>
              <Input
                value={fSecret}
                onChange={(e) => setFSecret(e.target.value)}
                className="font-mono text-sm"
                placeholder="ALTERCPA_TOKEN_MAIN"
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('altercpa.tokenSecretHint')}</p>
            </div>
            <div>
              <Label>{t('altercpa.callableGeos')}</Label>
              <Input value={fGeos} onChange={(e) => setFGeos(e.target.value)} placeholder="MK" />
              <p className="mt-1 text-xs text-muted-foreground">{t('altercpa.callableGeosHint')}</p>
            </div>
            <div>
              <Label>{t('altercpa.importScope')}</Label>
              <Select value={fScope} onValueChange={setFScope}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {IMPORT_SCOPES.map((sc) => (
                    <SelectItem key={sc} value={sc}>{t(`altercpa.scope_${sc}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">{t(`altercpa.scopeHint_${fScope}`)}</p>
            </div>
            <div>
              <Label>{t('altercpa.statusMirror')}</Label>
              <Select value={fMirror} onValueChange={setFMirror}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MIRROR_MODES.map((m) => (
                    <SelectItem key={m} value={m}>{t(`altercpa.mirror_${m}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">{t(`altercpa.mirrorHint_${fMirror}`)}</p>
            </div>
            <div>
              <Label>{t('altercpa.syncFrom')}</Label>
              <Input type="date" value={fSyncFrom} onChange={(e) => setFSyncFrom(e.target.value)} />
              <p className="mt-1 text-xs text-muted-foreground">{t('altercpa.syncFromHint')}</p>
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <Label className="cursor-pointer">{t('altercpa.active')}</Label>
              <Switch checked={fActive} onCheckedChange={setFActive} />
            </div>
            <div>
              <Label>{t('altercpa.notes')}</Label>
              <Textarea value={fNotes} onChange={(e) => setFNotes(e.target.value)} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !fName.trim() || !fSecret.trim()}
            >
              {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({ label, value, mono, icon }: { label: string; value: string; mono?: boolean; icon?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={`flex items-center gap-1 text-right ${mono ? 'font-mono text-xs' : ''}`}>
        {icon}{value}
      </span>
    </div>
  );
}
