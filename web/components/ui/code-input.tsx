"use client";

import { type ReactElement, useEffect, useRef, useState } from "react";

// Keys for a row that is never inserted into, removed from or reordered, so
// they can be names rather than positions.
const BOXES = ["one", "two", "three", "four", "five", "six"] as const;

export const CODE_LENGTH = BOXES.length;

// Six boxes drawn under ONE real input, never six inputs. That is the whole
// design decision: the OS keyboard's "From Messages: 123456" strip, paste,
// backspace and select-all are all things the platform already does to a single
// `one-time-code` field, and six would mean imitating every one of them with
// index-juggling refs — while still losing the autofill, which fills one field
// and gives up. The boxes are the shell `Input` wears (h-11, rounded-xl, the
// same border and accent ring), so this reads as kip's field rather than a
// widget that wandered in.
//
// The input is transparent rather than hidden, because an `opacity-0` field is
// skipped by some autofill, and the caret is drawn as the ring on whichever box
// comes next.
//
// It submits its own form on the sixth digit. A code is the one field with
// nothing left to decide once it is full, so the tap that follows exists only
// because the form has a button. Fired from an effect, or the caller's submit
// would read the state from before the digit that completed it.
export default function CodeInput({
  value,
  onChange,
  invalid = false,
  autoFocus = false,
}: {
  value: string;
  onChange: (next: string) => void;
  invalid?: boolean;
  autoFocus?: boolean;
}): ReactElement {
  const field = useRef<HTMLInputElement>(null);
  // Seeded from `autoFocus` rather than starting false: React focuses the node
  // itself during commit, which does NOT go through the `onFocus` handler, so a
  // field that opens focused drew no ring at all — six identical empty boxes
  // with nothing saying which one the next digit lands in. Probed in a browser,
  // where `document.activeElement` was already the input and every box still
  // read `border-border`.
  const [focused, setFocused] = useState(autoFocus);

  useEffect(() => {
    if (value.length === CODE_LENGTH) field.current?.form?.requestSubmit?.();
  }, [value]);

  // Everything here assumes the caret is at the end — the ring names the next
  // box, backspace takes the last digit — so a tap that would land it in the
  // middle is walked back to the end instead.
  function toEnd(): void {
    field.current?.setSelectionRange(value.length, value.length);
  }

  const next = Math.min(value.length, CODE_LENGTH - 1);

  return (
    <div className="relative">
      <div className="grid grid-cols-6 gap-2">
        {BOXES.map((name, index) => {
          const live = focused && index === next;
          return (
            <div
              key={name}
              className={`flex h-11 items-center justify-center rounded-xl border bg-surface text-base font-semibold tabular-nums transition ${
                invalid
                  ? "border-danger"
                  : live
                    ? "border-accent ring-2 ring-accent/20"
                    : "border-border"
              }`}
            >
              {value[index] ?? ""}
            </div>
          );
        })}
      </div>
      <input
        ref={field}
        autoComplete="one-time-code"
        inputMode="numeric"
        // biome-ignore lint/a11y/noAutofocus: the code step replaces the field it follows, so the keyboard is already up — a tap to get it back is one the previous step never asked for.
        autoFocus={autoFocus}
        aria-label="6-digit code"
        aria-invalid={invalid || undefined}
        maxLength={CODE_LENGTH}
        value={value}
        // Non-digits are dropped rather than refused, so a code pasted with a
        // space or a dash in it still lands.
        onChange={(event) =>
          onChange(event.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))
        }
        onFocus={() => {
          setFocused(true);
          toEnd();
        }}
        onBlur={() => setFocused(false)}
        onClick={toEnd}
        className="absolute inset-0 h-full w-full bg-transparent text-transparent caret-transparent outline-none selection:bg-transparent"
      />
    </div>
  );
}
