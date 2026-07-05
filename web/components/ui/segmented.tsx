"use client";

import type { ReactElement } from "react";

// An inline segmented control: two or more equal-width options in a tonal pill
// track, the active one raised as a white thumb. Each option is flex-1 so it
// fits narrow screens — drives the listing type toggle and the theme picker.
export type SegmentedOption<T extends string> = {
  readonly value: T;
  readonly label: string;
};

export default function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel?: string;
}): ReactElement {
  return (
    <fieldset
      aria-label={ariaLabel}
      className="flex min-w-0 gap-1 rounded-full border-0 bg-surface-muted p-1"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`h-9 flex-1 rounded-full px-3 text-sm font-semibold transition ${
              active
                ? "bg-surface text-text shadow-soft"
                : "text-muted hover:text-text"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}
