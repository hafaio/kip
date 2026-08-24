"use client";

import type { ConfirmationResult } from "firebase/auth";
import type { ReactElement, RefObject } from "react";
import {
  confirmPhoneCode,
  sendAttachLink,
  sendPhoneCode,
  sendReturnLink,
} from "../utils/auth";
import { isForeignNumber, parseDestination } from "../utils/destination";
import { auth } from "../utils/firebase";
import Input from "./ui/input";

// One field for both doors, shared by the two sheets that collect a way to
// reach someone. The Segmented sets only the keyboard and the autofill hint —
// `parseDestination` decides the route from what was actually typed, so being in
// the "wrong" mode can never turn a good address into an error.
//
// Email defaults because the failure modes are asymmetric: a number typed on an
// email keyboard is awkward, an address typed on a numeric keypad is impossible.
export type ReachState = {
  raw: string;
  mode: "email" | "phone";
  pending: ConfirmationResult | null;
  code: string;
  sentTo: string | null;
};

export const EMPTY_REACH: ReachState = {
  raw: "",
  mode: "email",
  pending: null,
  code: "",
  sentTo: null,
};

// `only` is the caller saying its surface names one door — the Settings row that
// adds a number — so an address typed into it is a mistake rather than the other
// route, and saying "or an email address" there would offer something the sheet
// around it cannot do.
export function reachError(raw: string, only?: "phone"): string | null {
  if (!raw) return null;
  const parsed = parseDestination(raw);
  if (only && parsed.kind === "email") return "That's an email, not a number.";
  if (parsed.kind !== "unknown") return null;
  if (isForeignNumber(raw)) {
    return "Phone codes are US-only for now — an email works from anywhere.";
  }
  return only
    ? "That doesn't look like a US phone number."
    : "That doesn't look like an email address or a US phone number.";
}

// Sends whichever kind was typed. Email returns immediately (the link lands in
// an inbox); phone hands back a pending confirmation the caller must finish with
// a code, which is the one asymmetry between the doors that reaches the UI.
//
// `mode` is the only thing that differs between attaching an identity to the
// account already asking and coming back to one you already have — and only for
// email, since a texted code signs in or links off the same call. Parameterised
// rather than duplicated: the two paths drifting is precisely how phone ended up
// offered on one and not the other.
export async function sendReach(
  raw: string,
  host: string,
  container: HTMLElement,
  mode: "attach" | "return" = "attach",
): Promise<{ pending: ConfirmationResult | null; sentTo: string }> {
  const parsed = parseDestination(raw);
  if (parsed.kind === "email") {
    if (mode === "return") await sendReturnLink(parsed.value);
    else await sendAttachLink(parsed.value, host);
    return { pending: null, sentTo: parsed.value };
  }
  if (parsed.kind === "phone") {
    const wasUid = auth().currentUser?.uid ?? null;
    const pending = await sendPhoneCode(parsed.value, container);
    // Stashed on the object so the confirm step can tell whether the uid
    // survived without threading it through the sheet's state.
    return {
      pending: Object.assign(pending, { wasUid }),
      sentTo: parsed.value,
    };
  }
  throw new Error("nothing to send to");
}

export async function confirmReach(
  pending: ConfirmationResult,
  code: string,
): Promise<{ sameAccount: boolean }> {
  const wasUid = (pending as { wasUid?: string | null }).wasUid ?? null;
  return confirmPhoneCode(pending, code, wasUid);
}

export default function ReachField({
  state,
  onChange,
  hostRef,
  only,
}: {
  state: ReachState;
  onChange: (next: ReachState) => void;
  // Owned by the caller because the SEND needs it, and the send lives there.
  hostRef: RefObject<HTMLDivElement | null>;
  // Pins the field to one door and drops the offer of the other. See
  // `reachError`.
  only?: "phone";
}): ReactElement {
  // The code step replaces the field rather than sitting under it: at that point
  // the number is settled and the only thing left to type is six digits. It
  // carries the SAME message line, or a refused code has nowhere to be said and
  // the sheet just stops.
  if (state.pending) {
    return (
      <>
        {/* The message line above describes the PREVIOUS step and cannot know
            about this one, so the code step names its own: a bare six-digit box
            with nothing saying anything was texted, or where to, was the one
            step the restructure was meant to make legible. */}
        <p className="text-sm text-muted">
          We texted a code to {state.sentTo}. Standard message rates apply.
        </p>
        <Input
          autoComplete="one-time-code"
          inputMode="numeric"
          autoFocus
          value={state.code}
          onChange={(event) =>
            onChange({ ...state, code: event.target.value.trim() })
          }
          placeholder="123456"
        />
        {/* A code that never arrives must not trap the ask. Backing out returns
            to the field with everything else intact, so the request can still
            go with no way to be reached — which is what "optional" has to mean
            for it to be true. */}
        <button
          type="button"
          onClick={() => onChange({ ...EMPTY_REACH, mode: state.mode })}
          className="self-start text-sm font-semibold text-accent-ink hover:opacity-80"
        >
          {only
            ? "Didn't get it? Start over"
            : "Didn't get it? Use something else"}
        </button>
      </>
    );
  }

  const phoneMode = state.mode === "phone";

  return (
    <>
      {/* The switch lives in the field's tail and only while the field is
          empty: everything it does — keyboard, autofill hint, placeholder — is
          settled at focus, before a character exists. Words rather than an icon
          because a stranger on a share link meets this once, and naming the
          ALTERNATIVE removes the is-this-a-state-or-an-action ambiguity every
          icon toggle carries. */}
      <Input
        autoComplete={phoneMode ? "tel" : "email"}
        inputMode={phoneMode ? "tel" : "email"}
        value={state.raw}
        onChange={(event) => onChange({ ...state, raw: event.target.value })}
        placeholder={phoneMode ? "(415) 555-0123" : "you@example.com"}
        wideSuffix
        suffix={
          state.raw || only ? undefined : (
            <button
              type="button"
              onClick={() =>
                onChange({ ...state, mode: phoneMode ? "email" : "phone" })
              }
              className="text-sm font-semibold text-accent-ink hover:opacity-80"
            >
              {phoneMode ? "Use email" : "Use phone"}
            </button>
          )
        }
      />

      {/* Invisible reCAPTCHA still binds to a real element, so one has to exist
          before the send rather than being conjured during it. Out of flow: at
          zero height it still collected a full gap from the column, which is
          12px of nothing between the field and the button. */}
      <div ref={hostRef} className="absolute" />
    </>
  );
}
