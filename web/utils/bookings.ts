"use client";

import {
  addDoc,
  arrayUnion,
  collection,
  type DocumentData,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  type QueryDocumentSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db, onSnapshotError } from "./firebase";
import { isExpired } from "./format";
import type { AvailabilityWindow, Booking, Listing } from "./types";

function epoch(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : 0;
}

function toBooking(snap: QueryDocumentSnapshot<DocumentData>): Booking {
  const data = snap.data();
  return {
    id: snap.id,
    listingId: data.listingId,
    ownerId: data.ownerId,
    guestId: data.guestId,
    windowId: data.windowId,
    start: data.start,
    end: data.end,
    status: data.status ?? "REQUESTED",
    cancelledBy: data.cancelledBy ?? null,
    cancelReason: data.cancelReason ?? null,
    hiddenBy: data.hiddenBy ?? [],
    createdAt: epoch(data.createdAt),
  };
}

// Bookings where I'm the guest (my trips).
export function watchMyTrips(
  uid: string,
  onChange: (bookings: Booking[]) => void,
): () => void {
  const ref = query(collection(db(), "bookings"), where("guestId", "==", uid));
  return onSnapshot(
    ref,
    (snap) => onChange(snap.docs.map(toBooking)),
    onSnapshotError("trips"),
  );
}

// Bookings against my places (requests I need to confirm).
export function watchIncomingBookings(
  uid: string,
  onChange: (bookings: Booking[]) => void,
): () => void {
  const ref = query(collection(db(), "bookings"), where("ownerId", "==", uid));
  return onSnapshot(
    ref,
    (snap) => onChange(snap.docs.map(toBooking)),
    onSnapshotError("incomingBookings"),
  );
}

export type BookingOutcome = "requested" | "confirmed" | "unavailable";

// A normal slot stays OPEN — only the owner may flip it. An auto-accept slot is
// first come, first served: concurrent grabs contend on the window doc inside a
// transaction, so exactly one wins and the rest get "unavailable".
export async function requestBooking(
  guestId: string,
  listing: Listing,
  window: AvailabilityWindow,
): Promise<BookingOutcome> {
  const notice = {
    listingId: listing.id,
    ownerId: listing.ownerId,
    guestId,
    start: window.start,
    end: window.end,
    // Pinned null by the rules, so one can't be lodged pre-stamped as cancelled.
    cancelledBy: null,
    cancelReason: null,
  };

  if (!window.autoAccept) {
    const _ref = await addDoc(collection(db(), "bookings"), {
      ...notice,
      windowId: window.id,
      status: "REQUESTED",
      createdAt: serverTimestamp(),
    });
    return "requested";
  }

  const windowRef = doc(db(), "listings", listing.id, "windows", window.id);
  // Pre-allocated so the id is known for the notification after the commit.
  const bookingRef = doc(collection(db(), "bookings"));
  try {
    await runTransaction(db(), async (tx) => {
      const snap = await tx.get(windowRef);
      if (!snap.exists() || snap.data().status !== "OPEN") {
        throw new Error("unavailable");
      }
      tx.update(windowRef, { status: "BOOKED", bookingId: bookingRef.id });
      tx.set(bookingRef, {
        ...notice,
        windowId: window.id,
        status: "CONFIRMED",
        createdAt: serverTimestamp(),
      });
    });
    return "confirmed";
  } catch (error) {
    if (error instanceof Error && error.message === "unavailable") {
      return "unavailable";
    }
    throw error;
  }
}

// Why an ask couldn't go. The rules refuse all four causes identically, as
// `permission-denied`, which the portal page can only render as "this link may
// have been turned off" — true for a revoked link and wrong for the rest.
// Reading the slot first is what lets the refusal say which.
export class SlotGone extends Error {
  constructor(readonly why: "taken" | "moved" | "removed" | "past") {
    super(why);
    this.name = "SlotGone";
  }
}

type Slot = { id: string; start: string; end: string };

// What the pre-flight read means, separated from the reading. `null` is the read
// having FAILED rather than the slot being absent — offline, or refused — and it
// answers nothing, so the ask proceeds and Firestore queues it. Turning a read
// that never happened into "those dates aren't offered any more" would drop the
// ask and lie about why.
//
// Pure so the four causes can be pinned without a network: the wrong branch here
// is invisible in every test that has one.
export function slotVerdict(
  slot: {
    exists: boolean;
    status?: string;
    start?: string;
    end?: string;
  } | null,
  window: Slot,
  expired: boolean,
): SlotGone["why"] | null {
  if (slot === null) return null;
  if (!slot.exists) return "removed";
  if (slot.status !== "OPEN") return "taken";
  if (slot.start !== window.start || slot.end !== window.end) return "moved";
  if (expired) return "past";
  return null;
}

