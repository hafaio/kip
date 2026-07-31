"use client";

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { LuLoaderCircle, LuMapPin } from "react-icons/lu";
import AuthMenu from "../../components/auth-menu";
import AuthPanel from "../../components/auth-panel";
import Avatar from "../../components/avatar";
import { PhotoGallery } from "../../components/cover-photo";
import ThemeButton from "../../components/theme-button";
import Button from "../../components/ui/button";
import Chip from "../../components/ui/chip";
import FieldNote from "../../components/ui/field-note";
import Input from "../../components/ui/input";
import Sheet from "../../components/ui/sheet";
import Wordmark, { Mark } from "../../components/wordmark";
import {
  fetchMyBookingsWith,
  requestStayViaPortal,
} from "../../utils/bookings";
import {
  clientState,
  type DebugDetail,
  recordDebugEvent,
} from "../../utils/debug";
import { errorCode } from "../../utils/firebase";
import { formatDateRange, nights } from "../../utils/format";
import { areFriends } from "../../utils/friends";
import { listingTypeIcon, listingTypeLabel } from "../../utils/listings";
import { claimGrant, fetchPortalPage } from "../../utils/portals";
import {
  fetchMyConnectRequest,
  sendPortalConnectRequest,
} from "../../utils/requests";
import { useKip } from "../../utils/store";
import type {
  Portal,
  PortalContent,
  PortalListing,
  PortalWindow,
} from "../../utils/types";
import { validateDisplayName } from "../../utils/username";

type LoadState = "loading" | "ready" | "missing";

// Stands in for a window id when the ask carries no dates.
const FRIEND_ONLY = "__friend__";

// What the visitor tapped, held while they make an account. A null window means
// they asked to connect rather than for specific dates.
type Ask = { listingId: string | null; window: PortalWindow | null };

// Why an ask never went out. Two causes, because the advice differs: a refused
// write may mean a revoked link, whereas a stall never reached the server.
type Failure = "refused" | "stalled";

// The only timeout in the flow: this page is outside the app's gate, so the
// Unreachable screen never renders here. A stall nobody else names ends here.
const ASK_TIMEOUT_MS = 10_000;

// Everything about the visitor's relationship with this host, answered in one
// go. Dates stay a LIST rather than a flag, or one pending friend request
// suppresses every Request button on the page — bookings have auto-ids and
// nothing stops a visitor asking for several ranges.
//
// Null means not answered YET, which is why the connect control waits for it
// rather than guessing: the three states are mutually exclusive, and the wrong
// guess offers an ask that can only be refused.
type Standing = {
  windowIds: readonly string[];
  confirmed: boolean;
  connectPending: boolean;
  friend: boolean;
};

// What the connect control has to say. `none` covers the host themselves and
// anyone already connected — neither has anything left to ask for. `unknown` is
// the lookup not having answered yet, where drawing an ask would be a guess.
type Connect = "ask" | "sent" | "none" | "unknown";

