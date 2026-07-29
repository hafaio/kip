"use client";

import { type ReactNode, useEffect } from "react";

// A reusable modal surface: a full-bleed bottom sheet on mobile (slides up from
// the edge with a drag-handle bar and a rounded top, respecting the home-
// indicator safe area) and a centered rounded card on larger screens. Tapping
// the backdrop or pressing Escape dismisses. The body is scroll-locked while
// open so the sheet doesn't scroll the page behind it.
export default function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
}): ReactNode {
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        className="relative flex max-h-[88vh] w-full flex-col overflow-y-auto rounded-t-3xl bg-surface p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-panel sm:max-w-md sm:rounded-3xl sm:pb-5"
      >
        <span className="mx-auto mb-3 h-1.5 w-10 shrink-0 rounded-full bg-surface-hover sm:hidden" />
        {title ? (
          <h2 className="mb-4 text-xl font-bold tracking-[-0.02em]">{title}</h2>
        ) : null}
        {children}
      </div>
    </div>
  );
}
