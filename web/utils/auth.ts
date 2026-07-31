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
import { auth, errorCode } from "./firebase";

// A share-link visitor is already anonymous, so signing up LINKS that identity
// rather than minting a new uid and orphaning their grant. Linking is impossible
// when the credential already exists — they're signing in, not up — so that path
// falls back and the uid does change; callers must re-claim anything keyed to it.
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

// Firebase restores a persisted session asynchronously, so anything branching on
// "is anyone signed in?" must await this or act on a false negative.
let restored: Promise<void> | null = null;

export function authSettled(): Promise<User | null> {
  restored ??= new Promise((resolve) => {
    const stop = onAuthStateChanged(auth(), () => {
      stop();
      resolve();
    });
  });
  // Only the WAIT is one-shot; the ANSWER is read fresh every call. Caching the
  // first callback's argument told a second share link in the same tab — a
  // fragment change, not a reload — that nobody was signed in.
  return restored.then(() => auth().currentUser);
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
  // Fire-and-forget: a failed send must never block sign-up.
  sendEmailVerification(credential.user).catch((error) =>
    console.error("sendEmailVerification", error),
  );
  return credential;
}

// Sign in, then create only if that fails. The order matters: Identity Platform
// masks a failed sign-in as `invalid-credential` whether the account is missing
// or the password is wrong, but a create can't be masked — refusing IS the
// answer — so `email-already-in-use` means the password was simply wrong.
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

// Firebase deliberately won't say which reason.
function failedSignIn(error: unknown): boolean {
  const code = authErrorCode(error);
  return (
    code === "auth/invalid-credential" ||
    code === "auth/wrong-password" ||
    code === "auth/user-not-found"
  );
}

// The one case the two calls together can distinguish, so the panel can say it.
export class WrongPassword extends Error {
  readonly code = "kip/wrong-password";
  constructor() {
    super("wrong password");
  }
}

export function passwordReset(email: string): Promise<void> {
  return sendPasswordResetEmail(auth(), email.trim());
}

export function authErrorCode(error: unknown): string {
  return errorCode(error);
}

// Anything unmapped falls back to a generic line, so no raw SDK string is shown.
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
