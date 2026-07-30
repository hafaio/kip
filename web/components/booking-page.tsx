"use client";

import { type ReactElement, type ReactNode, useState } from "react";
import {
  LuCalendarDays,
  LuCheck,
  LuChevronRight,
  LuClock,
  LuMapPin,
  LuX,
} from "react-icons/lu";
import { formatDateRange, isExpired, nights } from "../utils/format";
import { listingTypeIcon } from "../utils/listings";
import { useKip } from "../utils/store";
import type { Booking, CancelReason } from "../utils/types";
import Avatar from "./avatar";
import CoverPhoto from "./cover-photo";
import { useAction, useDialog } from "./dialog";
import Button from "./ui/button";
import Chip, { type ChipTone } from "./ui/chip";
import { Group, Row } from "./ui/list";

// `byMe` is the only axis needed, because the reason and the side always agree —
// every reason but STAY_CANCELLED belongs to exactly one party.
function cancelNote(
  reason: CancelReason | null,
  byMe: boolean,
  otherName: string,
): string {
  switch (reason) {
    case "DECLINED":
      return byMe
        ? "You declined this request"
        : `${otherName} couldn't host these dates`;
    case "WITHDRAWN":
      return byMe
        ? "You took this request back"
        : `${otherName} took this request back`;
    case "SLOT_MOVED":
      return byMe
        ? "You moved these dates, so this request was cancelled"
        : `${otherName} moved these dates, so this request was cancelled`;
    case "SLOT_CANCELLED":
      return byMe
        ? "You called these dates off"
        : `${otherName} called these dates off`;
    case "STAY_CANCELLED":
      return byMe
        ? "You cancelled this stay"
        : `${otherName} cancelled this stay`;
    default:
      return "This booking was cancelled";
  }
}

