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

// Guest books a window. For a normal window we just record a REQUESTED booking
// and leave the window OPEN — only the owner can flip it (rules), so it goes
// BOOKED on confirm. For an auto-accept window it's first come, first served: a
// transaction re-reads the window and, if still OPEN, atomically marks it BOOKED
// and writes a CONFIRMED booking. Concurrent grabs contend on the window doc, so
// exactly one wins and the rest get "unavailable".
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
    // A stay starts life un-cancelled, and the rules pin both to null so one
    // can't be lodged pre-stamped as called off by the host.
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
  // Pre-allocate the booking ref so its id is known for the notification after
  // the transaction commits.
  const bookingRef = doc(collection(db(), "bookings"));
  try {
    await runTransaction(db(), async (tx) => {
      const snap = await tx.get(windowRef);
      if (!snap.exists() || snap.data().status !== "OPEN") {
        throw new Error("unavailable");
      }
      tx.update(windowRef, { status: "BOOKED", bookedBy: guestId });
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

// Ask to stay through a share link. This is the SAME document a friend creates —
// a REQUESTED booking — so there's one concept for "someone wants these dates"
// rather than a parallel request type. What differs is only the authorisation
// (a share-link grant instead of friendship) and that instant booking is never
// on the table here, however the slot is configured.
export async function requestStayViaPortal(
  guestId: string,
  ownerId: string,
  listingId: string,
  window: { id: string; start: string; end: string },
): Promise<void> {
  await addDoc(collection(db(), "bookings"), {
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

// The guest's own bookings with one host — so a share-link page can still show
// "requested" after a reload.
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

// Owner confirms: mark the booking CONFIRMED and the slot BOOKED together,
// stamping the guest as bookedBy so they can release it if they cancel.
//
// Sight of the LISTING is not granted here — the guest issues that pointer
// themselves (see claimGuestAccess). It can't be written in this batch anyway:
// rules evaluate against committed state, so the booking is still REQUESTED as
// far as they're concerned.
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
      // The ask itself can go while the host is looking at it — the guest takes
      // it back, or the slot is cancelled out from under it. CANCELLED is
      // terminal in the rules, so without this read the write is refused and the
      // host gets a raw error where the honest answer is the one the slot race
      // already gives: this can't be confirmed any more.
      if (!current.exists() || current.data().status !== "REQUESTED") {
        throw new Error("unavailable");
      }
      // Two people can ask for the same slot. Confirming both one after the other
      // is already refused by the rules (they require an OPEN slot), but two
      // confirms landing at the same instant would BOTH evaluate against a slot
      // that was still open, and both commit. A transaction re-reads inside the
      // commit and aborts if anything touched the slot meanwhile, so exactly one
      // wins — the same guarantee instant booking has always had.
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
        bookedBy: booking.guestId,
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

// Point the other party of a stay at the booking that lets this user read their
// profile. The same shape as the guest marker below, and self-issued for the same
// reason — the reader writes it, naming the stay that justifies it, and the rules
// re-read that stay on every use. So it grants nothing on its own, goes inert the
// moment the stay is cancelled, and no cancel path has to tear it down.
//
// This is what replaces the two parties' names being copied onto every booking:
// that copy could only be kept true by rewriting every booking a person had ever
// been party to on each rename, which is unbounded and would eventually blow the
// 500-operation batch limit. Each side claims its own pointer, so the two
// directions are independent.
export async function claimKnownBy(
  readerUid: string,
  otherUid: string,
  bookingId: string,
): Promise<void> {
  await setDoc(doc(db(), "users", otherUid, "knownBy", readerUid), {
    bookingId,
  });
}

// Point a listing at the booking that entitles this guest to see it. Idempotent,
// and safe to call whenever a confirmed stay is noticed — the pointer grants
// nothing by itself; the rules re-read the booking every time it's used, so it
// goes inert the moment the stay is cancelled. That's why no cancel path has to
// remember to tear it down. Takes the three ids rather than the booking, like
// claimKnownBy above, so the caller can name a stay without holding it.
export async function claimGuestAccess(
  listingId: string,
  guestUid: string,
  bookingId: string,
): Promise<void> {
  await setDoc(doc(db(), "listings", listingId, "guests", guestUid), {
    bookingId,
  });
}

// Guest cancels their own request/stay. A pending REQUESTED booking left the
// window OPEN, so there's nothing to reopen. A CONFIRMED one (auto-accept or
// owner-confirmed) holds the window BOOKED with the guest as bookedBy, so the
// guest releases it back to OPEN in the same batch (rules permit the booker).
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
      { status: "OPEN", bookedBy: null },
    );
  }
  await batch.commit();
}

// Owner declines or cancels a single booking: mark it CANCELLED, and reopen the
// window ONLY if this booking actually holds it (a CONFIRMED stay). A non-auto
// window stays OPEN while multiple friends hold REQUESTED bookings, so declining
// one pending request must not reopen — and thereby silently un-hold — a DIFFERENT
// guest's already-confirmed booking on the same window. Mirrors cancelBookingAsGuest.
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
      { status: "OPEN", bookedBy: null },
    );
  }
  await batch.commit();
}

// Owner cancels an entire slot: cancel every FUTURE booking on it (those guests
// are notified) and delete the slot itself, in one batch. A stay that has already
// happened is left CONFIRMED — clearing an old slot off your calendar shouldn't
// retroactively cancel a visit, or tell the guest their stay was called off after
// they'd already been.
// Use this rather than a bare window delete so a booked window's booking isn't
// left orphaned. `bookingsOnWindow` is the owner's bookings for this window
// (the store passes them from its live incomingBookings).
export async function cancelWindowAsOwner(
  listingId: string,
  windowId: string,
  bookingsOnWindow: readonly Booking[],
): Promise<void> {
  // `isExpired`, not a hand-rolled comparison: it is `end < today`, so a stay
  // checking out TODAY is still live. Written as `end > today` this missed
  // exactly that case — the window was deleted anyway, leaving a CONFIRMED
  // booking pointing at a slot that no longer exists, and the guest's own cancel
  // (a batch that updates the window) then failed forever with no way out.
  const active = bookingsOnWindow.filter(
    (booking) => booking.status !== "CANCELLED" && !isExpired(booking.end),
  );
  const windowRef = doc(db(), "listings", listingId, "windows", windowId);
  // Read the window's slot share-link before deleting it: deleting the window
  // without deleting its portal would leave a world-readable, still-requestable
  // capability URL that the owner can no longer revoke (the window doc is gone).
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

// Clear a cancelled booking off this user's own list. Not a delete: the document
// is the record for BOTH parties, and the side that didn't tidy up keeps seeing
// it exactly as before. arrayUnion, never a plain write of `[uid]` — the rules
// refuse a hiddenBy that drops the other party's entry, so replacing the array
// would fail the moment they'd cleared it first.
export async function hideBooking(
  uid: string,
  bookingId: string,
): Promise<void> {
  await updateDoc(doc(db(), "bookings", bookingId), {
    hiddenBy: arrayUnion(uid),
  });
}

// The same for a whole list at once. The caller passes the bookings it already
// holds live, so clearing a section costs one batch and no query.
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
