"use client";

import { type ReactElement, useEffect, useMemo, useState } from "react";
import { LuChevronRight, LuMapPin, LuPlus, LuZap } from "react-icons/lu";
import { fetchBookingIfVisible } from "../utils/bookings";
import { formatDateRange, isExpired, nights, todayIso } from "../utils/format";
import { fetchRoom, findOverlap, listingTypeLabel } from "../utils/listings";
import { useKip } from "../utils/store";
import type { AvailabilityWindow, Booking, Listing } from "../utils/types";
import Avatar from "./avatar";
import BookingRow from "./booking-row";
import CoverPhoto, { PhotoGallery } from "./cover-photo";
import { useAction, useDialog } from "./dialog";
import PhotoStrip from "./photo-strip";
import ShareLink from "./share-link";
import SlotRow from "./slot-row";
import Button from "./ui/button";
import Chip from "./ui/chip";
import FieldNote from "./ui/field-note";
import { Group, Row, Section } from "./ui/list";
import Sheet from "./ui/sheet";
import Switch from "./ui/switch";

const FIELD =
  "h-11 w-full rounded-xl border border-border bg-surface px-3.5 text-base outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20";

// The single place surface: owner console, or the bookable friend view.
export default function RoomPage({ id }: { id: string }): ReactElement {
  const { user, myListings, friendListings, tripListings, friendWindows } =
    useKip();
  const [fetched, setFetched] = useState<{
    listing: Listing;
    windows: readonly AvailabilityWindow[];
  } | null>(null);
  const [looked, setLooked] = useState(false);

  // A guest pointer opens the place and not its calendar, so dates come back
  // empty for a stay at a non-friend's.
  const loaded =
    myListings.find((listing) => listing.id === id) ??
    friendListings.find((listing) => listing.id === id) ??
    tripListings.find((listing) => listing.id === id);
  const haveLoaded = loaded !== undefined;

  // Arriving straight here finds nothing loaded, so ask for THIS place rather
  // than every friend's — and don't call it missing until the answer is in.
  useEffect(() => {
    if (haveLoaded) return;
    let live = true;
    setLooked(false);
    fetchRoom(id)
      .then((room) => {
        if (live) setFetched(room);
      })
      .catch((error) => console.error("fetchRoom", error))
      .finally(() => {
        if (live) setLooked(true);
      });
    return () => {
      live = false;
    };
  }, [id, haveLoaded]);

  // The state outlives a move to another room, so only this room's fetch counts.
  const local = fetched?.listing.id === id ? fetched : null;
  const room = loaded ?? local?.listing;
  if (!room) {
    return looked ? (
      <p className="text-muted">This place isn't available right now.</p>
    ) : (
      <p className="text-muted">Loading…</p>
    );
  }

  const isMine = room.ownerId === user?.uid;
  return isMine ? (
    <OwnerView listing={room} />
  ) : (
    <FriendView
      listing={room}
      windows={friendWindows[id] ?? local?.windows ?? []}
    />
  );
}

// `thumbnails` is the one difference between the views: the owner already has a
// rail further down that reorders, so a second one would mean two things at once.
function DetailBlock({
  listing,
  thumbnails,
}: {
  listing: Listing;
  thumbnails: boolean;
}): ReactElement {
  return (
    <div className="flex flex-col gap-3">
      <PhotoGallery
        photos={listing.photos}
        thumbnails={thumbnails}
        heroClassName="aspect-[3/2] max-h-[26rem] w-full sm:aspect-[16/9]"
      />
      <h2 className="text-2xl font-extrabold tracking-[-0.03em]">
        {listing.title}
      </h2>
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <Chip tone="type">{listingTypeLabel(listing.type)}</Chip>
        <span className="flex min-w-0 items-center gap-1.5">
          <LuMapPin size={14} className="shrink-0" />
          <span className="truncate">{listing.location.label}</span>
        </span>
      </div>
      {listing.description ? (
        <p className="text-[0.9375rem] leading-relaxed text-text/90">
          {listing.description}
        </p>
      ) : null}
    </div>
  );
}

