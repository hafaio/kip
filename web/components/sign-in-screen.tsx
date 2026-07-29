"use client";

import type { ReactElement } from "react";
import AuthPanel from "./auth-panel";
import ThemeButton from "./theme-button";
import Wordmark from "./wordmark";

// kip is friends-only — nothing is public except share links — so this gate is
// everything an unauthenticated visitor sees when they come to the app directly.
// The ways in live in AuthPanel, shared with the public share-link page.
export default function SignInScreen(): ReactElement {
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex justify-end p-4">
        <ThemeButton />
      </div>
      <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6 pb-24">
        <div className="flex flex-col items-center gap-5 text-center">
          <Wordmark size="lg" />
          <p className="max-w-xs text-[0.9375rem] text-muted">
            Share a spare room or your whole place with friends, for free.
          </p>
        </div>

        <div className="w-full max-w-sm">
          <AuthPanel />
        </div>
      </main>
    </div>
  );
}
