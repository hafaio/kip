"use client";

import { type ReactElement, useMemo, useState } from "react";
import {
  LuLocateFixed,
  LuMapPin,
  LuRotateCw,
  LuSlidersHorizontal,
  LuX,
} from "react-icons/lu";
import { todayIso } from "../utils/format";
import { geocodeAddress } from "../utils/geocode";
import {
  describeCriteria,
  EMPTY_CRITERIA,
  type SearchCriteria,
  searchListings,
} from "../utils/search";
import { useKip } from "../utils/store";
import type { ListingType } from "../utils/types";
import PlaceCard from "./place-card";
import SavedSearches from "./saved-searches";
import Button from "./ui/button";
import IconButton from "./ui/icon-button";
import Segmented from "./ui/segmented";
import Sheet from "./ui/sheet";

const RADII = [10, 25, 50, 100, 250] as const;

const FIELD =
  "h-11 w-full rounded-xl border border-border bg-surface px-3.5 text-base outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20";

export default function BrowseView(): ReactElement | null {
  const {
    user,
    friends,
    friendListings,
    friendWindows,
    criteria,
    setCriteria,
    refreshBrowse,
  } = useKip();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const matches = useMemo(
    () => searchListings(friendListings, friendWindows, criteria),
    [friendListings, friendWindows, criteria],
  );

  async function refresh(): Promise<void> {
    setRefreshing(true);
    try {
      await refreshBrowse();
    } finally {
      setRefreshing(false);
    }
  }

  if (!user) return null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setFiltersOpen(true)}
          className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full bg-surface px-4 text-left text-sm font-medium shadow-soft transition hover:shadow-card"
        >
          <LuSlidersHorizontal className="shrink-0 text-accent-ink" />
          <span className="truncate">{describeCriteria(criteria)}</span>
        </button>
        <IconButton label="Refresh" variant="surface" onClick={refresh}>
          <LuRotateCw className={refreshing ? "animate-spin" : ""} />
        </IconButton>
      </div>

      {friends.length === 0 ? (
        <p className="px-1 text-sm text-muted">
          Add some friends first — when they share a place, you'll see it here.
        </p>
      ) : matches.length === 0 ? (
        <p className="px-1 text-sm text-muted">
          {criteria.near
            ? "No friends' places match — try a wider radius or dates."
            : "No friends' places free right now. Try widening your dates."}
        </p>
      ) : (
        <div className="gap-3 md:columns-2 lg:columns-3">
          {matches.map((match) => (
            <div key={match.listing.id} className="mb-3 break-inside-avoid">
              <PlaceCard
                listing={match.listing}
                windows={match.windows}
                distanceKm={match.distanceKm}
              />
            </div>
          ))}
        </div>
      )}

      <FilterSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        criteria={criteria}
        setCriteria={setCriteria}
        resultCount={matches.length}
      />
    </div>
  );
}

function FilterSheet({
  open,
  onClose,
  criteria,
  setCriteria,
  resultCount,
}: {
  open: boolean;
  onClose: () => void;
  criteria: SearchCriteria;
  setCriteria: (criteria: SearchCriteria) => void;
  resultCount: number;
}): ReactElement {
  const [nearText, setNearText] = useState("");
  const [locating, setLocating] = useState(false);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);

  function update(partial: Partial<SearchCriteria>): void {
    setCriteria({ ...criteria, ...partial });
  }

  async function findLocation(): Promise<void> {
    const queryText = nearText.trim();
    if (!queryText) return;
    setLocating(true);
    setGeoMsg(null);
    const hit = await geocodeAddress(queryText);
    setLocating(false);
    if (!hit) {
      setGeoMsg("Couldn't find that place — try a city or postcode.");
      return;
    }
    update({ near: { lat: hit.lat, lng: hit.lng }, nearLabel: hit.label });
    setNearText("");
  }

  function useMyLocation(): void {
    if (!navigator.geolocation) {
      setGeoMsg("Location isn't available in this browser.");
      return;
    }
    setLocating(true);
    setGeoMsg(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        update({
          near: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          },
          nearLabel: "Your location",
        });
        setNearText("");
      },
      (error) => {
        setLocating(false);
        setGeoMsg("Couldn't get your location.");
        console.error(error);
      },
      { timeout: 10000 },
    );
  }

  function clearLocation(): void {
    update({ near: null, nearLabel: null });
    setNearText("");
    setGeoMsg(null);
  }

  return (
    <Sheet open={open} onClose={onClose} title="Filters">
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            From
            <input
              type="date"
              className={FIELD}
              min={todayIso()}
              value={criteria.start ?? ""}
              onChange={(event) =>
                update({ start: event.target.value || null })
              }
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            To
            <input
              type="date"
              className={FIELD}
              min={criteria.start ?? todayIso()}
              value={criteria.end ?? ""}
              onChange={(event) => update({ end: event.target.value || null })}
            />
          </label>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-muted">Type</span>
          <Segmented
            ariaLabel="Place type"
            value={criteria.type ?? "ANY"}
            onChange={(value) =>
              update({ type: value === "ANY" ? null : (value as ListingType) })
            }
            options={[
              { value: "ANY", label: "Any" },
              { value: "ROOM", label: "Room" },
              { value: "FLAT", label: "Flat" },
              { value: "HOUSE", label: "House" },
            ]}
          />
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm text-muted">Location</span>
          {criteria.near ? (
            <div className="flex items-center gap-2">
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
                <LuMapPin className="shrink-0 text-accent-ink" />
                <span className="truncate">
                  {criteria.nearLabel ?? "Nearby"}
                </span>
              </span>
              <select
                className="h-11 shrink-0 rounded-xl border border-border bg-surface px-2 text-base outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                value={criteria.radiusKm}
                onChange={(event) =>
                  update({ radiusKm: Number(event.target.value) })
                }
              >
                {RADII.map((km) => (
                  <option key={km} value={km}>
                    {km} km
                  </option>
                ))}
              </select>
              <IconButton
                label="Clear location"
                variant="danger"
                onClick={clearLocation}
              >
                <LuX />
              </IconButton>
            </div>
          ) : (
            <>
              <input
                className={FIELD}
                placeholder="City, address, or area"
                value={nearText}
                onChange={(event) => setNearText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    findLocation();
                  }
                }}
              />
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={findLocation}
                  disabled={!nearText.trim() || locating}
                  className="flex-1"
                >
                  <LuMapPin />
                  Find
                </Button>
                <Button
                  variant="secondary"
                  onClick={useMyLocation}
                  disabled={locating}
                  className="flex-1"
                >
                  <LuLocateFixed />
                  My location
                </Button>
              </div>
            </>
          )}
          {geoMsg ? <p className="text-sm text-danger">{geoMsg}</p> : null}
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button
            variant="ghost"
            onClick={() => setCriteria(EMPTY_CRITERIA)}
            className="shrink-0"
          >
            Clear all
          </Button>
          <Button size="lg" onClick={onClose} className="flex-1">
            {resultCount === 1 ? "Show 1 place" : `Show ${resultCount} places`}
          </Button>
        </div>

        {/* Below the footer, not above it: picking a saved search is the rarer
            reason to be here, and the primary action must stay reachable
            without scrolling past a list. */}
        <SavedSearches
          criteria={criteria}
          setCriteria={setCriteria}
          onApply={onClose}
        />
      </div>
    </Sheet>
  );
}
