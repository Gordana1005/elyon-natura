import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

/**
 * A number that opens the orders it counted. With no href (a row not counted
 * from `orders`, or a basis /orders cannot filter on) it renders as plain text —
 * a link that opened a different set would be worse than none.
 */
export function DrillLink({
  href, children, className, title, ariaLabel,
}: { href: string | null | undefined; children: ReactNode; className?: string; title?: string; ariaLabel?: string }) {
  if (!href) return <span className={className} title={title}>{children}</span>;
  return (
    <Link
      to={href}
      title={title}
      aria-label={ariaLabel}
      className={cn(
        'rounded-sm underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {children}
    </Link>
  );
}
