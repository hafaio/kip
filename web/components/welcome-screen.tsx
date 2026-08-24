"use client";

import type { ReactElement } from "react";
import AuthPanel from "./auth-panel";
import SiteFooter from "./site-footer";
import ThemeButton from "./theme-button";
import Wordmark from "./wordmark";

// What a stranger who typed the URL sees. There is honestly almost nothing to
// show them — kip has no public surface by construction — so it doesn't pretend
// otherwise. Nobody is enrolled
// here: a new person's front door is a friend's link, and offering a way in
// would rebuild the wall in different paint.
//
// It also serves the one person who DOES belong here: someone with an account on
// a new device. That is the ONLY thing anyone can act on from this screen, so it
// is shown rather than hidden behind a reveal — a tap to see the only control on
// a page buys nothing, and the line above already says who the page is for.
export default function WelcomeScreen(): ReactElement {
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex justify-end p-4">
        <ThemeButton />
      </div>
      <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6 pb-24">
        <div className="flex flex-col items-center gap-5 text-center">
          <Wordmark size="lg" />
          <p className="max-w-xs text-[0.9375rem] text-muted">
            Share a spare room, or your whole place, with friends. For free.
          </p>
        </div>

        <div className="flex w-full max-w-sm flex-col gap-3">
          <p className="text-center text-sm text-muted">Been here before?</p>
          <AuthPanel />
        </div>
      </main>

      <SiteFooter className="px-4 pb-8" />
    </div>
  );
}
