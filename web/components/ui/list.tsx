"use client";

import type { ReactElement, ReactNode } from "react";

// A quiet section label — small, muted, semibold. Sections group the app's flat
// lists the way iOS Settings groups its rows.
export function SectionHeading({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}): ReactElement {
  return (
    <div className="flex items-center justify-between gap-2 px-1">
      {/* Never wraps to make room for its action — the action truncates instead,
          since titles here are short and fixed while an action can carry a
          user-chosen name. */}
      <h2 className="shrink-0 text-sm font-semibold text-muted">{children}</h2>
      {action}
    </div>
  );
}

// A labeled section: a quiet heading over its content.
export function Section({
  title,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <section className={`flex flex-col gap-2.5 ${className}`}>
      {title ? <SectionHeading action={action}>{title}</SectionHeading> : null}
      {children}
    </section>
  );
}

// A grouped list: a soft shadow-card holding rows separated by near-invisible
// hairlines. The shadow is the separator; there's no outer border.
export function Group({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <div
      className={`overflow-hidden rounded-3xl bg-surface shadow-card divide-y divide-border ${className}`}
    >
      {children}
    </div>
  );
}

// One row in a grouped list. With `onClick` it's the whole-row tap target
// (opening a detail screen or sheet); otherwise it's a passive container. Inner
// text blocks should carry `min-w-0` + `truncate` so nothing overflows.
export function Row({
  onClick,
  children,
  className = "",
  ariaLabel,
}: {
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}): ReactElement {
  const base = "flex w-full items-center gap-3 px-4 min-h-14 py-3 text-left";
  if (onClick) {
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={onClick}
        className={`${base} transition-colors hover:bg-surface-hover ${className}`}
      >
        {children}
      </button>
    );
  }
  return <div className={`${base} ${className}`}>{children}</div>;
}
