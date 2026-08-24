"use client";

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { FaGoogle } from "react-icons/fa";
import { LuLoaderCircle, LuMapPin } from "react-icons/lu";
import Avatar from "../../components/avatar";
import { PhotoGallery } from "../../components/cover-photo";
import ReachField, {
  codeReady,
  confirmReach,
  EMPTY_REACH,
  type ReachState,
  reachError,
  sendReach,
} from "../../components/reach-field";
import SiteFooter from "../../components/site-footer";
import ThemeButton from "../../components/theme-button";
import Button from "../../components/ui/button";
import Chip from "../../components/ui/chip";
import Input from "../../components/ui/input";
import Sheet from "../../components/ui/sheet";
import Wordmark, { Mark } from "../../components/wordmark";
import {
  fetchMyBookingsWith,
  requestStayViaPortal,
  SlotGone,
} from "../../utils/bookings";
import {
  clientState,
  type DebugDetail,
  recordDebugEvent,
} from "../../utils/debug";
import { auth, errorCode } from "../../utils/firebase";
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

// Why an ask never went out, and the advice differs for every one: a refused
// write may mean a revoked link, a stall never reached the server, and the four
// slot causes are the world having moved rather than anything being wrong.
type Failure = "refused" | "stalled" | "taken" | "moved" | "removed" | "past";

// Said in the visitor's terms, never the rule's. The four slot causes read as
// news about the dates rather than as something they did wrong, because that is
// what they are — and each names what happened, since "unavailable" would leave
// someone wondering whether to wait or ask for something else.
const FAILURE_COPY: Record<Failure, string> = {
  refused: "That didn't go through — the link may have been turned off.",
  stalled:
    "Couldn't reach kip just now, so nothing was sent. Check your connection.",
  taken: "Someone else took those dates while you were deciding.",
  moved: "Those dates changed, so nothing was sent. Take another look.",
  removed: "Those dates aren't offered any more.",
  past: "Those dates have already been and gone.",
};

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

// The one screen outside the auth gate. Nothing here needs an account: browsing
// needs no identity at all, and asking needs only a name. The buttons are live
// from the first paint; tapping one holds the ask and asks who they are in place.
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
  // Lifted out of the form: the form unmounts the moment the profile lands, and
  // these are the two things that still have something to say afterwards.
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
    if (!user || !hostId) return;
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
    // Runs for an anonymous visitor too, and must: they are the ones who ask.
    // Someone returning to their own pending ask hours later is signed in as the
    // same account (Firebase persists to IndexedDB), so this is what recognises
    // them instead of offering an ask they already made.
  }, [user, hostId]);

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
        // A slot that moved is not a refusal — it is news, and the visitor is
        // owed which news. Everything else reaching here really was refused.
        const gone = error instanceof SlotGone ? error.why : null;
        report(gone ?? "refused", { code: errorCode(error) });
        setFailed({
          reason: gone ?? "refused",
          ask: { listingId, window: slot },
        });
      })
      .finally(() => setBusy(null));
  }, [ask, portal, user, profileReady, profile, report]);

  // A name is what an ask needs — not an account. Someone who has never typed
  // one has nothing to look up either, so their ask is live from the first
  // paint, which is the visitor this whole page exists for.
  const named = Boolean(profile?.displayName);
  const isOwner = Boolean(user) && user?.uid === portal?.ownerId;
  const connect: Connect = isOwner
    ? "none"
    : !named
      ? "ask"
      : standing === null
        ? "unknown"
        : standing.friend
          ? "none"
          : standing.connectPending
            ? "sent"
            : "ask";
  const needsName = ask !== null && profileReady && !named;
  // A held ask spins the control it came from, so a tap is never a no-op. The
  // sheet covers "no name"; it does not cover the gap between the page loading
  // and the profile answering, where a tap used to show nothing at all.
  const holding = ask === null ? busy : (ask.window?.id ?? FRIEND_ONLY);

  // An ask held with NEITHER sheet up is waiting on the profile. Deliberately
  // not extended to the send: that write is Firestore's, which queues offline
  // and lands on reconnect.
  useEffect(() => {
    if (ask === null || needsName) return;
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
  }, [ask, needsName, profileUnreachable, report]);

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
            notice={notice}
            failed={failed?.reason ?? null}
            onRetry={() => {
              if (!failed) return;
              setNotice(null);
              setAsk(failed.ask);
              setFailed(null);
            }}
            onAsk={(listingId, slot) => {
              // Both clear: a fresh ask must not sit under the explanation of
              // why the last one didn't go.
              setNotice(null);
              setFailed(null);
              setAsk({ listingId, window: slot });
            }}
          />
        ) : null}

        <SiteFooter className="mx-auto mt-12 max-w-2xl" />
      </main>

      {/* Closing it abandons the held ask, which is the only way out and needs
          no separate control. */}
      {/* Held open past the profile write when an address was given: writing it
          flips `named` and the ask flies, but a one-time send has no other
          guard against a typo than the address read back. */}
      <Sheet
        open={needsName || sentTo !== null}
        onClose={() => {
          setAsk(null);
          setSentTo(null);
        }}
        title={sentTo ? "Check your email" : "What should we call you?"}
      >
        {sentTo ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">
              Your request is already on its way. Open the link at {sentTo} and
              your kip will work on any device — nothing here is waiting on it.
            </p>
            <Button size="lg" onClick={() => setSentTo(null)}>
              Done
            </Button>
          </div>
        ) : (
          <NameForm
            host={portal?.ownerName.split(" ")[0] ?? null}
            onSent={setSentTo}
            onAbandon={(why) => {
              setAsk(null);
              setNotice(why);
            }}
          />
        )}
      </Sheet>
    </div>
  );
}

