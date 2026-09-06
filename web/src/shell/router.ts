/**
 * Hash routing without a library.
 *
 *   #/            -> overview
 *   #/overview    -> overview
 *   #/cash        -> cash
 *   #/audit/<id>  -> audit, param = <id>
 *   anything else -> overview
 *
 * The SPA fallback in wrangler serves index.html for every path, and the hash
 * never reaches the server, so deep links work with zero backend involvement.
 */

import { useCallback, useEffect, useState } from "react";
import type { PageId } from "../pages/types";

export interface Route {
  page: PageId;
  param: string | null;
}

export const PAGE_IDS: readonly PageId[] = [
  "overview",
  "cash",
  "collect",
  "spend",
  "policy",
  "audit",
  "insights",
  "agent",
];

function isPageId(s: string): s is PageId {
  return (PAGE_IDS as readonly string[]).includes(s);
}

export function parseHash(hash: string): Route {
  // "#/audit/abc" -> ["audit", "abc"]
  const trimmed = hash.replace(/^#/, "").replace(/^\/+/, "");
  const [head = "", ...rest] = trimmed.split("/");
  const page = head.trim().toLowerCase();
  if (page === "" || !isPageId(page)) return { page: "overview", param: null };
  const param = rest.length > 0 ? safeDecode(rest.join("/")) : null;
  return { page, param: param === "" ? null : param };
}

/** A hand-typed `%` in the hash must not take the whole app down. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function hashFor(page: PageId, param?: string | null): string {
  return param ? `#/${page}/${encodeURIComponent(param)}` : `#/${page}`;
}

function readRoute(): Route {
  if (typeof window === "undefined") return { page: "overview", param: null };
  return parseHash(window.location.hash);
}

export function useHashRoute(): Route & { navigate: (hash: string) => void } {
  const [route, setRoute] = useState<Route>(readRoute);

  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onChange);
    // Normalise an empty hash so the rail's active state and the URL agree.
    if (window.location.hash === "") {
      window.history.replaceState(null, "", "#/overview");
      onChange();
    }
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((hash: string) => {
    const next = hash.startsWith("#") ? hash : `#${hash.startsWith("/") ? "" : "/"}${hash}`;
    if (window.location.hash === next) return;
    window.location.hash = next;
  }, []);

  return { page: route.page, param: route.param, navigate };
}
