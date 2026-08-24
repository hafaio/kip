"use client";

import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { FaGoogle } from "react-icons/fa";
import { LuLoaderCircle } from "react-icons/lu";
import { PhoneAlreadySet } from "../utils/auth";
import { auth } from "../utils/firebase";
import { useKip } from "../utils/store";
import { validateDisplayName } from "../utils/username";
import { useDialog } from "./dialog";
import ReachField, {
  confirmReach,
  EMPTY_REACH,
  type ReachState,
  reachError,
  sendReach,
} from "./reach-field";
import Button from "./ui/button";
import Input from "./ui/input";
import Sheet from "./ui/sheet";

type NameGateValue = {
  // Runs an action that will put your name in front of another person,
  // collecting the name first if there isn't one. Nothing is written until the
  // action runs, so dismissing the sheet abandons it and costs nothing.
  runNamed: (action: () => Promise<void>, label: string) => Promise<void>;
  // Opens the same sheet with nothing held, for the surfaces that ask someone to
  // finish rather than to do something — the hosting card, the reach card.
  askIdentity: () => void;
};

const NameGateContext = createContext<NameGateValue | null>(null);

// Said the same way wherever a link turns out to be a sign-in: the sheet here,
// and the Settings rows that add a way in. It names the ONE thing nobody can
// fix from inside kip — there is no merge — so it has to end with a choice
// rather than an apology.
export function otherAccountAlert(door: string): {
  title: string;
  body: string;
} {
  return {
    title: "You're in your other account",
    body: `That ${door} was already on kip, so you're signed into it now. kip can't combine two accounts — keep whichever has more history, and delete the other from its own Settings. Whatever you were doing, start it again from here.`,
  };
}

// Routes that own their identity flow. Matched on a trailing segment so the
// GitHub Pages base path doesn't change the answer.
function ownRoute(pathname: string): boolean {
  return /\/(portal|continue)\/?$/.test(pathname);
}

export function useNameGate(): NameGateValue {
  const ctx = useContext(NameGateContext);
  if (!ctx) throw new Error("useNameGate must be used within NameGateProvider");
  return ctx;
}

