"use client";

import { type ReactElement, useMemo, useState } from "react";
import { LuChevronRight } from "react-icons/lu";
import { isExpired } from "../utils/format";
import {
  EMPTY_CRITERIA,
  hitsForSearches,
  type SearchCriteria,
  searchListings,
} from "../utils/search";
import { useKip } from "../utils/store";
import Avatar from "./avatar";
import BookingRow from "./booking-row";
import { useDialog } from "./dialog";
import PlaceCard from "./place-card";
import RequestCard from "./request-card";
import SavedSearchRow from "./saved-search-row";
import Button from "./ui/button";
import { Group, Row, Section } from "./ui/list";

const PREVIEW_COUNT = 4;
const FRIEND_PREVIEW = 4;
const REQUEST_PREVIEW = 5;
const COMING_UP_PREVIEW = 5;

// A pluralized "N thing" fragment, or null when the count is zero.
function countPhrase(count: number, noun: string): string | null {
  if (count <= 0) return null;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// The landing dashboard.
export default function HomeView(): ReactElement | null {
  const {
    user,
    profile,
    trips,
    incomingBookings,
    incomingRequests,
    friends,
    friendListings,
    friendWindows,
    savedSearches,
    setCriteria,
    markSearchSeen,
    deleteSavedSearch,
    setView,
    navigate,
  } = useKip();
  const { confirm } = useDialog();

  // Confirming an ask whose dates have gone would book a stay in the past, so
  // it stops needing attention rather than sitting there forever.
  const bookingRequests = incomingBookings.filter(
    (booking) => booking.status === "REQUESTED" && !isExpired(booking.end),
  );
  // Your own outstanding asks too — the status chip tells them apart.
  const upcomingStays = trips.filter(
    (trip) => trip.status !== "CANCELLED" && !isExpired(trip.end),
  );
  const confirmedTrips = upcomingStays.filter(
    (trip) => trip.status === "CONFIRMED",
  );
  const upcomingGuests = incomingBookings.filter(
    (booking) => booking.status === "CONFIRMED" && !isExpired(booking.end),
  );
  // Interleaved by date: capped at five, two runs would bury next week's guest
  // behind a trip six months out.
  const comingUp = [...upcomingStays, ...upcomingGuests].sort((left, right) =>
    left.start.localeCompare(right.start),
  );
  const available = useMemo(
    () => searchListings(friendListings, friendWindows, EMPTY_CRITERIA),
    [friendListings, friendWindows],
  );
  // Free: the browse set is already in memory, so these are array passes, not
  // reads. They're as of the last refresh, like everything else drawn from it.
  const searchHits = useMemo(
    () => hitsForSearches(savedSearches, friendListings, friendWindows),
    [savedSearches, friendListings, friendWindows],
  );

  // Opening one puts its results on screen, which is what "seen" means.
  function openSearch(searchId: string, criteria: SearchCriteria): void {
    setCriteria(criteria);
    markSearchSeen(searchId).catch((error) =>
      console.error("markSearchSeen", error),
    );
    setView("browse");
  }

  async function removeSearch(searchId: string, label: string): Promise<void> {
    const ok = await confirm({
      title: "Remove this search?",
      body: `"${label}" will stop appearing here. The places themselves aren't affected.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (ok) await deleteSavedSearch(searchId);
  }

  if (!user) {
    return null;
  }

  const hasAttention = bookingRequests.length + incomingRequests.length > 0;

  // The Auth copy is a fire-and-forget mirror, so reading it first greeted
  // "there" whenever that write lost.
  const firstName = (profile?.displayName || user.displayName || "there").split(
    " ",
  )[0];
  // Counted by name, so the line is a table of contents for the sections below
  // rather than a total to reconcile against them.
  const waiting = [
    countPhrase(bookingRequests.length, "stay request"),
    countPhrase(incomingRequests.length, "friend request"),
  ]
    .filter(Boolean)
    .join(" and ");
  const summary =
    [
      waiting ? `${waiting} waiting` : null,
      confirmedTrips.length > 0
        ? confirmedTrips.length === 1
          ? "a trip coming up"
          : `${confirmedTrips.length} trips coming up`
        : null,
    ]
      .filter(Boolean)
      .join(", plus ") || "You're all caught up.";

  return (
    <div className="flex flex-col gap-7">
      <VerifyEmailPrompt />

      <div>
        <h1 className="text-2xl font-extrabold tracking-[-0.03em] md:text-3xl">
          Welcome back, {firstName}
        </h1>
        <p className="mt-1 text-[0.9375rem] text-muted">
          {summary.endsWith(".") ? summary : `${summary}.`}
        </p>
      </div>

      <div className="flex flex-col gap-7 md:grid md:grid-cols-[minmax(0,1fr)_320px] md:items-start md:gap-8">
        <div className="flex min-w-0 flex-col gap-7">
          {/* Two asks, two sections: one hands over a set of dates, the other
              hands over everything you share from then on, and a single stack
              made the reader tell them apart by card shape. Stays lead because
              they're the dated ones — a request expires with its nights — and
              because the uncapped list has to sit above the capped one. */}
          {bookingRequests.length > 0 ? (
            <Section title="Stay requests">
              <Group>
                {bookingRequests.map((booking) => (
                  <BookingRow key={booking.id} booking={booking} />
                ))}
              </Group>
            </Section>
          ) : null}

          {/* Uncapped above, capped here: a friend request keeps until you answer
              it and Friends lists every one, whereas someone waiting on specific
              nights can't be sent elsewhere to be found. */}
          {incomingRequests.length > 0 ? (
            <Section
              title="Friend requests"
              action={
                incomingRequests.length > REQUEST_PREVIEW ? (
                  <button
                    type="button"
                    onClick={() => setView("friends")}
                    className="text-sm font-semibold text-accent-ink hover:opacity-80"
                  >
                    See all {incomingRequests.length}
                  </button>
                ) : null
              }
            >
              {incomingRequests.slice(0, REQUEST_PREVIEW).map((request) => (
                <RequestCard key={request.id} request={request} />
              ))}
            </Section>
          ) : null}

          {comingUp.length > 0 ? (
            <Section
              title="Coming up"
              action={
                comingUp.length > COMING_UP_PREVIEW ? (
                  <button
                    type="button"
                    onClick={() => setView("trips")}
                    className="text-sm font-semibold text-accent-ink hover:opacity-80"
                  >
                    See all upcoming
                  </button>
                ) : null
              }
            >
              <Group>
                {comingUp.slice(0, COMING_UP_PREVIEW).map((booking) => (
                  <BookingRow key={booking.id} booking={booking} />
                ))}
              </Group>
            </Section>
          ) : null}

          {/* Above the general list because it's the same thing narrowed to
              what you actually asked for. */}
          {searchHits.length > 0 ? (
            <Section title="Your searches">
              <Group>
                {searchHits.map((hit) => (
                  <SavedSearchRow
                    key={hit.search.id}
                    hits={hit}
                    onOpen={() =>
                      openSearch(hit.search.id, hit.search.criteria)
                    }
                    onRemove={() =>
                      removeSearch(hit.search.id, hit.search.label)
                    }
                  />
                ))}
              </Group>
            </Section>
          ) : null}

          <Section
            title="Open at friends' places"
            action={
              available.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setView("browse")}
                  className="text-sm font-semibold text-accent-ink hover:opacity-80"
                >
                  Browse all
                </button>
              ) : null
            }
          >
            {available.length === 0 ? (
              <p className="px-1 text-sm text-muted">
                {!hasAttention && comingUp.length === 0
                  ? "Nothing here yet. Add friends and browse the places they share."
                  : "No friends' places free right now."}
              </p>
            ) : (
              <div className="gap-3 md:columns-2">
                {available.slice(0, PREVIEW_COUNT).map((match) => (
                  <div
                    key={match.listing.id}
                    className="mb-3 break-inside-avoid"
                  >
                    <PlaceCard
                      listing={match.listing}
                      windows={match.windows}
                      distanceKm={match.distanceKm}
                    />
                  </div>
                ))}
              </div>
            )}
          </Section>

          {friends.length === 0 ? (
            <button
              type="button"
              onClick={() => setView("friends")}
              className="text-left text-sm font-semibold text-accent-ink hover:opacity-80"
            >
              Find your friends on kip →
            </button>
          ) : null}
        </div>

        <aside className="hidden flex-col gap-6 md:flex">
          {friends.length > 0 ? (
            <Section
              title="Friends"
              action={
                <button
                  type="button"
                  onClick={() => setView("friends")}
                  className="text-sm font-semibold text-accent-ink hover:opacity-80"
                >
                  All
                </button>
              }
            >
              <Group>
                {friends.slice(0, FRIEND_PREVIEW).map((friend) => (
                  <Row
                    key={friend.uid}
                    onClick={() => navigate({ kind: "person", id: friend.uid })}
                    ariaLabel={friend.displayName}
                  >
                    <Avatar
                      name={friend.displayName}
                      photoURL={friend.photoURL}
                      className="h-9 w-9 text-sm"
                    />
                    <span className="min-w-0 flex-1 truncate text-[0.9375rem] font-medium">
                      {friend.displayName}
                    </span>
                    <LuChevronRight className="shrink-0 text-faint" />
                  </Row>
                ))}
              </Group>
            </Section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

// An unverified account receives nothing at all, and the only explanation would
// otherwise sit in Settings, which they have no reason to visit.
function VerifyEmailPrompt(): ReactElement | null {
  const { user, email, emailVerified, resendVerification } = useKip();
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!user || emailVerified || !email) return null;

  async function resend(): Promise<void> {
    setFailed(false);
    try {
      await resendVerification();
      setSent(true);
    } catch (error) {
      console.error(error);
      setFailed(true);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-3xl bg-surface p-4 shadow-card sm:flex-row sm:items-center">
      <p className="min-w-0 flex-1 text-sm text-muted">
        {sent
          ? `Confirmation sent to ${email}. Open it, then reload kip.`
          : `Confirm ${email} to get notified about bookings — until you do, kip can't email you.`}
      </p>
      {sent ? null : (
        <Button variant="secondary" onClick={resend} className="shrink-0">
          {failed ? "Try again" : "Confirm email"}
        </Button>
      )}
    </div>
  );
}
