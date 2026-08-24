"use client";

import {
  type AuthError,
  type ConfirmationResult,
  GoogleAuthProvider,
  linkWithPhoneNumber,
  linkWithPopup,
  onAuthStateChanged,
  PhoneAuthProvider,
  RecaptchaVerifier,
  sendSignInLinkToEmail,
  signInWithCredential,
  signInWithPhoneNumber,
  signInWithPopup,
  type User,
  unlink,
} from "firebase/auth";
import { auth, errorCode } from "./firebase";

// Every door here LINKS onto whoever is signed in, so the uid survives and a
// share-link visitor keeps the grant and the ask they already made. Linking is
// impossible when the credential already belongs to someone — they are signing
// in, not up — so each falls back to a plain sign-in and the uid DOES change.
// That is why they all report `sameAccount`: a caller that writes a profile
// afterwards must not write it over a stranger's.

function alreadyRegistered(error: unknown): boolean {
  const code = authErrorCode(error);
  return (
    code === "auth/credential-already-in-use" ||
    code === "auth/email-already-in-use" ||
    code === "auth/provider-already-linked" ||
    // What a phone link actually raises when the NUMBER belongs to someone
    // else. Observed against the emulator; it comes back at send, before any
    // message goes out, which is what makes the fallback below free.
    code === "auth/account-exists-with-different-credential"
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

// Links onto whoever is signed in — ANY session without Google already on it,
// not just an anonymous one. Gating this on `isAnonymous` meant a phone-only
// account tapping "add an email, use Google" was signed OUT of itself and into
// something else, abandoning its listings and friends without a word.
//
// Reports whether the uid survived, exactly as the phone door does. False means
// the Google account already existed and they have moved to it, so anything
// keyed to the old uid is no longer theirs — and, critically, the profile they
// have landed in is a real one whose name and photo must not be overwritten.
export async function googleSignIn(): Promise<{ sameAccount: boolean }> {
  const current = auth().currentUser;
  const wasUid = current?.uid ?? null;
  if (current) {
    try {
      const linked = await linkWithPopup(current, new GoogleAuthProvider());
      return { sameAccount: linked.user.uid === wasUid };
    } catch (error) {
      if (!alreadyRegistered(error)) throw error;
    }
  }
  const signedIn = await signInWithPopup(auth(), new GoogleAuthProvider());
  return { sameAccount: signedIn.user.uid === wasUid };
}

// Passwords are retired. An address that already has one is reached by the same
// one-time link as any other — `signInWithEmailLink` lands on the existing
// account — so nothing is stranded and the reset flow, with its own screen and
// its own careful non-enumeration notice, left the product with it.

// The doors an account actually has, as Settings lists them. Email-link sign-in
// rides on the Email/Password provider, so its id is `password` however little
// of one kip asks for.
export const EMAIL_DOOR = "password";
export const GOOGLE_DOOR = "google.com";
export const PHONE_DOOR = "phone";

export type Door = { providerId: string; value: string | null };

export function doorsOf(user: User | null): readonly Door[] {
  return (user?.providerData ?? []).map((entry) => ({
    providerId: entry.providerId,
    value: entry.email ?? entry.phoneNumber,
  }));
}

export function sameDoors(
  left: readonly Door[],
  right: readonly Door[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (door, index) =>
        door.providerId === right[index].providerId &&
        door.value === right[index].value,
    )
  );
}

// Never the last one. An account with no credential still looks like an account
// and behaves like a ticket: nothing left to sign back in with, and
// `hasCredential()` in the rules starts refusing handle claims and new places.
//
// Firebase itself will unlink the last provider without complaint, so this is
// the whole of the guard — and it reads THIS tab's copy of the user, so two tabs
// each removing a different door still strand the account between them. What it
// catches is one tab acting on a stale surface, or the control being reached
// some other way. Rules can't see Auth providers, so there is nowhere better.
export async function removeDoor(providerId: string): Promise<void> {
  const current = auth().currentUser;
  if (!current) throw new Error("not signed in");
  if (current.providerData.length < 2) {
    throw new Error("removing the last way in would strand the account");
  }
  try {
    await unlink(current, providerId);
  } catch (error) {
    const code = authErrorCode(error);
    if (code === "auth/requires-recent-login") {
      throw new StaleSession();
    }
    // The door is already gone, which is what was asked for. This is what a
    // retry hits after a first attempt unlinked it and then failed below.
    if (code !== "auth/no-such-provider") throw error;
  }
  // `unlink` persists the shortened `providerData` and tells NOBODY — unlike
  // every linking call, it never reaches `_notifyListenersIfCurrent`. So the row
  // that had just been removed sat there until a reload, which is the failure
  // the store's snapshot exists to prevent, arriving one layer lower down.
  // `reload` is the cheap call that both re-reads the server's answer and fires
  // the listener.
  try {
    await current.reload();
  } catch (error) {
    // The unlink has already landed, so this costs the row's freshness until
    // the next reload and nothing more. Raised, it told someone their door was
    // still there and sent them back to press a button that now no-ops.
    console.error(error);
  }
}

// Firebase refuses to change what an account signs in with — removing a door,
// deleting the account — on a session that isn't recent. Distinguished so the
// caller can say the one useful thing: come back in and press it again.
export class StaleSession extends Error {
  readonly code = "kip/stale-session";
  constructor() {
    super("sign in again to finish");
  }
}

export function authErrorCode(error: unknown): string {
  return errorCode(error);
}

// Anything unmapped falls back to a generic line, so no raw SDK string is shown.
export function authErrorMessage(error: unknown): string {
  switch (authErrorCode(error)) {
    case "auth/invalid-email":
      return "That doesn't look like a valid email.";
    // A one-time link is sent to an address whether or not kip knows it, so
    // there is nothing here about an account already existing — the flow has
    // no branch to tell them about.
    case "auth/unauthorized-continue-uri":
    case "auth/invalid-continue-uri":
      return "kip can't send links here yet. Tell Erik.";
    // Loss register: the plain word earns its place at the moment of loss.
    case "auth/user-disabled":
      return "This account has been disabled.";
    case "auth/too-many-requests":
      return "Too many attempts. Try again later.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Cancelled — nothing happened.";
    default:
      return "Something went wrong. Try again.";
  }
}

// Everything `/continue/` needs, carried in the continue URL's QUERY — not the
// fragment kip uses everywhere else. That is forced rather than chosen: kip does
// not author this link, Firebase builds it around its own action handler, and a
// fragment does not survive that redirect.
//
// What rides here is worth being plain about: an ID token is a BEARER
// CREDENTIAL, accepted by Firestore's REST API as that account for up to an
// hour — not inert residue. The address it is mailed to was typed by an
// unverified visitor, so a typo hands a stranger an hour as that account, and a
// click hands them it permanently. What bounds the damage is what the account
// holds at that moment: a name and one pending ask. A kip-minted single-use
// nonce redeemed for the link would be tighter, and needs a server to mint it.
// The portal token is deliberately ABSENT: `/continue/` replays nothing — the ask
// went at submit — so it needs no capability, and the one durable secret in this
// flow never leaves the fragment world.
export type ContinuePayload = {
  idToken: string;
  email: string;
  host: string;
};

function continueUrl(payload: ContinuePayload): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const query = new URLSearchParams(payload).toString();
  return `${window.location.origin}${base}/continue/?${query}`;
}