// One read per taken slot, never a query: a query returning even one unreadable
// document is refused whole, so the misses have to be taken individually. The
// reader's own stays come from `trips` instead of costing a read each.
function useVisibleStays(
  windows: readonly AvailabilityWindow[],
): ReadonlyMap<string, Booking> {
  const { trips } = useKip();
  const [fetched, setFetched] = useState<ReadonlyMap<string, Booking>>(
    new Map(),
  );
  const mine = useMemo(
    () =>
      new Map(
        trips
          .filter((trip) => trip.status === "CONFIRMED")
          .map((trip) => [trip.id, trip] as const),
      ),
    [trips],
  );
  // Joined into one string so the effect tracks the SET of ids, not the array
  // identity, which changes on every snapshot.
  const wanted = windows
    .filter(
      (window) =>
        window.status !== "OPEN" &&
        window.bookingId != null &&
        !mine.has(window.bookingId) &&
        !isExpired(window.end),
    )
    .map((window) => window.bookingId as string)
    .sort()
    .join(",");

  useEffect(() => {
    if (!wanted) {
      setFetched(new Map());
      return;
    }
    let live = true;
    Promise.all(
      wanted
        .split(",")
        .map(async (id) => [id, await fetchBookingIfVisible(id)] as const),
    )
      .then((pairs) => {
        if (!live) return;
        setFetched(
          new Map(
            pairs.filter((pair): pair is [string, Booking] => pair[1] !== null),
          ),
        );
      })
      .catch((error) => console.error("visibleStays", error));
    return () => {
      live = false;
    };
  }, [wanted]);

  return useMemo(() => new Map([...mine, ...fetched]), [mine, fetched]);
}

function FriendView({
  listing,
  windows,
}: {
  listing: Listing;
  windows: readonly AvailabilityWindow[];
}): ReactElement {
  const { friends, navigate } = useKip();
  const host = friends.find((friend) => friend.uid === listing.ownerId);
  const held = useVisibleStays(windows);
  // A taken range is listed only when its stay is readable — which happens for
  // your own, and for a friend who shares theirs. Everyone else's simply isn't
  // here, so an unexplained "Booked" never appears.
  const dates = [...windows]
    .filter(
      (window) =>
        !isExpired(window.end) &&
        (window.status === "OPEN" ||
          (window.bookingId != null && held.has(window.bookingId))),
    )
    .sort((left, right) => left.start.localeCompare(right.start));
  const anyHeld = dates.some((window) => window.status !== "OPEN");

  return (
    <div className="flex flex-col gap-6 md:grid md:grid-cols-[minmax(0,1fr)_360px] md:items-start md:gap-8">
      <div className="flex min-w-0 flex-col gap-5">
        {host ? (
          <button
            type="button"
            onClick={() => navigate({ kind: "person", id: host.uid })}
            className="bg-accent-soft flex items-center gap-3 rounded-2xl p-3.5 text-left"
          >
            <Avatar
              name={host.displayName}
              photoURL={host.photoURL}
              className="h-12 w-12 text-base"
              ring
            />
            <span className="min-w-0">
              <span className="block truncate font-bold text-accent-ink">
                {host.displayName}'s place
              </span>
              <span className="block text-sm text-accent-ink/80">
                You're friends
              </span>
            </span>
          </button>
        ) : null}
        <DetailBlock listing={listing} thumbnails />
      </div>

      <aside className="md:sticky md:top-24">
        {/* Named for what's in it: "Open dates" would be a lie the moment a
            taken one is listed alongside. */}
        <Section title={anyHeld ? "Dates" : "Open dates"}>
          {dates.length === 0 ? (
            <p className="px-1 text-sm text-muted">No open dates right now.</p>
          ) : (
            <Group>
              {dates.map((window) => (
                <SlotRow
                  key={window.id}
                  listing={listing}
                  window={window}
                  stay={
                    window.bookingId
                      ? (held.get(window.bookingId) ?? null)
                      : null
                  }
                />
              ))}
            </Group>
          )}
        </Section>
      </aside>
    </div>
  );
}

