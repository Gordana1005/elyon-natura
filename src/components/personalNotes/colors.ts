import type { NotebookColor } from '@/lib/personalNotesApi';

/** A notebook's colour dot / stripe (a fixed Tailwind class per colour — no dynamic class names). */
export const NOTEBOOK_DOT: Record<NotebookColor, string> = {
  slate: 'bg-slate-400',
  sky: 'bg-sky-500',
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-400',
  rose: 'bg-rose-500',
  violet: 'bg-violet-500',
};

export const dotClass = (c: NotebookColor | null | undefined): string => (c ? NOTEBOOK_DOT[c] : 'bg-muted-foreground/30');
