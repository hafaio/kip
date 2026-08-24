"use client";

import { signInWithEmailLink } from "firebase/auth";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import ThemeButton from "../../components/theme-button";
import { Mark } from "../../components/wordmark";
import { tokenExpired } from "../../utils/auth";
import { auth, firebaseConfig } from "../../utils/firebase";

// Its own route rather than a mode of `/portal/`, because that page mints an
// anonymous account on load — this one must not, since it has no use for a
// session and every landing would leave a throwaway behind. A skip flag would
// have been an invariant held by a comment.
//
// Two jobs behind one URL, told apart by whether an ID token rides along.
// ATTACHING (token present) links the address to the anonymous account already
// asking somewhere else and never signs in here — which is what makes it survive
// a mail app's throwaway browser. RETURNING (no token) is a real sign-in on this
// device, for someone coming back with no session at all.

// One HTTPS round trip to a warm endpoint, with a person watching a page that
// offers nothing else. Deliberately shorter than the portal's ten seconds, which
// covers a dependency chain with the SDK's own retries behind it.
const CONTINUE_TIMEOUT_MS = 6_000;

// `connectAuthEmulator` points the SDK, and nothing points a raw fetch — so
// attaching was the one door a local run could not open, while returning (an SDK
// call) worked. Written out rather than read off a helper for the reason the
// same pair is written out in `utils/firebase.ts`: Next inlines NODE_ENV, so the
// whole ternary folds and no localhost address reaches a production bundle.
function identityToolkit(): string {
  return process.env.NODE_ENV !== "production" &&
    process.env.NEXT_PUBLIC_AUTH_EMULATOR === "1"
    ? "http://127.0.0.1:9099/identitytoolkit.googleapis.com"
    : "https://identitytoolkit.googleapis.com";
}

type Outcome = "working" | "done" | "expired" | "stalled" | "taken" | "failed";

// The one refusal that is worth naming, because it is the one nobody can fix
// from anywhere else: kip cannot merge two accounts, and the ask this link
// belongs to is held by the account that was asking, not by the address.
const EMAIL_EXISTS = "EMAIL_EXISTS";

// What the link carried, read out of the address bar exactly once.
type Link = {
  // The URL as it arrived. `signInWithEmailLink` parses the code out of it
  // itself, so it has to be kept rather than rebuilt.
  href: string;
  idToken: string;
  email: string;
  oobCode: string;
  host: string | null;
};

const LINK_KEY = "kip:continue";

// The ATTACH link carries an ID token, which is a live credential for the
// account asking — an hour of one — and leaving it standing in the address bar
// puts it in the static host's access log, in this browser's history, and in
// whatever that history syncs to. It cannot be kept out of the first request
// (that request is how the page loads at all), but it has no business outliving
// it, so it is read once and wiped with `replaceState`.
//
// Mirrored into `sessionStorage` first, because wiping it breaks two things
// otherwise: the retry button re-reads the link, and a RELOAD would find an
// attach link with no token and fall through to the RETURNING branch — which
// signs in rather than links, minting a second account for an address whose
// whole point was to join the first. Per tab, gone when it closes, and sent
// nowhere; strictly better than the address bar, which is where it was.
function readLink(): Link | null {
  const query = new URLSearchParams(window.location.search);
  const email = query.get("email");
  if (email) {
    const link: Link = {
      href: window.location.href,
      idToken: query.get("idToken") ?? "",
      email,
      oobCode: query.get("oobCode") ?? "",
      host: query.get("host"),
    };
    let mirrored = true;
    try {
      sessionStorage.setItem(LINK_KEY, JSON.stringify(link));
    } catch {
      mirrored = false;
    }
    // Only once there is a safer copy. Wiping is worth doing BECAUSE the token
    // is held somewhere better; with nowhere to hold it, wiping destroys the
    // only copy and a reload lands on a page that can no longer finish. And the
    // browsers that refuse storage are private windows, which keep no history
    // to leak into — so the wipe buys least exactly where it would cost most.
    if (mirrored) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    return link;
  } else {
    try {
      const held = sessionStorage.getItem(LINK_KEY);
      return held ? (JSON.parse(held) as Link) : null;
    } catch {
      return null;
    }
  }
}

