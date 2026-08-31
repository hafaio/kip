"use client";

import { type ReactElement, useState } from "react";
import {
  LuChevronDown,
  LuDownload,
  LuInbox,
  LuLogOut,
  LuMessageSquare,
  LuSettings,
  LuUser,
} from "react-icons/lu";
import { credentialed } from "../utils/feedback";
import { useInstall } from "../utils/install";
import { useKip } from "../utils/store";
import Avatar from "./avatar";
import { useDialog } from "./dialog";
import FeedbackSheet from "./feedback-sheet";
import { useLeave } from "./use-leave";

// Only shown once signed in (the app gates on auth). Sign-in itself lives on
// the WelcomeScreen, so this is the profile menu: your profile, Settings (the
// dock has no room for it), feedback, installing kip where that is possible,
// and sign-out.
export default function AuthMenu(): ReactElement | null {
  const {
    user,
    anonymous,
    email,
    doors,
    emailVerified,
    admin,
    unreadFeedback,
    profile,
    signOut,
    setView,
    navigate,
  } = useKip();
  const { leave, leaving } = useLeave();
  const { ready, byHand, install } = useInstall();
  const { alert } = useDialog();
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState(false);

  const displayName = profile?.displayName ?? user?.displayName ?? email;
  const photoURL = profile?.photoURL ?? user?.photoURL ?? null;

  async function doSignOut() {
    // Leaving is a teardown, not a sign-out, so it shares Settings' flow. The
    // menu stays open meanwhile, so "Leaving…" has somewhere to show until the
    // sign-out unmounts it.
    if (anonymous) {
      await leave();
      return;
    }
    setOpen(false);
    try {
      await signOut();
    } catch (error) {
      console.error(error);
    }
  }

  // A visitor who has not typed a name has nothing to show here — no avatar, no
  // profile. Once they have one they are a participant and the menu is theirs,
  // minus the exit: see below.
  // The app's own routes only. `/portal/` and `/continue/` render neither the
  // nav stack nor Settings, and history writes are skipped by pathname there —
  // so both destinations in this menu are dead taps. It used to be spared this
  // by hiding from anonymous sessions; now that a named anonymous visitor is a
  // participant, the gate has to name the reason directly.
  if (
    typeof window !== "undefined" &&
    /\/(portal|continue)\/?$/.test(window.location.pathname)
  ) {
    return null;
  }
  // Nameless sessions get no menu, and want none: they hold no profile, no ask
  // and no friends, so leaving would swap one empty anonymous account for
  // another — and the other two items here are a profile they don't have and
  // Settings. Three near-dead controls is worse than no avatar.
  if (!user || !displayName) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="You"
        className="flex h-10 items-center gap-0.5 rounded-full pr-1 transition hover:opacity-80"
      >
        <Avatar
          name={displayName ?? ""}
          photoURL={photoURL}
          className="h-9 w-9 text-sm shadow-soft"
        />
        {/* An avatar on its own reads as decoration, which is how Settings and
            sign-out end up looking absent — they live behind it. The chevron is
            the only thing saying it opens something. */}
        <LuChevronDown className="shrink-0 text-muted" size={14} />
        {/* The menu is shut by default, so a dot only inside it says nothing
            until you have already gone looking. */}
        {unreadFeedback && !open ? (
          <span className="absolute right-5 top-0.5 size-2 rounded-full bg-accent ring-2 ring-bg" />
        ) : null}
      </button>
      {open ? (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-2xl bg-surface p-1.5 shadow-panel">
            <button
              type="button"
              onClick={() => {
                if (user) navigate({ kind: "person", id: user.uid });
                setOpen(false);
              }}
              className="flex h-11 w-full items-center gap-3 whitespace-nowrap rounded-xl px-3 text-[0.9375rem] font-medium text-text hover:bg-surface-hover"
            >
              <LuUser className="text-muted" />
              <span>Your profile</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setView("settings");
                setOpen(false);
              }}
              className="flex h-11 w-full items-center gap-3 whitespace-nowrap rounded-xl px-3 text-[0.9375rem] font-medium text-text hover:bg-surface-hover"
            >
              <LuSettings className="text-muted" />
              <span>Settings</span>
            </button>
            {/* Only the operator, and only the rules make that true: the
                fragment this opens is guessable, and reaching it without the
                role renders an empty list rather than anything. */}
            {admin ? (
              <button
                type="button"
                onClick={() => {
                  setView("feedback");
                  setOpen(false);
                }}
                className="flex h-11 w-full items-center gap-3 whitespace-nowrap rounded-xl px-3 text-[0.9375rem] font-medium text-text hover:bg-surface-hover"
              >
                <LuInbox className="text-muted" />
                <span>Feedback inbox</span>
                {/* A dot, not a count: how MANY are waiting doesn't change what
                    you do about them, and a number would cost reading the whole
                    collection to draw it. */}
                {unreadFeedback ? (
                  <span className="ml-auto size-2 shrink-0 rounded-full bg-accent">
                    {/* Read out, where an aria-label on a roleless span is
                        simply dropped. */}
                    <span className="sr-only">unread</span>
                  </span>
                ) : null}
              </button>
            ) : null}
            {/* The rules refuse a report from an identity a page load mints, so
                the row is hidden rather than offered and then denied. What that
                costs is the visitor best placed to report a broken share link,
                which is the trade the credential gate makes everywhere. */}
            {credentialed(doors, emailVerified) ? (
              <button
                type="button"
                onClick={() => {
                  setFeedback(true);
                  setOpen(false);
                }}
                className="flex h-11 w-full items-center gap-3 whitespace-nowrap rounded-xl px-3 text-[0.9375rem] font-medium text-text hover:bg-surface-hover"
              >
                <LuMessageSquare className="text-muted" />
                <span>Send feedback</span>
              </button>
            ) : null}
            {/* Only where it can do something. Chrome hands over a prompt and
                this opens it; Safari has no such event, so on an iPhone the row
                says where the control actually is rather than offering a button
                that cannot work. Installed already, neither shows. */}
            {ready || byHand ? (
              <button
                type="button"
                onClick={async () => {
                  setOpen(false);
                  if (ready) await install();
                  else {
                    await alert({
                      title: "Add kip to your Home Screen",
                      body: "Tap the Share button in Safari, then Add to Home Screen. kip opens like an app after that, and keeps working when you have no signal.",
                    });
                  }
                }}
                className="flex h-11 w-full items-center gap-3 whitespace-nowrap rounded-xl px-3 text-[0.9375rem] font-medium text-text hover:bg-surface-hover"
              >
                <LuDownload className="text-muted" />
                <span>Install kip</span>
              </button>
            ) : null}
            {/* Everyone gets an exit, and it is the one thing in this menu
                that reads as an action rather than a destination. What differs
                is what it MEANS: with a credential it is an ordinary sign-out;
                without one there is no way back in, so leaving is deletion and
                the word says so before the confirm does. Hiding it from
                unverified sessions left the people it matters most to with no
                way out of the menu at all. */}
            <button
              type="button"
              onClick={doSignOut}
              className="mt-1 flex h-11 w-full items-center gap-3 whitespace-nowrap rounded-xl border-t border-border px-3 text-[0.9375rem] font-semibold text-danger hover:bg-danger-soft"
            >
              <LuLogOut />
              <span>
                {anonymous ? (leaving ? "Leaving…" : "Leave kip") : "Sign out"}
              </span>
            </button>
          </div>
        </>
      ) : null}
      <FeedbackSheet open={feedback} onClose={() => setFeedback(false)} />
    </div>
  );
}
