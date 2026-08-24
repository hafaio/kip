// What leaving does to one booking, decided without touching Firestore.
//
// The teardown runs again on every retry, over an account it has already partly
// dismantled, and each write it makes here fires `onBookingChanged` — so a
// booking it has already cancelled must be left alone or the other party is told
// their stay was called off once per attempt. That skip is the whole reason
// retries are safe, and it is here rather than inline for the reason
// `messages.ts` is a file: the walk around it needs the Admin SDK and a live
// account to exercise, this needs neither.

export type CancelReason = "STAY_CANCELLED" | "WITHDRAWN" | "SLOT_CANCELLED";

export type Cancellation = {
  readonly status: "CANCELLED";
  readonly cancelledBy: string;
  readonly cancelReason: CancelReason;
  // A confirmed stay HOLDS its slot, so the host gets those nights back in the
  // same commit — but only at someone else's place: the leaver's own slots are
  // deleted whole a phase later.
  readonly releasesSlot: boolean;
};

// Null means leave it exactly as it is. Two ways to get one, and they are
// different facts: a booking that is already CANCELLED has said everything it
// is going to say, and a stay whose last day has passed is a record of a visit
// that happened — "cancelled" is the wrong word for it, and writing it would
// tell someone their trip was called off after they had been on it.
export function cancellationFor(
  booking: {
    status?: unknown;
    end?: unknown;
    guestId?: unknown;
    ownerId?: unknown;
  },
  uid: string,
  cutoff: string,
): Cancellation | null {
  if (booking.status === "CANCELLED") return null;
  if (typeof booking.end !== "string" || booking.end < cutoff) return null;

  const confirmed = booking.status === "CONFIRMED";
  return {
    status: "CANCELLED",
    cancelledBy: uid,
    // The wording each one reaches the other party as. A withdrawn ask says
    // nothing at all, which is right — theirs was never answered.
    cancelReason: confirmed
      ? "STAY_CANCELLED"
      : booking.guestId === uid
        ? "WITHDRAWN"
        : "SLOT_CANCELLED",
    releasesSlot: confirmed && booking.ownerId !== uid,
  };
}
