import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  EMPTY_USER_FILTERS, readUserFilterParams, readUserSortParams, writeUserFilterParams, writeUserSortParams,
  type UserFilterState, type UserSort,
} from '@/lib/users/filterUsers';

/** How long the URL trails the last keystroke. */
const URL_DELAY_MS = 250;
const canon = (q: string) => (q.trim() ? q : '');

/**
 * The /users filters and sort, kept in the URL
 * (?q=…&role=…&status=…&online=1&sort=…&dir=…, replace: true) so a reload or a
 * pasted link keeps them.
 *
 * Everything but the search is read straight from the URL. The search box
 * answers every keystroke from local state and the URL follows 250 ms later:
 * Safari throws once a page calls history.replaceState() too often, and a
 * thrown write would freeze the box mid-word.
 */
export function useUserFilterParams() {
  const [sp, setSp] = useSearchParams();
  const fromUrl = useMemo(() => readUserFilterParams(sp), [sp]);
  const sort = useMemo(() => readUserSortParams(sp), [sp]);
  const [query, setQuery] = useState(fromUrl.query);
  // The query the URL holds because WE wrote it — tells our own echo from an
  // outside change (the sidebar link, a pasted link).
  const written = useRef(canon(fromUrl.query));
  const setSpRef = useRef(setSp);
  setSpRef.current = setSp;

  // URL → box, only for outside changes.
  useEffect(() => {
    const q = canon(fromUrl.query);
    if (q === written.current) return;
    written.current = q;
    setQuery(fromUrl.query);
  }, [fromUrl.query]);

  // Box → URL, trailing the typing.
  useEffect(() => {
    const id = window.setTimeout(() => {
      const next = canon(query);
      if (next === written.current) return;
      written.current = next;
      setSpRef.current((prev) => writeUserFilterParams(prev, { query: next }), { replace: true });
    }, URL_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  /** Sets any of roles / status / online (the search has setQuery). */
  const setFilters = useCallback(
    (next: Partial<Omit<UserFilterState, 'query'>>) =>
      setSp((prev) => writeUserFilterParams(prev, next), { replace: true }),
    [setSp],
  );
  const setSort = useCallback(
    (next: UserSort) => setSp((prev) => writeUserSortParams(prev, next), { replace: true }),
    [setSp],
  );
  /** Clears every filter (the sort stays). */
  const clear = useCallback(() => {
    written.current = '';
    setQuery('');
    setSp((prev) => writeUserFilterParams(prev, EMPTY_USER_FILTERS), { replace: true });
  }, [setSp]);

  const filters = useMemo<UserFilterState>(
    () => ({ query, roles: fromUrl.roles, status: fromUrl.status, online: fromUrl.online }),
    [query, fromUrl.roles, fromUrl.status, fromUrl.online],
  );
  return { filters, sort, setQuery, setFilters, setSort, clear };
}
