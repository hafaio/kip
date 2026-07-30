"use client";

import {
  type CollectionReference,
  collection,
  type DocumentData,
  type DocumentSnapshot,
  doc,
  getDoc,
  getDocs,
  type QueryDocumentSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "./firebase";
import { isExpired } from "./format";
import type {
  AvailabilityWindow,
  Listing,
  ListingPhoto,
  Party,
  Portal,
  PortalContent,
  PortalListing,
  PortalWindow,
} from "./types";

function epoch(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : 0;
}

function toPortal(snap: QueryDocumentSnapshot<DocumentData>): Portal {
  const data = snap.data();
  return {
    id: snap.id,
    scope: data.scope ?? "LISTING",
    ownerId: data.ownerId,
    ownerName: data.ownerName ?? "",
    ownerPhotoURL: data.ownerPhotoURL ?? null,
    listings: data.listings ?? [],
    createdAt: epoch(data.createdAt),
  };
}

// `windowIds` pins a SLOT link to the one range it covers; the dates themselves
// are never copied.
function toPortalListing(
  listing: Listing,
  windowIds: readonly string[] | null,
): PortalListing {
  return {
    listingId: listing.id,
    title: listing.title,
    type: listing.type,
    description: listing.description,
    locationLabel: listing.location.label,
    photos: [...listing.photos],
    windowIds: windowIds ? [...windowIds] : null,
  };
}

// Kept current by the propagate* helpers below rather than by republishing.
function portalBase(scope: Portal["scope"], owner: Party) {
  return {
    scope,
    ownerId: owner.uid,
    ownerName: owner.displayName,
    ownerPhotoURL: owner.photoURL,
    createdAt: serverTimestamp(),
  };
}

// A new UUID plus deleting the old one, so regenerating kills old links instantly.
export async function publishListingPortal(
  listing: Listing,
  owner: Party,
): Promise<string> {
  const id = crypto.randomUUID();
  const batch = writeBatch(db());
  if (listing.publicPortalId) {
    batch.delete(doc(db(), "portals", listing.publicPortalId));
  }
  // No copy of the room — this grant unlocks the room doc, so it's read live.
  batch.set(doc(db(), "portals", id), {
    ...portalBase("LISTING", owner),
    listingId: listing.id,
  });
  batch.update(doc(db(), "listings", listing.id), { publicPortalId: id });
  await batch.commit();
  return id;
}

export async function revokeListingPortal(
  listingId: string,
  portalId: string,
): Promise<void> {
  const batch = writeBatch(db());
  batch.delete(doc(db(), "portals", portalId));
  batch.update(doc(db(), "listings", listingId), { publicPortalId: null });
  await batch.commit();
}

export async function publishSlotPortal(
  listing: Listing,
  window: AvailabilityWindow,
  owner: Party,
): Promise<string> {
  const id = crypto.randomUUID();
  const batch = writeBatch(db());
  if (window.publicPortalId) {
    batch.delete(doc(db(), "portals", window.publicPortalId));
  }
  // The one copy in the system: a slot grant doesn't unlock the room, so without
  // this a shared date range couldn't say which place it belongs to.
  batch.set(doc(db(), "portals", id), {
    ...portalBase("SLOT", owner),
    listings: [toPortalListing(listing, [window.id])],
  });
  batch.update(doc(db(), "listings", listing.id, "windows", window.id), {
    publicPortalId: id,
  });
  await batch.commit();
  return id;
}

export async function revokeSlotPortal(
  listingId: string,
  windowId: string,
  portalId: string,
): Promise<void> {
  const batch = writeBatch(db());
  batch.delete(doc(db(), "portals", portalId));
  batch.update(doc(db(), "listings", listingId, "windows", windowId), {
    publicPortalId: null,
  });
  await batch.commit();
}

// Names no places — the grant lets the visitor query them, so a room added later
// just appears. The previous id is read INSIDE the transaction: a stale one would
// move the pointer without deleting anything, stranding a live link nothing can
// revoke.
export async function publishUserPortal(owner: Party): Promise<string> {
  const id = crypto.randomUUID();
  const prefsRef = doc(db(), "users", owner.uid, "settings", "prefs");
  await runTransaction(db(), async (tx) => {
    const snap = await tx.get(prefsRef);
    const previous = snap.data()?.profilePortalId as string | null | undefined;
    if (previous) tx.delete(doc(db(), "portals", previous));
    tx.set(doc(db(), "portals", id), portalBase("USER", owner));
    tx.set(prefsRef, { profilePortalId: id }, { merge: true });
  });
  return id;
}

export async function revokeUserPortal(
  ownerUid: string,
  portalId: string,
): Promise<void> {
  const batch = writeBatch(db());
  batch.delete(doc(db(), "portals", portalId));
  batch.set(
    doc(db(), "users", ownerUid, "settings", "prefs"),
    { profilePortalId: null },
    { merge: true },
  );
  await batch.commit();
}

// The client already holds all of these, so a rename never needs a query.
export function ownedPortalIds(
  profilePortalId: string | null,
  listings: readonly Listing[],
  windowsByListing: Readonly<Record<string, readonly AvailabilityWindow[]>>,
): string[] {
  const ids = profilePortalId ? [profilePortalId] : [];
  for (const listing of listings) {
    if (listing.publicPortalId) ids.push(listing.publicPortalId);
    for (const window of windowsByListing[listing.id] ?? []) {
      // An expired slot's link stays live so it can still be revoked, but nobody
      // will book it, so it isn't worth rewriting on every rename.
      if (window.publicPortalId && !isExpired(window.end)) {
        ids.push(window.publicPortalId);
      }
    }
  }
  return ids;
}

export async function propagateProfile(
  owner: Party,
  portalIds: readonly string[],
): Promise<void> {
  if (portalIds.length === 0) return;
  const batch = writeBatch(db());
  for (const id of portalIds) {
    batch.set(
      doc(db(), "portals", id),
      { ownerName: owner.displayName, ownerPhotoURL: owner.photoURL },
      { merge: true },
    );
  }
  await batch.commit();
}

// Slot links only — they're the one kind carrying a copy. The others read live.
export async function propagateListing(
  listing: Listing,
  windows: readonly AvailabilityWindow[],
): Promise<void> {
  const targets = windows
    .map((window) => window.publicPortalId)
    .filter((id): id is string => Boolean(id));
  if (targets.length === 0) return;

  const snaps = await Promise.all(
    targets.map((id) => getDoc(doc(db(), "portals", id))),
  );
  const batch = writeBatch(db());
  snaps.forEach((snap, index) => {
    if (!snap.exists()) return;
    const current: PortalListing[] = snap.data().listings ?? [];
    const next = current.map((entry) =>
      entry.listingId === listing.id
        ? toPortalListing(listing, entry.windowIds)
        : entry,
    );
    batch.update(doc(db(), "portals", targets[index]), { listings: next });
  });
  await batch.commit();
}

// `expires` exists for a Firestore TTL policy to collect these. Housekeeping
// only: an old grant is already inert, since reads compare it against the token
// the document currently sits under.
const GRANT_DAYS = 30;

// Writing this doc IS the proof the visitor holds the token — the path names it,
// and the rule refuses one that doesn't resolve to a live link.
export async function claimGrant(portalId: string, uid: string): Promise<void> {
  await setDoc(doc(db(), "portals", portalId, "grants", uid), {
    expires: grantExpiry(),
  });
}

function grantExpiry(): Date {
  const expires = new Date();
  expires.setDate(expires.getDate() + GRANT_DAYS);
  return expires;
}

// Rooms are read live for USER and LISTING scope and copied for SLOT; free dates
// are always live. `signIn` is taken in flight so the anonymous sign-in overlaps
// the portal read — the portal doc needs no identity, being readable by id.
// `onOwner` fires when the portal doc lands — a round trip before the rooms and
// two before the dates — so the page has something honest to draw that early.
export async function fetchPortalPage(
  portalId: string,
  signIn: Promise<string>,
  onOwner?: (portal: Portal) => void,
): Promise<PortalContent | null> {
  // The grant needs the token and the uid, and both are in hand before the
  // portal doc lands — waiting for that doc put a whole round trip in front of a
  // write that never read it. Swallowed because a token naming no portal has the
  // write refused by design, and that case belongs to `snap.exists()` below; a
  // grant that genuinely failed to land resurfaces as a refusal on the reads it
  // was meant to authorise.
  const claimed = signIn.then((uid) =>
    claimGrant(portalId, uid).catch(() => {}),
  );

  // Announced off the doc read ALONE. Awaiting the Promise.all first would put
  // the sign-in, the grant and the bookings query in front of a callback whose
  // whole purpose is to beat them — the portal doc needs no identity, so it is
  // the one thing that can be shown at one round trip.
  const early = getDoc(doc(db(), "portals", portalId)).then((snap) => {
    const found = snap.exists()
      ? toPortal(snap as QueryDocumentSnapshot)
      : null;
    if (found) onOwner?.(found);
    return { snap, found };
  });

  const [{ snap, found }, held] = await Promise.all([
    early,
    signIn.then(heldWindows),
    claimed,
  ]);
  if (!found) return null;
  const portal = found;
  const data = snap.data() ?? {};

  const listings: PortalListing[] = portal.listings.length
    ? [...portal.listings]
    : await readLiveListings(portal, data.listingId ?? null);

  const perListing = await Promise.all(
    listings.map(
      async (listing) =>
        [
          listing.listingId,
          await readVisibleWindows(listing, held.get(listing.listingId)),
        ] as const,
    ),
  );

  return {
    portal: { ...portal, listings },
    windows: Object.fromEntries(perListing),
  };
}

// A USER link names no rooms, so a room added later just appears.
async function readLiveListings(
  portal: Portal,
  listingId: string | null,
): Promise<PortalListing[]> {
  const snaps = listingId
    ? [await getDoc(doc(db(), "listings", listingId))]
    : (
        await getDocs(
          query(
            collection(db(), "listings"),
            where("ownerId", "==", portal.ownerId),
          ),
        )
      ).docs;

  return snaps
    .filter((snap) => snap.exists())
    .map((snap) => {
      const listing = snap.data() ?? {};
      return {
        listingId: snap.id,
        title: listing.title ?? "",
        type: listing.type ?? "ROOM",
        description: listing.description ?? "",
        locationLabel: listing.location?.label ?? "",
        photos: (listing.photos as ListingPhoto[]) ?? [],
        windowIds: null,
      };
    });
}

const EMPTY_HELD: ReadonlySet<string> = new Set();

async function readVisibleWindows(
  listing: PortalListing,
  holding: ReadonlySet<string> = EMPTY_HELD,
): Promise<PortalWindow[]> {
  const windowsRef = collection(db(), "listings", listing.listingId, "windows");
  const snaps = listing.windowIds
    ? await Promise.all(
        listing.windowIds.map((id) => getDoc(doc(windowsRef, id))),
      )
    : await readOpenAndHeld(windowsRef, holding);

  return (
    snaps
      .filter((entry) => entry.exists())
      // A slot link still shows its own dates once past; wider links drop them
      // rather than offering a stranger last month.
      .filter(
        (entry) => listing.windowIds || !isExpired(entry.data()?.end ?? ""),
      )
      .map((entry) => {
        const data = entry.data() ?? {};
        return {
          id: entry.id,
          start: data.start ?? "",
          end: data.end ?? "",
          details: data.details ?? "",
          autoAccept: data.autoAccept === true,
          booked: (data.status ?? "OPEN") !== "OPEN",
          bookedByMe: holding.has(entry.id),
        };
      })
      .sort((left, right) => left.start.localeCompare(right.start))
  );
}

// Asked of my own bookings rather than of the slots: a slot no longer names the
// guest holding it, so there is nothing on it left to match against. One query
// for the whole page, keyed by room — it was one per room, each of them waiting
// on the grant that authorises the room reads. `guestId == uid` is the FIRST
// clause of the booking read rule, so this needs no grant and never had to.
//
// The status filter is not tidiness: without it this drags back every booking
// the visitor has ever had, on the critical path, to use the confirmed few. The
// old per-room query was at least bounded by its room. `fetchStaysOf` proves the
// pair is allowed.
async function heldWindows(uid: string): Promise<Map<string, Set<string>>> {
  const snap = await getDocs(
    query(
      collection(db(), "bookings"),
      where("guestId", "==", uid),
      where("status", "==", "CONFIRMED"),
    ),
  );
  const byListing = new Map<string, Set<string>>();
  for (const entry of snap.docs) {
    const booking = entry.data();
    const slots = byListing.get(booking.listingId) ?? new Set<string>();
    slots.add(booking.windowId as string);
    byListing.set(booking.listingId, slots);
  }
  return byListing;
}

// Two reads rather than an `or` because each stands on its own clause of the
// window read rule — mixing them could return a document the rules refuse, which
// sinks the whole query. The held ones are fetched by id, since the only clause
// admitting them matches one document at a time.
async function readOpenAndHeld(
  windowsRef: CollectionReference<DocumentData>,
  held: ReadonlySet<string>,
): Promise<DocumentSnapshot<DocumentData>[]> {
  const [free, mine] = await Promise.all([
    getDocs(query(windowsRef, where("status", "==", "OPEN"))),
    Promise.all([...held].map((id) => getDoc(doc(windowsRef, id)))),
  ]);
  // The two shouldn't overlap, but the rules only pin that on the guest's release
  // and not the owner's edits, so the overlap is dropped rather than assumed away
  // into a duplicate row.
  return [
    ...free.docs,
    ...mine.filter(
      (entry) => entry.exists() && entry.data()?.status !== "OPEN",
    ),
  ];
}