function lodge(
  guestId: string,
  ownerId: string,
  listingId: string,
  window: Slot,
): Promise<unknown> {
  return addDoc(collection(db(), "bookings"), {
    listingId,
    ownerId,
    guestId,
    windowId: window.id,
    start: window.start,
    end: window.end,
    status: "REQUESTED",
    cancelledBy: null,
    cancelReason: null,
    createdAt: serverTimestamp(),
  });
}

// The same document a friend creates; only the authorisation differs, and
// instant booking is never on the table however the slot is configured. The
// dates asked for are the ones that were SHOWN, never whatever the slot says
// now — a host who shifted them while the visitor was deciding has not been
// agreed with.
export async function requestStayViaPortal(
  guestId: string,
  ownerId: string,
  listingId: string,
  window: Slot,
): Promise<void> {
  // Only a read that actually answered may refuse an ask. Offline this rejects,
  // and the ask still goes: `addDoc` queues locally and lands on reconnect,
  // which is the property this flow is documented to have. Turning a cache miss
  // into "those dates aren't offered any more" would drop the ask and lie.
  const slot = await getDoc(
    doc(db(), "listings", listingId, "windows", window.id),
  ).catch(() => null);

  const verdict = slotVerdict(
    slot === null ? null : { exists: slot.exists(), ...(slot.data() ?? {}) },
    window,
    isExpired(window.end),
  );
  if (verdict) throw new SlotGone(verdict);

  await lodge(guestId, ownerId, listingId, window);
}

// A denial is the answer, not an error, so the caller can ask and act on the
// silence. Same shape as `fetchUserProfile` reading a private stranger as null.
export async function fetchBookingIfVisible(
  bookingId: string,
): Promise<Booking | null> {
  const snap = await getDoc(doc(db(), "bookings", bookingId)).catch((error) => {
    if (error?.code !== "permission-denied") throw error;
    return null;
  });
  if (!snap?.exists()) {
    return null;
  } else {
    return toBooking(snap);
  }
}

// Readable only while they share them, and all-or-nothing. The status filter is
// load-bearing: without it Firestore refuses the query outright.
export async function fetchStaysOf(guestId: string): Promise<Booking[]> {
  const snap = await getDocs(
    query(
      collection(db(), "bookings"),
      where("guestId", "==", guestId),
      where("status", "==", "CONFIRMED"),
    ),
  ).catch((error) => {
    if (error?.code !== "permission-denied") throw error;
    return null;
  });
  if (!snap) {
    return [];
  } else {
    return snap.docs
      .map(toBooking)
      .filter((booking) => !isExpired(booking.end))
      .sort((left, right) => left.start.localeCompare(right.start));
  }
}

// So a share-link page can still show "requested" after a reload.
export async function fetchMyBookingsWith(
  guestId: string,
  ownerId: string,
): Promise<Booking[]> {
  const snap = await getDocs(
    query(
      collection(db(), "bookings"),
      where("guestId", "==", guestId),
      where("ownerId", "==", ownerId),
    ),
  );
  return snap.docs.map(toBooking);
}

// Sight of the listing isn't granted here — the guest self-issues that pointer,
// and it couldn't be written in this commit anyway, since the rules still see
// the booking as REQUESTED.
export async function confirmBooking(
  booking: Booking,
): Promise<BookingOutcome> {
  const bookingRef = doc(db(), "bookings", booking.id);
  const windowRef = doc(
    db(),
    "listings",
    booking.listingId,
    "windows",
    booking.windowId,
  );
  try {
    await runTransaction(db(), async (tx) => {
      const [current, snap] = await Promise.all([
        tx.get(bookingRef),
        tx.get(windowRef),
      ]);
      // The ask can be withdrawn while the host is looking at it. Without this
      // read the rules refuse the write and the host sees a raw error instead of
      // "no longer available".
      if (!current.exists() || current.data().status !== "REQUESTED") {
        throw new Error("unavailable");
      }
      // The rules refuse two sequential confirms, but two landing at the same
      // instant would both evaluate against a still-open slot. Re-reading inside
      // the commit is what makes exactly one win.
      if (
        !snap.exists() ||
        snap.data().status !== "OPEN" ||
        snap.data().start !== booking.start ||
        snap.data().end !== booking.end
      ) {
        throw new Error("unavailable");
      }
      tx.update(bookingRef, { status: "CONFIRMED" });
      tx.update(windowRef, {
        status: "BOOKED",
        bookingId: booking.id,
      });
    });
    return "confirmed";
  } catch (error) {
    if (error instanceof Error && error.message === "unavailable") {
      return "unavailable";
    }
    throw error;
  }
}

