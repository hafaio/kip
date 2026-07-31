"use client";

import type { ReactElement } from "react";
import { LuChevronRight, LuPlus } from "react-icons/lu";
import { todayIso } from "../utils/format";
import { listingTypeIcon, listingTypeLabel } from "../utils/listings";
import { useKip } from "../utils/store";
import type { Listing } from "../utils/types";
import BookingRow from "./booking-row";
import CoverPhoto from "./cover-photo";
import Button from "./ui/button";
import Chip from "./ui/chip";
import { Group, Row, Section } from "./ui/list";

function ListingRow({ listing }: { listing: Listing }): ReactElement {
  const { myWindows, incomingBookings, navigate } = useKip();
  const windows = myWindows[listing.id] ?? [];
  const open = windows.filter((window) => window.status === "OPEN").length;
  const booked = windows.filter((window) => window.status === "BOOKED").length;
  // The same boundary the list below uses: an ask for dates that have gone can
  // never be confirmed, so counting it here would promise a request the section
  // no longer holds.
  const today = todayIso();
  const pending = incomingBookings.filter(
    (booking) =>
      booking.listingId === listing.id &&
      booking.status === "REQUESTED" &&
      booking.end >= today,
  ).length;

  const meta = [
    listingTypeLabel(listing.type),
    `${open} open`,
    booked > 0 ? `${booked} booked` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const TypeIcon = listingTypeIcon(listing.type);
  return (
    <Row
      onClick={() => navigate({ kind: "room", id: listing.id })}
      ariaLabel={listing.title}
    >
      {/* A place you'd recognise on sight beats a bed icon, so the cover takes
          the leading slot when there is one. Same 40px square either way — the
          row keeps its rhythm whether or not a place has photos. */}
      <CoverPhoto
        photo={listing.photos[0]}
        className="h-10 w-10 shrink-0"
        fallback={
          <span className="bg-accent-soft grid h-10 w-10 shrink-0 place-items-center rounded-full text-accent-ink">
            <TypeIcon size={18} />
          </span>
        }
      />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[0.9375rem] font-semibold">
          {listing.title}
        </span>
        <span className="block truncate text-sm text-muted">{meta}</span>
      </div>
      {pending > 0 ? (
        <Chip tone="pending">
          {pending} {pending === 1 ? "request" : "requests"}
        </Chip>
      ) : null}
      <LuChevronRight className="shrink-0 text-faint" />
    </Row>
  );
}

export default function PlacesView(): ReactElement {
  const { user, myListings, incomingBookings, navigate } = useKip();

  if (!user) {
    return <p className="text-muted">Sign in to list a room or your place.</p>;
  }

  // Places is the host's side of kip, so it carries the two things that happen
  // TO your places: someone waiting on an answer, and someone arriving. Home
  // shows these too, mixed in with your own trips and connect requests — it's the
  // digest you land on. This is the tab that owns places, and an ask about one of
  // them had no route from here at all; a per-place count on the row above says
  // which place, and these say who and when.
  const today = todayIso();
  const pendingAsks = incomingBookings
    .filter((booking) => booking.status === "REQUESTED" && booking.end >= today)
    .sort((left, right) => left.start.localeCompare(right.start));
  const upcomingGuests = incomingBookings
    .filter((booking) => booking.status === "CONFIRMED" && booking.end >= today)
    .sort((left, right) => left.start.localeCompare(right.start));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-7">
      <Section
        title="My places"
        action={
          myListings.length > 0 ? (
            <button
              type="button"
              onClick={() => navigate({ kind: "listing-form", id: null })}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent-ink hover:opacity-80"
            >
              <LuPlus className="text-xs" />
              Add place
            </button>
          ) : null
        }
      >
        {myListings.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-3xl bg-surface p-5 shadow-card">
            <p className="text-sm text-muted">
              You haven't listed anything yet. Add a room you're not using or
              your whole place while you're away.
            </p>
            <Button
              onClick={() => navigate({ kind: "listing-form", id: null })}
            >
              <LuPlus />
              Add place
            </Button>
          </div>
        ) : (
          <Group>
            {myListings.map((listing) => (
              <ListingRow key={listing.id} listing={listing} />
            ))}
          </Group>
        )}
      </Section>

      {pendingAsks.length > 0 ? (
        <Section title="Asking to stay">
          <Group>
            {pendingAsks.map((booking) => (
              <BookingRow key={booking.id} booking={booking} />
            ))}
          </Group>
        </Section>
      ) : null}

      {upcomingGuests.length > 0 ? (
        <Section title="Upcoming guests">
          <Group>
            {upcomingGuests.map((booking) => (
              <BookingRow key={booking.id} booking={booking} />
            ))}
          </Group>
        </Section>
      ) : null}
    </div>
  );
}
