import { Component, type ErrorInfo, type ReactNode } from 'react';
import i18n from '@/i18n';

/**
 * Last line of defence against a white screen (owner, 29.09.2026: "they must never get an all
 * white screen"): a render error anywhere below shows a short message and a reload button
 * instead of unmounting the whole app. A failed lazy chunk after a deploy is handled earlier,
 * by the vite:preloadError reload in main.tsx.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('App error:', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const t = i18n.t.bind(i18n);
    return (
      <div className="flex h-screen items-center justify-center bg-background px-4">
        <div className="max-w-sm text-center space-y-3">
          <h1 className="text-lg font-semibold">{t('appError.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('appError.desc')}</p>
          <button
            type="button"
            className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-muted"
            onClick={() => window.location.reload()}
          >
            {t('appError.reload')}
          </button>
        </div>
      </div>
    );
  }
}
