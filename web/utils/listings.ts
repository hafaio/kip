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
  setDoc,
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

// "WHOLE_PLACE" is the legacy name for "HOUSE".
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

// Client-side because a rule can't query sibling documents, and the only person
// a clash hurts is the owner whose calendar it is. `end` is exclusive, so ranges
// that merely touch are deliberately allowed.
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

// An id with no document, so the form can upload photos to
// `listings/{ownerId}/{id}/…` before the place exists: Storage checks only the
// owner in the path, and Firestore pins only `ownerId` on create.
export function newListingId(): string {
  return doc(collection(db(), "listings")).id;
}

export async function createListing(
  ownerId: string,
  listingId: string,
  input: ListingInput,
  photos: readonly ListingPhoto[],
): Promise<void> {
  await setDoc(doc(db(), "listings", listingId), {
    ownerId,
    title: input.title,
    type: input.type,
    description: input.description,
    location: withGeohash(input.location),
    photos: [...photos],
    createdAt: serverTimestamp(),
  });
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

// Its own write, not part of the details form: a strip edit has to land even if
// the form is never submitted.
export async function setListingPhotos(
  listingId: string,
  photos: readonly ListingPhoto[],
): Promise<void> {
  await updateDoc(doc(db(), "listings", listingId), {
    photos: [...photos],
  });
}

// Takes the listing, its windows, their portals and its live bookings, in one
// batch. A portal left behind would keep serving the place to anyone with the
// old link, with nothing left to revoke it by.
export async function deleteListing(
  listing: Listing,
  bookings: readonly Booking[],
): Promise<void> {
  const windows = await getDocs(
    collection(db(), "listings", listing.id, "windows"),
  );
  const batch = writeBatch(db());
  // Future stays only. A stay that already happened is a record, not an
  // obligation — cancelling it would tell a guest their completed visit was
  // called off, and stamp the host as having done it.
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

export async function setWindowAutoAccept(
  listingId: string,
  windowId: string,
  autoAccept: boolean,
): Promise<void> {
  await updateDoc(doc(db(), "listings", listingId, "windows", windowId), {
    autoAccept,
  });
}

// A slot with pending asks stays editable — locking on request would let anyone
// freeze a host's calendar just by asking — so moving it cancels those asks
// rather than silently redefining what was asked for.
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
    batch.update(doc(db(), "bookings", booking.id), {
      status: "CANCELLED",
      cancelledBy: booking.ownerId,
      cancelReason: "SLOT_MOVED",
    });
  }
  await batch.commit();
}

// Set by the RULES' 20-lookup budget, not the `in` filter's 30: each distinct
// friend costs one exists() on their edge. The rules tests pin both sides, so
// adding a lookup fails a test rather than silently emptying Browse.
const BROWSE_CHUNK = 20;

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

// For a stay whose host isn't a friend — nothing else fetches those, since
// Browse only asks for friends' places. A deleted place, or one whose pointer
// has gone inert, reads as null rather than throwing.
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

// For landing straight on a room with nothing loaded. The dates can be refused
// where the place is not — a guest's pointer opens the listing, deliberately not
// the host's calendar — so a denial still yields the room.
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
