"use client";

import { type ReactElement, useState } from "react";
import { FaGoogle } from "react-icons/fa";
import { LuLoaderCircle } from "react-icons/lu";
import { authErrorCode, authErrorMessage } from "../utils/auth";
import { useKip } from "../utils/store";
import { useDialog } from "./dialog";
import Button from "./ui/button";
import FieldNote from "./ui/field-note";
import Input from "./ui/input";

// Deliberately no sign-in/sign-up toggle: it asked for the same two fields
// either way and made the visitor answer a question kip can answer itself. Its
// own component because the share-link page needs it too — a visitor must be
// able to make an account without leaving the link they opened.
export default function AuthPanel(): ReactElement {
  const { configured, signIn, continueWithEmail, resetPassword } = useKip();
  const { alert } = useDialog();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function guardConfigured(): Promise<boolean> {
    if (configured) return true;
    await alert({
      title: "Firebase isn't set up yet",
      body: "Create a Firebase project, enable Email/Password and Google sign-in, and paste its config into web/utils/firebase.ts to sign in.",
    });
    return false;
  }

  // Shared scaffolding for all three paths.
  async function runAuth(action: () => Promise<unknown>): Promise<void> {
    if (!(await guardConfigured())) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (caught) {
      console.error(caught);
      setError(authErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function doEmail(): Promise<void> {
    return runAuth(async () => {
      const { created } = await continueWithEmail(email, password);
      // The one thing a merged flow can get wrong: a mistyped address silently
      // dropping someone into an empty kip.
      if (created) setNotice(`New account created for ${email.trim()}.`);
    });
  }

  async function doReset(): Promise<void> {
    if (!(await guardConfigured())) return;
    if (!email.trim()) {
      setError("Enter your email above first, then tap Forgot password.");
      return;
    }
    setError(null);
    try {
      await resetPassword(email);
    } catch (caught) {
      console.error(caught);
      // Only errors that don't reveal whether an account exists.
      const code = authErrorCode(caught);
      if (code === "auth/invalid-email" || code === "auth/too-many-requests") {
        setError(authErrorMessage(caught));
        return;
      }
    }
    setNotice(
      `If an account exists for ${email.trim()}, a reset link is on its way.`,
    );
  }

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <form
        className="flex w-full flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          doEmail();
        }}
      >
        <Input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
        />
        <Input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
        />
        {error ? <FieldNote tone="danger">{error}</FieldNote> : null}
        {notice ? <FieldNote tone="success">{notice}</FieldNote> : null}
        <Button type="submit" size="lg" disabled={busy} className="w-full">
          {busy ? <LuLoaderCircle className="animate-spin" /> : "Continue"}
        </Button>
        <button
          type="button"
          onClick={doReset}
          className="w-fit self-center text-sm text-muted transition hover:text-accent-ink"
        >
          Forgot password?
        </button>
      </form>

      <div className="flex w-full items-center gap-3 text-xs text-faint">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      {/* Not a `Button`: no variant is a plain raised white pill, which is what
          a provider button has to be — Google's mark on an accent fill is both
          off-brand and against their guidelines. Everything else about it
          matches one, disabled state included. */}
      <button
        type="button"
        onClick={() => runAuth(signIn)}
        disabled={busy}
        className="flex h-12 w-full items-center justify-center gap-2.5 rounded-full bg-surface px-6 font-semibold shadow-card transition hover:shadow-panel disabled:pointer-events-none disabled:opacity-50"
      >
        <FaGoogle className="text-accent-ink" />
        <span>Continue with Google</span>
      </button>

      <p className="px-2 text-center text-sm text-muted">
        New here? Continue with an email and a password and kip will make you an
        account.
      </p>
    </div>
  );
}