// Once the code is spent there is nothing left to retry and no reason to keep a
// credential around.
function forgetLink(): void {
  try {
    sessionStorage.removeItem(LINK_KEY);
  } catch {
    // Nothing to do, and nothing depends on it having worked.
  }
}

export default function ContinuePage(): ReactElement {
  const [outcome, setOutcome] = useState<Outcome>("working");
  const [mode, setMode] = useState<"attach" | "return">("attach");
  const [host, setHost] = useState<string | null>(null);

  // The whole job, callable again by the retry button — no counter, so nothing
  // has to be a dependency that isn't read.
  // The one-time code may be spent ONCE. React's StrictMode mounts every effect
  // twice in dev, and the cleanup below only stops the first run from writing
  // state — it cannot recall a request already in flight. Without this the
  // second mount always found the code spent, so the email door was the one
  // path a local run could never verify.
  const spent = useRef<string | null>(null);
  // Read once and held, because reading it is what WIPES it: after the first
  // pass the address bar carries nothing, so the retry button has only this.
  const link = useRef<Link | null>(null);

  const attach = useCallback((retrying = false): (() => void) => {
    link.current ??= readLink();
    const held = link.current;

    if (!held) {
      setOutcome("failed");
      return () => undefined;
    }
    const { idToken, email } = held;
    setHost(held.host);
    // The discriminator between the two modes. An ID token means an anonymous
    // account is asking for this address to be attached to it; its absence means
    // someone is coming back to an account they already have, and the same call
    // signs them in instead of linking.
    const returning = !idToken;
    setMode(returning ? "return" : "attach");

    // Before spending the one-time code, never after: the code outlives our
    // token, so an expired open must not burn one that still works. A returning
    // link carries no token, so only the code's own lifetime applies.
    if (!returning && tokenExpired(idToken)) {
      // Nothing can be done with it and no retry is offered, so it goes.
      forgetLink();
      setOutcome("expired");
      return () => undefined;
    }

    const code = held.oobCode;
    // A retry is a deliberate second send, and this guard is only about the
    // second MOUNT — refusing one left the page on `working` with nothing on it,
    // since returning here sets no outcome at all.
    if (!retrying && spent.current === code) return () => undefined;
    spent.current = code;

    let live = true;
    // A stall is only ever provisional: the call may still be in flight, and if
    // it lands the answer replaces this. Retry is offered on the timeout alone,
    // because a call that ANSWERED has already spent the one-time code — posting
    // it again would report failure for a flow that worked.
    const timer = setTimeout(() => {
      if (live) setOutcome("stalled");
    }, CONTINUE_TIMEOUT_MS);

    // Two calls, because the modes want different things from the answer.
    // Returning needs a SESSION in this browser, and only the SDK can persist
    // one — the raw REST call hands back tokens with nowhere to put them, so the
    // page would say "you're signed in" over a browser that is not, and every
    // attempt would burn a one-time code. Attaching wants no session at all:
    // passing an idToken makes the endpoint LINK the address to that account
    // rather than mint one, and this browser is disposable.
    const work: Promise<unknown> = returning
      ? signInWithEmailLink(auth(), email, held.href)
      : fetch(
          `${identityToolkit()}/v1/accounts:signInWithEmailLink?key=${firebaseConfig.apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, oobCode: code, idToken }),
          },
        ).then(async (response) => {
          if (response.ok) return;
          const refusal = await response
            .json()
            .then((body) => body?.error?.message)
            .catch(() => null);
          throw new Error(refusal === EMAIL_EXISTS ? EMAIL_EXISTS : "refused");
        });

    work
      .then((): Outcome => "done")
      .catch(
        (error: Error): Outcome =>
          error.message === EMAIL_EXISTS ? "taken" : "failed",
      )
      .then((result) => {
        if (!live) return;
        clearTimeout(timer);
        // Spent, or refused for a reason nothing can change, so the credential
        // stops being kept. `failed` keeps it because a RELOAD is the only retry
        // it has — the screen deliberately offers no button, since a call that
        // ANSWERED has spent the code — and the one failure worth another go, a
        // request that never reached the server, lands here too. `stalled` is
        // the outcome with a button, and it never reaches this line at all: the
        // timeout sets it, not the work.
        if (result !== "failed") forgetLink();
        setOutcome(result);
      });

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => {
    cancel.current = attach();
    return () => cancel.current?.();
  }, [attach]);

  // Returning ends in the app itself: the sign-in has happened and this is the
  // device they want it on, so a panel with a button on it is a step between
  // someone and the thing they asked for. Attaching stays where it is — that
  // browser is disposable and the session it belongs to is somewhere else.
  const arriving = mode === "return" && outcome === "done";
  const left = useRef(false);
  useEffect(() => {
    // StrictMode runs this twice, and the guard costs less than reasoning about
    // whether a second navigation to the same URL is harmless.
    if (!arriving || left.current) return;
    left.current = true;
    // Replace, not assign: the code in this URL has been spent, so Back must
    // not lead back to it, and the app is entered on a URL that never held it.
    window.location.replace(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/`);
  }, [arriving]);

  // Empty when the address was added from inside the app rather than beside an
  // ask, where there is no request to mention at all.
  const who = host || null;

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex justify-end p-4">
        <ThemeButton />
      </div>
      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 pb-24 text-center">
        <Mark />

        {/* Static, and true whichever way the call goes. A script that never
            runs at all has still said the thing that matters — which a timeout
            cannot do, because a timeout is also script. It cannot name the host
            for the same reason: one exported page, and the query is unreadable
            before hydration. */}
        <p className="max-w-xs text-sm text-muted">
          This page only finishes what the email started — nothing you've
          already done depends on it.
        </p>

        {/* `arriving` holds the page on its quiet state while the browser
            leaves, rather than flashing a panel nobody is meant to read. */}
        {outcome === "working" || arriving ? null : outcome === "done" ? (
          <div className="flex flex-col gap-2">
            <h1 className="text-xl font-bold tracking-[-0.02em]">You're set</h1>
            <p className="max-w-xs text-sm text-muted">
              {who
                ? `Your email is attached, and your request to ${who} is already on its way.`
                : "Your email is attached."}{" "}
              Your kip lives in the browser you started from — you can close
              this page and head back there.
            </p>
          </div>
        ) : outcome === "expired" ? (
          <div className="flex flex-col gap-2">
            <h1 className="text-xl font-bold tracking-[-0.02em]">
              This link expired
            </h1>
            <p className="max-w-xs text-sm text-muted">
              Links like this only work for about an hour. Open the link your
              friend sent you again and kip will offer a fresh one — your
              request is unaffected.
            </p>
          </div>
        ) : outcome === "taken" ? (
          <div className="flex flex-col gap-2">
            <h1 className="text-xl font-bold tracking-[-0.02em]">
              That address already has a kip
            </h1>
            <p className="max-w-xs text-sm text-muted">
              It belongs to another account, and kip can't combine two. Open kip
              where you already use that address, or sign back in with it from
              kip's front page. Whatever you asked for still stands where you
              asked it.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <h1 className="text-xl font-bold tracking-[-0.02em]">
              {outcome === "stalled"
                ? "This page can't get through"
                : "That didn't work"}
            </h1>
            <p className="max-w-xs text-sm text-muted">
              {outcome === "stalled"
                ? "Nothing is lost. Try again, or close this and finish from where you started."
                : "This link can't be used. Nothing is lost: whatever you asked for still stands where you asked it."}
            </p>
            {/* Only after a timeout, where the call may never have run. A call
                that ANSWERED has spent the one-time code, so retrying it fails
                identically every press — the refusal is the answer, not a
                hiccup. */}
            {outcome === "stalled" ? (
              <button
                type="button"
                onClick={() => {
                  // Cancel the previous attempt and keep this one's canceller:
                  // a late answer from the first call would otherwise stamp its
                  // outcome over this one's.
                  cancel.current?.();
                  setOutcome("working");
                  cancel.current = attach(true);
                }}
                className="h-11 rounded-full bg-surface px-5 text-sm font-semibold shadow-card"
              >
                Try again
              </button>
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}
