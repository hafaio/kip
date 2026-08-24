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

// An absence from cache is two facts wearing one face, and the snapshot carries
// nothing that separates them. The SDK raises it the moment the listener
// attaches, before it has spoken to anyone, as soon as the target carries a
// resume token from a previous visit — and it raises exactly the same event
// when it concludes it is offline with nothing cached. Read as the offline
// verdict it tells an ordinary reload that the device can't reach kip; read as
// an answer it would put a returning user through onboarding, whose write
// merges over the name they already have. So it proves nothing by itself: the
// cache has to be asked which of the two raised it, which is `watchOwnProfile`'s
// job. A cached EXISTING profile needs no such asking — it's their own.
export function classifySnapshot(
  exists: boolean,
  fromCache: boolean,
): "answered" | "unproven" {
  return exists || !fromCache ? "answered" : "unproven";
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

// Which attempt an answer belongs to. `watchOwnProfile` asks the cache a
// question whose answer arrives on its own schedule, and Firestore's own promise
// not to call back after `unsubscribe` does not extend to it — so the listener
// has one escape hatch through which a torn-down attempt can still speak.
//
// It has to be attempt identity and not the uid: a `generation` re-attach opens
// a new listener for the SAME person, so a straggler from the old one carries
// the right uid and nothing outside this closure can tell it from an answer.
// Ordering and teardown are the same question — `stop()` is just "no later
// answer is current, ever" — which is why one counter serves both.
export function attempt(): {
  mint: () => () => boolean;
  stop: () => void;
} {
  let latest = 0;
  return {
    mint: () => {
      const mine = ++latest;
      return () => mine === latest;
    },
    stop: () => {
      latest += 1;
    },
  };
}
