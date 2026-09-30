import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import {
  apiCreateShiftTemplate, apiDeleteShiftTemplate, apiUpdateShiftTemplate, isHm, type GridTemplate,
} from '@/lib/shiftsApi';
import { shiftErrorText } from './errors';

/**
 * Create / edit / delete the templates (the grid's brushes). A time change moves the template's
 * shifts from the Skopje today on (by template_id, server side); past days stay as they were.
 * Times are typed as HH:MM — never the browser's <input type="time">, which shows AM/PM on an
 * English machine.
 */
export function TemplatesDialog({ open, onOpenChange, templates, onChanged }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: GridTemplate[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');

  const openForm = (tpl: GridTemplate | null) => {
    setEditing(tpl ? tpl.id : 'new');
    setName(tpl?.name ?? '');
    setStart(tpl?.start ?? '07:00');
    setEnd(tpl?.end ?? '15:00');
  };
  const valid = name.trim().length > 0 && isHm(start) && isHm(end) && end > start;
  const fail = (e: unknown) => toast({ title: t('common.error'), description: shiftErrorText(e), variant: 'destructive' });

  const save = useMutation({
    mutationFn: async () => {
      if (editing === 'new') return { created: await apiCreateShiftTemplate({ name: name.trim(), start_time: start, end_time: end }) };
      return { updated: await apiUpdateShiftTemplate(editing as string, { name: name.trim(), start_time: start, end_time: end }) };
    },
    onSuccess: (r) => {
      toast({ title: 'updated' in r && r.updated ? t('shiftsPage.templates.updated', { n: r.updated.shifts_updated ?? 0 }) : t('shiftsPage.templates.created') });
      setEditing(null);
      onChanged();
    },
    onError: fail,
  });
  const del = useMutation({
    mutationFn: (id: string) => apiDeleteShiftTemplate(id),
    onSuccess: () => { toast({ title: t('shiftsPage.templates.deleted') }); onChanged(); },
    onError: fail,
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setEditing(null); onOpenChange(v); }}>
      <DialogContent className="max-h-[90dvh] w-[calc(100vw-2rem)] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('shiftsPage.templates.title')}</DialogTitle>
          <DialogDescription>{t('shiftsPage.templates.desc')}</DialogDescription>
        </DialogHeader>

        {templates.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('shiftsPage.templates.none')}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {templates.map((tpl) => (
              <li key={tpl.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{tpl.name}</span>
                  <span className="block text-xs tabular-nums text-muted-foreground">{tpl.start}–{tpl.end}</span>
                </span>
                <span className="flex shrink-0 gap-1">
                  <Button type="button" variant="ghost" size="icon" className="h-9 w-9" aria-label={`${t('shiftsPage.templates.edit')} ${tpl.name}`} onClick={() => openForm(tpl)}>
                    <Pencil className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-destructive" aria-label={`${t('shiftsPage.templates.delete')} ${tpl.name}`}
                    disabled={del.isPending}
                    onClick={() => { if (window.confirm(t('shiftsPage.templates.deleteConfirm', { name: tpl.name }))) del.mutate(tpl.id); }}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {editing ? (
          <form className="space-y-3 rounded-lg border p-3" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
            <label className="block space-y-1 text-xs text-muted-foreground">
              <span>{t('shiftsPage.templates.name')}</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="h-9 text-sm" autoFocus />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1 text-xs text-muted-foreground">
                <span>{t('shiftsPage.templates.start')}</span>
                <Input value={start} onChange={(e) => setStart(e.target.value.trim())} inputMode="numeric" placeholder="07:00" className="h-9 text-sm tabular-nums" />
              </label>
              <label className="block space-y-1 text-xs text-muted-foreground">
                <span>{t('shiftsPage.templates.end')}</span>
                <Input value={end} onChange={(e) => setEnd(e.target.value.trim())} inputMode="numeric" placeholder="15:00" className="h-9 text-sm tabular-nums" />
              </label>
            </div>
            <p className={valid ? 'text-[11px] text-muted-foreground' : 'text-[11px] text-red-700 dark:text-red-400'}>
              {valid ? t('shiftsPage.templates.timeHint') : t('shiftsPage.templates.invalid')}
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>{t('shiftsPage.templates.cancel')}</Button>
              <Button type="submit" disabled={!valid || save.isPending}>{t('shiftsPage.templates.save')}</Button>
            </div>
          </form>
        ) : (
          <Button type="button" variant="outline" onClick={() => openForm(null)} className="w-full">
            <Plus className="h-4 w-4" aria-hidden /> {t('shiftsPage.templates.add')}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