// Self-issued by the reader, naming the stay that justifies it. Grants nothing
// on its own, so it goes inert when that stay is cancelled and no cancel path
// has to tear it down.
export async function claimKnownBy(
  readerUid: string,
  otherUid: string,
  bookingId: string,
): Promise<void> {
  await setDoc(doc(db(), "users", otherUid, "knownBy", readerUid), {
    bookingId,
  });
}

// Same pointer shape as claimKnownBy, and idempotent, so it's safe to re-run
// whenever a confirmed stay is noticed.
export async function claimGuestAccess(
  listingId: string,
  guestUid: string,
  bookingId: string,
): Promise<void> {
  await setDoc(doc(db(), "listings", listingId, "guests", guestUid), {
    bookingId,
  });
}

// A pending ask left the window OPEN, so only a CONFIRMED stay has one to release.
export async function cancelBookingAsGuest(booking: Booking): Promise<void> {
  const batch = writeBatch(db());
  batch.update(doc(db(), "bookings", booking.id), {
    status: "CANCELLED",
    cancelledBy: booking.guestId,
    cancelReason:
      booking.status === "CONFIRMED" ? "STAY_CANCELLED" : "WITHDRAWN",
  });
  if (booking.status === "CONFIRMED") {
    batch.update(
      doc(db(), "listings", booking.listingId, "windows", booking.windowId),
      { status: "OPEN", bookingId: null },
    );
  }
  await batch.commit();
}

// Reopens the window only for a CONFIRMED stay: several guests can hold pending
// asks on one slot, so declining one must not un-hold another's confirmed stay.
export async function cancelBookingAsOwner(booking: Booking): Promise<void> {
  const batch = writeBatch(db());
  batch.update(doc(db(), "bookings", booking.id), {
    status: "CANCELLED",
    cancelledBy: booking.ownerId,
    cancelReason:
      booking.status === "CONFIRMED" ? "STAY_CANCELLED" : "DECLINED",
  });
  if (booking.status === "CONFIRMED") {
    batch.update(
      doc(db(), "listings", booking.listingId, "windows", booking.windowId),
      { status: "OPEN", bookingId: null },
    );
  }
  await batch.commit();
}

// Future bookings only: clearing an old slot off your calendar shouldn't tell a
// guest their stay was called off after they'd already been. Always use this
// rather than a bare window delete, or a booked window's booking is orphaned.
export async function cancelWindowAsOwner(
  listingId: string,
  windowId: string,
  bookingsOnWindow: readonly Booking[],
): Promise<void> {
  // `isExpired`, not a hand-rolled comparison — a stay checking out TODAY is
  // still live, and getting that boundary wrong stranded the guest's own cancel.
  const active = bookingsOnWindow.filter(
    (booking) => booking.status !== "CANCELLED" && !isExpired(booking.end),
  );
  const windowRef = doc(db(), "listings", listingId, "windows", windowId);
  // Read before deleting: the window doc is the only pointer to its share link,
  // so losing it would strand a live capability URL nothing can revoke.
  const snap = await getDoc(windowRef);
  const slotPortalId = snap.exists()
    ? (snap.data().publicPortalId as string | null)
    : null;
  const batch = writeBatch(db());
  for (const booking of active) {
    batch.update(doc(db(), "bookings", booking.id), {
      status: "CANCELLED",
      cancelledBy: booking.ownerId,
      cancelReason: "SLOT_CANCELLED",
    });
  }
  if (slotPortalId) batch.delete(doc(db(), "portals", slotPortalId));
  batch.delete(windowRef);
  await batch.commit();
}

// arrayUnion, never a plain write: the rules refuse a hiddenBy that drops the
// other party's entry, so replacing the array fails once they've cleared it too.
export async function hideBooking(
  uid: string,
  bookingId: string,
): Promise<void> {
  await updateDoc(doc(db(), "bookings", bookingId), {
    hiddenBy: arrayUnion(uid),
  });
}

// The caller passes bookings it already holds, so this costs one batch, no query.
export async function hideBookings(
  uid: string,
  bookingIds: readonly string[],
): Promise<void> {
  if (bookingIds.length === 0) return;
  const batch = writeBatch(db());
  for (const bookingId of bookingIds) {
    batch.update(doc(db(), "bookings", bookingId), {
      hiddenBy: arrayUnion(uid),
    });
  }
  await batch.commit();
}
