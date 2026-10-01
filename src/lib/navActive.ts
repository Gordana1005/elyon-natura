/**
 * Is a sidebar item the page on screen?
 *  - a plain path is lit on itself and on its sub-routes (/settings/teams, /segments/:id…);
 *    '/' stays exact;
 *  - a path with a query (/calls?queue=call-again) is lit only when every one of its
 *    params is in the address;
 *  - a plain path steps aside while a query sibling for the same page is lit, so
 *    "Повици" and "Повторни повици" are never lit together.
 */
export function navItemActive(itemPath: string, pathname: string, search: string, siblings: string[] = []): boolean {
  const queryMatches = (path: string): boolean => {
    const [p, q] = path.split('?');
    if (p !== pathname || !q) return false;
    const want = new URLSearchParams(q);
    const have = new URLSearchParams(search);
    for (const [k, v] of want) if (have.get(k) !== v) return false;
    return true;
  };
  if (itemPath.includes('?')) return queryMatches(itemPath);
  const lit = pathname === itemPath || (itemPath !== '/' && pathname.startsWith(`${itemPath}/`));
  if (!lit) return false;
  return !siblings.some((s) => s !== itemPath && s.startsWith(`${itemPath}?`) && queryMatches(s));
}
