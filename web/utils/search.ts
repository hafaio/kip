"use client";

import { distanceBetween } from "geofire-common";
import { isExpired } from "./format";
import type { AvailabilityWindow, Listing, ListingType } from "./types";

export type SearchCriteria = {
  // ISO calendar dates; a window matches if it fully covers [start, end).
  readonly start: string | null;
  readonly end: string | null;
  readonly near: { readonly lat: number; readonly lng: number } | null;
  // Display-only human label for `near` (e.g. "Brooklyn, NY"); ignored by
  // matching, kept so the resolved location survives navigation.
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

// A window covers the requested stay if it's open and its range contains the
// whole [start, end) interval. A missing bound is NOT a wildcard that matches any
// window: a start-only search must find a window actually open ON that date (not
// one that already ended before it), and symmetrically an end-only search must
// find one still open THROUGH that checkout. With neither, any open window counts.
function windowMatchesDates(
  window: AvailabilityWindow,
  start: string | null,
  end: string | null,
): boolean {
  if (window.status !== "OPEN") return false;
  // Dates that have been and gone aren't availability. Without this a slot from
  // last year stays bookable forever, because nothing else ages a window out.
  if (isExpired(window.end)) return false;
  if (start && !(window.start <= start && start < window.end)) return false;
  if (end && !(window.start < end && end <= window.end)) return false;
  return true;
}

// Filter friends' listings by the criteria, returning each listing with the
// subset of windows that match and its distance from the search point (if any).
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
      // A listing with no resolved coordinates can't be placed, so it drops out
      // of a location search rather than matching from (0, 0).
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

  // Nearest first when searching by location; otherwise soonest available first
  // (each listing's windows are sorted ascending, so windows[0] is its earliest).
  matches.sort((left, right) => {
    if (left.distanceKm !== null && right.distanceKm !== null) {
      return left.distanceKm - right.distanceKm;
    }
    return left.windows[0].start.localeCompare(right.windows[0].start);
  });
  return matches;
}
