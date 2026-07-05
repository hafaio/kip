"use client";

import {
  type CollectionReference,
  collection,
  type DocumentData,
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

// The copied, public-safe half of a place. `windowIds` pins a SLOT link to the
// one date range it covers; wider links leave it null and the visitor lists the
// room's windows. The dates themselves are never copied.
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

// The copied half of a link: who's sharing, and what. Kept current by the
// propagate* helpers below rather than by republishing.
function portalBase(scope: Portal["scope"], owner: Party) {
  return {
    scope,
    ownerId: owner.uid,
    ownerName: owner.displayName,
    ownerPhotoURL: owner.photoURL,
    createdAt: serverTimestamp(),
  };
}

// Mint (or regenerate) a LISTING-scope link: a fresh portal under a new UUID,
// delete any previous one, repoint the listing — so regenerating kills old links
// instantly. Returns the new id.
export async function publishListingPortal(
  listing: Listing,
  owner: Party,
): Promise<string> {
  const id = crypto.randomUUID();
  const batch = writeBatch(db());
  if (listing.publicPortalId) {
    batch.delete(doc(db(), "portals", listing.publicPortalId));
  }
  // No copy of the room: a room link's grant unlocks the room document itself,
  // so the visitor reads its title and description live.
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

// Mint (or regenerate) a SLOT-scope link: a portal over a single window, with
// the active id stored on the window doc.
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
  // The room's details are copied in even though only one date range is shared —
  // that copy is precisely what lets a slot link show the place it belongs to.
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

// Mint (or regenerate) a USER-scope link: a portal over ALL the owner's places,
// with the active id stored in the owner's prefs (which the store watches). It
// names no places at all — the visitor's grant lets them query the owner's rooms
// live, so one added after the link was shared simply appears.
// The previous link id is read INSIDE the transaction, never taken from the
// caller. A stale value — two tabs, a slow render — would delete nothing while
// still moving the pointer, stranding a live link that keeps serving the owner's
// name and keeps authorising connect requests, with no pointer left to revoke it
// by. Nothing else can find it after that.
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

// Every link this owner currently has out: their profile link, one per shared
// place, and one per shared date range. The client already holds all of these,
// so keeping the owner's name current across them never needs a query.
export function ownedPortalIds(
  profilePortalId: string | null,
  listings: readonly Listing[],
  windowsByListing: Readonly<Record<string, readonly AvailabilityWindow[]>>,
): string[] {
  const ids = profilePortalId ? [profilePortalId] : [];
  for (const listing of listings) {
    if (listing.publicPortalId) ids.push(listing.publicPortalId);
    for (const window of windowsByListing[listing.id] ?? []) {
      // A link to dates that have been and gone is still live — it's kept so it
      // can be revoked — but nobody is going to book them, so it isn't worth a
      // write every time the owner changes their name. Rewriting a name onto a
      // link nobody will act on is exactly the unbounded work worth not doing.
      if (window.publicPortalId && !isExpired(window.end)) {
        ids.push(window.publicPortalId);
      }
    }
  }
  return ids;
}

// Push a changed display name / photo out to every link the owner has shared.
// Copies are only worth having if they stay true, and this is the owner-driven
// half — the half a write-through can actually catch.
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

// Push an edited place out to its DATE-RANGE links only — the one kind that
// carries a copy of the room, because a slot grant deliberately doesn't unlock
// the room document. Room and profile links read the room live and need nothing.
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

// Grants are cheap to re-issue and only ever read back by the rules, so they get
// a short life and the visitor's client simply rewrites one on each visit.
//
// `expires` is there for a Firestore TTL policy to collect them. That policy is a
// console/gcloud step and is NOT configured yet, so grants currently accumulate —
// harmless, because an old grant is already inert: reads compare it against the
// token a document currently sits under. Housekeeping, never security.
const GRANT_DAYS = 30;

// Claim read access to whatever this link covers. Writing this doc is the proof
// the visitor holds the token: the path names it, and the rule refuses a token
// that doesn't resolve to a live link. Idempotent — re-visiting just pushes the
// expiry out.
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

// Open a public share link. Returns the places it covers plus their free dates,
// or null if the link was revoked or regenerated.
//
// The caller must already be signed in — anonymously is fine, and is what the
// share-link page does — because every live read is authorised by a grant, and a
// grant needs an identity to belong to.
//
// Where the places come from depends on how wide the link is, and that difference
// is forced by what a rule can look up:
//   USER    — query the owner's rooms live. The grant covers all of them.
//   LISTING — read that one room live.
//   SLOT    — use the copy carried in the link. A slot grant deliberately does NOT
//             unlock the room, so there is nothing live to read; the copy is why a
//             single shared date range can still show which place it belongs to.
// Free dates are always live, for every scope.
// `signIn` is taken in flight rather than as a uid, so the visitor's anonymous
// sign-in and the portal read overlap. The portal doc is world-readable by id —
// that's the whole capability — so it needs no identity, and waiting for auth
// before asking for it made the page a full round trip slower than it has to be.
export async function fetchPortalPage(
  portalId: string,
  signIn: Promise<string>,
): Promise<PortalContent | null> {
  const [snap, uid] = await Promise.all([
    getDoc(doc(db(), "portals", portalId)),
    signIn,
  ]);
  if (!snap.exists()) return null;
  const portal = toPortal(snap as QueryDocumentSnapshot);
  const data = snap.data();

  // Claim before the reads below: the grant is what authorises them.
  await claimGrant(portalId, uid);

  const listings: PortalListing[] = portal.listings.length
    ? [...portal.listings]
    : await readLiveListings(portal, data.listingId ?? null);

  const perListing = await Promise.all(
    listings.map(
      async (listing) =>
        [listing.listingId, await readVisibleWindows(listing, uid)] as const,
    ),
  );

  return {
    portal: { ...portal, listings },
    windows: Object.fromEntries(perListing),
  };
}

// A USER link names no rooms — the grant lets the visitor query them, so a room
// added after the link was shared just appears. A LISTING link names exactly one.
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

// Dates, always read live. A slot link names the single range it covers; anything
// wider lists the room's open ones plus any the VISITOR themselves holds.
//
// That second half is why this isn't one query. A range someone else has taken
// stays hidden — it isn't availability and it isn't the visitor's business — but
// their own booked range dropping out left them a page that offered them nothing
// and said nothing about the stay they already had. The in-app friend view draws
// the same line ("Booked by you"). Two queries rather than an `or`, because each
// stands on its own clause of the window read rule: the visitor's grant covers
// the open ranges, `bookedBy == uid` covers theirs, so neither can return a
// document the rules would refuse and sink the whole query with.
async function readVisibleWindows(
  listing: PortalListing,
  uid: string,
): Promise<PortalWindow[]> {
  const windowsRef = collection(db(), "listings", listing.listingId, "windows");
  const snaps = listing.windowIds
    ? await Promise.all(
        listing.windowIds.map((id) => getDoc(doc(windowsRef, id))),
      )
    : await readOpenAndHeld(windowsRef, uid);

  return (
    snaps
      .filter((entry) => entry.exists())
      // Dates that have been and gone aren't availability, here as everywhere
      // else. A wider link would otherwise offer a stranger a Request button for
      // last month, since `status` only ever says OPEN or BOOKED. A slot link
      // still shows the slot it names — the point is that the person you sent it
      // to sees what became of it.
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
          // A slot a link points AT is shown whatever its state — if someone else
          // got there first it reads "Booked", rather than silently disappearing
          // and leaving the person you sent it to wondering what they missed.
          booked: (data.status ?? "OPEN") !== "OPEN",
          bookedByMe: data.bookedBy === uid,
        };
      })
      .sort((left, right) => left.start.localeCompare(right.start))
  );
}

// What a wider link shows: every free range, plus every range this visitor holds.
// The two should never overlap — releasing a slot clears `bookedBy` as it reopens
// — but the rules only pin that on the guest's release, not on the owner's own
// edits, so the overlap is dropped rather than assumed away into a duplicate row.
async function readOpenAndHeld(
  windowsRef: CollectionReference<DocumentData>,
  uid: string,
): Promise<QueryDocumentSnapshot<DocumentData>[]> {
  const [free, held] = await Promise.all([
    getDocs(query(windowsRef, where("status", "==", "OPEN"))),
    getDocs(query(windowsRef, where("bookedBy", "==", uid))),
  ]);
  return [
    ...free.docs,
    ...held.docs.filter((entry) => entry.data().status !== "OPEN"),
  ];
}