// Attaches an address to the account that is ALREADY asking, rather than making
// a new one. Nothing is created here — `sendSignInLinkToEmail` writes no user —
// so someone who never opens the mail holds nothing server-side and can retry.
export async function sendAttachLink(
  email: string,
  host: string,
): Promise<void> {
  const current = auth().currentUser;
  if (!current) throw new Error("no session to attach an address to");
  // Forced, not cached. Firebase only refreshes under about five minutes left,
  // so a tab open for fifty would mint a link that dies in ten — while the page
  // it lands on says an hour.
  const idToken = await current.getIdToken(true);
  await sendSignInLinkToEmail(auth(), email, {
    url: continueUrl({ idToken, email, host }),
    handleCodeInApp: true,
  });
}

// A token minted a while ago is refused by the endpoint that would spend it, and
// the ask it belongs to may be hours old. Checking before spending the one-time
// code is what stops an expired open BURNING a code that is still good — the two
// lifetimes differ, and kip's is the shorter.
export function tokenExpired(idToken: string): boolean {
  try {
    const [, body] = idToken.split(".");
    const { exp } = JSON.parse(
      atob(body.replace(/-/g, "+").replace(/_/g, "/")),
    );
    return typeof exp !== "number" || exp * 1000 <= Date.now();
  } catch {
    // Unreadable is not usable.
    return true;
  }
}

