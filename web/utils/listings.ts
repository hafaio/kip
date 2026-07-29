"use client";

import {
  addDoc,
  collection,
  type DocumentData,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  type QueryDocumentSnapshot,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { geohashForLocation } from "geofire-common";
import type { IconType } from "react-icons";
import { LuBed, LuBuilding2, LuHouse } from "react-icons/lu";
import { db, onSnapshotError } from "./firebase";
import { isExpired } from "./format";
import type {
  AvailabilityWindow,
  Booking,
  GeoLocation,
  Listing,
  ListingPhoto,
  ListingType,
} from "./types";

// The human label for a place tier, Room → Flat → House (increasing autonomy).
export function listingTypeLabel(type: ListingType): string {
  switch (type) {
    case "ROOM":
      return "Room";
    case "FLAT":
      return "Flat";
    case "HOUSE":
      return "House";
  }
}

// The lucide glyph for a place tier; call sites render it as `<Icon size={…} />`.
export function listingTypeIcon(type: ListingType): IconType {
  switch (type) {
    case "ROOM":
      return LuBed;
    case "FLAT":
      return LuBuilding2;
    case "HOUSE":
      return LuHouse;
  }
}

// Coerce a raw stored `type` into the current enum: the legacy "WHOLE_PLACE"
// tier is now "HOUSE", a known tier passes through, and anything else (missing
// or unrecognized) falls back to "ROOM".
function normalizeType(raw: unknown): ListingType {
  if (raw === "WHOLE_PLACE" || raw === "HOUSE") return "HOUSE";
  else if (raw === "FLAT") return "FLAT";
  else return "ROOM";
}

function epoch(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : 0;
}

function toListing(snap: QueryDocumentSnapshot<DocumentData>): Listing {
  const data = snap.data();
  return {
    id: snap.id,
    ownerId: data.ownerId,
    title: data.title ?? "",
    type: normalizeType(data.type),
    description: data.description ?? "",
    location: data.location as GeoLocation,
    photos: (data.photos as ListingPhoto[]) ?? [],
    publicPortalId: data.publicPortalId ?? null,
    createdAt: epoch(data.createdAt),
  };
}

function toWindow(
  listingId: string,
  snap: QueryDocumentSnapshot<DocumentData>,
): AvailabilityWindow {
  const data = snap.data();
  return {
    id: snap.id,
    listingId,
    start: data.start,
    end: data.end,
    status: data.status ?? "OPEN",
    autoAccept: data.autoAccept ?? false,
    details: data.details ?? "",
    bookedBy: data.bookedBy ?? null,
    publicPortalId: data.publicPortalId ?? null,
  };
}

// Two date ranges clash when each starts before the other ends. `end` is the
// checkout day (exclusive), so touching ranges — one ending the day the next
// starts — are fine and deliberately allowed.
//
// Checked on the client, not in the rules: a rule can't query sibling documents,
// and the only person a clash hurts is the owner whose own calendar it is, so a
// crafted client gains nothing by skipping it. Returns the first clashing window,
// or null. `skipId` excludes the window being edited from its own comparison.
export function findOverlap(
  windows: readonly AvailabilityWindow[],
  range: { start: string; end: string },
  skipId?: string,
): AvailabilityWindow | null {
  return (
    windows.find(
      (window) =>
        window.id !== skipId &&
        range.start < window.end &&
        window.start < range.end,
    ) ?? null
  );
}

export type ListingInput = {
  readonly title: string;
  readonly type: ListingType;
  readonly description: string;
  readonly location: Omit<GeoLocation, "geohash">;
};

function withGeohash(location: Omit<GeoLocation, "geohash">): GeoLocation {
  return {
    ...location,
    geohash: geohashForLocation([location.lat, location.lng]),
  };
}

export function watchMyListings(
  uid: string,
  onChange: (listings: Listing[]) => void,
): () => void {
  const ref = query(collection(db(), "listings"), where("ownerId", "==", uid));
  return onSnapshot(
    ref,
    (snap) => onChange(snap.docs.map(toListing)),
    onSnapshotError("myListings"),
  );
}

export async function createListing(
  ownerId: string,
  input: ListingInput,
): Promise<string> {
  const ref = await addDoc(collection(db(), "listings"), {
    ownerId,
    title: input.title,
    type: input.type,
    description: input.description,
    location: withGeohash(input.location),
    photos: [],
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateListing(
  listingId: string,
  input: ListingInput,
): Promise<void> {
  await updateDoc(doc(db(), "listings", listingId), {
    title: input.title,
    type: input.type,
    description: input.description,
    location: withGeohash(input.location),
  });
}

// Photos are added and removed one at a time, as the owner uploads them, so they
// get their own write instead of riding along with the details form — a strip
// edit must land even if the form is never submitted.
export async function setListingPhotos(
  listingId: string,
  photos: readonly ListingPhoto[],
): Promise<void> {
  await updateDoc(doc(db(), "listings", listingId), {
    photos: [...photos],
  });
}

// Delete a listing, its windows, every public share-link (portal) they point at,
// AND every live booking against it, in one batch. Under the capability model "revoke = delete", so a portal
// left behind would keep serving the owner's name/photo and the place's details
// to anyone with the old link — and stay requestable — with no way to revoke it
// once the listing/window docs are gone. Takes the full listing (not just the id)
// so we have its `publicPortalId`; each window carries its own on the doc.
export async function deleteListing(
  listing: Listing,
  bookings: readonly Booking[],
): Promise<void> {
  const windows = await getDocs(
    collection(db(), "listings", listing.id, "windows"),
  );
  const batch = writeBatch(db());
  // A slot going away must take its asks and stays with it — otherwise a guest is
  // left holding a request, or a confirmed stay, against dates that no longer
  // exist and nobody can cancel. Cancelling a single slot already does this
  // (cancelWindowAsOwner); deleting the whole place has to as well.
  //
  // Only what's still ahead, on the same boundary `isExpired` uses everywhere
  // else. A stay that already happened is a record, not an obligation: flipping
  // it to CANCELLED would tell a guest their completed visit was called off, and
  // stamp the host as having done it.
  for (const booking of bookings) {
    if (
      booking.listingId === listing.id &&
      booking.status !== "CANCELLED" &&
      !isExpired(booking.end)
    ) {
      batch.update(doc(db(), "bookings", booking.id), {
        status: "CANCELLED",
        cancelledBy: booking.ownerId,
        cancelReason: "SLOT_CANCELLED",
      });
    }
  }
  for (const window of windows.docs) {
    const slotPortalId = window.data().publicPortalId as string | null;
    if (slotPortalId) batch.delete(doc(db(), "portals", slotPortalId));
    batch.delete(window.ref);
  }
  if (listing.publicPortalId) {
    batch.delete(doc(db(), "portals", listing.publicPortalId));
  }
  batch.delete(doc(db(), "listings", listing.id));
  await batch.commit();
}

export function watchWindows(
  listingId: string,
  onChange: (windows: AvailabilityWindow[]) => void,
): () => void {
  return onSnapshot(
    collection(db(), "listings", listingId, "windows"),
    (snap) =>
      onChange(snap.docs.map((snapshot) => toWindow(listingId, snapshot))),
    onSnapshotError("windows"),
  );
}

export async function addWindow(
  listingId: string,
  window: {
    start: string;
    end: string;
    autoAccept: boolean;
    details: string;
  },
): Promise<void> {
  await addDoc(collection(db(), "listings", listingId, "windows"), {
    start: window.start,
    end: window.end,
    status: "OPEN",
    autoAccept: window.autoAccept,
    details: window.details,
  });
}

// Owner-only: flip whether an open window auto-accepts. Guests can't reach this
// (the rule for guest window writes only permits the OPEN->BOOKED status flip).
export async function setWindowAutoAccept(
  listingId: string,
  windowId: string,
  autoAccept: boolean,
): Promise<void> {
  await updateDoc(doc(db(), "listings", listingId, "windows", windowId), {
    autoAccept,
  });
}

// Owner-only: edit an open slot's dates and details in place. A slot with a
// CONFIRMED stay on it can't be moved at all (the rule freezes its dates), but a
// slot with PENDING asks is still open and editable — locking on request would
// let anyone freeze a host's calendar just by asking. So moving the dates cancels
// those asks instead of silently redefining what was asked for. Same principle as
// deleting a slot taking its bookings with it.
export async function updateWindow(
  listingId: string,
  windowId: string,
  fields: { start: string; end: string; details: string },
  pending: readonly Booking[] = [],
): Promise<void> {
  const voided = pending.filter(
    (booking) =>
      booking.windowId === windowId &&
      booking.status === "REQUESTED" &&
      (booking.start !== fields.start || booking.end !== fields.end),
  );

  const batch = writeBatch(db());
  batch.update(doc(db(), "listings", listingId, "windows", windowId), {
    start: fields.start,
    end: fields.end,
    details: fields.details,
  });
  for (const booking of voided) {
    // The reason rides on the booking: a trigger can't see who wrote, and "those
    // dates moved" is a different message from "declined".
    batch.update(doc(db(), "bookings", booking.id), {
      status: "CANCELLED",
      cancelledBy: booking.ownerId,
      cancelReason: "SLOT_MOVED",
    });
  }
  await batch.commit();
}

// Chunk size is set by the SECURITY RULES, not by the `in` filter (which allows
// 30). Reading a friend's listing costs exactly one rule lookup — the `exists()`
// on their friends edge, which the listings rule reaches as its second clause —
// and Firestore caps a query at 20 lookups. Repeats of the same path are free, so
// the ceiling is the number of DISTINCT owners in one query, not the number of
// places returned: 30 places across 3 friends is fine, 25 across 25 friends is
// refused outright.
//
// 20 is therefore the exact limit, not a guess, and `web/tests/rules.test.ts`
// pins BOTH sides of it — so if a future rule change adds a lookup before or at
// the friend check, the test fails instead of Browse silently emptying for
// whoever has the most friends.
const BROWSE_CHUNK = 20;

// Fetch all listings owned by the given friends, chunked so no single query
// exceeds the rules' lookup budget. Used for the Browse view.
export async function fetchFriendListings(
  friendUids: readonly string[],
): Promise<Listing[]> {
  const chunks: string[][] = [];
  for (let index = 0; index < friendUids.length; index += BROWSE_CHUNK) {
    chunks.push(friendUids.slice(index, index + BROWSE_CHUNK));
  }
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const snap = await getDocs(
        query(collection(db(), "listings"), where("ownerId", "in", chunk)),
      );
      return snap.docs.map(toListing);
    }),
  );
  return results.flat();
}

// One place by id, for a stay whose host isn't a friend: the guest pointer
// (`listings/{id}/guests/{uid}`) is what makes that listing readable to them, and
// nothing else fetches it — Browse only ever asks for friends' places. A place
// that's since been deleted, or one whose pointer has gone inert because the stay
// was cancelled, reads as null rather than throwing, and the caller falls back to
// naming it as a place it can't see.
export async function fetchListing(listingId: string): Promise<Listing | null> {
  const snap = await getDoc(doc(db(), "listings", listingId)).catch((error) => {
    if (error?.code !== "permission-denied") throw error;
    return null;
  });
  if (!snap?.exists()) return null;
  return toListing(snap as QueryDocumentSnapshot<DocumentData>);
}

export async function fetchWindows(
  listingId: string,
): Promise<AvailabilityWindow[]> {
  const snap = await getDocs(
    collection(db(), "listings", listingId, "windows"),
  );
  return snap.docs.map((snapshot) => toWindow(listingId, snapshot));
}

// One place and its dates together, for landing straight on a room — a pasted
// link, a reload — with nothing loaded yet. The alternative is pulling every
// friend's place to find the one being looked at.
//
// The dates are a second read and can be refused where the place is not: a
// guest's pointer opens the LISTING they're staying at, deliberately not the
// host's calendar. So a denial there still yields the room, with no dates —
// exactly what such a guest saw before, when nothing fetched them at all.
export async function fetchRoom(listingId: string): Promise<{
  listing: Listing;
  windows: AvailabilityWindow[];
} | null> {
  const listing = await fetchListing(listingId);
  if (!listing) return null;
  const windows = await fetchWindows(listingId).catch((error) => {
    if (error?.code !== "permission-denied") throw error;
    return [];
  });
  return { listing, windows };
}
