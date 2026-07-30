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

// From your own live state, not the portal doc: you own every link that can
// reach you, so a token you don't hold is one already revoked.
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

// Asking to STAY is a different thing and renders as a BookingRow. A link-borne
// request says so, since how they reached you is the main thing you need to
// answer — and the link is the only way to stop them asking again. The person
// taps through, because for a stranger from a link this card is the only place
// they appear at all.
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
  // This card also sits ON the requester's page, where linking through would
  // push a second copy of the screen it's already on.
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

  // Each link is controlled where it was made. A slot's sheet isn't a screen,
  // so the room screen names the slot and the page opens it.
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

  // Declining leaves the link live, so this is the moment to say so. The prompt
  // names the scope, because a profile link and a date link are not the same
  // hammer at all.
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
          {/* Passive label: a status pill that took a tap would read as a button. */}
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

        {/* Beside the buttons from sm up; at 390px the sentence needs the width. */}
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
