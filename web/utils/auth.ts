"use client";

import {
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  GoogleAuthProvider,
  linkWithCredential,
  linkWithPopup,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  type User,
} from "firebase/auth";
import { auth } from "./firebase";

// A share-link visitor is already signed in ANONYMOUSLY, so "creating an account"
// should upgrade that identity rather than mint a new one — otherwise their uid
// changes underneath them and anything keyed to it (their portal grant) is
// orphaned. `linkWithPopup`/`linkWithCredential` keep the same uid.
//
// Linking fails when the credential already belongs to a real account — i.e. they
// are signing IN, not up. There's nothing to preserve in that case, so fall back
// to a normal sign-in and accept the uid change; callers must re-derive anything
// they'd keyed to the old one.
function anonymousUser(): User | null {
  const current = auth().currentUser;
  return current?.isAnonymous ? current : null;
}

function alreadyRegistered(error: unknown): boolean {
  const code = authErrorCode(error);
  return (
    code === "auth/credential-already-in-use" ||
    code === "auth/email-already-in-use" ||
    code === "auth/provider-already-linked"
  );
}

// Resolves once Firebase has finished restoring a persisted session — which it
// does asynchronously, so `auth().currentUser` is null for a beat after load even
// for someone who IS signed in. Anything that branches on "is anyone signed in?"
// has to wait for this, or it will act on a false negative. Created once and
// reused, because the first callback is the only one that answers the question.
let settled: Promise<User | null> | null = null;

export function authSettled(): Promise<User | null> {
  if (!settled) {
    settled = new Promise((resolve) => {
      const stop = onAuthStateChanged(auth(), (user) => {
        stop();
        resolve(user);
      });
    });
  }
  return settled;
}

export async function googleSignIn(): Promise<unknown> {
  const anonymous = anonymousUser();
  if (anonymous) {
    try {
      return await linkWithPopup(anonymous, new GoogleAuthProvider());
    } catch (error) {
      if (!alreadyRegistered(error)) throw error;
    }
  }
  return signInWithPopup(auth(), new GoogleAuthProvider());
}

export function emailSignIn(email: string, password: string): Promise<unknown> {
  return signInWithEmailAndPassword(auth(), email.trim(), password);
}

export async function emailSignUp(
  email: string,
  password: string,
): Promise<unknown> {
  const anonymous = anonymousUser();
  const credential = anonymous
    ? await linkWithCredential(
        anonymous,
        EmailAuthProvider.credential(email.trim(), password),
      ).catch(async (error) => {
        if (!alreadyRegistered(error)) throw error;
        return createUserWithEmailAndPassword(auth(), email.trim(), password);
      })
    : await createUserWithEmailAndPassword(auth(), email.trim(), password);
  // Fire-and-forget: gives the user a way to verify (so their email can later be
  // stored + used for notifications). A failed send never blocks sign-up.
  sendEmailVerification(credential.user).catch((error) =>
    console.error("sendEmailVerification", error),
  );
  return credential;
}

// One way in, whichever it turns out to be: sign in, and only if that email has
// no account, create one. Returns whether an account was made, so the caller can
// say so — an account appearing silently is the one thing a merged flow can get
// wrong, since a typo'd address would otherwise leave someone standing in a
// brand-new empty kip wondering where their friends went.
//
// The order matters. Firebase masks a failed sign-in as `invalid-credential`
// whether the account is missing or the password is wrong (that's Identity
// Platform's improved email privacy), so sign-in alone can't tell the two apart —
// but sign-UP can: an existing address comes back `email-already-in-use`, which
// is not maskable, because refusing IS the answer. So a refused create means the
// account exists and the password was simply wrong.
export async function emailContinue(
  email: string,
  password: string,
): Promise<{ created: boolean }> {
  try {
    await emailSignIn(email, password);
    return { created: false };
  } catch (error) {
    if (!failedSignIn(error)) throw error;
  }
  try {
    await emailSignUp(email, password);
    return { created: true };
  } catch (error) {
    if (alreadyRegistered(error)) throw new WrongPassword();
    throw error;
  }
}

// A sign-in that didn't work, for either reason. Firebase deliberately doesn't
// say which.
function failedSignIn(error: unknown): boolean {
  const code = authErrorCode(error);
  return (
    code === "auth/invalid-credential" ||
    code === "auth/wrong-password" ||
    code === "auth/user-not-found"
  );
}

// The one case the two calls together CAN distinguish, given its own error so the
// panel can say "wrong password" instead of Firebase's deliberately vague line.
export class WrongPassword extends Error {
  readonly code = "kip/wrong-password";
  constructor() {
    super("wrong password");
  }
}

export function passwordReset(email: string): Promise<void> {
  return sendPasswordResetEmail(auth(), email.trim());
}

// The stable Firebase error code (e.g. "auth/invalid-credential"), or "".
export function authErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
}

// Map a Firebase auth error to a message a person can act on. Firebase throws
// with a stable `code`; anything unmapped falls back to a generic line so we
// never surface a raw SDK string.
export function authErrorMessage(error: unknown): string {
  switch (authErrorCode(error)) {
    case "auth/invalid-email":
      return "That doesn't look like a valid email.";
    case "auth/missing-password":
      return "Enter a password.";
    case "auth/weak-password":
      return "Password must be at least 6 characters.";
    case "auth/email-already-in-use":
      return "An account already exists for that email. Try signing in.";
    case "auth/account-exists-with-different-credential":
      return "You already have an account with this email — sign in with your password instead.";
    case "auth/user-disabled":
      return "This account has been disabled.";
    case "kip/wrong-password":
      return "That password doesn't match this account.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Wrong email or password.";
    case "auth/too-many-requests":
      return "Too many attempts. Try again in a little while.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Sign-in was cancelled.";
    default:
      return "Something went wrong. Try again.";
  }
}
