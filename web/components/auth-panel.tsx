"use client";

import { type ReactElement, useRef, useState } from "react";
import { FaGoogle } from "react-icons/fa";
import { LuLoaderCircle } from "react-icons/lu";
import { authErrorMessage } from "../utils/auth";
import { useKip } from "../utils/store";
import { useDialog } from "./dialog";
import ReachField, {
  confirmReach,
  EMPTY_REACH,
  type ReachState,
  reachError,
  sendReach,
} from "./reach-field";
import Button from "./ui/button";

// The door — the whole of it, since the same one-time link both makes an account
// and returns you to one, and the flow never asks which you are. No password: a
// one-time link or code is fewer things to remember and fewer to lose, and
// retiring it took the whole reset flow — its own screen, its own failure
// states, its own careful "if an account exists" notice — out of the product.
//
// It offers the SAME three doors as the identity sheet, and that is the point
// rather than a nicety: an account whose only credential is a phone number could
// not get back in on a new device while this offered email and Google alone.
// Anything addable must be returnable.
//
// Nothing here says sign in or sign up, and the omission is deliberate: the same
// link works whether or not kip has met this address, so there is no question to
// answer and no wrong door to pick. Nor does anything spell out the accepted
// formats — the placeholder and the "Use phone" link carry them, and the US-only
// limit is said by `reachError` at the moment it bites.
//
// It owns the CARD as well as the form, so that the standing notice under the
// card and the error that replaces it are one node rather than the same string
// synchronised into two components. `notice` is what that line says when
// nothing is wrong.
export default function AuthPanel({
  notice,
}: {
  notice: string;
}): ReactElement {
  const { configured, signIn } = useKip();
  const { alert } = useDialog();
  const [reach, setReach] = useState<ReachState>(EMPTY_REACH);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const recaptcha = useRef<HTMLDivElement>(null);

  const invalid = reachError(reach.raw);
  const problem = invalid ?? error;

  async function guardConfigured(): Promise<boolean> {
    if (configured) return true;
    await alert({
      title: "Firebase isn't set up yet",
      body: "Create a Firebase project, enable Email link, Phone and Google sign-in, and paste its config into web/utils/firebase.ts to continue.",
    });
    return false;
  }

  async function run(action: () => Promise<unknown>): Promise<void> {
    if (!(await guardConfigured())) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      console.error(caught);
      // Remedy-shaped, matching the other two surfaces: `authErrorMessage`
      // ends at "Something went wrong. Try again." for most codes, which tells
      // nobody what to do differently. Its specific cases still speak.
      const mapped = authErrorMessage(caught);
      setError(
        mapped === "Something went wrong. Try again."
          ? "Couldn't send that. Check or change it."
          : mapped,
      );
    } finally {
      setBusy(false);
    }
  }

  async function submit(): Promise<void> {
    if (invalid || !reach.raw) return;
    // A code already sent is waiting to be typed, so this finishes it.
    if (reach.pending) {
      // Caught apart from the send, and worded like its siblings: routed
      // through `run`, a refused code came back as "couldn't send that" while
      // the code step in front of them was asking for exactly that code.
      setBusy(true);
      setError(null);
      try {
        await confirmReach(reach.pending, reach.code);
      } catch (caught) {
        console.error(caught);
        setError("Wrong code. Check it, or ask for another.");
      } finally {
        setBusy(false);
      }
      return;
    }
    const holder = recaptcha.current;
    // Reported, not swallowed — the two sheets throw here and say so, and a
    // dead Continue with no spinner and nothing in the console is the exact
    // divergence these four surfaces exist to have eliminated.
    if (!holder) {
      setError("Couldn't start that. Reload and try again.");
      return;
    }
    await run(async () => {
      const sent = await sendReach(reach.raw, "", holder, "return");
      if (sent.pending) setReach({ ...reach, ...sent });
      else setSentTo(sent.sentTo);
    });
  }

  // Deliberately identical whether or not kip knows the address — that is what
  // preserves the non-enumeration the old reset notice had to spell out.
  const body = sentTo ? (
    <div className="flex flex-col gap-3 text-center">
      <p className="text-sm text-muted">
        Open the link we sent to {sentTo} and you're in. It works for about an
        hour.
      </p>
      <Button variant="ghost" onClick={() => setSentTo(null)}>
        Use something else
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
      <ReachField
        state={reach}
        onChange={(next) => {
          setError(null);
          setReach(next);
        }}
        hostRef={recaptcha}
        invalid={Boolean(problem)}
      />
      <Button
        type="submit"
        size="lg"
        className="w-full"
        disabled={busy || Boolean(invalid) || !reach.raw}
      >
        {busy ? <LuLoaderCircle className="animate-spin" /> : "Continue"}
      </Button>

      {/* Under the button it stands in for, the same as every other surface
          that offers it — above, it reads as the recommended route, which is
          a claim kip has no reason to make about one door of three. */}
      <div className="flex items-center gap-3 py-0.5">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs text-faint">or</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <Button
        type="button"
        variant="secondary"
        size="lg"
        className="w-full"
        disabled={busy}
        onClick={() => run(signIn)}
      >
        <FaGoogle />
        Continue with Google
      </Button>
    </form>
  );

  return (
    <>
      {/* No heading and no label. An email field over a Continue button is
          self-evidently the way in, and "no sign-up, no password" is said by
          the absence of a toggle and a password field rather than by a line
          claiming it. */}
      <div className="w-full max-w-sm rounded-3xl bg-surface p-6 text-left shadow-panel">
        {body}
      </div>
      {/* The card's caption, and the height belongs to the slot rather than to
          the copy: the notice's own two lines are reserved whether it or an
          error is speaking, so a problem appearing, changing or clearing never
          moves the card above it. The page is a centred column, so anything
          that changes height here re-centres and shifts the door itself.

          One line of error is a budget rather than a hope, pinned by
          `tests/auth-copy.test.ts`. */}
      <p
        aria-live="polite"
        className={`max-w-sm min-h-10 text-sm leading-5 ${problem ? "text-danger" : "text-muted"}`}
      >
        {problem ?? notice}
      </p>
    </>
  );
}
