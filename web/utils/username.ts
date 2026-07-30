"use client";

import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "./firebase";

// Mirrored in firestore.rules, so a crafted client can't grab a bad handle.
const USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/;

// Also in the rules, for the same reason.
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

// Null when valid, or a human-readable reason.
export function validateUsername(raw: string): string | null {
  const username = normalizeUsername(raw);
  if (username.length < 3) return "At least 3 characters.";
  if (username.length > 20) return "At most 20 characters.";
  if (!USERNAME_RE.test(username))
    return "Letters, numbers and _ only, starting with a letter.";
  if (RESERVED.has(username)) return "That username is reserved.";
  return null;
}

export function validateDisplayName(raw: string): string | null {
  if (raw.trim().length < 2) return "At least 2 characters.";
  if (raw.trim().length > 50) return "At most 50 characters.";
  return null;
}

// A get on the registry doc — the users table is never enumerated.
export async function isUsernameAvailable(raw: string): Promise<boolean> {
  const username = normalizeUsername(raw);
  const snap = await getDoc(doc(db(), "usernames", username));
  return !snap.exists();
}

// A display name only — a handle isn't required to use kip, and `searchable` is
// left unwritten so a fresh account is unreachable by default.
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

// Registry FIRST, and that ordering is the whole uniqueness guarantee: a
// collision is denied by the registry's owner-only update rule, so the profile
// write never happens. Searchability rides along, a handle existing to be found by.
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