// The stay, guest side, or the request, owner side.
export default function BookingPage({ id }: { id: string }): ReactElement {
  const {
    user,
    trips,
    incomingBookings,
    friendListings,
    myListings,
    tripListings,
    knownPerson,
    cancelTrip,
    confirmBooking,
    declineBooking,
    hideBooking,
    navigate,
    back,
  } = useKip();
  const run = useAction();
  const { alert, confirm } = useDialog();
  const [busy, setBusy] = useState(false);

  // The ordinary double-click only; the transaction is the real protection.
  async function confirmStay(): Promise<void> {
    if (!booking) return;
    setBusy(true);
    try {
      const outcome = await confirmBooking(booking);
      if (outcome === "unavailable") {
        // Either another stay took the dates or the ask was withdrawn, and the
        // transaction can't tell which without claiming more than it knows.
        await alert({
          title: "Too late for this one",
          body: "Either those dates went to another stay or the guest took their request back — either way there's nothing left to confirm. This page will catch up in a moment.",
        });
      }
    } catch (error) {
      console.error(error);
    } finally {
      setBusy(false);
    }
  }

  const booking: Booking | undefined =
    trips.find((candidate) => candidate.id === id) ??
    incomingBookings.find((candidate) => candidate.id === id);
  if (!booking) {
    return <p className="text-muted">This booking isn't available.</p>;
  }

  const room =
    friendListings.find((listing) => listing.id === booking.listingId) ??
    myListings.find((listing) => listing.id === booking.listingId) ??
    tripListings.find((listing) => listing.id === booking.listingId);
  const title = room?.title || "A place";
  const address = room?.location.label || "Address unavailable";
  const iAmGuest = booking.guestId === user?.uid;
  const otherUid = iAmGuest ? booking.ownerId : booking.guestId;
  // A pending ask authorises no read, so an unanswered stranger stays "Someone"
  // with the role beneath carrying what is actually known.
  const other = knownPerson(otherUid);
  const otherName = other?.displayName || "Someone";
  const otherPhoto = other?.photoURL ?? null;
  const PlaceIcon = room ? listingTypeIcon(room.type) : LuMapPin;
  // A round 40px crop of a room is barely a picture.
  const hero = (
    <CoverPhoto
      photo={room?.photos[0]}
      className="aspect-[16/9] max-h-56 w-full"
    />
  );
  // Every row in this card leads with an icon, so dropping it for the place
  // alone left the title out of line with the rows beneath.
  const placeThumb = (
    <span className="bg-accent-soft grid h-10 w-10 shrink-0 place-items-center rounded-2xl text-accent-ink">
      <PlaceIcon size={18} />
    </span>
  );

  // The page it's on has nothing left to show once hidden.
  async function clearFromList(cleared: Booking): Promise<void> {
    const agreed = await confirm({
      title: "Clear this from your list?",
      body: `It disappears from your ${iAmGuest ? "trips" : "bookings"}. ${otherName} still has their copy — nothing is deleted.`,
      confirmLabel: "Clear",
    });
    if (!agreed) return;
    await hideBooking(cleared.id);
    back();
  }

  const moment: {
    tone: ChipTone;
    label: string;
    note: string;
    circle: string;
    icon: ReactNode;
  } =
    booking.status === "CONFIRMED"
      ? {
          tone: "confirmed",
          label: "Confirmed",
          note: iAmGuest
            ? "Your stay is all set"
            : `You're hosting ${otherName}`,
          circle: "bg-success-soft text-success",
          icon: <LuCheck size={24} />,
        }
      : booking.status === "REQUESTED"
        ? {
            tone: "pending",
            label: "Pending",
            note: iAmGuest
              ? `Waiting on ${otherName} to confirm`
              : `${otherName} wants to book`,
            circle: "bg-pending-soft text-pending",
            icon: <LuClock size={22} />,
          }
        : {
            tone: "neutral",
            label: "Cancelled",
            note: cancelNote(
              booking.cancelReason,
              booking.cancelledBy === user?.uid,
              otherName,
            ),
            circle: "bg-surface-muted text-muted",
            icon: <LuX size={22} />,
          };

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <div className="flex flex-col items-center gap-3 pt-2 text-center">
        <span
          className={`grid h-16 w-16 place-items-center rounded-full ${moment.circle}`}
        >
          {moment.icon}
        </span>
        <Chip tone={moment.tone}>{moment.label}</Chip>
        <p className="text-lg font-bold tracking-[-0.02em]">{moment.note}</p>
      </div>

      {room?.photos[0] ? hero : null}

      <Group>
        {room ? (
          <Row
            onClick={() => navigate({ kind: "room", id: room.id })}
            ariaLabel={title}
          >
            {placeThumb}
            <div className="min-w-0 flex-1">
              <span className="block truncate text-[0.9375rem] font-semibold">
                {title}
              </span>
              <span className="block truncate text-sm text-muted">
                {address}
              </span>
            </div>
            <LuChevronRight className="shrink-0 text-faint" />
          </Row>
        ) : (
          <Row>
            {placeThumb}
            <div className="min-w-0 flex-1">
              <span className="block truncate text-[0.9375rem] font-semibold">
                {title}
              </span>
              <span className="block truncate text-sm text-muted">
                {address}
              </span>
            </div>
          </Row>
        )}
        <Row>
          <span className="bg-accent-soft grid h-10 w-10 shrink-0 place-items-center rounded-2xl text-accent-ink">
            <LuCalendarDays size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <span className="block text-[0.9375rem] font-semibold">
              {formatDateRange(booking.start, booking.end)}
            </span>
            <span className="block text-sm text-muted">
              {nights(booking.start, booking.end)} nights
            </span>
          </div>
        </Row>
        {/* Tappable whether or not they're a friend: it's the one place a
            share-link guest and their host can ask to connect, since neither is
            searchable to the other and neither holds the other's link. */}
        <Row
          onClick={() => navigate({ kind: "person", id: otherUid })}
          ariaLabel={otherName}
        >
          <Avatar
            name={otherName}
            photoURL={otherPhoto}
            className="h-10 w-10 text-sm"
          />
          <div className="min-w-0 flex-1">
            <span className="block truncate text-[0.9375rem] font-semibold">
              {otherName}
            </span>
            <span className="block text-sm text-muted">
              {iAmGuest ? "Your host" : "Your guest"}
            </span>
          </div>
          <LuChevronRight className="shrink-0 text-faint" />
        </Row>
      </Group>

      {booking.status !== "CANCELLED" ? (
        <div className="flex flex-col gap-2">
          {iAmGuest ? (
            <Button
              variant="danger"
              size="lg"
              onClick={() => run(() => cancelTrip(booking))}
            >
              Cancel {booking.status === "CONFIRMED" ? "stay" : "request"}
            </Button>
          ) : booking.status === "REQUESTED" && isExpired(booking.end) ? (
            <>
              <p className="px-1 text-sm text-muted">
                These dates have passed, so this can no longer be confirmed.
                Declining lets the guest know.
              </p>
              <Button
                variant="ghost"
                onClick={() => run(() => declineBooking(booking))}
              >
                Decline
              </Button>
            </>
          ) : booking.status === "REQUESTED" ? (
            <>
              <Button size="lg" disabled={busy} onClick={confirmStay}>
                Confirm booking
              </Button>
              <Button
                variant="ghost"
                onClick={() => run(() => declineBooking(booking))}
              >
                Decline
              </Button>
            </>
          ) : (
            <Button
              variant="danger"
              size="lg"
              onClick={() => run(() => declineBooking(booking))}
            >
              Cancel booking
            </Button>
          )}
        </div>
      ) : (
        <Button
          variant="ghost"
          onClick={() => run(() => clearFromList(booking))}
        >
          Clear from my list
        </Button>
      )}
    </div>
  );
}
