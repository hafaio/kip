"use client";

import { type ReactElement, useEffect } from "react";
// Side effect only: importing it is what attaches the install listener, at
// module scope, before React can be late to it.
import "../utils/install";

// Registers the worker, once the page has loaded.
export default function Pwa(): ReactElement | null {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // Never in dev: `next dev` serves modules a cache would hand back stale,
    // with no version bump between edits to invalidate them. The file is built
    // there anyway, so flipping this line is all it takes to try it locally.
    if (process.env.NODE_ENV !== "production") return;
    const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    // Deliberately after load. Registration competes with the first paint's own
    // requests for the same connection, and the worker is of no use on the visit
    // that installs it.
    const start = () => {
      navigator.serviceWorker
        .register(`${base}/sw.js`, { scope: `${base}/` })
        .catch((error) => console.warn("service worker", error));
    };
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
  }, []);
  return null;
}