// The host has to see a name rather than a blank. No handle, and no account —
// the ask goes out on this alone, and keeping it is a separate offer made after.
function NameForm({
  host,
  onSent,
  onAbandon,
}: {
  host: string | null;
  onSent: (email: string) => void;
  // Drops the held ask AND carries the reason up. Needed when the visitor turns
  // out to already have an account: the send effect would otherwise lodge the
  // request from an identity they never asked as — and dropping it unmounts
  // this form, so anything said down here would never be read.
  onAbandon: (why: string) => void;
}): ReactElement {
  const { user, signIn, completeOnboarding } = useKip();
  const [name, setName] = useState(user?.displayName ?? "");
  const [reach, setReach] = useState<ReachState>(EMPTY_REACH);
  const recaptcha = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalid = name ? validateDisplayName(name) : null;
  const reachInvalid = reachError(reach.raw);
  const problem = invalid ?? reachInvalid ?? error;

  // The one path that identifies you BEFORE the ask, and the only one that needs
  // no name typed: Google already knows it. The other two send on the name in the
  // field and prove the address or number afterwards.
  async function googleAsk(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { sameAccount } = await signIn();
      // Landing in an account they already had: it has its own name and photo,
      // which must not be overwritten, and the ask must not fly from it as a
      // side effect of adding a way to be reached.
      if (!sameAccount) {
        onAbandon(
          "That Google account is already on kip — you're in it now. Ask again and it'll go from this account.",
        );
        return;
      }
      const known = auth().currentUser?.displayName?.trim();
      if (!known) {
        // Nothing to write, so fall back to the field rather than sending an ask
        // that would reach the host as a blank.
        setError("Google didn't share a name. Type one.");
        return;
      }
      await completeOnboarding(known);
    } catch (caught) {
      console.error(caught);
      setError("That didn't work. Try again, or use email.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(): Promise<void> {
    if (validateDisplayName(name) || reachInvalid) return;
    setBusy(true);
    setError(null);
    let emailed: string | null = null;
    // Two failures, two remedies: a bad destination is corrected here, a failed
    // write is retried. One catch blamed the destination for both.
    if (reach.pending) {
      try {
        const { sameAccount } = await confirmReach(reach.pending, reach.code);
        // That number already had a kip account, so they are in it now — with
        // its own name and photo, which the sheet's must not overwrite. The ask
        // stays with the account that made it; only that browser can act on it.
        if (!sameAccount) {
          // Dropping the held ask is what makes this true: otherwise the send
          // effect fires the moment the new account's profile lands, lodging
          // the request from an identity they never asked as. The message goes
          // UP, because dropping the ask unmounts this form.
          setBusy(false);
          onAbandon(
            "That number is already on kip — you're in it now. Ask again and it'll go from this account.",
          );
          return;
        }
      } catch (caught) {
        console.error(caught);
        setError("Wrong code. Check it, or ask for another.");
        setBusy(false);
        return;
      }
    } else if (reach.raw) {
      try {
        // Sent FIRST, and an emailed address handed UP before the profile write,
        // which unmounts this form the moment it lands.
        const holder = recaptcha.current;
        if (!holder) throw new Error("no element for the check to bind to");
        const sent = await sendReach(reach.raw, host ?? "your host", holder);
        if (sent.pending) {
          // A code is on its way; the ask waits for it to be typed.
          setReach({ ...reach, pending: sent.pending, sentTo: sent.sentTo });
          setBusy(false);
          return;
        }
        // NOT handed up yet: doing so swaps the sheet's body and unmounts this
        // form, so a profile write that then failed would have nowhere to say
        // so — under a line claiming the request was already on its way.
        emailed = sent.sentTo;
      } catch (caught) {
        console.error(caught);
        // The profile is unwritten, so the ask has not gone: they can correct
        // it or clear it and send without one.
        setError("Couldn't send that. Check it, or clear it.");
        setBusy(false);
        return;
      }
    }

    try {
      await completeOnboarding(name.trim());
    } catch (caught) {
      console.error(caught);
      setError("Couldn't save that. Check your connection.");
      setBusy(false);
      return;
    }
    setBusy(false);
    if (emailed) onSent(emailed);
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Input
        autoComplete="name"
        autoFocus
        invalid={Boolean(invalid)}
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Your name"
      />
      <ReachField
        state={reach}
        onChange={(next) => {
          setError(null);
          setReach(next);
        }}
        hostRef={recaptcha}
        invalid={Boolean(reachInvalid || error)}
      />
      {/* Below both fields and above the button: it describes the reach field
          it follows, and carries whatever is wrong. Nothing sits between the
          two inputs, and the name needs no caption — the title asks for it.

          Two lines are reserved so the swap never resizes the sheet, which
          grows upward and would shove the fields off the thumb. Two rather
          than one because the host's first name is in the standing copy, so
          its length is not kip's to promise. */}
      <p
        aria-live="polite"
        className={`min-h-10 text-sm leading-5 ${problem ? "text-danger" : "text-muted"}`}
      >
        {problem ??
          `Only so kip can reach you — ${host ?? "they"} never sees it.`}
      </p>
      <Button
        type="submit"
        size="lg"
        disabled={
          busy ||
          Boolean(validateDisplayName(name) || reachInvalid) ||
          Boolean(reach.pending && !codeReady(reach))
        }
      >
        {busy ? <LuLoaderCircle className="animate-spin" /> : "Send request"}
      </Button>

      {/* Below the button it replaces, because that is what it is: the same ask
          sent a different way. Above it, it read as the preferred route. */}
      <div className="flex items-center gap-3 py-0.5">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs text-faint">or</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <Button
        type="button"
        variant="secondary"
        size="lg"
        disabled={busy}
        onClick={googleAsk}
      >
        <FaGoogle />
        Request with Google
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
  notice,
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
  // Why an ask was dropped rather than sent — the visitor turned out to have an
  // account already. Lives up here because dropping the ask unmounts the sheet
  // that would otherwise have said so.
  notice: string | null;
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

      {notice ? (
        <p className="px-1 text-center text-sm text-muted">{notice}</p>
      ) : null}

      {/* Without this the button just reappears and a failure is invisible. The
          retry re-sends the ask that failed, so nothing has to be found again. */}
      {failed ? (
        <div className="flex flex-col items-center gap-3 px-1">
          <p className="text-center text-sm text-danger">
            {FAILURE_COPY[failed]}
          </p>
          {/* Retrying a slot that has gone would only fail again the same way,
              so the four of those offer nothing and say so instead. */}
          {failed === "refused" || failed === "stalled" ? (
            <Button variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
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
