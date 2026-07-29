"use client";

import { type ReactElement, useState } from "react";
import { formatDateRange } from "../utils/format";
import { useKip } from "../utils/store";
import type {
  AvailabilityWindow,
  ConnectRequest,
  Listing,
} from "../utils/types";
import Avatar from "./avatar";
import { useAction, useDialog } from "./dialog";
import Button from "./ui/button";
import Chip from "./ui/chip";

// Which of your links a request came through, with everything needed to reach or
// revoke it. Derived from your OWN live state rather than by reading the portal
// doc: the recipient of a link-borne request is by definition that link's owner,
// so the client already holds every token they have out — and a token that isn't
// among them is one already revoked or regenerated, which is exactly the case
// where there's nothing left to offer.
type LinkTarget =
  | { readonly scope: "USER" }
  | { readonly scope: "LISTING"; readonly listing: Listing }
  | {
      readonly scope: "SLOT";
      readonly listing: Listing;
      readonly window: AvailabilityWindow;
    };

function findLink(
  portalId: string | null,
  profilePortalId: string | null,
  listings: readonly Listing[],
  windowsByListing: Readonly<Record<string, readonly AvailabilityWindow[]>>,
): LinkTarget | null {
  if (!portalId) return null;
  if (portalId === profilePortalId) return { scope: "USER" };
  const room = listings.find((listing) => listing.publicPortalId === portalId);
  if (room) return { scope: "LISTING", listing: room };
  for (const listing of listings) {
    const window = (windowsByListing[listing.id] ?? []).find(
      (candidate) => candidate.publicPortalId === portalId,
    );
    if (window) return { scope: "SLOT", listing, window };
  }
  return null;
}