// One sheet that collects whatever is missing — a name, a way to be reached, or
// both — so no surface has to know which of the two a person lacks.
//
// The portal page keeps its own copy of this pattern rather than calling in: its
// hold reports failures into `debug` and races a timeout, neither of which the
// in-app verbs need. Two implementations of one WRITTEN-DOWN pattern is fine;
// two patterns is not.
export default function NameGateProvider({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const {
    profile,
    profileReady,
    anonymous,
    email,
    signIn,
    completeOnboarding,
  } = useKip();
  const { alert } = useDialog();
  const [held, setHeld] = useState<{
    action: () => Promise<void>;
    label: string;
  } | null>(null);
  const [name, setName] = useState("");
  const [reach, setReach] = useState<ReachState>(EMPTY_REACH);
  const recaptcha = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback((action: () => Promise<void>, label: string) => {
    setName("");
    setReach(EMPTY_REACH);
    setSentTo(null);
    setError(null);
    setHeld({ action, label });
  }, []);

  // A brand-new credentialed account — someone continuing on a new device, or a
  // Google arrival carrying no name — has no ask to hold and no friend request
  // to accept, so nothing else would ever open this. Without it they land in the
  // app permanently nameless, and every write pinned to their profile refuses.
  useEffect(() => {
    // Only on the app's own routes. `/portal/` and `/continue/` render their own
    // sheets and reach that state legitimately — a Google sign-in returning no
    // name, a phone sign-in into a profileless account — where this would stack
    // a second sheet that cannot be dismissed, since closing it re-opens it on
    // the next render.
    if (typeof window !== "undefined" && ownRoute(window.location.pathname)) {
      return;
    }
    if (!profileReady || anonymous || profile?.displayName || held) return;
    open(async () => undefined, "Continue");
  }, [profileReady, anonymous, profile, held, open]);

  const askIdentity = useCallback(
    () => open(async () => undefined, "Continue"),
    [open],
  );

  const runNamed = useCallback(
    async (action: () => Promise<void>, label: string): Promise<void> => {
      if (profile?.displayName) {
        await action();
        return;
      }
      open(action, label);
    },
    [profile, open],
  );

  const needsName = !profile?.displayName;
  // Credentialed is not the same as reachable: a phone-only account has a way
  // back in and still no address kip can write to, and gating on `anonymous`
  // handed exactly that person a sheet with nothing in it.
  const needsReach = anonymous || !email;
  const reachInvalid = reachError(reach.raw);
  const invalid = name && needsName ? validateDisplayName(name) : null;
  const problem = invalid ?? reachInvalid ?? error;
  const message = "Only so kip can reach you. Nobody else sees it.";

  // Two failures with two different remedies — correct an address, or retry a
  // write — so they are caught separately. One catch around both blamed the
  // address for a Firestore outage, sometimes under a note saying that same
  // address had just worked.
  // Google identifies you outright, so there is nothing to prove afterwards and
  // no name to type — it carries one. The held action runs straight after.
  async function googleAttach(): Promise<void> {
    if (!held) return;
    setBusy(true);
    setError(null);
    try {
      const { sameAccount } = await signIn();
      // That Google account already existed and they are in it now. It has its
      // own name and photo, which this sheet's must not overwrite, and the held
      // action belongs to a uid they have just left — so neither runs, and the
      // sheet stays up to say why rather than vanishing.
      if (!sameAccount) {
        // Closed, not merely explained. The held action belongs to the uid they
        // just left, and for the account they landed in both fields compute
        // away — leaving a sentence, a dead submit and a divider.
        setHeld(null);
        await alert(otherAccountAlert("Google account"));
        return;
      }
      const known = auth().currentUser?.displayName?.trim();
      if (needsName && known) await completeOnboarding(known);
      else if (needsName) {
        setError("Google didn't share a name. Type one.");
        return;
      }
      await held.action();
      setHeld(null);
    } catch (caught) {
      console.error(caught);
      setError("That didn't work. Try again, or use email.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(): Promise<void> {
    if (!held || reachInvalid || sentTo) return;
    if (needsName && validateDisplayName(name)) return;
    setBusy(true);
    setError(null);
    let emailed: string | null = null;

    // A code that has been sent is waiting to be typed, so this submit finishes
    // that rather than starting again.
    if (reach.pending) {
      try {
        const { sameAccount } = await confirmReach(reach.pending, reach.code);
        // The number belonged to an account they already had, so they are now
        // IN it — and it has its own name and photo. Writing the sheet's over
        // them would be destructive, and the held action belongs to a uid they
        // are no longer, so neither runs.
        if (!sameAccount) {
          setBusy(false);
          setHeld(null);
          await alert(otherAccountAlert("number"));
          return;
        }
      } catch (caught) {
        console.error(caught);
        setError("Wrong code. Check it, or ask for another.");
        setBusy(false);
        return;
      }
    } else if (reach.raw) {
      try {
        // First, while this sheet is still mounted to report it: writing the
        // profile can close it, and a send awaited afterwards could neither echo
        // the address back nor show a failure to anyone.
        const holder = recaptcha.current;
        if (!holder) throw new Error("no element for the check to bind to");
        // No host: this reach was collected in Settings or beside an accept,
        // where there is no request for the landing page to name.
        const sent = await sendReach(reach.raw, "", holder);
        // Recorded either way: a code needs the second step, and an emailed
        // link needs the confirmation panel to have something to name.
        setReach({ ...reach, pending: sent.pending, sentTo: sent.sentTo });
        if (sent.pending) {
          // The phone door has a second step, so nothing else runs yet.
          setBusy(false);
          return;
        }
        emailed = sent.sentTo;
      } catch (caught) {
        console.error(caught);
        setError(
          caught instanceof PhoneAlreadySet
            ? "This account has a number. Add an email."
            : "Couldn't send that. Check it, or clear it.",
        );
        setBusy(false);
        return;
      }
    }

    try {
      // Before the action, because the rules read the COMMITTED profile: an edge
      // write is pinned against the name Firestore holds, not the one in hand.
      if (needsName) await completeOnboarding(name.trim());
      await held.action();
    } catch (caught) {
      console.error(caught);
      setError("Couldn't save that. Check your connection.");
      setBusy(false);
      return;
    }

    setBusy(false);
    // An emailed link is still to be opened, so the sheet says so. A code has
    // been typed by now, and a bare name has nothing left to report.
    if (emailed) setSentTo(emailed);
    else setHeld(null);
  }

  return (
    <NameGateContext.Provider value={{ runNamed, askIdentity }}>
      {children}
      <Sheet
        open={held !== null}
        onClose={() => setHeld(null)}
        title={
          needsName ? "What should we call you?" : "Where can kip reach you?"
        }
      >
        {/* Once the email is away the form has nothing left to do, and leaving
            it submittable would re-run a held action whose request may already
            be gone — painting an error over a flow that worked. */}
        {sentTo ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">
              Check {sentTo} and open the link — that's what keeps your kip if
              you switch phones. Nothing is waiting on it; you can close this.
            </p>
            <Button size="lg" onClick={() => setHeld(null)}>
              Done
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {needsName ? (
              <Input
                autoComplete="name"
                autoFocus
                invalid={Boolean(invalid)}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Your name"
              />
            ) : null}

            {needsReach ? (
              <ReachField
                state={reach}
                onChange={(next) => {
                  setError(null);
                  setReach(next);
                }}
                hostRef={recaptcha}
                invalid={Boolean(reachInvalid || error)}
              />
            ) : null}

            {/* One line, under both fields and over the button, carrying the
                reason for the address OR whatever is wrong. Two slots would
                make the sheet grow and shrink as you type; one cannot. It is
                the address that needs explaining, so with no address field
                there is nothing to say and only a problem can speak.

                Rendered whether or not it has anything to say, because a
                bottom sheet grows UPWARD: a message that APPEARS rather than
                swapping shoves the fields out from under the thumb typing
                into them. Name-only mode has no standing copy, which is
                exactly the mode that used to jump. One line is enough for
                both — every string either slot can hold measures one at the
                sheet's 350px, which is what the budget in
                `tests/auth-copy.test.ts` keeps true. */}
            <p
              aria-live="polite"
              className={`min-h-5 text-sm leading-5 ${problem ? "text-danger" : "text-muted"}`}
            >
              {problem ?? (needsReach ? message : null)}
            </p>

            {/* Labelled by the verb it finishes, never "Save" — the button
              completes what they tapped rather than starting something new. */}
            <Button
              type="submit"
              size="lg"
              disabled={
                busy ||
                Boolean(reachInvalid) ||
                (needsName && Boolean(validateDisplayName(name)))
              }
            >
              {busy ? (
                <LuLoaderCircle className="animate-spin" />
              ) : (
                (held?.label ?? "Continue")
              )}
            </Button>
            {/* Below the button it replaces: the same thing, done another way.
                Above it, it read as the preferred route. */}
            <div className="flex items-center gap-3 py-0.5">
              <span className="h-px flex-1 bg-border" />
              <span className="text-xs text-faint">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              disabled={busy}
              onClick={googleAttach}
            >
              <FaGoogle />
              Continue with Google
            </Button>
          </form>
        )}
      </Sheet>
    </NameGateContext.Provider>
  );
}
