"use client";

import type { ReactElement } from "react";
import { LuChevronRight, LuMapPin } from "react-icons/lu";
import { formatDateRange } from "../utils/format";
import { listingTypeIcon } from "../utils/listings";
import { useKip } from "../utils/store";
import type { Booking, BookingStatus } from "../utils/types";
import CoverPhoto from "./cover-photo";
import Chip, { type ChipTone } from "./ui/chip";
import { Row } from "./ui/list";

const STATUS: Record<BookingStatus, { label: string; tone: ChipTone }> = {
  REQUESTED: { label: "Pending", tone: "pending" },
  CONFIRMED: { label: "Confirmed", tone: "confirmed" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

// `lead` says which of the place and the person comes first: the place tells
// rows apart on a list spanning places, and repeats uselessly on one place's own
// Guests list. The cover follows it for the same reason.
export default function BookingRow({
  booking,
  lead = "place",
  showCounterpart = true,
}: {
  booking: Booking;
  lead?: "place" | "person";
  // Off on a list that is already about one person — naming them on every row
  // says nothing, and on a stay you're only watching there is no "with" to it.
  showCounterpart?: boolean;
}): ReactElement {
  const {
    user,
    knownPerson,
    friendListings,
    myListings,
    tripListings,
    navigate,
  } = useKip();

  const iAmGuest = booking.guestId === user?.uid;
  const otherUid = iAmGuest ? booking.ownerId : booking.guestId;
  // A pending ask authorises no read, so an unanswered stranger is "Someone".
  const otherName = knownPerson(otherUid)?.displayName || "Someone";
  const known = [...friendListings, ...myListings, ...tripListings].find(
    (listing) => listing.id === booking.listingId,
  );
  const title = known?.title || "A place";
  // An unreadable place falls back to a pin: the leading slot exists either way,
  // and an empty one breaks the row rhythm.
  const PlaceIcon = known ? listingTypeIcon(known.type) : LuMapPin;
  const status = STATUS[booking.status];
  const person = iAmGuest ? `with ${otherName}` : otherName;
  const headline = lead === "person" ? otherName : title;
  const detail = lead === "person" || !showCounterpart ? "" : `${person} · `;

  return (
    <Row
      onClick={() => navigate({ kind: "booking", id: booking.id })}
      ariaLabel={headline}
    >
      {lead === "place" ? (
        <CoverPhoto
          photo={known?.photos[0]}
          className="h-10 w-10 shrink-0"
          fallback={
            <span className="bg-accent-soft grid h-10 w-10 shrink-0 place-items-center rounded-2xl text-accent-ink">
              <PlaceIcon size={18} />
            </span>
          }
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[0.9375rem] font-semibold">
          {headline}
        </span>
        <span className="block truncate text-sm text-muted">
          {detail}
          {formatDateRange(booking.start, booking.end)}
        </span>
      </div>
      <Chip tone={status.tone}>{status.label}</Chip>
      <LuChevronRight className="shrink-0 text-faint" />
    </Row>
  );
}
