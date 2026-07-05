"use client";

import {
  collection,
  type DocumentData,
  doc,
  getDoc,
  onSnapshot,
  type QueryDocumentSnapshot,
  setDoc,
  Timestamp,
  writeBatch,
} from "firebase/firestore";
import { db, onSnapshotError } from "./firebase";
import type { Friend, Profile } from "./types";
import { normalizeUsername } from "./username";

// serverTimestamp() resolves to a Timestamp once the write lands; until then a
// local snapshot may surface null. Fall back to 0 so types stay `number`.
function epoch(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : 0;
}

function toProfile(uid: string, data: DocumentData): Profile {
  return {
    uid,
    username: data.username ?? "",
    displayName: data.displayName ?? "",
    photoURL: data.photoURL ?? null,
    searchable: data.searchable === true,
    createdAt: epoch(data.createdAt),
  };
}

// Read a single user's public profile by uid. Readable only by the owner, their
// friends, anyone when the profile is `searchable`, or whoever still shares a
// live stay with them (rules) — that fourth clause is why this function is on the
// booking path at all, since a share-link guest and their host are neither
// friends nor searchable. Anyone else is denied, which surfaces here as null
// rather than throwing, so a private stranger reads as "not found".
export async function fetchUserProfile(uid: string): Promise<Profile | null> {
  const snap = await getDoc(doc(db(), "users", uid)).catch((error) => {
    if (error?.code !== "permission-denied") throw error;
    return null;
  });
  if (!snap?.exists()) return null;
  return toProfile(uid, snap.data());
}

// Turn discoverability-by-handle on or off. The handle itself is permanent and
// stays claimed either way, so this is freely reversible. Turning it ON requires
// a username to already exist (enforced in the rules) — see claimUsername.
export async function setSearchable(
  uid: string,
  searchable: boolean,
): Promise<void> {
  await setDoc(doc(db(), "users", uid), { searchable }, { merge: true });
}

// Live-subscribe to the signed-in user's own profile. Unlike the rest of the
// app the profile now lives in Firestore (username + user-chosen displayName),
// so own-profile views read it from here rather than deriving it from the Auth
// user. A missing doc (or one without a username) surfaces as null → onboarding.
export function watchOwnProfile(
  uid: string,
  onChange: (profile: Profile | null) => void,
  onError?: () => void,
): () => void {
  const log = onSnapshotError("ownProfile");
  return onSnapshot(
    doc(db(), "users", uid),
    (snap) => {
      // A local-cache snapshot arrives first, and for a browser that has never
      // seen this account it says "no such document" — which the gate reads as
      // "needs onboarding" and shows a returning user a form asking their name.
      // An ABSENT doc is only believable from the server; an existing one is
      // fine from cache, since it can only have got there by being real.
      if (!snap.exists() && snap.metadata.fromCache) return;
      onChange(snap.exists() ? toProfile(uid, snap.data()) : null);
    },
    (error) => {
      log(error);
      onError?.();
    },
  );
}

function toFriend(snap: QueryDocumentSnapshot<DocumentData>): Friend {
  const data = snap.data();
  return {
    uid: snap.id,
    username: data.username ?? "",
    displayName: data.displayName ?? "",
    photoURL: data.photoURL ?? null,
    since: epoch(data.since),
  };
}

// Rewrite how the owner appears — their name, their photo, or both — and heal the
// copy of it sitting in every friend's list. Each friend holds a denormalized
// `{displayName, photoURL}` so rendering the list costs no extra reads; the rule
// lets you rewrite the entry that represents YOU, which is the only way that copy
// can ever be corrected. Bounded by friend count, and only runs on an edit.
//
// Name and photo go together even when only one changed: the edge rule pins the
// name to the committed profile, so sending both makes a photo-only heal satisfy
// that check by construction, and a name-only edit repairs a photo copy that some
// earlier failure left behind.
export async function updateProfileIdentity(
  uid: string,
  identity: { displayName: string; photoURL: string | null },
  friendUids: readonly string[],
): Promise<void> {
  // The profile write must land BEFORE the edges: the rule authorising an edge
  // update compares it against the profile, and rules read committed state, so
  // doing both in one batch would check the new name against the old one and be
  // refused. Same ordering constraint as claiming a username.
  await setDoc(doc(db(), "users", uid), identity, { merge: true });
  if (friendUids.length === 0) return;

  const batch = writeBatch(db());
  for (const friendUid of friendUids) {
    batch.update(doc(db(), "users", friendUid, "friends", uid), identity);
  }
  await batch.commit();
}

export function watchFriends(
  uid: string,
  onChange: (friends: Friend[]) => void,
): () => void {
  return onSnapshot(
    collection(db(), "users", uid, "friends"),
    (snap) => {
      onChange(snap.docs.map(toFriend));
    },
    onSnapshotError("friends"),
  );
}

// Resolve a username to a profile via the registry (a GET on the handle), then a
// GET on the user by uid — no query/enumeration of the users table.
export async function findUserByUsername(
  username: string,
): Promise<Profile | null> {
  const idx = await getDoc(doc(db(), "usernames", normalizeUsername(username)));
  if (!idx.exists()) return null;
  return fetchUserProfile(idx.data().uid as string);
}

export async function unfriend(uid: string, friendUid: string): Promise<void> {
  const batch = writeBatch(db());
  batch.delete(doc(db(), "users", uid, "friends", friendUid));
  batch.delete(doc(db(), "users", friendUid, "friends", uid));
  await batch.commit();
}
