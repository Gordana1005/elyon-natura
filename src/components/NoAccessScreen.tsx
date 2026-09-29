import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Shown when a login may open no page at all (no role, or every module switched off) — instead of
 * a redirect loop, which renders nothing: the white screen the owner reported on 29.09.2026.
 */
export function NoAccessScreen() {
  const { t } = useTranslation();
  const { signOut } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="flex h-screen items-center justify-center bg-background px-4">
      <div className="max-w-sm text-center space-y-3">
        <ShieldAlert className="mx-auto h-8 w-8 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t('access.noPageTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('access.noPageDesc')}</p>
        <Button variant="outline" onClick={async () => { await signOut(); navigate('/login', { replace: true }); }}>
          {t('common.signOut')}
        </Button>
      </div>
    </div>
  );
}
