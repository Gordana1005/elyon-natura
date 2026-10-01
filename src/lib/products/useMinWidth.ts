import { useEffect, useState } from 'react';

/**
 * true while the viewport is at least `px` wide. /products mounts EITHER the
 * table (xl, 1280 px) OR the cards — before Производи 2.0 both were mounted and
 * one hidden with CSS, which doubled the DOM (57.000 elements for 706 rows).
 */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const read = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true);
  const [on, setOn] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const onChange = () => setOn(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [query]);
  return on;
}