// The one screen outside the auth gate. Browsing needs no account; asking does,
// but the account comes AFTER the tap — the buttons are live signed out, and
// tapping one holds the ask and opens sign-up in place.
export default function PortalPage(): ReactElement {
  const {
    user,
    anonymous,
    profile,
    profileReady,
    profileUnreachable,
    ensureAnonymous,
  } = useKip();
  const [page, setPage] = useState<PortalContent | null>(null);
  // The portal doc on its own, a round trip ahead of `page`. A SLOT link carries
  // its room here too, but only `page` has the DATES, and a room rendered
  // without them claims "No open dates right now" — so nothing below the host
  // block is drawn from this. Superseded the moment `page` lands.
  const [owner, setOwner] = useState<Portal | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [standing, setStanding] = useState<Standing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  // Carries the ask it came from, so trying again is one tap rather than a hunt
  // back to a button that may now be scrolled off or behind the error.
  const [failed, setFailed] = useState<{ reason: Failure; ask: Ask } | null>(
    null,
  );
  // The rooms didn't load, but the host block did — a different failure from a
  // link that never resolved, and it must not overwrite what's already on screen.
  const [roomsFailed, setRoomsFailed] = useState(false);
  // Everything that needs the ROOMS reads `page`; everything that needs only the
  // host reads this, so the header can render while the rest is still arriving.
  const portal = page?.portal ?? owner;

  // Anonymous sign-in gives the live reads an identity to hang a grant on. The
  // hashchange listener matters because pasting a different link changes only the
  // fragment, which the browser treats as the same document — no reload.
  const [token, setToken] = useState("");
  useEffect(() => {
    const read = () => setToken(window.location.hash.slice(1));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  useEffect(() => {
    if (!token) {
      setState("missing");
      return;
    }
    let live = true;
    // Tracked here rather than off `owner`, which this closure captured as null.
    let painted = false;
    setState("loading");
    setPage(null);
    setOwner(null);
    setRoomsFailed(false);
    setStanding(null);
    // A held ask names a portal that is about to stop existing, and the send
    // effect would refuse it forever without saying so.
    setAsk(null);
    setFailed(null);
    // Handed over in flight: the portal doc needs no identity to read.
    fetchPortalPage(token, ensureAnonymous(), (found) => {
      if (!live) return;
      painted = true;
      setOwner(found);
      setState("ready");
    })
      .then((found) => {
        if (!live) return;
        setPage(found);
        setState(found ? "ready" : "missing");
      })
      .catch((error: unknown) => {
        console.error(error);
        if (!live) return;
        // Once the host block is up, the link demonstrably resolved, so
        // replacing the page with "this link isn't active" would be a lie about
        // what went wrong — and a jarring one, since they can already see it did.
        if (painted) setRoomsFailed(true);
        else setState("missing");
      });
    return () => {
      live = false;
    };
  }, [token, ensureAnonymous]);

  // Reported separately, so neither ask can hide the other's affordance. Keyed
  // on the host's uid rather than on `portal`, which is now a DIFFERENT object
  // each time it improves — first the portal doc, then the fuller one — and
  // would otherwise run this, and its three reads, twice on every load.
  const hostId = portal?.ownerId ?? null;
  useEffect(() => {
    if (!user || anonymous || !hostId) return;
    Promise.all([
      fetchMyBookingsWith(user.uid, hostId),
      fetchMyConnectRequest(user.uid, hostId),
      areFriends(user.uid, hostId),
    ])
      .then(([bookings, request, friend]) => {
        const live = bookings.filter(
          (booking) => booking.status !== "CANCELLED",
        );
        setStanding({
          windowIds: live.map((booking) => booking.windowId),
          confirmed: live.some((booking) => booking.status === "CONFIRMED"),
          connectPending: request !== null,
          friend,
        });
      })
      .catch((error: unknown) => console.error(error));
    // `anonymous` earns its place in the deps: linking keeps the uid, so `user`
    // never changes identity for someone who made their account on this page.
  }, [user, anonymous, hostId]);

  // Written during render so a failure reports the state it actually failed in,
  // rather than whatever the effect closed over when it armed — for the timer
  // that is up to ten seconds of drift. Same shape as `lastPopped` in page.tsx.
  const vector = useRef<DebugDetail>({});
  vector.current = {
    anonymous,
    profileReady,
    profileUnreachable,
    hasProfile: profile !== null,
    hasName: Boolean(profile?.displayName),
    hostLoaded: portal !== null,
    roomsLoaded: page !== null,
  };
  // These failures throw nothing, so the state that decided them is the whole
  // report. Stable, so effects can call it without re-running on every render.
  const report = useCallback((reason: Failure, extra: DebugDetail = {}) => {
    recordDebugEvent("portal-ask", {
      reason,
      ...vector.current,
      ...clientState(),
      ...extra,
    });
  }, []);

  // Cleared first, so a later dependency change can't fire a second request. The
  // name comes off the kip profile, never `user.email` — that would write their
  // address into a document the host can read.
  useEffect(() => {
    if (!ask || !portal || !user || !profileReady || !profile?.displayName) {
      return;
    }
    const { listingId, window: slot } = ask;
    setAsk(null);
    setBusy(slot?.id ?? FRIEND_ONLY);
    setFailed(null);
    const sender = {
      uid: user.uid,
      username: profile.username,
      displayName: profile.displayName,
      photoURL: profile.photoURL,
    };

    // Re-claimed as whoever we are NOW: signing in to an existing account mints
    // a fresh uid, orphaning the grant written on load.
    claimGrant(portal.id, user.uid)
      // Asking for dates IS a booking — the same document a friend creates.
      .then(() =>
        listingId && slot
          ? requestStayViaPortal(sender.uid, portal.ownerId, listingId, slot)
          : sendPortalConnectRequest(portal, sender),
      )
      // Never confirmed: a link is not friendship, whatever the slot allows.
      .then(() =>
        setStanding((current) => ({
          windowIds: slot
            ? [...(current?.windowIds ?? []), slot.id]
            : (current?.windowIds ?? []),
          confirmed: current?.confirmed ?? false,
          connectPending: slot ? (current?.connectPending ?? false) : true,
          // Asking is only ever offered to someone who isn't one yet, so this
          // settles `unknown` for a visitor whose lookup never ran at all.
          friend: current?.friend ?? false,
        })),
      )
      .catch((error: unknown) => {
        console.error(error);
        report("refused", { code: errorCode(error) });
        setFailed({ reason: "refused", ask: { listingId, window: slot } });
      })
      .finally(() => setBusy(null));
  }, [ask, portal, user, profileReady, profile, report]);

  // Anonymous counts as signed out here — a ticket is not an account.
  const identified = Boolean(user) && !anonymous;
  const isOwner = identified && user?.uid === portal?.ownerId;
  // A signed-out visitor has no edge and no request, so there is nothing to
  // look up and the ask is live from the first paint — which is the visitor
  // this whole page exists for.
  const connect: Connect = isOwner
    ? "none"
    : !identified
      ? "ask"
      : standing === null
        ? "unknown"
        : standing.friend
          ? "none"
          : standing.connectPending
            ? "sent"
            : "ask";
  const needsAccount = ask !== null && !identified;
  const needsName =
    ask !== null && identified && profileReady && !profile?.displayName;
  // A held ask spins the control it came from, so a tap is never a no-op. The
  // sheets cover "no account" and "no name"; neither covers the gap between
  // signed in and profile loaded, where a tap used to show nothing at all.
  const holding = ask === null ? busy : (ask.window?.id ?? FRIEND_ONLY);

  // An ask held with NEITHER sheet up is waiting on the profile. Deliberately
  // not extended to the send: that write is Firestore's, which queues offline
  // and lands on reconnect.
  useEffect(() => {
    if (ask === null || needsAccount || needsName) return;
    const give = (): void => {
      report("stalled");
      setAsk(null);
      setFailed({ reason: "stalled", ask });
    };
    if (profileUnreachable) {
      give();
      return;
    }
    const timer = setTimeout(give, ASK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [ask, needsAccount, needsName, profileUnreachable, report]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 items-center gap-3 px-4">
        {/* An anchor, not a router push — this page sits outside the nav stack. */}
        <a
          href={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/`}
          aria-label="kip home"
          className="rounded-2xl"
        >
          <Wordmark />
        </a>
        <div className="ml-auto flex items-center gap-1">
          <ThemeButton />
          <AuthMenu />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        {state === "loading" ? (
          // The same mark the app boots behind.
          <div className="flex min-h-[60vh] items-center justify-center">
            <Mark />
          </div>
        ) : state === "missing" ? (
          <div className="mx-auto max-w-md pt-12 text-center">
            <h1 className="text-xl font-bold tracking-[-0.02em]">
              This link isn't active
            </h1>
            <p className="mt-2 text-sm text-muted">
              It may have been turned off or regenerated. Ask whoever shared it
              for a fresh link.
            </p>
          </div>
        ) : portal ? (
          <PortalView
            portal={portal}
            windows={page?.windows ?? {}}
            roomsPending={page === null}
            roomsFailed={roomsFailed}
            isOwner={isOwner}
            connect={connect}
            standing={standing}
            busy={holding}
            failed={failed?.reason ?? null}
            onRetry={() => {
              if (!failed) return;
              setAsk(failed.ask);
              setFailed(null);
            }}
            onAsk={(listingId, slot) => {
              setFailed(null);
              setAsk({ listingId, window: slot });
            }}
          />
        ) : null}
      </main>

      <Sheet
        open={needsAccount || needsName}
        onClose={() => setAsk(null)}
        title={
          needsAccount
            ? `Create an account to ask ${portal?.ownerName.split(" ")[0] ?? "them"}`
            : "What should we call you?"
        }
      >
        {needsAccount ? (
          <>
            <p className="mb-5 text-sm text-muted">
              kip is friends-only, so you'll need an account before you can ask.
              It takes a moment, and your request is sent as soon as you're in.
            </p>
            <AuthPanel />
          </>
        ) : (
          <NameForm />
        )}
      </Sheet>
    </div>
  );
}

// The host has to see a name rather than a blank. No handle — that's optional.
function NameForm(): ReactElement {
  const { user, completeOnboarding } = useKip();
  const [name, setName] = useState(user?.displayName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalid = name ? validateDisplayName(name) : null;

  async function submit(): Promise<void> {
    if (validateDisplayName(name)) return;
    setBusy(true);
    setError(null);
    try {
      await completeOnboarding(name.trim());
    } catch (caught) {
      console.error(caught);
      setError("Couldn't save that. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="text-sm text-muted">
        This is the name your host will see. You can change it later.
      </p>
      <Input
        autoComplete="name"
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Your name"
      />
      {invalid ? <FieldNote tone="danger">{invalid}</FieldNote> : null}
      {error ? <FieldNote tone="danger">{error}</FieldNote> : null}
      <Button
        type="submit"
        size="lg"
        disabled={busy || Boolean(validateDisplayName(name))}
      >
        {busy ? <LuLoaderCircle className="animate-spin" /> : "Send request"}
      </Button>
    </form>
  );
}

function PortalView({
  portal,
  windows,
  roomsPending,
  roomsFailed,
  isOwner,
  connect,
  standing,
  busy,
  failed,
  onRetry,
  onAsk,
}: {
  portal: Portal;
  windows: Readonly<Record<string, readonly PortalWindow[]>>;
  // True while only the portal doc has arrived, so the host block is all that
  // can be drawn honestly.
  roomsPending: boolean;
  roomsFailed: boolean;
  failed: Failure | null;
  isOwner: boolean;
  connect: Connect;
  standing: Standing | null;
  busy: string | null;
  onRetry: () => void;
  onAsk: (listingId: string | null, window: PortalWindow | null) => void;
}): ReactElement {
  const firstName = portal.ownerName.split(" ")[0] || portal.ownerName;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex items-center gap-3">
        <Avatar
          name={portal.ownerName}
          photoURL={portal.ownerPhotoURL}
          className="h-12 w-12 text-base"
          ring
        />
        <div className="min-w-0">
          <p className="text-sm text-muted">Shared by</p>
          <p className="font-bold">{portal.ownerName}</p>
        </div>
      </div>

      {roomsFailed ? (
        <p className="text-sm text-danger">
          Couldn't load what's shared here. Check your connection and try again.
        </p>
      ) : roomsPending ? (
        // "Nothing shared here right now" is a statement about an empty link,
        // and saying it to someone whose rooms are in flight is worse than
        // saying nothing at all.
        <div aria-hidden className="flex flex-col gap-4">
          <div className="h-40 animate-pulse rounded-3xl bg-surface shadow-card" />
          <div className="h-40 animate-pulse rounded-3xl bg-surface shadow-card" />
        </div>
      ) : portal.listings.length === 0 ? (
        <p className="text-sm text-muted">Nothing shared here right now.</p>
      ) : (
        portal.listings.map((listing) => (
          <ListingBlock
            key={listing.listingId}
            listing={listing}
            windows={windows[listing.listingId] ?? []}
            canAsk={!isOwner}
            requestedWindowIds={standing?.windowIds ?? []}
            busy={busy}
            onAsk={onAsk}
          />
        ))
      )}

      {/* The only route when a link has nothing free on it, and it reports its
          own state where it stands rather than vanishing — the same swap a slot
          row makes between Request and a Requested chip. Nothing at all once
          they're connected: a link is an ordinary way to reach a friend's
          places, so there is simply nothing left to ask for. */}
      {connect === "sent" ? (
        <Chip tone="pending" className="self-center">
          Friend request sent
        </Chip>
      ) : connect === "ask" ? (
        <Button
          variant="secondary"
          size="lg"
          className="w-full"
          onClick={() => onAsk(null, null)}
          disabled={busy !== null}
        >
          {busy === FRIEND_ONLY ? (
            <LuLoaderCircle className="animate-spin" />
          ) : (
            "Ask to be friends"
          )}
        </Button>
      ) : null}

      {/* Dates only — the connect chip above says its own piece, and this line
          used to speak for both without naming which. */}
      {standing && standing.windowIds.length > 0 ? (
        <p className="px-1 text-center text-sm text-muted">
          {standing.confirmed
            ? `${firstName} confirmed your dates — they're yours.`
            : `Sent — ${firstName} will get back to you.`}
        </p>
      ) : null}

      {/* Without this the button just reappears and a failure is invisible. The
          retry re-sends the ask that failed, so nothing has to be found again. */}
      {failed ? (
        <div className="flex flex-col items-center gap-3 px-1">
          <p className="text-center text-sm text-danger">
            {failed === "refused"
              ? "That didn't go through — the link may have been turned off."
              : "Couldn't reach kip just now, so nothing was sent. Check your connection."}
          </p>
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ListingBlock({
  listing,
  windows,
  canAsk,
  requestedWindowIds,
  busy,
  onAsk,
}: {
  listing: PortalListing;
  windows: readonly PortalWindow[];
  canAsk: boolean;
  requestedWindowIds: readonly string[];
  busy: string | null;
  onAsk: (listingId: string | null, window: PortalWindow | null) => void;
}): ReactElement {
  const TypeIcon = listingTypeIcon(listing.type);
  return (
    <div className="flex flex-col gap-3 rounded-3xl bg-surface p-4 shadow-card">
      {/* The token in each URL is what opens the object, so a link-holder
          browses the same photos a friend would. */}
      <PhotoGallery photos={listing.photos} heroClassName="h-44 w-full" />
      <div className="flex items-start gap-3">
        <span className="bg-accent-soft grid h-10 w-10 shrink-0 place-items-center rounded-2xl text-accent-ink">
          <TypeIcon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-bold tracking-[-0.01em]">{listing.title}</h2>
          <p className="flex items-center gap-1 text-sm text-muted">
            <LuMapPin className="shrink-0" size={14} />
            <span className="truncate">{listing.locationLabel}</span>
          </p>
        </div>
        <Chip tone="type" className="mt-0.5">
          {listingTypeLabel(listing.type)}
        </Chip>
      </div>
      {listing.description ? (
        <p className="text-[0.9375rem] leading-relaxed text-text/90">
          {listing.description}
        </p>
      ) : null}

      {windows.length === 0 ? (
        <p className="border-t border-border pt-3 text-sm text-muted">
          No open dates right now.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border border-t border-border">
          {windows.map((window) => (
            <li key={window.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <span className="block text-[0.9375rem] font-semibold">
                  {formatDateRange(window.start, window.end)}
                </span>
                <p className="text-sm text-muted">
                  {nights(window.start, window.end)} nights
                  {window.details ? ` · ${window.details}` : ""}
                </p>
              </div>
              {/* A range the visitor holds is listed only because it's theirs, so a
                  stranger's grey chip would tell them nothing. */}
              {window.bookedByMe ? (
                <Chip tone="confirmed">Booked by you</Chip>
              ) : window.booked ? (
                <Chip tone="booked">Booked</Chip>
              ) : requestedWindowIds.includes(window.id) ? (
                <Chip tone="pending">Requested</Chip>
              ) : canAsk ? (
                <Button
                  onClick={() => onAsk(listing.listingId, window)}
                  disabled={busy !== null}
                >
                  {busy === window.id ? (
                    <LuLoaderCircle className="animate-spin" />
                  ) : (
                    "Request"
                  )}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
