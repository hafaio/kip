"use client";

import type { ReactElement } from "react";

// A labeled on/off switch rendered as a track + thumb (never a pill button).
// ON is the gradient track. Renders as a full-width row so it drops cleanly into
// a grouped list: label + optional description on the left, the toggle right.
export default function Switch({
  checked,
  onChange,
  label,
  description,
  srSuffix,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  // Read aloud after the label, for a list where the same labels appear once
  // per channel and the heading that tells them apart is not part of any name.
  srSuffix?: string;
  disabled?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-3 px-4 py-3 text-left disabled:opacity-50"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[0.9375rem] font-semibold">
          {label}
          {srSuffix ? <span className="sr-only"> {srSuffix}</span> : null}
        </span>
        {description ? (
          <span className="mt-0.5 block text-sm text-muted">{description}</span>
        ) : null}
      </span>
      <span
        className={`relative h-[1.625rem] w-11 shrink-0 rounded-full transition ${
          checked ? "bg-gradient-accent shadow-glow" : "bg-surface-hover"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-[1.375rem] w-[1.375rem] rounded-full bg-white shadow-soft transition-transform ${
            checked ? "translate-x-[1.125rem]" : ""
          }`}
        />
      </span>
    </button>
  );
}
