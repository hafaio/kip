"use client";

import type { ReactElement } from "react";
import { LuMapPin, LuZap } from "react-icons/lu";
import { formatDateRange, isExpired } from "../utils/format";
import { listingTypeLabel } from "../utils/listings";
import { useKip } from "../utils/store";
import type { AvailabilityWindow, Listing } from "../utils/types";
import Avatar from "./avatar";
import CoverPhoto from "./cover-photo";
import Chip from "./ui/chip";

// A result card for a friend's place: the host featured up top (gradient ring),
// a type chip, the bold title, a location/distance line, and a footer teasing
// open windows with an Instant chip. The whole card taps through to the room
// page; a nested host button (above a full-bleed overlay) taps to the host's
// person page instead.
export default function PlaceCard({
  listing,
  windows,
  distanceKm,
  showHost = true,
}: {
  listing: Listing;
  windows: readonly AvailabilityWindow[];
  distanceKm?: number | null;
  showHost?: boolean;
}): ReactElement {
  const { user, friends, navigate } = useKip();
  const host = friends.find((friend) => friend.uid === listing.ownerId);
  const isMine = listing.ownerId === user?.uid;

  const open = windows
    .filter((window) => window.status === "OPEN" && !isExpired(window.end))
    .sort((left, right) => left.start.localeCompare(right.start));
  const hasInstant = open.some((window) => window.autoAccept);

  return (
    <article className="relative rounded-3xl bg-surface p-4 shadow-card transition hover:shadow-panel">
      <button
        type="button"
        aria-label={listing.title}
        onClick={() => navigate({ kind: "room", id: listing.id })}
        className="absolute inset-0 rounded-3xl"
      />
      <div className="pointer-events-none relative flex flex-col gap-2.5">
        {/* Just the cover here: the whole card is one tap target for the room,
            so anything browsable inside it would be a button fighting that. */}
        <CoverPhoto photo={listing.photos[0]} className="h-40 w-full" />
        <div className="flex items-center gap-2.5">
          {showHost && host && !isMine ? (
            <button
              type="button"
              onClick={() => navigate({ kind: "person", id: host.uid })}
              className="pointer-events-auto -m-1 flex min-w-0 items-center gap-2.5 rounded-2xl p-1 text-left"
            >
              <Avatar
                name={host.displayName}
                photoURL={host.photoURL}
                className="h-9 w-9 text-sm"
                ring
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold">
                  {host.displayName}
                </span>
                <span className="block text-xs text-muted">
                  Hosting · your friend
                </span>
              </span>
            </button>
          ) : null}
          <Chip tone="type" className="ml-auto">
            {listingTypeLabel(listing.type)}
          </Chip>
        </div>

        <h3 className="text-lg font-bold tracking-[-0.02em]">
          {listing.title}
        </h3>

        <p className="flex items-center gap-1.5 text-sm text-muted">
          <LuMapPin size={14} className="shrink-0" />
          <span className="truncate">{listing.location.label}</span>
          {typeof distanceKm === "number" ? (
            <span className="shrink-0">· {Math.round(distanceKm)} km</span>
          ) : null}
        </p>

        <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-border pt-3">
          {open.length === 0 ? (
            <span className="text-sm text-muted">No open dates right now</span>
          ) : (
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-bold">
                {open.length} open {open.length === 1 ? "window" : "windows"}
              </span>
              <span className="truncate text-xs text-muted">
                next {formatDateRange(open[0].start, open[0].end)}
              </span>
            </span>
          )}
          {hasInstant ? (
            <Chip tone="instant" icon={<LuZap size={12} />}>
              Instant
            </Chip>
          ) : null}
        </div>
      </div>
    </article>
  );
}
