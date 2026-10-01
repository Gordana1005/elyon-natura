import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAutosave } from './useAutosave';

type Patch = { title?: string; body?: string; pinned?: boolean };
class Conflict extends Error { constructor(readonly current: { version: number }) { super('conflict'); } }

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup(save: (p: Patch, base: number, o: { keepalive: boolean }) => Promise<{ version: number }>, extra: Partial<Parameters<typeof useAutosave<Patch, { version: number }>>[0]> = {}) {
  const onSaved = vi.fn();
  const onConflict = vi.fn();
  const hook = renderHook(() => useAutosave<Patch, { version: number }>({
    version: 1, save, isConflict: (e) => e instanceof Conflict, onSaved, onConflict, ...extra,
  }));
  return { ...hook, onSaved, onConflict };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('useAutosave — debounce', () => {
  it('saves 1.200 ms after the last edit, once, with the merged patch', async () => {
    const save = vi.fn(async (_p: Patch, base: number) => ({ version: base + 1 }));
    const { result, onSaved } = setup(save);
    act(() => { result.current.schedule({ title: 'Н' }); });
    expect(result.current.status).toBe('dirty');
    await act(async () => { vi.advanceTimersByTime(1000); });
    act(() => { result.current.schedule({ body: 'текст' }); });
    await act(async () => { vi.advanceTimersByTime(1199); });
    expect(save).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ title: 'Н', body: 'текст' }, 1, { keepalive: false });
    expect(result.current.status).toBe('saved');
    expect(result.current.savedAt).not.toBeNull();
    expect(onSaved).toHaveBeenCalledWith({ version: 2 }, { title: 'Н', body: 'текст' });
    expect(result.current.currentVersion()).toBe(2);
  });

  it('does nothing when read-only', async () => {
    const save = vi.fn(async () => ({ version: 2 }));
    const { result } = setup(save, { enabled: false });
    act(() => { result.current.schedule({ body: 'x' }); });
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(save).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });
});

describe('useAutosave — flush', () => {
  it('flush sends at once (blur / pin / move)', async () => {
    const save = vi.fn(async (_p: Patch, base: number) => ({ version: base + 1 }));
    const { result } = setup(save);
    act(() => { result.current.schedule({ pinned: true }); });
    await act(async () => { await result.current.flush(); });
    expect(save).toHaveBeenCalledWith({ pinned: true }, 1, { keepalive: false });
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('one request in flight: edits made meanwhile go right after, on the new version (newest wins)', async () => {
    const first = deferred<{ version: number }>();
    const save = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (_p: Patch, base: number) => ({ version: base + 1 }));
    const { result } = setup(save);
    act(() => { result.current.schedule({ body: 'a' }); });
    let done!: Promise<void>;
    act(() => { done = result.current.flush(); });
    expect(result.current.status).toBe('saving');
    act(() => { result.current.schedule({ body: 'ab' }); });
    act(() => { result.current.schedule({ body: 'abc' }); });
    act(() => { void result.current.flush(); }); // a second flush while the first runs → chained, not parallel
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve({ version: 2 }); await done; });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]).toEqual([{ body: 'abc' }, 2, { keepalive: false }]);
    expect(result.current.status).toBe('saved');
    expect(result.current.currentVersion()).toBe(3);
  });

  it('a hidden tab flushes with keepalive', async () => {
    const save = vi.fn(async (_p: Patch, base: number) => ({ version: base + 1 }));
    const { result } = setup(save);
    act(() => { result.current.schedule({ body: 'x' }); });
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    vis.mockRestore();
    expect(save).toHaveBeenCalledWith({ body: 'x' }, 1, { keepalive: true });
  });

  it('pagehide flushes with keepalive', async () => {
    const save = vi.fn(async (_p: Patch, base: number) => ({ version: base + 1 }));
    const { result } = setup(save);
    act(() => { result.current.schedule({ title: 't' }); });
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(save).toHaveBeenCalledWith({ title: 't' }, 1, { keepalive: true });
  });

  it('unmount (a note switch) sends the last edit', async () => {
    const save = vi.fn(async (_p: Patch, base: number) => ({ version: base + 1 }));
    const { result, unmount } = setup(save);
    act(() => { result.current.schedule({ body: 'последно' }); });
    await act(async () => { unmount(); });
    expect(save).toHaveBeenCalledWith({ body: 'последно' }, 1, { keepalive: false });
  });
});

describe('useAutosave — failures and conflicts', () => {
  it('a failure keeps the edit and "try again" resends it', async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new Error('HTTP 503'))
      .mockImplementation(async (_p: Patch, base: number) => ({ version: base + 1 }));
    const { result } = setup(save);
    act(() => { result.current.schedule({ body: 'x' }); });
    await act(async () => { await result.current.flush(); });
    expect(result.current.status).toBe('error');
    await act(async () => { await result.current.retry(); });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]).toEqual([{ body: 'x' }, 1, { keepalive: false }]);
    expect(result.current.status).toBe('saved');
  });

  it('a 409 holds every further save until the person chooses — "keep mine" writes on the new version', async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new Conflict({ version: 5 }))
      .mockImplementation(async (_p: Patch, base: number) => ({ version: base + 1 }));
    const { result, onConflict } = setup(save);
    act(() => { result.current.schedule({ body: 'моја' }); });
    await act(async () => { await result.current.flush(); });
    expect(result.current.status).toBe('conflict');
    expect(onConflict).toHaveBeenCalledTimes(1);
    act(() => { result.current.schedule({ body: 'моја 2' }); });
    await act(async () => { vi.advanceTimersByTime(5000); await result.current.flush(); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('conflict');
    await act(async () => { await result.current.keepMine(5, { title: 'Т', body: 'моја 2', pinned: false }); });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][1]).toBe(5);
    expect(save.mock.calls[1][0]).toMatchObject({ body: 'моја 2', title: 'Т' });
    expect(result.current.status).toBe('saved');
  });

  it('"take theirs" drops my edit and continues on their version', async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new Conflict({ version: 9 }))
      .mockImplementation(async (_p: Patch, base: number) => ({ version: base + 1 }));
    const { result } = setup(save);
    act(() => { result.current.schedule({ body: 'моја' }); });
    await act(async () => { await result.current.flush(); });
    act(() => { result.current.takeTheirs(9); });
    expect(result.current.status).toBe('saved');
    expect(result.current.hasPending()).toBe(false);
    act(() => { result.current.schedule({ body: 'нова' }); });
    await act(async () => { await result.current.flush(); });
    expect(save.mock.calls[1]).toEqual([{ body: 'нова' }, 9, { keepalive: false }]);
  });
});
