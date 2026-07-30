import { describe, expect, test } from "bun:test";
import {
  countNewSince,
  describeCriteria,
  EMPTY_CRITERIA,
  hitsForSearches,
  type SavedSearch,
  type SearchCriteria,
  sameCriteria,
  searchListings,
} from "../utils/search";
import type { AvailabilityWindow, Listing } from "../utils/types";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

// Far enough out that these never age past `isExpired` as the calendar moves.
function isoIn(days: number): string {
  return new Date(NOW + days * DAY).toISOString().slice(0, 10);
}

function listing(id: string, extra: Partial<Listing> = {}): Listing {
  return {
    id,
    ownerId: "owner",
    title: id,
    type: "ROOM",
    description: "",
    location: { label: "", lat: 0, lng: 0, geohash: "" },
    photos: [],
    publicPortalId: null,
    createdAt: 0,
    ...extra,
  };
}

function slot(
  id: string,
  from: number,
  to: number,
  createdAt: number,
): AvailabilityWindow {
  return {
    id,
    listingId: "a",
    start: isoIn(from),
    end: isoIn(to),
    status: "OPEN",
    autoAccept: false,
    details: "",
    bookedBy: null,
    publicPortalId: null,
    createdAt,
  };
}

function saved(criteria: SearchCriteria, lastSeenAt: number): SavedSearch {
  return { id: "s", label: "s", criteria, lastSeenAt, createdAt: 0 };
}

describe("countNewSince", () => {
  const listings = [listing("a")];

  test("counts slots added after the mark, not places", () => {
    const windows = {
      a: [
        slot("w1", 10, 14, NOW - 5 * DAY),
        slot("w2", 20, 24, NOW + 5 * DAY),
        slot("w3", 30, 34, NOW + 6 * DAY),
      ],
    };
    const matches = searchListings(listings, windows, EMPTY_CRITERIA);
    expect(matches).toHaveLength(1);
    expect(countNewSince(matches, NOW)).toBe(2);
  });

  test("a window written before createdAt existed is never new", () => {
    const windows = { a: [slot("w1", 10, 14, 0)] };
    const matches = searchListings(listings, windows, EMPTY_CRITERIA);
    expect(countNewSince(matches, 0)).toBe(0);
  });

  test("only slots the search actually matches count", () => {
    const windows = {
      a: [slot("w1", 10, 14, NOW + DAY), slot("w2", 200, 204, NOW + DAY)],
    };
    const matches = searchListings(listings, windows, {
      ...EMPTY_CRITERIA,
      start: isoIn(11),
      end: isoIn(13),
    });
    expect(countNewSince(matches, NOW)).toBe(1);
  });
});

describe("hitsForSearches", () => {
  test("reports places and fresh slots per search", () => {
    const listings = [listing("a"), listing("b", { type: "HOUSE" })];
    const windows = {
      a: [slot("w1", 10, 14, NOW + DAY)],
      b: [slot("w2", 10, 14, NOW - DAY)],
    };
    const [any, houses] = hitsForSearches(
      [
        saved(EMPTY_CRITERIA, NOW),
        saved({ ...EMPTY_CRITERIA, type: "HOUSE" }, NOW),
      ],
      listings,
      windows,
    );
    expect(any.places).toBe(2);
    expect(any.fresh).toBe(1);
    expect(houses.places).toBe(1);
    // The house's slot predates the mark, so it's a hit but not news.
    expect(houses.fresh).toBe(0);
  });

  test("a search matching nothing reports zeroes rather than dropping out", () => {
    const hits = hitsForSearches([saved(EMPTY_CRITERIA, NOW)], [], {});
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ places: 0, fresh: 0 });
  });
});

describe("describeCriteria", () => {
  test("names the empty search rather than returning nothing", () => {
    expect(describeCriteria(EMPTY_CRITERIA)).toBe("Any dates");
  });

  test("carries type and place, and radius only alongside a location", () => {
    expect(
      describeCriteria({
        ...EMPTY_CRITERIA,
        type: "FLAT",
        near: { lat: 1, lng: 2 },
        nearLabel: "Lisbon",
        radiusKm: 25,
      }),
    ).toBe("Any dates · Flat · Lisbon · 25 km");
    expect(describeCriteria({ ...EMPTY_CRITERIA, radiusKm: 25 })).toBe(
      "Any dates",
    );
  });

  test("distinguishes an open-ended range from a closed one", () => {
    const from = describeCriteria({ ...EMPTY_CRITERIA, start: "2027-03-01" });
    const until = describeCriteria({ ...EMPTY_CRITERIA, end: "2027-03-05" });
    expect(from.startsWith("From ")).toBe(true);
    expect(until.startsWith("Until ")).toBe(true);
    expect(
      describeCriteria({
        ...EMPTY_CRITERIA,
        start: "2027-03-01",
        end: "2027-03-05",
      }),
    ).toContain("–");
  });
});

describe("sameCriteria", () => {
  const lisbon = { lat: 38.7223, lng: -9.1393 };

  test("the empty search equals itself, so it can't be saved twice", () => {
    expect(sameCriteria(EMPTY_CRITERIA, { ...EMPTY_CRITERIA })).toBe(true);
  });

  test("any differing field makes it a different search", () => {
    const base = { ...EMPTY_CRITERIA, start: "2027-05-10" };
    expect(sameCriteria(base, { ...base, start: "2027-05-11" })).toBe(false);
    expect(sameCriteria(base, { ...base, end: "2027-05-14" })).toBe(false);
    expect(sameCriteria(base, { ...base, type: "HOUSE" })).toBe(false);
    expect(sameCriteria(base, { ...base, near: lisbon })).toBe(false);
  });

  test("the same place geocoded twice is the same search", () => {
    const near = { ...EMPTY_CRITERIA, near: lisbon };
    // Same spot to four decimal places (~10m) but not bit-identical.
    const again = {
      ...EMPTY_CRITERIA,
      near: { lat: 38.72231, lng: -9.13929 },
      nearLabel: "Lisboa",
    };
    expect(sameCriteria(near, again)).toBe(true);
    expect(
      sameCriteria(near, { ...EMPTY_CRITERIA, near: { lat: 40.4, lng: -3.7 } }),
    ).toBe(false);
  });

  test("radius only separates two searches that name a place", () => {
    const here = { ...EMPTY_CRITERIA, near: lisbon };
    expect(sameCriteria(here, { ...here, radiusKm: 100 })).toBe(false);
    // Without a location the radius does nothing, so it can't make them differ.
    expect(
      sameCriteria(EMPTY_CRITERIA, { ...EMPTY_CRITERIA, radiusKm: 100 }),
    ).toBe(true);
  });

  test("the label isn't part of what makes a search distinct", () => {
    expect(
      sameCriteria({ ...EMPTY_CRITERIA, nearLabel: "x" }, EMPTY_CRITERIA),
    ).toBe(true);
  });
});
