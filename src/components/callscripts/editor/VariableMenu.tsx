import { useCallback, useRef, useState } from 'react';
import { Braces } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SCRIPT_VAR_NAMES, type ScriptVarName } from '@/lib/callScriptsTypes';
import { useScriptLabels } from '../parts';

type Setter = (value: string) => void;
interface Target { el: HTMLTextAreaElement | HTMLInputElement; set: Setter }

/**
 * Where "Вметни променлива" writes: the text field the writer was last in, at its cursor (the
 * selection survives the blur the menu causes). Every editable script text registers through
 * `bind(set)` → its onFocus / onSelect.
 */
export function useCursorInsert() {
  const last = useRef<Target | null>(null);
  const bind = useCallback((set: Setter) => ({
    onFocus: (e: { currentTarget: HTMLTextAreaElement | HTMLInputElement }) => { last.current = { el: e.currentTarget, set }; },
  }), []);
  const insert = useCallback((token: string): boolean => {
    const target = last.current;
    if (!target || !target.el.isConnected) return false;
    const { el, set } = target;
    const value = el.value;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    set(value.slice(0, start) + token + value.slice(end));
    const caret = start + token.length;
    requestAnimationFrame(() => {
      el.focus();
      try { el.setSelectionRange(caret, caret); } catch { /* number inputs */ }
    });
    return true;
  }, []);
  return { bind, insert };
}

/** The eleven variables ({{customer_name}} …), each with what it becomes on /calls. */
export function VariableMenu({ onInsert, disabled }: { onInsert: (name: ScriptVarName) => boolean; disabled?: boolean }) {
  const L = useScriptLabels();
  const { t } = L;
  const [open, setOpen] = useState(false);
  const [missed, setMissed] = useState(false);
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setMissed(false); }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-9" disabled={disabled} data-testid="variable-menu"
          onMouseDown={(e) => e.preventDefault() /* keep the cursor in the field */}>
          <Braces className="mr-1.5 h-4 w-4" aria-hidden />{t('callScripts.editor.insertVariable')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-1.5">
        <p className="px-1.5 pb-1.5 pt-0.5 text-[11px] leading-snug text-muted-foreground">
          {missed ? t('callScripts.editor.insertNoField') : t('callScripts.editor.insertHint')}
        </p>
        <ul className="max-h-[min(20rem,60vh)] overflow-y-auto">
          {SCRIPT_VAR_NAMES.map((v) => (
            <li key={v}>
              <button type="button" data-testid={`var-${v}`}
                onClick={() => { if (onInsert(v)) setOpen(false); else setMissed(true); }}
                className="flex min-h-9 w-full flex-wrap items-center gap-x-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="min-w-0 flex-1 font-medium">{L.variable(v)}</span>
                <code className="rounded bg-violet-50 px-1 text-[11px] text-violet-900 dark:bg-violet-500/15 dark:text-violet-200">{`{{${v}}}`}</code>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
