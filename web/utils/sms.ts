// kip's sending number, empty until one is provisioned — the same "ships able to
// be off" shape `smsConfigured()` has on the sender's side. It is not a secret:
// it rides in the From line of every message kip sends, exactly as GMAIL_USER
// does.
//
// A SECOND copy of `TWILIO_FROM` in `functions/src/index.ts`, because the two
// packages cannot import from each other. `tests/drift.test.ts` pins them
// together — a number that disagreed with the sender's would tell someone to
// text START to a phone kip has never texted from, which is worse than saying
// nothing, since the message would go somewhere and change nothing.
export const SMS_FROM = "";

// `?&body=` rather than `?body=` or `&body=`: the one form both iOS and Android
// prefill from, so re-opting in is a tap rather than a number to copy out.
export function startTextLink(from: string): string {
  return `sms:${from}?&body=START`;
}

// US only, which is where kip texts at all — anything else is shown as stored
// rather than mangled into a shape it isn't.
export function formatUsNumber(e164: string): string {
  const digits = e164.startsWith("+1") ? e164.slice(2) : "";
  return /^\d{10}$/.test(digits)
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : e164;
}

// Longer than the portal ask's ten seconds, deliberately: that one covers a
// browser talking to Firestore, this one waits on a Cloud Function that may be
// cold-starting, Twilio's own ten-second timeout inside it, and a second write
// afterwards. Ten seconds here would call a healthy run stalled.
export const CHECK_STALL_MS = 30_000;

export type ProbeState = "idle" | "checking" | "stalled" | "answered";

// Derived from the two stamps and the clock, never stored: the ask is already
// an epoch reading of the client's own clock, so a spinner that should have
// finished is computable at render — and survives a reload, which a flag in
// component state would not.
//
// `stalled` exists because a spinner that never stops goes on claiming work is
// in progress when none is, the same reason the portal ask has a deadline. It
// is not terminal: a late answer arrives on the prefs listener and moves it on.
export function probeState(
  askedAt: number | null,
  answeredAt: number | null,
  now: number,
): ProbeState {
  if (askedAt === null) return "idle";
  if (askedAt <= (answeredAt ?? 0)) return "answered";
  return now - askedAt < CHECK_STALL_MS ? "checking" : "stalled";
}
