"use client";

import { distanceBetween } from "geofire-common";
import { isExpired } from "./format";
import type { AvailabilityWindow, Listing, ListingType } from "./types";

export type SearchCriteria = {
  // ISO calendar dates; a window matches if it fully covers [start, end).
  readonly start: string | null;
  readonly end: string | null;
  readonly near: { readonly lat: number; readonly lng: number } | null;
  // Display only; kept so the resolved location survives navigation.
  readonly nearLabel: string | null;
  readonly radiusKm: number;
  readonly type: ListingType | null;
};

export const EMPTY_CRITERIA: SearchCriteria = {
  start: null,
  end: null,
  near: null,
  nearLabel: null,
  radiusKm: 50,
  type: null,
};

export type ListingMatch = {
  readonly listing: Listing;
  readonly windows: readonly AvailabilityWindow[];
  readonly distanceKm: number | null;
};

// A missing bound is NOT a wildcard: a start-only search must still find a window
// open ON that date, not one that ended before it.
function windowMatchesDates(
  window: AvailabilityWindow,
  start: string | null,
  end: string | null,
): boolean {
  if (window.status !== "OPEN") return false;
  // Nothing else ages a window out — `status` only ever says OPEN or BOOKED.
  if (isExpired(window.end)) return false;
  if (start && !(window.start <= start && start < window.end)) return false;
  if (end && !(window.start < end && end <= window.end)) return false;
  return true;
}

// Each listing with the windows that matched, and its distance if searching near.
export function searchListings(
  listings: readonly Listing[],
  windowsByListing: Readonly<Record<string, readonly AvailabilityWindow[]>>,
  criteria: SearchCriteria,
): ListingMatch[] {
  const matches: ListingMatch[] = [];
  for (const listing of listings) {
    if (criteria.type && listing.type !== criteria.type) continue;

    let distanceKm: number | null = null;
    if (criteria.near) {
      // Unplaced listings drop out rather than matching from (0, 0).
      if (!listing.location.lat && !listing.location.lng) continue;
      distanceKm = distanceBetween(
        [listing.location.lat, listing.location.lng],
        [criteria.near.lat, criteria.near.lng],
      );
      if (distanceKm > criteria.radiusKm) continue;
    }

    const windows = (windowsByListing[listing.id] ?? [])
      .filter((window) =>
        windowMatchesDates(window, criteria.start, criteria.end),
      )
      .sort((left, right) => left.start.localeCompare(right.start));
    if (windows.length === 0) continue;

    matches.push({ listing, windows, distanceKm });
  }

  // Windows are sorted ascending, so windows[0] is a listing's earliest.
  matches.sort((left, right) => {
    if (left.distanceKm !== null && right.distanceKm !== null) {
      return left.distanceKm - right.distanceKm;
    }
    return left.windows[0].start.localeCompare(right.windows[0].start);
  });
  return matches;
}
