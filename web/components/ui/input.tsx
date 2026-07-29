"use client";

import type { InputHTMLAttributes, ReactElement, ReactNode } from "react";

// The one text input for the app: a white surface with the only visible border +
// an accent focus ring, at the shared 44px (h-11) control height and text-base
// (≥16px, so iOS Safari doesn't zoom on focus). `prefix` renders a static
// adornment (e.g. the "@" on a handle field); `suffix` a trailing slot (e.g. a
// validity spinner/check). Everything else is a normal <input>.
export default function Input({
  prefix,
  suffix,
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  prefix?: ReactNode;
  suffix?: ReactNode;
}): ReactElement {
  const base =
    "h-11 w-full rounded-xl border border-border bg-surface text-base outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20";
  if (!prefix && !suffix)
    return <input className={`${base} px-3.5 ${className}`} {...props} />;
  return (
    <div className="relative w-full">
      {prefix ? (
        <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-muted">
          {prefix}
        </span>
      ) : null}
      <input
        className={`${base} ${prefix ? "pl-8" : "pl-3.5"} ${suffix ? "pr-10" : "pr-3.5"} ${className}`}
        {...props}
      />
      {suffix ? (
        <span className="absolute inset-y-0 right-3.5 flex items-center">
          {suffix}
        </span>
      ) : null}
    </div>
  );
}
