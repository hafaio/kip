"use client";

import type { ReactElement } from "react";
import { isExpired } from "../utils/format";
import { useKip } from "../utils/store";
import BookingRow from "./booking-row";
import { useAction, useDialog } from "./dialog";
import { Group, Section } from "./ui/list";

export default function TripsView(): ReactElement {
  const { user, trips, hideCancelledTrips } = useKip();
  const run = useAction();
  const { confirm } = useDialog();

  // Clearing is per-party: these rows go from THIS list, and each host's own
  // record of the cancellation is untouched.
  async function clearCancelled(): Promise<void> {
    const agreed = await confirm({
      title: "Clear cancelled trips?",
      body: "They disappear from your list. Each host still has their copy — nothing is deleted.",
      confirmLabel: "Clear all",
    });
    if (!agreed) return;
    await hideCancelledTrips();
  }

  if (!user) {
    return <p className="text-muted">Sign in to see your trips.</p>;
  }

  const upcoming = trips
    .filter((trip) => trip.status !== "CANCELLED" && !isExpired(trip.end))
    .sort((left, right) => left.start.localeCompare(right.start));
  const past = trips
    .filter((trip) => trip.status !== "CANCELLED" && isExpired(trip.end))
    .sort((left, right) => right.start.localeCompare(left.start));
  // Cancelled stays get their own section rather than being folded into Past:
  // most of them are still in the future, and filing next month's called-off trip
  // under "Past" reads as a mistake. They can't sit under Upcoming either — they
  // aren't coming — and this is the only route in to who cancelled and why.
  const cancelled = trips
    .filter((trip) => trip.status === "CANCELLED")
    .sort((left, right) => right.start.localeCompare(left.start));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-7">
      <Section title="Upcoming">
        {upcoming.length === 0 ? (
          <p className="px-1 text-sm text-muted">
            No upcoming trips. Find a place in Browse and request some dates.
          </p>
        ) : (
          <Group>
            {upcoming.map((trip) => (
              <BookingRow key={trip.id} booking={trip} />
            ))}
          </Group>
        )}
      </Section>

      {past.length > 0 ? (
        <Section title="Past">
          <Group className="opacity-70">
            {past.map((trip) => (
              <BookingRow key={trip.id} booking={trip} />
            ))}
          </Group>
        </Section>
      ) : null}

      {cancelled.length > 0 ? (
        <Section
          title="Cancelled"
          action={
            <button
              type="button"
              onClick={() => run(clearCancelled)}
              className="text-sm font-semibold text-accent-ink hover:opacity-80"
            >
              Clear all
            </button>
          }
        >
          <Group className="opacity-70">
            {cancelled.map((trip) => (
              <BookingRow key={trip.id} booking={trip} />
            ))}
          </Group>
        </Section>
      ) : null}
    </div>
  );
}