function OwnerView({ listing }: { listing: Listing }): ReactElement {
  const {
    myWindows,
    incomingBookings,
    deleteListing,
    hideBookingsById,
    setListingPhotos,
    publishListingPortal,
    revokeListingPortal,
    navigate,
    replace,
    screen,
  } = useKip();
  const { confirm } = useDialog();
  const run = useAction();
  // Owner-only, which is why the friend view can ignore it entirely.
  const focusedWindowId =
    screen.kind === "room" && screen.id === listing.id
      ? (screen.windowId ?? null)
      : null;
  const [editingWindowId, setEditingWindowId] = useState<string | null>(
    focusedWindowId,
  );
  const [addingSlot, setAddingSlot] = useState(false);

  // Only ever OPENS — closing clears the argument, so the two never fight over
  // a sheet the user just dismissed.
  useEffect(() => {
    if (focusedWindowId) setEditingWindowId(focusedWindowId);
  }, [focusedWindowId]);

  // In place, not pushed: a pushed entry would make browser-back reopen the
  // sheet just closed.
  function closeSlotSheet(): void {
    setEditingWindowId(null);
    if (focusedWindowId) replace({ kind: "room", id: listing.id });
  }

  // Opening it names it in the URL — in place, so it adds no entry to go back
  // through. Without this, tapping a request inside the sheet pushed the
  // booking on top of a room that had forgotten which slot was open, and back
  // returned to a bare room page. The deep-link variant already existed; this
  // just makes an ordinary tap arrive at the same address.
  function openSlotSheet(windowId: string): void {
    setEditingWindowId(windowId);
    replace({ kind: "room", id: listing.id, windowId });
  }

  const allWindows = [...(myWindows[listing.id] ?? [])].sort((left, right) =>
    left.start.localeCompare(right.start),
  );
  // The same boundary Trips uses, so a slot and a stay stop being current on the
  // same day.
  const windows = allWindows.filter((window) => !isExpired(window.end));
  // Newest first, so recent dates aren't buried under last year's.
  const expired = allWindows
    .filter((window) => isExpired(window.end))
    .sort((left, right) => right.start.localeCompare(left.start));
  const bookings = incomingBookings
    .filter((booking) => booking.listingId === listing.id)
    .sort((left, right) => {
      if (left.status === right.status)
        return left.start.localeCompare(right.start);
      return left.status === "REQUESTED" ? -1 : 1;
    });
  const activeBookings = bookings.filter(
    (booking) => booking.status !== "CANCELLED",
  );
  // How many are still waiting on an answer for one slot. The sheet filters
  // `incomingBookings` again for itself rather than being handed this — both
  // read the one subscription and both take `REQUESTED`, which is what keeps the
  // count and the rows behind it in step.
  const askedOn = (windowId: string): number =>
    bookings.filter(
      (booking) =>
        booking.windowId === windowId && booking.status === "REQUESTED",
    ).length;
  // Not a guest any more, but this is the only way in to it.
  const cancelledBookings = bookings
    .filter((booking) => booking.status === "CANCELLED")
    .sort((left, right) => right.start.localeCompare(left.start));

  async function remove(): Promise<void> {
    const ok = await confirm({
      title: `Delete "${listing.title}"?`,
      body: "This removes the listing and all its availability. Cancel any booked slots first so guests are notified.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (ok) run(() => deleteListing(listing));
  }

  // Per-party: the guest's own record of the cancellation is untouched.
  async function clearCancelled(): Promise<void> {
    const agreed = await confirm({
      title: "Clear cancelled bookings?",
      body: "They disappear from this place's list. Each guest still has their copy — nothing is deleted.",
      confirmLabel: "Clear all",
    });
    if (!agreed) return;
    await hideBookingsById(cancelledBookings.map((booking) => booking.id));
  }

  // The id survives, so a sheet named before the listener catches up opens when
  // it does, and one naming a removed slot just leaves you on the room.
  const editingWindow = editingWindowId
    ? allWindows.find((window) => window.id === editingWindowId)
    : undefined;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="mb-1 text-xs font-bold uppercase tracking-[0.08em] text-accent-ink">
          Manage place
        </p>
        <DetailBlock listing={listing} thumbnails={false} />
      </div>

      <div className="flex flex-col gap-6 md:grid md:grid-cols-[minmax(0,1fr)_360px] md:items-start md:gap-8">
        <aside className="flex flex-col gap-6 md:col-start-2 md:row-start-1 md:sticky md:top-24">
          <Section title="Availability">
            {windows.length === 0 ? (
              <p className="px-1 text-sm text-muted">
                No open dates yet. Add some so friends can ask to stay.
              </p>
            ) : (
              <Group>
                {windows.map((window) => (
                  <SlotSummaryRow
                    key={window.id}
                    window={window}
                    asked={askedOn(window.id)}
                    onOpen={() => openSlotSheet(window.id)}
                  />
                ))}
              </Group>
            )}
            <div>
              <Button variant="secondary" onClick={() => setAddingSlot(true)}>
                <LuPlus />
                Add dates
              </Button>
            </div>
          </Section>

          {expired.length > 0 ? (
            <Section title="Past dates">
              <Group className="opacity-70">
                {expired.map((window) => (
                  <PastSlotRow
                    key={window.id}
                    window={window}
                    asked={askedOn(window.id)}
                    onOpen={() => openSlotSheet(window.id)}
                  />
                ))}
              </Group>
            </Section>
          ) : null}

          {cancelledBookings.length > 0 ? (
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
                {cancelledBookings.map((booking) => (
                  <BookingRow
                    key={booking.id}
                    booking={booking}
                    lead="person"
                  />
                ))}
              </Group>
            </Section>
          ) : null}
        </aside>

        <div className="flex min-w-0 flex-col gap-6 md:col-start-1 md:row-start-1">
          <Section title="Photos">
            <p className="px-1 text-sm text-muted">
              The first one leads the page — put another first to change that.
            </p>
            <PhotoStrip
              ownerId={listing.ownerId}
              listingId={listing.id}
              photos={listing.photos}
              editable
              onChange={(photos) => setListingPhotos(listing.id, photos)}
            />
          </Section>

          <Section title="Sharing">
            <ShareLink
              portalId={listing.publicPortalId}
              createLabel="Create public link"
              onCreate={async () => {
                await publishListingPortal(listing);
              }}
              onRevoke={() => revokeListingPortal(listing)}
            />
          </Section>

          {activeBookings.length > 0 ? (
            <Section title="Guests">
              <Group>
                {activeBookings.map((booking) => (
                  <BookingRow
                    key={booking.id}
                    booking={booking}
                    lead="person"
                  />
                ))}
              </Group>
            </Section>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Button
              variant="secondary"
              onClick={() => navigate({ kind: "listing-form", id: listing.id })}
            >
              Edit details
            </Button>
            <Button variant="danger" onClick={remove}>
              Delete place
            </Button>
          </div>
        </div>
      </div>

      {editingWindow ? (
        <SlotSheet
          listing={listing}
          window={editingWindow}
          existing={allWindows}
          onClose={closeSlotSheet}
        />
      ) : null}
      {addingSlot ? (
        <AddSlotSheet
          listingId={listing.id}
          existing={allWindows}
          onClose={() => setAddingSlot(false)}
        />
      ) : null}
    </div>
  );
}

function SlotSummaryRow({
  window,
  asked,
  onOpen,
}: {
  window: AvailabilityWindow;
  asked: number;
  onOpen: () => void;
}): ReactElement {
  const chips = window.status === "BOOKED" || window.autoAccept || asked > 0;
  return (
    <Row onClick={onOpen} ariaLabel={formatDateRange(window.start, window.end)}>
      <div className="min-w-0 flex-1">
        <span className="block text-[0.9375rem] font-semibold">
          {formatDateRange(window.start, window.end)}
          <span className="font-normal text-muted">
            {" "}
            · {nights(window.start, window.end)} nights
          </span>
        </span>
        {chips ? (
          <span className="mt-1 flex flex-wrap items-center gap-2">
            {window.status === "BOOKED" ? (
              <Chip tone="booked">Booked</Chip>
            ) : window.autoAccept ? (
              <Chip tone="instant" icon={<LuZap size={12} />}>
                Instant
              </Chip>
            ) : null}
            {/* What makes the requests inside the sheet findable: without it a
                slot two people are waiting on looks exactly like one nobody has
                asked about, and the host has to open every slot to find out. */}
            {asked > 0 ? (
              <Chip tone="pending">
                {asked === 1 ? "1 asked" : `${asked} asked`}
              </Chip>
            ) : null}
            {window.details ? (
              <span className="text-sm text-muted">{window.details}</span>
            ) : null}
          </span>
        ) : window.details ? (
          <span className="block text-sm text-muted">{window.details}</span>
        ) : null}
      </div>
      <LuChevronRight className="shrink-0 text-faint" />
    </Row>
  );
}

function PastSlotRow({
  window,
  asked,
  onOpen,
}: {
  window: AvailabilityWindow;
  asked: number;
  onOpen: () => void;
}): ReactElement {
  return (
    <Row onClick={onOpen} ariaLabel={formatDateRange(window.start, window.end)}>
      <div className="min-w-0 flex-1">
        <span className="block text-[0.9375rem] font-semibold">
          {formatDateRange(window.start, window.end)}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted">
            {window.status === "BOOKED"
              ? "Someone stayed"
              : "Nobody booked these"}
          </span>
          {/* Here too, and this is where it matters most: nothing ages an ask
              out, so a request for dates that have gone sits in someone's list
              until it is declined, and a past slot is the last place a host
              would think to look for one. */}
          {asked > 0 ? (
            <Chip tone="pending">
              {asked === 1 ? "1 asked" : `${asked} asked`}
            </Chip>
          ) : null}
        </span>
      </div>
      <LuChevronRight className="shrink-0 text-faint" />
    </Row>
  );
}

function SlotSheet({
  listing,
  window,
  existing,
  onClose,
}: {
  listing: Listing;
  window: AvailabilityWindow;
  existing: readonly AvailabilityWindow[];
  onClose: () => void;
}): ReactElement {
  const listingId = listing.id;
  const {
    incomingBookings,
    updateWindow,
    setWindowAutoAccept,
    cancelWindow,
    publishSlotPortal,
    revokeSlotPortal,
  } = useKip();
  const { confirm } = useDialog();
  const run = useAction();
  const [start, setStart] = useState(window.start);
  const [end, setEnd] = useState(window.end);
  const [details, setDetails] = useState(window.details);

  const booked = window.status === "BOOKED";
  // Reviving these would be a new set of dates wearing an old slot's history —
  // its share link, and whatever was asked of it — so they can only be cleared.
  const expired = isExpired(window.end);
  // Listed in the sheet AND consulted by Save: a pending ask can never be
  // confirmed onto different nights, so moving the dates cancels it.
  const pending = incomingBookings
    .filter(
      (booking) =>
        booking.windowId === window.id && booking.status === "REQUESTED",
    )
    // Oldest first: these are queueing for one slot, and who asked first is the
    // only ordering the host has any reason to read.
    .sort((left, right) => left.createdAt - right.createdAt);
  // By id, not by "the first live booking on this slot". A slot that lost a race
  // keeps the losers' asks alongside the winner, so a `find` on status-not-
  // cancelled returned whichever the array happened to hold first — naming a
  // pending asker as the person staying, and offering their booking as the stay
  // to cancel. The slot itself names its holder; nothing else has to be guessed.
  const guestBooking = window.bookingId
    ? incomingBookings.find((booking) => booking.id === window.bookingId)
    : undefined;

  const dirty =
    start !== window.start || end !== window.end || details !== window.details;
  const clash =
    start && end && end > start
      ? findOverlap(existing, { start, end }, window.id)
      : null;
  const gone = Boolean(end) && isExpired(end);
  const valid = Boolean(start && end && end > start) && !clash && !gone;

  const datesMoved = start !== window.start || end !== window.end;

  async function save(): Promise<void> {
    if (!valid) return;
    if (datesMoved && pending.length > 0) {
      const ok = await confirm({
        title:
          pending.length === 1
            ? "Cancel the pending request?"
            : `Cancel ${pending.length} pending requests?`,
        body: "They asked for the dates as they are now, so moving them cancels what they asked for. They'll be told, and can ask again.",
        confirmLabel: "Move dates",
        cancelLabel: "Keep dates",
        tone: "danger",
      });
      if (!ok) return;
    }
    await updateWindow(listingId, window.id, {
      start,
      end,
      details: details.trim(),
    });
    onClose();
  }

  async function cancelSlot(): Promise<void> {
    const ok = await confirm({
      title: expired ? "Remove these dates?" : "Cancel this slot?",
      body: expired
        ? "They've already passed, so this only clears them off your calendar — a stay that already happened isn't affected."
        : booked
          ? "The guest's booking will be cancelled and they'll be notified."
          : "This removes these open dates.",
      confirmLabel: expired ? "Remove" : "Cancel slot",
      cancelLabel: "Keep",
      tone: "danger",
    });
    if (!ok) return;
    run(() => cancelWindow(listingId, window.id));
    onClose();
  }

  // Who has asked for these nights, which is the thing that decides what to do
  // with them: moving the dates cancels every one of these, and the confirm that
  // says so should not be the first the host hears of it.
  //
  // Placed per branch rather than above all three, because the right position
  // differs. On an OPEN slot it belongs over the date fields, for the reason
  // just given. On a BOOKED one the stay that actually holds the nights outranks
  // the asks that missed them. It appears in both, and in expired, deliberately:
  // confirming does not cancel the losers and nothing ages an ask out, so those
  // are still sitting in someone's list waiting for an answer, and this is the
  // only surface that reaches them from the dates they are about.
  const asks =
    pending.length > 0 ? (
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-muted">
          {pending.length === 1
            ? "1 person asked"
            : `${pending.length} people asked`}
        </span>
        <Group>
          {pending.map((booking) => (
            <BookingRow
              key={booking.id}
              booking={booking}
              lead="person"
              showDates={false}
            />
          ))}
        </Group>
        {/* Only where it is a dead end. On an open slot the rows lead to a page
            that can answer them, which needs no caption. */}
        {booked || expired ? (
          <p className="px-1 text-sm text-muted">
            {/* Expired wins: a slot that is both has a stay that already
                happened, and "went to someone else" is present-tense race
                language for a race that finished long ago. */}
            {expired
              ? "These dates have passed, so these can only be declined."
              : "These dates went to someone else, so these can only be declined."}
          </p>
        ) : null}
      </div>
    ) : null;

  return (
    <Sheet
      open
      onClose={onClose}
      title={formatDateRange(window.start, window.end)}
    >
      <div className="flex flex-col gap-5">
        {/* The place these dates belong to, so a slot opened from a link or a
            deep URL isn't just a pair of dates with no context. */}
        <CoverPhoto
          photo={listing.photos[0]}
          className="aspect-[16/9] max-h-44 w-full"
        />

        {expired ? (
          <>
            <p className="text-[0.9375rem] text-muted">
              These dates have passed —{" "}
              {booked ? "someone stayed" : "nobody booked them"}. There's
              nothing left to change about the dates; new availability means new
              dates. You can still clear these off your calendar.
            </p>
            {window.details ? (
              <p className="text-sm text-muted">{window.details}</p>
            ) : null}
            {asks}
            {/* A link minted while these dates were live is still live. Removing
                the slot deletes it, but turning it off must not require that. */}
            {window.publicPortalId ? (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-semibold text-muted">
                  Link to these dates
                </span>
                <ShareLink
                  portalId={window.publicPortalId}
                  createLabel="Create link for these dates"
                  onCreate={async () => {
                    await publishSlotPortal(listingId, window);
                  }}
                  onRevoke={() => revokeSlotPortal(listingId, window)}
                />
              </div>
            ) : null}
          </>
        ) : booked ? (
          <>
            {/* A sentence naming the guest led nowhere: owner-cancel and
                everything else about the stay live on its own page, reachable
                from here only by closing the sheet and finding the Guests list.
                The row names them now, so the sentence keeps only what the row
                cannot say. */}
            {guestBooking ? (
              <Group>
                <BookingRow
                  booking={guestBooking}
                  lead="person"
                  showDates={false}
                />
              </Group>
            ) : null}
            {/* Nameless on purpose in the second case: a slot reads BOOKED for
                a beat before the booking holding it reaches this client, and
                there is nobody to name until it does. */}
            <p className="text-[0.9375rem] text-muted">
              {guestBooking
                ? "Cancelling frees these dates and notifies your guest."
                : "Cancelling frees these dates and notifies whoever booked them."}
            </p>
            {asks}
          </>
        ) : (
          <>
            {asks}
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5 text-sm text-muted">
                From
                <input
                  type="date"
                  className={FIELD}
                  min={todayIso()}
                  value={start}
                  onChange={(event) => setStart(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm text-muted">
                To
                <input
                  type="date"
                  className={FIELD}
                  min={start || todayIso()}
                  value={end}
                  onChange={(event) => setEnd(event.target.value)}
                />
              </label>
            </div>
            <label className="flex flex-col gap-1.5 text-sm text-muted">
              Notes for these dates
              <input
                className={FIELD}
                placeholder="e.g. flexible check-in, I'll be away"
                value={details}
                onChange={(event) => setDetails(event.target.value)}
              />
            </label>
            {clash ? (
              <FieldNote tone="danger">
                Overlaps your {formatDateRange(clash.start, clash.end)} dates.
              </FieldNote>
            ) : gone ? (
              <FieldNote tone="danger">
                Those dates have already passed.
              </FieldNote>
            ) : null}
            <Button onClick={save} disabled={!valid || !dirty}>
              Save changes
            </Button>

            <div className="rounded-2xl bg-surface-muted">
              <Switch
                checked={window.autoAccept}
                onChange={(next) =>
                  run(() => setWindowAutoAccept(listingId, window.id, next))
                }
                label="Instant book"
                description="Friends book these dates instantly (first come, first served)."
              />
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-sm font-semibold text-muted">
                Share these dates
              </span>
              <ShareLink
                portalId={window.publicPortalId}
                createLabel="Create link for these dates"
                onCreate={async () => {
                  await publishSlotPortal(listingId, window);
                }}
                onRevoke={() => revokeSlotPortal(listingId, window)}
              />
            </div>
          </>
        )}

        <Button variant="danger" onClick={cancelSlot}>
          {expired ? "Remove dates" : "Cancel slot"}
        </Button>
      </div>
    </Sheet>
  );
}

function AddSlotSheet({
  listingId,
  existing,
  onClose,
}: {
  listingId: string;
  existing: readonly AvailabilityWindow[];
  onClose: () => void;
}): ReactElement {
  const { addWindow } = useKip();
  const run = useAction();
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [details, setDetails] = useState("");
  const [autoAccept, setAutoAccept] = useState(false);
  const clash =
    start && end && end > start ? findOverlap(existing, { start, end }) : null;
  // `min` on the pickers is a hint a typed date walks straight past, and a slot
  // that's expired the moment it exists is availability nobody can ever book.
  const gone = Boolean(end) && isExpired(end);
  const valid = Boolean(start && end && end > start) && !clash && !gone;

  function add(): void {
    if (!valid) return;
    run(async () => {
      await addWindow(listingId, {
        start,
        end,
        autoAccept,
        details: details.trim(),
      });
      onClose();
    });
  }

  const note = clash ? (
    <FieldNote tone="danger">
      Overlaps your {formatDateRange(clash.start, clash.end)} dates.
    </FieldNote>
  ) : gone ? (
    <FieldNote tone="danger">Those dates have already passed.</FieldNote>
  ) : null;

  return (
    <Sheet open onClose={onClose} title="Add dates">
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            From
            <input
              type="date"
              className={FIELD}
              min={todayIso()}
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            To
            <input
              type="date"
              className={FIELD}
              min={start || todayIso()}
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          </label>
        </div>
        <label className="flex flex-col gap-1.5 text-sm text-muted">
          Notes for these dates
          <input
            className={FIELD}
            placeholder="e.g. flexible check-in, I'll be away"
            value={details}
            onChange={(event) => setDetails(event.target.value)}
          />
        </label>
        <div className="rounded-2xl bg-surface-muted">
          <Switch
            checked={autoAccept}
            onChange={setAutoAccept}
            label="Instant book"
            description="Friends book these dates instantly (first come, first served)."
          />
        </div>
        {note}
        <Button size="lg" onClick={add} disabled={!valid}>
          Add dates
        </Button>
      </div>
    </Sheet>
  );
}
