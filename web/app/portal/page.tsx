"use client";

import { type ReactElement, useEffect, useState } from "react";
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
import Wordmark from "../../components/wordmark";
import {
  fetchMyBookingsWith,
  requestStayViaPortal,
} from "../../utils/bookings";
import { formatDateRange, nights } from "../../utils/format";
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

// Stands in for a window id when the ask carries no dates, so one piece of state
// covers both "requested these dates" and "asked to connect".
const FRIEND_ONLY = "__friend__";

// What the visitor tapped, held while they make an account. A null window means
// they asked to connect rather than for specific dates.
type Ask = { listingId: string | null; window: PortalWindow | null };

// Whatever the visitor already has with this owner. Dates and friendship are two
// different asks and are tracked separately: one pending friend request used to
// suppress every Request button on the page, so the dates appeared and then
// vanished the moment the check resolved.
//
// `windowIds` is a set because a visitor may have asked for several ranges —
// bookings have auto-ids, so nothing stops them. `confirmed` decides the wording:
// "Sent — they'll get back to you" is wrong once they have.
type StandingAsk = {
  windowIds: readonly string[];
  confirmed: boolean;
  connectPending: boolean;
};

// The public share-link page — the one screen a non-friend can reach, and the
// only one outside the auth gate. Browsing needs no account: the page signs the
// visitor in anonymously and reads the place and its live dates straight from
// Firestore, gated on a grant proving they hold the link.
//
// Asking for something needs an account (the request is a document stamped with
// your user id), but the account comes AFTER the tap: the buttons are live when
// signed out, and tapping one holds the ask and opens sign-up in place. Nobody is
// made to create an account before they've seen whether it's worth it.
export default function PortalPage(): ReactElement {
  const { user, profile, profileReady, ensureAnonymous } = useKip();
  const [page, setPage] = useState<PortalContent | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [standing, setStanding] = useState<StandingAsk | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [failed, setFailed] = useState(false);
  const portal = page?.portal ?? null;

  // Sign the visitor in anonymously before reading. Free dates are read LIVE from
  // the host's records, and the rule that allows that needs an identity to hang
  // the visitor's proof-of-token on — a read request has no body to carry the
  // token inline. It's invisible: no prompt, no account, and if they later sign
  // in for real the same identity is upgraded rather than replaced.
  // Pasting a different link while already on this page changes only the
  // fragment, and a browser treats that as the same document — no reload, no
  // re-render. Nothing would happen at all without listening for it.
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
    setState("loading");
    setPage(null);
    setStanding(null);
    // Sign-in is handed over in flight: the portal doc is world-readable by id,
    // so reading it doesn't have to queue behind auth.
    fetchPortalPage(token, ensureAnonymous())
      .then((found) => {
        if (!live) return;
        setPage(found);
        setState(found ? "ready" : "missing");
      })
      .catch((error: unknown) => {
        console.error(error);
        if (live) setState("missing");
      });
    return () => {
      live = false;
    };
  }, [token, ensureAnonymous]);

  // Once signed in, surface what the visitor already has with this owner: which
  // ranges they've asked for, and whether they've asked to connect. The two are
  // reported separately so neither can hide the other's affordance.
  useEffect(() => {
    if (!user || user.isAnonymous || !portal) return;
    Promise.all([
      fetchMyBookingsWith(user.uid, portal.ownerId),
      fetchMyConnectRequest(user.uid, portal.ownerId),
    ])
      .then(([bookings, request]) => {
        const live = bookings.filter(
          (booking) => booking.status !== "CANCELLED",
        );
        setStanding({
          windowIds: live.map((booking) => booking.windowId),
          confirmed: live.some((booking) => booking.status === "CONFIRMED"),
          connectPending: request !== null,
        });
      })
      .catch((error: unknown) => console.error(error));
  }, [user, portal]);

  // Send the held ask as soon as the visitor has both an account and a name to
  // put on it. Clearing `ask` first means a later dependency change can't fire a
  // second request. The name comes off the kip profile, never the Auth account:
  // falling back to `user.email` would write their address into a document the
  // host can read.
  useEffect(() => {
    if (!ask || !portal || !user || !profileReady || !profile?.displayName) {
      return;
    }
    const { listingId, window: slot } = ask;
    setAsk(null);
    setBusy(slot?.id ?? FRIEND_ONLY);
    setFailed(false);
    const sender = {
      uid: user.uid,
      username: profile.username,
      displayName: profile.displayName,
      photoURL: profile.photoURL,
    };

    // Re-claim the grant as whoever we are NOW. Making an account does NOT
    // upgrade the anonymous visitor signed in on load — Firebase mints a fresh
    // uid — so the grant written back then belongs to an identity we just
    // discarded, and the booking write (which the rules gate on holding a grant)
    // would be refused. Idempotent, so this costs one write.
    claimGrant(portal.id, user.uid)
      // Asking for dates IS a booking request — the same document a friend would
      // create. Asking to connect is the only thing that needs its own record.
      .then(() =>
        listingId && slot
          ? requestStayViaPortal(sender.uid, portal.ownerId, listingId, slot)
          : sendPortalConnectRequest(portal, sender),
      )
      // Never confirmed: a link is not friendship, so a visitor's ask always
      // waits for the host, even on a slot a friend could have booked instantly.
      .then(() =>
        setStanding((current) => ({
          windowIds: slot
            ? [...(current?.windowIds ?? []), slot.id]
            : (current?.windowIds ?? []),
          confirmed: current?.confirmed ?? false,
          connectPending: slot ? (current?.connectPending ?? false) : true,
        })),
      )
      .catch((error: unknown) => {
        console.error(error);
        setFailed(true);
      })
      .finally(() => setBusy(null));
  }, [ask, portal, user, profileReady, profile]);

  // An anonymous visitor is signed in as far as Firebase is concerned, but has no
  // account in any sense that matters here — they still need a real one to ask.
  const identified = Boolean(user) && user?.isAnonymous === false;
  const needsAccount = ask !== null && !identified;
  const needsName =
    ask !== null && identified && profileReady && !profile?.displayName;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 items-center gap-3 px-4">
        {/* A share link is often someone's first sight of kip, so the mark is
            the way in. `basePath` is set on the deployed build, and an anchor
            rather than a router push because this page sits outside the app's
            nav stack entirely. */}
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
          // The same mark the app boots behind, so arriving on a link doesn't
          // look like a different product mid-load.
          <div className="flex min-h-[60vh] items-center justify-center">
            <span className="bg-gradient-accent grid h-16 w-16 animate-pulse place-items-center rounded-3xl text-3xl font-extrabold text-white shadow-glow">
              k
            </span>
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
            isOwner={identified && user?.uid === portal.ownerId}
            standing={standing}
            busy={busy}
            failed={failed}
            onAsk={(listingId, slot) => {
              setFailed(false);
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

// Shown right after a visitor makes an account from a share link: the one field
// kip needs before anything is written, since the host has to see a name rather
// than a blank. No handle — that's optional and lives in Settings.
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
  isOwner,
  standing,
  busy,
  failed,
  onAsk,
}: {
  portal: Portal;
  windows: Readonly<Record<string, readonly PortalWindow[]>>;
  failed: boolean;
  isOwner: boolean;
  standing: StandingAsk | null;
  busy: string | null;
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

      {portal.listings.length === 0 ? (
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

      {/* Connecting without picking dates — the only route when a link has
          nothing free on it, and the friendlier ask when it does. The button
          says what it does, so the paragraph that used to explain it was just
          the same sentence twice. */}
      {!isOwner && !standing?.connectPending ? (
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

      {standing &&
      (standing.windowIds.length > 0 || standing.connectPending) ? (
        <p className="px-1 text-center text-sm text-muted">
          {standing.confirmed
            ? `${firstName} confirmed your dates — they're yours.`
            : `Sent — ${firstName} will get back to you.`}
        </p>
      ) : null}

      {/* Without this a failure is invisible: the button just reappears and the
          visitor has no idea whether anything was sent. */}
      {failed ? (
        <p className="px-1 text-center text-sm text-danger">
          That didn't go through. Check your connection and try again — the link
          may also have been turned off.
        </p>
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
      {/* Each photo's URL rides along with the place — copied into a date-range
          link, read live by the wider ones — and the token in it is what opens
          the object, so the visitor browses the same photos a friend would. The
          whole set is already here, so anything less than the gallery would be
          withholding what was sent. */}
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
              {/* Before the plain "Booked": a range the visitor holds is only
                  listed at all because it's theirs, and the same grey chip a
                  stranger's stay gets would tell them nothing. */}
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
