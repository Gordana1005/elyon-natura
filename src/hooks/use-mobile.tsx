import * as React from "react";

const MOBILE_BREAKPOINT = 768;

const readIsMobile = () =>
  typeof window !== "undefined" && typeof window.innerWidth === "number" && window.innerWidth < MOBILE_BREAKPOINT;

export function useIsMobile() {
  // Read the width on the FIRST render (a SPA, no server render): the sidebar would otherwise draw its
  // desktop rail for one frame on a phone before switching to the drawer.
  const [isMobile, setIsMobile] = React.useState<boolean>(readIsMobile);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}

/** true while the viewport is at most `maxWidth` px wide (read on the first render, kept in sync). */
export function useMaxWidth(maxWidth: number) {
  const read = () => typeof window !== "undefined" && typeof window.innerWidth === "number" && window.innerWidth <= maxWidth;
  const [match, setMatch] = React.useState<boolean>(read);
  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const onChange = () => setMatch(window.innerWidth <= maxWidth);
    mql.addEventListener("change", onChange);
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, [maxWidth]);
  return match;
}
