// i18n first: the app mounts once the starting language (one lazy chunk) is loaded, so it is
// active from the first paint — no raw keys, no flash of another language.
import { i18nReady } from "@/i18n";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// A deploy renames the lazy chunks. A tab opened before it asks for a chunk that no longer exists;
// the import fails and the page renders nothing — a white screen (owner, 29.09.2026). Reload once
// to pick up the new build; the guard stops a genuinely broken chunk from reloading forever.
window.addEventListener("vite:preloadError", (event) => {
  try {
    const key = "elyon:chunk-reload-at";
    const last = Number(sessionStorage.getItem(key) || 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    /* storage blocked — still reload once */
  }
  event.preventDefault();
  window.location.reload();
});

const mount = () => createRoot(document.getElementById("root")!).render(<App />);
// If the language chunk fails (offline, a stale deploy) the app still mounts — the preloadError
// handler above reloads once to pick up the new build.
i18nReady.then(mount, mount);
