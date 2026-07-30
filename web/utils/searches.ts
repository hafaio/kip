"use client";

import {
  addDoc,
  collection,
  type DocumentData,
  deleteDoc,
  doc,
  onSnapshot,
  type QueryDocumentSnapshot,
  serverTimestamp,
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import { db, onSnapshotError } from "./firebase";
import {
  EMPTY_CRITERIA,
  type SavedSearch,
  type SearchCriteria,
} from "./search";
import type { ListingType } from "./types";

// Not a rule: a subcollection can't be counted in one. Two tabs can race past
// it, which is left alone — an over-long list only costs the owner reading
// their own app. Same posture as the overlap check.
export const MAX_SAVED_SEARCHES = 10;

function epoch(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : 0;
}

// Stored as written, so this only has to survive a hand-edited or older document.
function toCriteria(raw: unknown): SearchCriteria {
  const data = (raw ?? {}) as Record<string, unknown>;
  const near = data.near as { lat?: unknown; lng?: unknown } | null | undefined;
  // Checked, not just cast: a non-numeric lat/lng reaches `distanceBetween` as
  // NaN, and `NaN > radiusKm` is false, so a broken location would silently
  // match everything instead of nothing.
  const placed = typeof near?.lat === "number" && typeof near?.lng === "number";
  return {
    start: (data.start as string | null) ?? null,
    end: (data.end as string | null) ?? null,
    near: placed ? { lat: near.lat as number, lng: near.lng as number } : null,
    nearLabel: (data.nearLabel as string | null) ?? null,
    radiusKm: (data.radiusKm as number) ?? EMPTY_CRITERIA.radiusKm,
    type: (data.type as ListingType | null) ?? null,
  };
}

function toSavedSearch(snap: QueryDocumentSnapshot<DocumentData>): SavedSearch {
  // `estimate`, because the listener fires with the local write before the
  // server acknowledges it and an unresolved `serverTimestamp()` otherwise
  // reads as null — i.e. 0, i.e. "last looked at in 1970", which flashes every
  // existing match as new on the very save that should start the count at zero.
  const data = snap.data({ serverTimestamps: "estimate" });
  return {
    id: snap.id,
    label: data.label ?? "",
    criteria: toCriteria(data.criteria),
    lastSeenAt: epoch(data.lastSeenAt),
    createdAt: epoch(data.createdAt),
  };
}

export function watchSavedSearches(
  uid: string,
  onChange: (searches: SavedSearch[]) => void,
): () => void {
  return onSnapshot(
    collection(db(), "users", uid, "searches"),
    (snap) => {
      const searches = snap.docs.map(toSavedSearch);
      searches.sort((left, right) => left.createdAt - right.createdAt);
      onChange(searches);
    },
    onSnapshotError("savedSearches"),
  );
}

// Seen as of now, so a search is never born already claiming news.
export async function saveSearch(
  uid: string,
  label: string,
  criteria: SearchCriteria,
): Promise<void> {
  await addDoc(collection(db(), "users", uid, "searches"), {
    label,
    criteria,
    lastSeenAt: serverTimestamp(),
    createdAt: serverTimestamp(),
  });
}

export async function markSearchSeen(
  uid: string,
  searchId: string,
): Promise<void> {
  await updateDoc(doc(db(), "users", uid, "searches", searchId), {
    lastSeenAt: serverTimestamp(),
  });
}

export async function deleteSavedSearch(
  uid: string,
  searchId: string,
): Promise<void> {
  await deleteDoc(doc(db(), "users", uid, "searches", searchId));
}
