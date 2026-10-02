import "@testing-library/jest-dom";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

// The locales are lazy chunks in the app (src/i18n/index.ts). Tests read any language at any time,
// so every one is loaded before a test file runs — the same as when they were bundled.
import i18n, { i18nReady, SUPPORTED_LANGUAGES } from "@/i18n";
await i18nReady;
await i18n.loadLanguages(SUPPORTED_LANGUAGES);
