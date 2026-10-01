import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  NOTEBOOK_COLORS, PN_LIMITS, apiCreateNotebook, apiUpdateNotebook, personalNotesErrorText,
  type Notebook, type NotebookColor,
} from '@/lib/personalNotesApi';
import { charCount } from '@/lib/personalNotes/model';
import { NOTEBOOK_DOT } from './colors';

/** New notebook / rename + colour. The name is 1–80 characters (trimmed on the server too). */
export function NotebookDialog({
  open, onOpenChange, notebook, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present = edit, absent = create. */
  notebook?: Notebook | null;
  onSaved: (nb: Notebook) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [title, setTitle] = useState('');
  const [color, setColor] = useState<NotebookColor | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) { setTitle(notebook?.title ?? ''); setColor(notebook?.color ?? null); }
  }, [open, notebook]);

  const clean = title.trim();
  const valid = clean.length > 0 && charCount(clean) <= PN_LIMITS.notebookTitle;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const r = notebook
        ? await apiUpdateNotebook(notebook.id, { title: clean, color })
        : await apiCreateNotebook({ title: clean, color });
      onSaved(r.notebook);
      onOpenChange(false);
    } catch (e) {
      toast({ title: personalNotesErrorText(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{notebook ? t('personalNotes.dialog.editTitle') : t('personalNotes.dialog.createTitle')}</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="space-y-1.5">
            <Label htmlFor="pn-notebook-title">{t('personalNotes.dialog.name')}</Label>
            <Input
              id="pn-notebook-title"
              value={title}
              maxLength={PN_LIMITS.notebookTitle}
              autoFocus
              placeholder={t('personalNotes.dialog.namePlaceholder')}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">{t('personalNotes.dialog.color')}</legend>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setColor(null)}
                aria-pressed={color === null}
                className={cn('flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs',
                  color === null ? 'border-foreground/60 bg-muted' : 'border-border')}
              >
                {t('personalNotes.dialog.noColor')}
              </button>
              {NOTEBOOK_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-pressed={color === c}
                  aria-label={t(`personalNotes.color.${c}`)}
                  title={t(`personalNotes.color.${c}`)}
                  className={cn('flex h-9 w-9 items-center justify-center rounded-full ring-offset-2 ring-offset-background',
                    NOTEBOOK_DOT[c], color === c && 'ring-2 ring-foreground/70')}
                >
                  {color === c && <Check className="h-4 w-4 text-white" aria-hidden />}
                </button>
              ))}
            </div>
          </fieldset>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={!valid || busy}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />}
              {notebook ? t('common.save') : t('personalNotes.dialog.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
