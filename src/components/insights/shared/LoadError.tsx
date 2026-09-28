import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/EmptyState';

// Failed fetch: say so, with a retry — never an endless spinner.
export function LoadError({ text, onRetry }: { text: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={<AlertTriangle className="h-5 w-5" />}
      title={t('insights.loadFailed')}
      description={text}
      size="sm"
      action={<Button variant="outline" size="sm" onClick={onRetry}>{t('common.retry')}</Button>}
    />
  );
}
