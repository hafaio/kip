"use client";

import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "./firebase";

// Handles are lowercase, 3–20 chars, letters/digits/underscore, and must start
// with a letter — restrictive enough to read as a name, permissive enough to be
// memorable. The registry (`usernames/{handle}`) keys on the normalized form.
const USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/;

// A few handles we never hand out, so a stranger can't impersonate the app.
const RESERVED = new Set([
  "admin",
  "kip",
  "support",
  "help",
  "root",
  "system",
  "about",
  "settings",
]);

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@+/, "");
}

// Returns null when valid, or a human-readable reason when not.
export function validateUsername(raw: string): string | null {
  const username = normalizeUsername(raw);
  if (username.length < 3) return "At least 3 characters.";
  if (username.length > 20) return "At most 20 characters.";
  if (!USERNAME_RE.test(username))
    return "Letters, numbers and _ only, starting with a letter.";
  if (RESERVED.has(username)) return "That username is reserved.";
  return null;
}

// Returns null when the display name is valid, or a reason when not. Kept beside
// validateUsername so both onboarding and Settings share one rule.
export function validateDisplayName(raw: string): string | null {
  if (raw.trim().length < 2) return "At least 2 characters.";
  if (raw.trim().length > 50) return "At most 50 characters.";
  return null;
}

// True when nobody has claimed this handle yet. A get on the registry doc — no
// enumeration of the users table.
export async function isUsernameAvailable(raw: string): Promise<boolean> {
  const username = normalizeUsername(raw);
  const snap = await getDoc(doc(db(), "usernames", username));
  return !snap.exists();
}

// Finish onboarding: write the profile with just a display name. A handle is NOT
// required to use kip — it only powers searchability (see claimUsername), so an
// account that arrived through a share link never needs one. `searchable` is left
// unwritten and defaults to false everywhere it's read. On first creation we stamp
// `createdAt`; a pre-existing account keeps its original signup date. The profile
// carries NO email — the address stays on the Auth account only.
export async function createProfile(
  uid: string,
  profile: { displayName: string; photoURL: string | null },
): Promise<void> {
  const existing = await getDoc(doc(db(), "users", uid));

  const fields: {
    displayName: string;
    photoURL: string | null;
    createdAt?: ReturnType<typeof serverTimestamp>;
  } = { displayName: profile.displayName, photoURL: profile.photoURL };
  if (!(existing.exists() && existing.data().createdAt))
    fields.createdAt = serverTimestamp();

  await setDoc(doc(db(), "users", uid), fields, { merge: true });
}

// Claim `username` for `uid` and turn searchability on — the two always happen
// together, since a handle exists only to be found by. Two sequential writes,
// registry FIRST: `usernames/{handle} -> { uid }` (a collision hits the rules'
// owner-only `update` path and is denied → we throw before touching the profile,
// so uniqueness holds), then `users/{uid}` (the write rule get()s the now-committed
// registry entry to confirm the displayed handle is really ours, and refuses
// `searchable: true` without one). An interrupted claim leaves at most an
// owned-but-unused registry entry, which a retry reuses idempotently.
//
// The handle is PERMANENT: the registry has no delete rule, so it can never be
// released and re-squatted — which is what lets searchability be turned back off
// without losing your name.
export async function claimUsername(
  uid: string,
  username: string,
): Promise<void> {
  const handle = normalizeUsername(username);
  await setDoc(doc(db(), "usernames", handle), { uid });
  await setDoc(
    doc(db(), "users", uid),
    { username: handle, searchable: true },
    { merge: true },
  );
}
