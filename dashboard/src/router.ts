import { useEffect, useState } from "react";

/** Hash routes work behind any proxy and from a phone bookmark. */
export function useRoute(): string[] {
  const read = () => (window.location.hash.replace(/^#\/?/, "") || "platforms").split("/").map(decodeURIComponent);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function go(...parts: string[]): void {
  window.location.hash = `/${parts.map(encodeURIComponent).join("/")}`;
}

export const href = (...parts: string[]) => `#/${parts.map(encodeURIComponent).join("/")}`;
