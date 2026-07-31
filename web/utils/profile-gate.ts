// When the profile gate opens, shuts, and gives up. Split from the store's
// effect because that needs React, Firebase and a live session to exercise,
// and this needs none of them — the same split as `reattach.ts`.

export type GateState = {
  // Uid the gate is open for. A re-attach for the same session must repair
  // silently — shutting the gate splashes over the whole app.
  readonly openFor: string | null;
  // Uid last attached for. A verdict belongs to an attempt: a retry for the
  // same uid keeps it, a new session starts clean.
  readonly triedFor: string | null;
  // No answer is coming right now — not "no profile", which IS an answer.
  readonly unreachable: boolean;
};

export const NO_SESSION: GateState = {
  openFor: null,
  triedFor: null,
  unreachable: false,
};

export type GateEvent =
  // The profile effect (re)attached for this uid.
  | { readonly kind: "attach"; readonly uid: string }
  // A real answer: the profile, or a server-confirmed absence.
  | { readonly kind: "answered"; readonly uid: string }
  // No answer is coming right now: the SDK's offline verdict, a listener
  // error, or the backstop.
  | { readonly kind: "silence"; readonly uid: string }
  | { readonly kind: "signedOut" };

// Covers only the SDK's machinery never running at all (a frozen primary tab
// holding the cache lease) — its own offline verdict otherwise lands within
// its 10s handshake timer, faster and better informed than any constant here.
export const GATE_BACKSTOP_MS = 15_000;

// An absence from cache is the one unbelievable snapshot: it is byte-identical
// for "no profile" and "offline with nothing cached", and believing it would
// put a returning user through onboarding, whose write merges over the name
// they already have. A cached EXISTING profile is believable — it's their own.
export function classifySnapshot(
  exists: boolean,
  fromCache: boolean,
): "answered" | "silence" {
  return exists || !fromCache ? "answered" : "silence";
}

export function gateStep(state: GateState, event: GateEvent): GateState {
  switch (event.kind) {
    case "signedOut":
      return NO_SESSION;
    case "attach":
      return {
        // A gate left open by some OTHER uid says nothing about this one.
        openFor: state.openFor === event.uid ? state.openFor : null,
        triedFor: event.uid,
        // Kept across a retry for the same uid: clearing it flashed the splash
        // between "can't reach" and the next failure, once per retry.
        unreachable: state.triedFor === event.uid && state.unreachable,
      };
    case "answered":
      if (state.triedFor === event.uid) {
        return { openFor: event.uid, triedFor: event.uid, unreachable: false };
      } else {
        // A straggler from a torn-down attempt settles nothing.
        return state;
      }
    case "silence":
      if (state.triedFor === event.uid && state.openFor === null) {
        return { ...state, unreachable: true };
      } else {
        // Once open, silence is the re-attach machinery's problem
        // (`listenersLost`), never a reason to shut the gate.
        return state;
      }
  }
}
