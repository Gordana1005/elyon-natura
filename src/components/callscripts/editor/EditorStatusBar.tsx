import { Archive, Copy, FileEdit, History, Loader2, MoreHorizontal, Save, Send, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { ScriptStatus } from '@/lib/callScriptsTypes';
import { useScriptLabels } from '../parts';

export type EditorAction = 'save' | 'publish' | 'unpublish' | 'archive' | 'to_draft' | 'delete';

/**
 * The editor's actions, sticky at the bottom (in reach on a phone):
 *   new / draft     Зачувај нацрт · Објави
 *   published       Зачувај (goes live at once) · Повлечи (back to a draft)
 *   archived        Врати во нацрт
 *   always          Архивирај · Копирај на… · Историја · Избриши (admins)
 * Publishing needs a title and one part with text — the button says what is missing.
 */
export function EditorStatusBar({
  isNew, status, version, dirty, busy, canDelete, blockers, note, onNote, onAction, onDuplicate, onHistory,
}: {
  isNew: boolean;
  status: ScriptStatus;
  version: number | null;
  dirty: boolean;
  busy: EditorAction | null;
  canDelete: boolean;
  blockers: ('title' | 'text')[];
  note: string;
  onNote: (v: string) => void;
  onAction: (a: EditorAction) => void;
  onDuplicate: () => void;
  onHistory: () => void;
}) {
  const L = useScriptLabels();
  const { t } = L;
  const spin = (a: EditorAction) => busy === a && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />;
  const any = busy !== null;
  const blockText = blockers.length ? t(`callScripts.editor.blocked_${blockers[0]}`) : undefined;

  return (
    <div role="region" aria-label={t('callScripts.editor.actions')} data-testid="editor-status-bar"
      className="sticky bottom-2 z-30 flex flex-wrap items-center gap-2 rounded-xl border bg-card/95 p-2 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-card/85">
      <span className={cn('px-1 text-xs', dirty ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-muted-foreground')} aria-live="polite" data-testid="editor-state">
        {isNew ? t('callScripts.editor.stateNew') : dirty ? t('callScripts.editor.stateDirty') : t('callScripts.editor.stateSaved', { version: version ?? '' })}
      </span>
      <Input value={note} onChange={(e) => onNote(e.target.value)} maxLength={500} placeholder={t('callScripts.editor.notePlaceholder')}
        aria-label={t('callScripts.editor.note')} className="order-last h-9 min-w-0 basis-full text-base md:order-none md:basis-56 md:text-sm lg:flex-1" />
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {status !== 'archived' && (
          <Button size="sm" variant={status === 'published' ? 'default' : 'outline'} className="h-9" disabled={any || (!dirty && !isNew)}
            onClick={() => onAction('save')} data-testid="editor-save"
            title={status === 'published' ? t('callScripts.editor.saveLiveHint') : undefined}>
            {spin('save') || <Save className="mr-1.5 h-4 w-4" aria-hidden />}
            {status === 'published' ? t('callScripts.editor.saveLive') : t('callScripts.editor.saveDraft')}
          </Button>
        )}
        {(isNew || status === 'draft') && (
          <Button size="sm" className="h-9" disabled={any || blockers.length > 0} onClick={() => onAction('publish')} title={blockText} data-testid="editor-publish">
            {spin('publish') || <Send className="mr-1.5 h-4 w-4" aria-hidden />}{t('callScripts.editor.publish')}
          </Button>
        )}
        {!isNew && status === 'published' && (
          <Button size="sm" variant="outline" className="h-9" disabled={any} onClick={() => onAction('unpublish')} data-testid="editor-unpublish">
            {spin('unpublish') || <Undo2 className="mr-1.5 h-4 w-4" aria-hidden />}{t('callScripts.editor.unpublish')}
          </Button>
        )}
        {!isNew && status === 'archived' && (
          <Button size="sm" className="h-9" disabled={any} onClick={() => onAction('to_draft')} data-testid="editor-to-draft">
            {spin('to_draft') || <FileEdit className="mr-1.5 h-4 w-4" aria-hidden />}{t('callScripts.editor.toDraft')}
          </Button>
        )}
        {!isNew && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-9" disabled={any} aria-label={t('callScripts.editor.more')} data-testid="editor-more">
                {spin('archive') || spin('delete') || <MoreHorizontal className="h-4 w-4" aria-hidden />}
                <span className="ml-1.5 hidden sm:inline">{t('callScripts.editor.more')}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={onDuplicate} data-testid="editor-duplicate"><Copy className="mr-2 h-4 w-4" aria-hidden />{t('callScripts.duplicate.open')}</DropdownMenuItem>
              <DropdownMenuItem onSelect={onHistory} data-testid="editor-history"><History className="mr-2 h-4 w-4" aria-hidden />{t('callScripts.history.open')}</DropdownMenuItem>
              {status !== 'archived' && (
                <DropdownMenuItem onSelect={() => onAction('archive')} data-testid="editor-archive"><Archive className="mr-2 h-4 w-4" aria-hidden />{t('callScripts.editor.archive')}</DropdownMenuItem>
              )}
              {canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onAction('delete')} className="text-destructive focus:text-destructive" data-testid="editor-delete">
                    <Trash2 className="mr-2 h-4 w-4" aria-hidden />{t('callScripts.editor.delete')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {blockText && (isNew || status === 'draft') && <p className="basis-full px-1 text-[11px] text-muted-foreground">{blockText}</p>}
    </div>
  );
}
