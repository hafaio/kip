// Where kip can reach someone, read off one field. The Email/Phone control beside
// it only tells the browser which keyboard and autofill to offer — routing is
// decided here, by what was actually typed, so the control is never a mode
// someone can be WRONG about: an address typed while Phone shows still sends an
// email rather than failing validation.
//
// Pure and tested, like `gateStep` and `decideReattach`, for the same reason: the
// sheet around it needs React and Firebase to exercise, and this needs neither.

export type Destination =
  | { kind: "email"; value: string }
  | { kind: "phone"; value: string }
  | { kind: "unknown" };

// Deliberately loose. A stricter pattern rejects addresses that work, and the
// only cost of accepting a bad one is that the code never arrives — which the
// waiting state already has to survive, since a typo is indistinguishable from
// slow mail.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// US only, which is the SMS region allowlist. Everything else is offered the
// email door rather than a refusal from the server after a code was billed.
const US_DIGITS = /^1?(\d{10})$/;

export function parseDestination(raw: string): Destination {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "unknown" };

  // An "@" is unambiguous: no phone number contains one, so this decides the
  // branch before either pattern runs and keeps the errors specific.
  if (trimmed.includes("@")) {
    return EMAIL.test(trimmed)
      ? { kind: "email", value: trimmed.toLowerCase() }
      : { kind: "unknown" };
  }

  // Punctuation people actually type: (415) 555-0123, 415.555.0123, +1 415 555 0123.
  const digits = trimmed.replace(/[\s\-().]/g, "").replace(/^\+/, "");
  const match = US_DIGITS.exec(digits);
  if (match) return { kind: "phone", value: `+1${match[1]}` };

  return { kind: "unknown" };
}

// A number that parses as a phone number somewhere, but not somewhere kip can
// text. Worth telling apart from gibberish: the advice is "use email", not
// "check what you typed".
export function isForeignNumber(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) return false;
  const digits = trimmed.replace(/[\s\-().]/g, "").replace(/^\+/, "");
  return /^\d{7,15}$/.test(digits) && !US_DIGITS.test(digits);
}
