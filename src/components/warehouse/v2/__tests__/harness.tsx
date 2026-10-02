import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';

/** Viewport width the useMinWidth / matchMedia queries answer for (setup.ts answers "no" by default). */
export function setViewport(width: number) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => {
      const min = /min-width:\s*(\d+)px/.exec(query);
      const max = /max-width:\s*(\d+)px/.exec(query);
      const matches = min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : false;
      return {
        matches, media: query, onchange: null,
        addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
      };
    },
  });
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
}

function Probe() {
  const loc = useLocation();
  return <output data-testid="url">{loc.search}</output>;
}

/** The current ?query of the in-memory router. */
export const urlParams = () => new URLSearchParams(screen.getByTestId('url').textContent ?? '');

export function renderAt(ui: ReactElement, url = '/warehouse') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        {ui}
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
