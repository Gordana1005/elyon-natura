import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { roleIcon, roleLabel } from './roleMeta';
import type { UserRow } from './UsersList';

export interface NewUser { full_name: string; email: string; password: string; roles: string[] }
export interface UserPatch { full_name?: string; email?: string; password?: string }

/**
 * "Додај корисник": name, e-mail, the roles the viewer may hand out (at least
 * one), password. The page validates and calls the api; true = created, so the
 * form resets.
 */
export function CreateUserDialog({ open, onOpenChange, availableRoles, busy, onCreate }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availableRoles: readonly string[];
  busy: boolean;
  onCreate: (u: NewUser) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const initialRole = availableRoles.includes('pending_agent') ? 'pending_agent' : availableRoles[0];
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roles, setRoles] = useState<Set<string>>(new Set([initialRole]));

  const toggle = (r: string) => setRoles((prev) => {
    const next = new Set(prev);
    if (next.has(r)) { if (next.size > 1) next.delete(r); } else next.add(r);
    return next;
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await onCreate({ full_name: name, email, password, roles: Array.from(roles) });
    if (ok) { setName(''); setEmail(''); setPassword(''); setRoles(new Set([initialRole])); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-xl">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t('usersPage.createNewUser')}</DialogTitle>
            <DialogDescription>{t('users.subtitle')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="cu-name">{t('usersPage.fullName')}</Label>
            <Input id="cu-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cu-email">{t('usersPage.email')}</Label>
            <Input id="cu-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <span className="text-sm font-medium">{t('usersPage.colRoles')}</span>
            <div role="group" aria-label={t('usersPage.colRoles')} className="grid grid-cols-2 gap-2">
              {availableRoles.map((r) => {
                const on = roles.has(r);
                const Icon = roleIcon(r);
                return (
                  <button key={r} type="button" aria-pressed={on} onClick={() => toggle(r)}
                    className={cn(
                      'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      on ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                    )}>
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="min-w-0 truncate">{roleLabel(r)}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cu-password">{t('usersPage.password')}</Label>
            <Input id="cu-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {busy ? t('usersPage.creating') : t('usersPage.createUser')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Уреди корисник" (admins): name, e-mail, an optional new password. Only what changed is sent. */
export function EditUserDialog({ target, onClose, busy, onSave }: {
  target: UserRow | null;
  onClose: () => void;
  busy: boolean;
  onSave: (u: UserRow, patch: UserPatch) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => {
    if (target) { setName(target.full_name); setEmail(target.email); setPassword(''); }
  }, [target]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!target) return;
    const patch: UserPatch = {};
    if (name.trim() && name.trim() !== target.full_name) patch.full_name = name.trim();
    if (email.trim() && email.trim() !== target.email) patch.email = email.trim();
    if (password) patch.password = password;
    onSave(target, patch);
  };

  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="max-w-md rounded-xl">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t('usersPage.editUser')}</DialogTitle>
            <DialogDescription>{target?.email}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="eu-name">{t('usersPage.fullName')}</Label>
            <Input id="eu-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="eu-email">{t('usersPage.email')}</Label>
            <Input id="eu-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="eu-password">{t('usersPage.newPasswordOptional')}</Label>
            <Input id="eu-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••" autoComplete="new-password" />
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {busy ? t('usersPage.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