// Someone asking to be friends, shown in Home's Friend requests section and on
// the Friends tab. Asking to STAY is a different thing entirely and renders as a
// BookingRow in its own section — the two used to share one stack, and readers
// had to tell them apart by card shape.
//
// A request that arrived through a share link is marked as such: it's likely from
// someone you don't know, and how they reached you is the main thing you need in
// order to answer. The link is also the only thing that can stop them asking
// again, so it's reachable from here — and offered for turning off on a decline.
//
// The person themselves taps through to their page, the same way a host does on
// a place card. Deciding whether to let someone in is the moment you most want
// to look at them, and for a stranger from a link this card was the ONLY place
// they appeared — their page can't be reached by handle (they may have none) or
// from a friends list they aren't in.
export default function RequestCard({
  request,
}: {
  request: ConnectRequest;
}): ReactElement {
  const {
    acceptRequest,
    declineRequest,
    prefs,
    myListings,
    myWindows,
    navigate,
    screen,
    revokeUserPortal,
    revokeListingPortal,
    revokeSlotPortal,
  } = useKip();
  const { confirm } = useDialog();
  const run = useAction();
  const [busy, setBusy] = useState(false);
  const viaLink = request.portalId !== null;
  // This card also sits ON the requester's page, which is where the accept and
  // decline live for someone you arrived at rather than were shown. Linking
  // there from there would push a second copy of the screen it's already on.
  const onTheirPage = screen.kind === "person" && screen.id === request.from;
  const link = findLink(
    request.portalId,
    prefs.profilePortalId,
    myListings,
    myWindows,
  );

  async function accept(): Promise<void> {
    setBusy(true);
    try {
      await acceptRequest(request);
    } catch (error) {
      console.error(error);
    } finally {
      setBusy(false);
    }
  }

  // Each link is controlled where it was made: a profile link on your own page,
  // a room's in that room's Sharing section, a date link's in that slot's sheet
  // on the room page. The sheet isn't a screen, so the room screen names the
  // slot and the page opens it — landing on the room instead would leave you
  // hunting the one set of dates the card just told you they came through.
  function openLink(target: LinkTarget): void {
    if (target.scope === "USER") {
      navigate({ kind: "person", id: request.to });
    } else if (target.scope === "LISTING") {
      navigate({ kind: "room", id: target.listing.id });
    } else {
      navigate({
        kind: "room",
        id: target.listing.id,
        windowId: target.window.id,
      });
    }
  }

  function revokeLink(target: LinkTarget): Promise<void> {
    if (target.scope === "USER") return revokeUserPortal();
    else if (target.scope === "LISTING")
      return revokeListingPortal(target.listing);
    else return revokeSlotPortal(target.listing.id, target.window);
  }

  // Saying no settles this one ask and nothing more — the link is still live and
  // they can walk back through it — so the moment to mention that is here. The
  // prompt names what turning it off costs, because the three scopes are not
  // remotely the same hammer: a profile link is every place, for everyone you've
  // ever sent it to; a date link is one set of nights.
  function revokePrompt(target: LinkTarget) {
    const closing =
      "Declining doesn't stop them asking again — turning the link off is what does.";
    if (target.scope === "USER") {
      return {
        title: "Turn off your profile link?",
        body: `This is the link you send to everyone, and it covers every place you share. Turning it off revokes it for all of them at once, not just for this person. ${closing}`,
        confirmLabel: "Turn off",
        tone: "danger" as const,
      };
    } else if (target.scope === "LISTING") {
      return {
        title: `Turn off the link to ${target.listing.title}?`,
        body: `Everyone you've sent that room's link to loses it, along with every date you open there. ${closing}`,
        confirmLabel: "Turn off",
        tone: "danger" as const,
      };
    } else {
      return {
        title: "Turn off the link to those dates?",
        body: `Just ${formatDateRange(target.window.start, target.window.end)} at ${target.listing.title}: anyone else holding that link loses those nights and nothing else. ${closing}`,
        confirmLabel: "Turn off",
        tone: "danger" as const,
      };
    }
  }

  async function decline(): Promise<void> {
    setBusy(true);
    try {
      await declineRequest(request);
    } finally {
      setBusy(false);
    }
    if (!link) return;
    const ok = await confirm(revokePrompt(link));
    if (ok) run(() => revokeLink(link));
  }

  const identity = (
    <>
      <Avatar
        name={request.fromName}
        photoURL={request.fromPhotoURL}
        className="h-11 w-11 text-base"
        ring
      />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[0.9375rem] font-bold">
          {request.fromName || "Someone"}
          {request.fromUsername ? (
            <span className="ml-1.5 font-normal text-muted">
              @{request.fromUsername}
            </span>
          ) : null}
        </span>
        <span className="block truncate text-sm text-muted">
          asked to be friends
        </span>
      </div>
    </>
  );

  return (
    <div className="rounded-3xl bg-surface shadow-card">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-3">
          {onTheirPage ? (
            identity
          ) : (
            <button
              type="button"
              onClick={() => navigate({ kind: "person", id: request.from })}
              className="-m-1 flex min-w-0 flex-1 items-center gap-3 rounded-2xl p-1 text-left"
            >
              {identity}
            </button>
          )}
          {/* The chip stays a passive label — a status pill that takes a tap
              reads as a button. The way to the link is its own quiet control,
              and it's absent when the link is already off. */}
          {viaLink ? (
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Chip tone="neutral">via your link</Chip>
              {link ? (
                <button
                  type="button"
                  onClick={() => openLink(link)}
                  className="text-sm font-semibold text-accent-ink hover:opacity-80"
                >
                  Manage link
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* What you're granting sits beside the buttons rather than above them:
            three stacked rows made a two-button card feel like a form. It only
            fits alongside from sm up — at 390px the sentence needs the width. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <p className="min-w-0 flex-1 text-sm text-muted">
            Friends can see every place you share, whenever it's free.
          </p>
          <div className="flex shrink-0 justify-end gap-2">
            <Button variant="ghost" onClick={decline} disabled={busy}>
              Decline
            </Button>
            <Button onClick={accept} disabled={busy}>
              Add friend
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
