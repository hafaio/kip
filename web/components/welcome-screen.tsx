"use client";

import type { ReactElement } from "react";
import AuthPanel from "./auth-panel";
import SiteFooter from "./site-footer";
import ThemeButton from "./theme-button";
import Wordmark from "./wordmark";

// Everyone who belongs on kip was invited by a person, so there is nobody here
// to persuade. The page confirms that this is the thing their friend meant and
// gets out of the way: one screen, one object to act on, nothing to scroll past.
// The smallness is the argument — a feature list would be selling something the
// visitor was already given.
//
// Pure render, deliberately: it never touches the fragment, so someone who
// opened a link to a room while signed out lands on that room the moment the
// door opens, off the stack the store already seeded.
export default function WelcomeScreen(): ReactElement {
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex justify-end p-4">
        <ThemeButton />
      </div>
      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        <div className="flex flex-col items-center gap-4">
          <Wordmark size="lg" />
          <p className="max-w-xs text-[0.9375rem] text-muted">
            Spare rooms and empty flats — shared between friends, for free.
          </p>
        </div>

        {/* The card AND the line under it, because that line is also where a
            problem with the field is said — one node, so the two can never
            disagree about how tall they are. */}
        <AuthPanel notice="Nothing on kip is public. Places appear when friends share them — or start by listing yours." />
      </main>

      <SiteFooter className="px-4 pb-8" />
    </div>
  );
}
