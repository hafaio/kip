"use client";

import { distanceBetween } from "geofire-common";
import { formatDate, isExpired } from "./format";
import { listingTypeLabel } from "./listings";
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

// Lives here rather than in `types.ts` because it wraps `SearchCriteria`, and
// `search.ts` already imports from there.
export type SavedSearch = {
  readonly id: string;
  readonly label: string;
  readonly criteria: SearchCriteria;
  // When its results were last looked at, which is what "new" is measured from.
  readonly lastSeenAt: number;
  readonly createdAt: number;
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

// Slots, not places: two new sets of dates at one friend's flat is two pieces of
// news. Windows predating `createdAt` carry 0 and so are never counted.
export function countNewSince(
  matches: readonly ListingMatch[],
  since: number,
): number {
  let count = 0;
  for (const match of matches) {
    for (const window of match.windows) {
      if (window.createdAt > since) count += 1;
    }
  }
  return count;
}

// Doubles as the default name for a saved search, so it reads as a phrase
// someone would have typed rather than a filter dump.
export function describeCriteria(criteria: SearchCriteria): string {
  const parts: string[] = [];
  if (criteria.start && criteria.end) {
    parts.push(`${formatDate(criteria.start)} – ${formatDate(criteria.end)}`);
  } else if (criteria.start) {
    parts.push(`From ${formatDate(criteria.start)}`);
  } else if (criteria.end) {
    parts.push(`Until ${formatDate(criteria.end)}`);
  } else {
    parts.push("Any dates");
  }
  if (criteria.type) parts.push(listingTypeLabel(criteria.type));
  if (criteria.near) {
    parts.push(criteria.nearLabel ?? "Nearby");
    parts.push(`${criteria.radiusKm} km`);
  }
  return parts.join(" · ");
}

// Field-by-field rather than JSON, since key order isn't guaranteed and the
// coordinates want a tolerance — "Lisbon" geocoded twice is the same search.
export function sameCriteria(
  left: SearchCriteria,
  right: SearchCriteria,
): boolean {
  const near =
    left.near === null || right.near === null
      ? left.near === right.near
      : Math.abs(left.near.lat - right.near.lat) < 1e-4 &&
        Math.abs(left.near.lng - right.near.lng) < 1e-4;
  return (
    left.start === right.start &&
    left.end === right.end &&
    left.type === right.type &&
    near &&
    // Radius only distinguishes two searches that are actually somewhere.
    (left.near === null || left.radiusKm === right.radiusKm)
  );
}

export type SavedSearchHits = {
  readonly search: SavedSearch;
  readonly places: number;
  readonly fresh: number;
};

// One pass per saved search over the already-loaded browse set — no reads. Home
// and the filter sheet both render from this, so a count can't differ by screen.
export function hitsForSearches(
  searches: readonly SavedSearch[],
  listings: readonly Listing[],
  windowsByListing: Readonly<Record<string, readonly AvailabilityWindow[]>>,
): SavedSearchHits[] {
  return searches.map((search) => {
    const matches = searchListings(listings, windowsByListing, search.criteria);
    return {
      search,
      places: matches.length,
      fresh: countNewSince(matches, search.lastSeenAt),
    };
  });
}
