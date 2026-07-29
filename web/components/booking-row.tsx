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

// One booking as a passive grouped-list row: who/what/when on the left, a status
// chip on the right. The whole row taps through to the booking page, where the
// role-appropriate actions (confirm/decline/cancel) live.
//
// `lead` says which of the place and the person to put first. On a list that
// spans places the place is what tells them apart; on one place's own Guests list
// every row would otherwise repeat that place's title and lead with nothing. The
// cover thumbnail follows `lead` for that same reason — one place's photo down
// its own Guests list is decoration, not information.
export default function BookingRow({
  booking,
  lead = "place",
}: {
  booking: Booking;
  lead?: "place" | "person";
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
  // Read live through the stay, so it's current rather than whoever they were
  // when the booking was made. Someone who asked through a share link and is
  // still waiting on an answer can't be read at all — a pending ask authorises
  // nothing — so they're "Someone" until the stay is confirmed.
  const otherName = knownPerson(otherUid)?.displayName || "Someone";
  const known = [...friendListings, ...myListings, ...tripListings].find(
    (listing) => listing.id === booking.listingId,
  );
  const title = known?.title || "A place";
  // A place you'd recognise on sight tells two rows apart faster than their
  // titles do, so the cover leads on the lists that span places. A booking whose
  // place can't be read any more falls back to a pin — the leading slot exists
  // either way, and an empty one would break the row rhythm.
  const PlaceIcon = known ? listingTypeIcon(known.type) : LuMapPin;
  const status = STATUS[booking.status];
  const person = iAmGuest ? `with ${otherName}` : otherName;
  const headline = lead === "person" ? otherName : title;
  const detail = lead === "person" ? "" : `${person} · `;

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