// The returning door. No ID token rides here — there is no anonymous account to
// attach to, and `/continue/` reads its absence as "sign this person in" rather
// than "link this address". Same one-time link, same landing page, two modes.
export async function sendReturnLink(email: string): Promise<void> {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const query = new URLSearchParams({ email }).toString();
  await sendSignInLinkToEmail(auth(), email, {
    url: `${window.location.origin}${base}/continue/?${query}`,
    handleCodeInApp: true,
  });
}

// Phone codes. The verifier is Firebase-managed reCAPTCHA in invisible mode:
// most people see nothing, and only suspicious traffic gets a challenge.
//
// It renders into a real element, and for an INVISIBLE verifier `clear()`
// deliberately leaves that widget in place — so a second attempt against the
// same element dies with "reCAPTCHA has already been rendered here", poisoning
// the field until the sheet is closed. Every attempt therefore gets a fresh
// child of its own, which can simply be thrown away.
function verifier(container: HTMLElement): {
  check: RecaptchaVerifier;
  done: () => void;
} {
  const slot = container.ownerDocument.createElement("div");
  container.appendChild(slot);
  const check = new RecaptchaVerifier(auth(), slot, { size: "invisible" });
  return {
    check,
    done: () => {
      check.clear();
      slot.remove();
    },
  };
}

// Sends the code. Linking keeps the uid, so a grant and a pending ask stay with
// the person who made them — which is the whole reason this links rather than
// signing in when there is already a session.
export async function sendPhoneCode(
  phone: string,
  container: HTMLElement,
): Promise<ConfirmationResult> {
  const current = auth().currentUser;

  // Refused rather than silently swapped. Falling through to a plain sign-in
  // here would mint or enter a DIFFERENT account, so someone adding a second
  // number from Settings lost their listings, friends and trips without being
  // told anything at all.
  if (current && current.phoneNumber !== null) {
    throw new PhoneAlreadySet();
  }

  // One verifier per attempt, and cleared exactly once. Clearing twice throws
  // `internal-error` from a `finally`, which discarded a ConfirmationResult for
  // an SMS that had already been sent — leaving a usable code in someone's
  // pocket and an error on their screen.
  const first = verifier(container);
  try {
    if (current) {
      try {
        return await linkWithPhoneNumber(current, phone, first.check);
      } catch (error) {
        if (!alreadyRegistered(error)) throw error;
      }
    } else {
      return await signInWithPhoneNumber(auth(), phone, first.check);
    }
  } finally {
    first.done();
  }

  // The number belongs to an account already: they are signing in, not signing
  // up. Refused BEFORE any message went out, so this is the first SMS rather
  // than a second — but it needs a FRESH verifier, since the failed attempt
  // spent the one above and reusing it fails `captcha-check-failed`.
  const retry = verifier(container);
  try {
    return await signInWithPhoneNumber(auth(), phone, retry.check);
  } finally {
    retry.done();
  }
}

// Refusing to swap is a product choice, not a limit: `updatePhoneNumber` exists,
// and unlink-then-relink works. Someone who already has a number already has a
// way back in, so a second one typed into the field that ADDS one reads as a
// mistake — and the fallback that would otherwise catch it signs them into a
// different account.
export class PhoneAlreadySet extends Error {
  readonly code = "kip/phone-already-set";
  constructor() {
    super("this account already has a number");
  }
}

// Whether the uid survived. False means the number already belonged to an
// account and they have just moved to it — so everything keyed to the old uid,
// a pending ask and a grant included, belongs to an identity they no longer
// are. Callers MUST branch on this: the account they are now in already has a
// name and a photo, and writing the sheet's over them is destructive.
export async function confirmPhoneCode(
  pending: ConfirmationResult,
  code: string,
  wasUid: string | null,
): Promise<{ sameAccount: boolean }> {
  try {
    const result = await pending.confirm(code);
    return { sameAccount: result.user.uid === wasUid };
  } catch (error) {
    // The number turned out to belong to someone else. The credential rides on
    // the error, so signing in with it costs nothing further — no second SMS.
    if (!alreadyRegistered(error)) throw error;
    const credential = PhoneAuthProvider.credentialFromError(
      error as AuthError,
    );
    if (!credential) throw error;
    const result = await signInWithCredential(auth(), credential);
    return { sameAccount: result.user.uid === wasUid };
  }
}
