"use client";

import { type ReactElement, useState } from "react";
import { LuLoaderCircle } from "react-icons/lu";
import { useKip } from "../utils/store";
import { validateDisplayName } from "../utils/username";
import Button from "./ui/button";
import FieldNote from "./ui/field-note";
import Input from "./ui/input";
import Wordmark from "./wordmark";

// Shown once, right after sign-up: authenticated but no profile yet. The ONLY
// thing we ask for is a display name (prefilled from Google, blank for an email
// account) — a handle is optional and lives in Settings, because it exists purely
// to make you findable and someone who arrived through a share link never needs
// one. Writing the profile advances the gate via the own-profile listener.
export default function OnboardingScreen(): ReactElement {
  const { user, completeOnboarding, signOut } = useKip();
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalid = displayName ? validateDisplayName(displayName) : null;
  const canSubmit = !busy && !validateDisplayName(displayName);

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await completeOnboarding(displayName.trim());
    } catch (caught) {
      console.error(caught);
      setError("Couldn't finish — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6 pb-24">
        <div className="flex flex-col items-center gap-4 text-center">
          <Wordmark size="lg" />
          <div>
            <h1 className="text-xl font-extrabold tracking-[-0.03em]">
              What should we call you?
            </h1>
            <p className="mt-1 max-w-xs text-[0.9375rem] text-muted">
              This is the name your friends will see. You can change it any
              time.
            </p>
          </div>
        </div>

        <form
          className="flex w-full max-w-sm flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="displayName"
              className="px-1 text-sm font-semibold text-muted"
            >
              Your name
            </label>
            <Input
              id="displayName"
              autoComplete="name"
              autoFocus
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Your name"
            />
            {invalid ? <FieldNote tone="danger">{invalid}</FieldNote> : null}
          </div>

          {error ? <FieldNote tone="danger">{error}</FieldNote> : null}

          <Button
            type="submit"
            size="lg"
            disabled={!canSubmit}
            className="w-full"
          >
            {busy ? <LuLoaderCircle className="animate-spin" /> : "Continue"}
          </Button>
        </form>

        <p className="text-sm text-muted">
          Signed in as {user?.email ?? "you"}.{" "}
          <button
            type="button"
            onClick={() => signOut()}
            className="font-semibold text-accent-ink transition hover:opacity-80"
          >
            Not you?
          </button>
        </p>
      </main>
    </div>
  );
}
