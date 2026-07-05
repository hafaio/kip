"use client";

import { type ReactElement, useState } from "react";
import { LuChevronRight, LuZap } from "react-icons/lu";
import { formatDateRange, nights } from "../utils/format";
import { useKip } from "../utils/store";
import type { AvailabilityWindow, Listing } from "../utils/types";
import CoverPhoto from "./cover-photo";
import Button from "./ui/button";
import Chip from "./ui/chip";
import { Row } from "./ui/list";

// One availability slot in a friend's room page, as a grouped-list row: the
// dates + a nights/details meta line on the left, and on the right either an
// Instant chip + the single Book/Request action, or a passive status chip.
// Booked-by-you and pending rows tap through to the booking page, where cancel
// lives. A range someone else has isn't listed here at all, so the only booked
// rows are the reader's own.
export default function SlotRow({
  listing,
  window,
}: {
  listing: Listing;
  window: AvailabilityWindow;
}): ReactElement {
  const { user, trips, requestBooking, refreshWindows, navigate } = useKip();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const myBooking = trips.find(
    (booking) =>
      booking.windowId === window.id && booking.status !== "CANCELLED",
  );

  async function book(): Promise<void> {
    setBusy(true);
    setNote(null);
    try {
      const outcome = await requestBooking(listing, window);
      // A slot that was taken — by this booking or by whoever got there first —
      // now reads BOOKED, and friends' dates aren't live, so this row would go on
      // offering it. Only this room's dates changed, so only they are refetched.
      if (outcome === "unavailable") {
        setNote("Just taken by someone else.");
        await refreshWindows(listing.id);
      } else if (outcome === "confirmed") {
        await refreshWindows(listing.id);
      }
    } catch (error) {
      console.error(error);
      setNote("Couldn't book — try again.");
    } finally {
      setBusy(false);
    }
  }

  // "Booked by you" means I actually HOLD this window (booked + stamped with my
  // uid) — not merely that I have some non-cancelled booking on it. Two friends
  // can both hold REQUESTED bookings on one non-auto window; when the owner
  // confirms the other, this flips to BOOKED by them, and the losing requester
  // (still REQUESTED) must not see a green "Booked by you".
  const iHoldWindow = window.bookedBy != null && window.bookedBy === user?.uid;
  const pendingRequest = myBooking?.status === "REQUESTED";
  const showInstant = window.autoAccept && window.status === "OPEN";

  const dates = (
    <span className="block text-[0.9375rem] font-semibold">
      {formatDateRange(window.start, window.end)}
    </span>
  );
  const meta = (
    <span className="block text-sm text-muted">
      {nights(window.start, window.end)} nights
      {window.details ? ` · ${window.details}` : ""}
    </span>
  );
  // The place these dates belong to. Every row in one list is the same room, so
  // this repeats — but a date range with no picture beside it reads as an
  // abstraction, and the picture is most of what makes it a place worth asking
  // for. It renders nothing when the room has no photos.
  const thumb = (
    <CoverPhoto photo={listing.photos[0]} className="h-10 w-10 shrink-0" />
  );

  // Booked-by-you or pending: the row is a link to my booking page.
  if (myBooking && (iHoldWindow || pendingRequest)) {
    return (
      <Row onClick={() => navigate({ kind: "booking", id: myBooking.id })}>
        {thumb}
        <div className="min-w-0 flex-1">
          {dates}
          {meta}
        </div>
        {iHoldWindow ? (
          <Chip tone="confirmed">Booked by you</Chip>
        ) : (
          <Chip tone="pending">Pending</Chip>
        )}
        <LuChevronRight className="shrink-0 text-faint" />
      </Row>
    );
  }

  // Booked, with my own booking not in hand yet: the room page only lists a
  // taken range when I'm the one holding it, so this is the moment before
  // `trips` arrives rather than someone else's stay. Passive and dimmed until it
  // resolves — never a Book button on dates that are gone.
  if (window.status === "BOOKED") {
    return (
      <div className="flex min-h-14 items-center gap-3 px-4 py-3 opacity-60">
        {thumb}
        <div className="min-w-0 flex-1">
          {dates}
          {meta}
        </div>
        <Chip tone="booked">Booked</Chip>
      </div>
    );
  }

  // Open and bookable: the one inline action.
  return (
    <div className="flex flex-col gap-1 px-4 py-3">
      <div className="flex items-center gap-3">
        {thumb}
        <div className="min-w-0 flex-1">
          {dates}
          {meta}
        </div>
        {showInstant ? (
          <Chip tone="instant" icon={<LuZap size={12} />}>
            Instant
          </Chip>
        ) : null}
        <Button onClick={book} disabled={busy}>
          {window.autoAccept ? "Book" : "Request"}
        </Button>
      </div>
      {note ? <p className="text-sm text-accent-ink">{note}</p> : null}
    </div>
  );
}
