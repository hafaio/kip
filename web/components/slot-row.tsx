"use client";

import { type ReactElement, useState } from "react";
import { LuChevronRight, LuZap } from "react-icons/lu";
import { formatDateRange, nights } from "../utils/format";
import { useKip } from "../utils/store";
import type { AvailabilityWindow, Booking, Listing } from "../utils/types";
import CoverPhoto from "./cover-photo";
import Button from "./ui/button";
import Chip from "./ui/chip";
import { Row } from "./ui/list";

export default function SlotRow({
  listing,
  window,
  stay = null,
}: {
  listing: Listing;
  window: AvailabilityWindow;
  // Passing this is what makes a taken row worth showing: it's the route to who
  // is there, and having it at all is the permission to know.
  stay?: Booking | null;
}): ReactElement {
  const { trips, requestBooking, refreshWindows, navigate } = useKip();
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
      // Friends' dates aren't live, so without this the row goes on offering a
      // slot that has just been taken.
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

  // Holding the window, not merely having a booking on it: two friends can both
  // have REQUESTED one, and the loser must not see "Booked by you".
  const iHoldWindow =
    window.bookingId != null && window.bookingId === myBooking?.id;
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
  // Repeats down a list, but a date range with no picture reads as an abstraction.
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

  // Unattributed either way: the chip says a slot is taken, and who by is a
  // deliberate second step through the stay. The non-interactive branch is a
  // fallback — today's caller filters out any taken slot it can't hand a stay.
  if (window.status === "BOOKED") {
    const taken = (
      <>
        {thumb}
        <div className="min-w-0 flex-1">
          {dates}
          {meta}
        </div>
        <Chip tone="booked">Booked</Chip>
      </>
    );
    return stay ? (
      <Row
        onClick={() => navigate({ kind: "booking", id: stay.id })}
        className="opacity-60"
      >
        {taken}
        <LuChevronRight className="shrink-0 text-faint" />
      </Row>
    ) : (
      <div className="flex min-h-14 items-center gap-3 px-4 py-3 opacity-60">
        {taken}
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
