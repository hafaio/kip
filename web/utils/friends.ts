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

// A pending serverTimestamp() reads as null locally until the write lands.
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

// A denial surfaces as null rather than throwing, so a private stranger reads
// as "not found" — which is what the rules intend them to look like.
export async function fetchUserProfile(uid: string): Promise<Profile | null> {
  const snap = await getDoc(doc(db(), "users", uid)).catch((error) => {
    if (error?.code !== "permission-denied") throw error;
    return null;
  });
  if (!snap?.exists()) return null;
  return toProfile(uid, snap.data());
}

// Freely reversible, because the handle stays claimed either way.
export async function setSearchable(
  uid: string,
  searchable: boolean,
): Promise<void> {
  await setDoc(doc(db(), "users", uid), { searchable }, { merge: true });
}

// The profile lives in Firestore, not on the Auth user, so own-profile views
// read it live. A missing doc surfaces as null, which the gate reads as onboarding.
export function watchOwnProfile(
  uid: string,
  onChange: (profile: Profile | null) => void,
  onError?: () => void,
): () => void {
  const log = onSnapshotError("ownProfile");
  return onSnapshot(
    doc(db(), "users", uid),
    (snap) => {
      // An ABSENT doc is only believable from the server — the cache says "no
      // such document" for a browser that has simply never seen this account,
      // which would put a returning user through onboarding.
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

// Heals the copy of you in every friend's list — the rule lets you rewrite the
// entry describing YOU, which is the only way that copy is ever corrected. Name
// and photo always go together, so a photo-only heal still satisfies the name pin.
export async function updateProfileIdentity(
  uid: string,
  identity: { displayName: string; photoURL: string | null },
  friendUids: readonly string[],
): Promise<void> {
  // Before the edges, never in one batch: the edge rule compares against the
  // COMMITTED profile, so batching checks the new name against the old.
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

// Two gets, no query — the users table is never enumerable.
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
