"use client";

import { type ReactElement, useEffect, useRef, useState } from "react";
import {
  LuCamera,
  LuCheck,
  LuLoaderCircle,
  LuMail,
  LuPencil,
  LuX,
} from "react-icons/lu";
import { fetchStaysOf } from "../utils/bookings";
import { isExpired } from "../utils/format";
import { fetchUserProfile } from "../utils/friends";
import { PhotoEncodeError } from "../utils/photos";
import { sendBookingConnectRequest } from "../utils/requests";
import { useKip } from "../utils/store";
import type { Booking, Profile } from "../utils/types";
import {
  isUsernameAvailable,
  normalizeUsername,
  validateDisplayName,
  validateUsername,
} from "../utils/username";
import Avatar from "./avatar";
import BookingRow from "./booking-row";
import { useAction, useDialog } from "./dialog";
import PlaceCard from "./place-card";
import RequestCard from "./request-card";
import ShareLink from "./share-link";
import Button from "./ui/button";
import FieldNote from "./ui/field-note";
import IconButton from "./ui/icon-button";
import Input from "./ui/input";
import { Group, Section } from "./ui/list";
import Switch from "./ui/switch";

// A glance at what they are up to, not a second Trips screen.
const ELSEWHERE_PREVIEW = 5;

// The heading itself becomes the field, so there's no form for a Save button to
// belong to — Enter or blur commits, Escape reverts.
function EditableName({ name }: { name: string }): ReactElement {
  const { profile, updateDisplayName } = useKip();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  // Escape has to beat the blur that follows it, or the blur commits the very
  // edit that was just abandoned.
  const reverting = useRef(false);

  // An acknowledgement, not a state — once the field is a heading again there's
  // nothing for it to sit beside.
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [saved]);

  function open(): void {
    // A blur isn't guaranteed to arrive, so a stale flag would swallow the next
    // edit's commit.
    reverting.current = false;
    setDraft(profile?.displayName ?? "");
    setSaved(false);
    setFailed(false);
    setEditing(true);
  }

  async function commit(): Promise<void> {
    if (reverting.current) {
      reverting.current = false;
      return;
    }
    setEditing(false);
    const trimmed = draft.trim();
    // Nowhere to argue, so an unsaveable name reverts; the field already said why.
    if (
      !profile ||
      validateDisplayName(draft) ||
      trimmed === profile.displayName
    )
      return;
    setFailed(false);
    try {
      await updateDisplayName(trimmed);
      setSaved(true);
    } catch (error) {
      console.error(error);
      setFailed(true);
    }
  }

  if (editing) {
    const invalid = validateDisplayName(draft);
    return (
      <div className="mx-auto flex w-full max-w-xs flex-col gap-1.5">
        <Input
          autoFocus
          aria-label="Display name"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            else if (event.key === "Escape") {
              reverting.current = true;
              setEditing(false);
            }
          }}
          onBlur={commit}
          className="text-center font-bold"
        />
        {invalid ? <FieldNote tone="danger">{invalid}</FieldNote> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex w-full min-w-0 items-center justify-center gap-1">
        <h2 className="min-w-0 truncate text-2xl font-extrabold tracking-[-0.03em]">
          {name}
        </h2>
        <IconButton label="Edit your display name" onClick={open}>
          <LuPencil size={16} />
        </IconButton>
      </div>
      {saved ? <FieldNote tone="success">Saved.</FieldNote> : null}
      {failed ? (
        <FieldNote tone="danger">Couldn't save that. Try again.</FieldNote>
      ) : null}
    </div>
  );
}

// Their own surface and shadow, because what's behind them is a photo.
const PHOTO_CONTROL =
  "grid h-7 w-7 place-items-center rounded-full bg-surface text-text shadow-card transition hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-50";

// The photo IS the control's label, so the controls sit on it. Removing falls
// back to the provider's photo, so it only appears when wearing your own.
function ProfilePhoto({
  name,
  photoURL,
}: {
  name: string;
  photoURL: string | null;
}): ReactElement {
  const { setProfilePhoto, providerPhotoURL } = useKip();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function change(file: Blob | null): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await setProfilePhoto(file);
    } catch (caught) {
      console.error(caught);
      setError(
        caught instanceof PhotoEncodeError
          ? "kip couldn't read that image. Try a different photo."
          : file
            ? "That didn't upload. Check your connection and try again."
            : "Couldn't remove that. Try again.",
      );
    } finally {
      setBusy(false);
      // The same file twice fires no change event unless the input is cleared.
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative inline-flex">
        <Avatar
          name={name}
          photoURL={photoURL}
          className="h-20 w-20 text-2xl"
          ring
        />
        {photoURL && photoURL !== providerPhotoURL ? (
          <button
            type="button"
            onClick={() => change(null)}
            disabled={busy}
            aria-label="Remove your photo"
            title="Remove your photo"
            className={`absolute bottom-0 left-0 ${PHOTO_CONTROL}`}
          >
            <LuX size={14} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          aria-label="Change your photo"
          title="Change your photo"
          className={`absolute bottom-0 right-0 ${PHOTO_CONTROL}`}
        >
          {busy ? (
            <LuLoaderCircle className="animate-spin" size={14} />
          ) : (
            <LuCamera size={14} />
          )}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            // Cancelling the picker fires nothing, so null would mean "remove".
            const chosen = event.target.files?.[0];
            if (chosen) change(chosen);
          }}
        />
      </div>
      {error ? <FieldNote tone="danger">{error}</FieldNote> : null}
    </div>
  );
}

// Self view only; Settings mirrors the switch.
function SelfIdentity(): ReactElement | null {
  const { profile, claimUsername, setSearchable } = useKip();
  const { confirm } = useDialog();
  const [claiming, setClaiming] = useState(false);
  const [username, setUsername] = useState("");
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalized = normalizeUsername(username);
  const formatError = username ? validateUsername(username) : null;

  // Debounced availability check, only once the format is valid.
  useEffect(() => {
    if (!username || formatError) {
      setAvailable(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    setAvailable(null);
    const timer = setTimeout(() => {
      isUsernameAvailable(normalized)
        .then(setAvailable)
        .catch((caught) => console.error("isUsernameAvailable", caught))
        .finally(() => setChecking(false));
    }, 400);
    return () => clearTimeout(timer);
  }, [username, normalized, formatError]);

  if (!profile) return null;
  const handle = profile.username;

  async function toggleSearchable(next: boolean): Promise<void> {
    // The rules refuse `searchable: true` without a handle, so claim one first.
    if (next && !handle) {
      setClaiming(true);
      return;
    }
    setError(null);
    try {
      await setSearchable(next);
    } catch (caught) {
      console.error(caught);
      setError("Couldn't save that. Try again.");
    }
  }

  async function claim(): Promise<void> {
    const ok = await confirm({
      title: `Claim @${normalized}?`,
      body: "Your username is permanent — it can't be changed or given up later.",
      confirmLabel: "Claim",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await claimUsername(normalized);
      setClaiming(false);
      setUsername("");
    } catch (caught) {
      console.error(caught);
      setError("That username was just taken. Try another.");
      setAvailable(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Group>
        <Switch
          checked={profile.searchable}
          onChange={toggleSearchable}
          label="Findable by username"
          description={
            handle
              ? `Anyone who knows @${handle} can send you a friend request.`
              : "Pick a permanent username so friends can search for you."
          }
        />

        {claiming && !handle ? (
          <div className="flex flex-col gap-2 px-4 py-3">
            <Input
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="yourname"
              prefix="@"
              suffix={
                checking ? (
                  <LuLoaderCircle className="animate-spin text-muted" />
                ) : available === true ? (
                  <LuCheck className="text-success-ink" />
                ) : available === false ? (
                  <LuX className="text-danger" />
                ) : null
              }
            />
            {formatError ? (
              <FieldNote tone="danger">{formatError}</FieldNote>
            ) : available === false ? (
              <FieldNote tone="danger">@{normalized} is taken.</FieldNote>
            ) : available === true ? (
              <FieldNote tone="success">@{normalized} is available.</FieldNote>
            ) : (
              <FieldNote>
                Letters, numbers and _, starting with a letter. Permanent once
                claimed.
              </FieldNote>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setClaiming(false)}>
                Cancel
              </Button>
              <Button onClick={claim} disabled={busy || available !== true}>
                Claim
              </Button>
            </div>
          </div>
        ) : null}
      </Group>

      {error ? <FieldNote tone="danger">{error}</FieldNote> : null}
    </div>
  );
}

// Serves a friend, yourself, and someone you've only hosted or stayed with —
// for that last pair the confirmed stay is the only thing making either readable.
export default function PersonPage({ uid }: { uid: string }): ReactElement {
  const {
    user,
    email: myEmail,
    profile: myProfile,
    prefs,
    friends,
    friendListings,
    friendWindows,
    myListings,
    myWindows,
    incomingRequests,
    outgoingRequests,
    trips,
    incomingBookings,
    knownPerson,
    publishUserPortal,
    revokeUserPortal,
    cancelRequest,
    unfriend,
    back,
  } = useKip();
  const { confirm } = useDialog();
  const run = useAction();
  const isSelf = uid === user?.uid;
  const friend = friends.find((candidate) => candidate.uid === uid);
  // Already loaded either way, so the fetch below is only for someone searchable.
  const known = knownPerson(uid);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [asking, setAsking] = useState(false);

  const [theirStays, setTheirStays] = useState<readonly Booking[]>([]);

  useEffect(() => {
    if (isSelf || known) return;
    fetchUserProfile(uid)
      .then(setProfile)
      .catch((error) => console.error("fetchUserProfile", error));
  }, [isSelf, known, uid]);

  // Empty unless they've chosen to share, which the rules decide — the whole
  // query is refused otherwise, so there's no half-answer to interpret here.
  useEffect(() => {
    if (isSelf || !friend) {
      setTheirStays([]);
      return;
    }
    let live = true;
    fetchStaysOf(uid)
      .then((stays) => {
        if (live) setTheirStays(stays);
      })
      .catch((error) => console.error("fetchStaysOf", error));
    return () => {
      live = false;
    };
  }, [isSelf, friend, uid]);

  // Cancelled stays are left to Trips — this is a summary, not a second copy of
  // that screen — but they still count as having met, so they stay in the list.
  const staysBetween = [
    ...trips.filter((trip) => trip.ownerId === uid),
    ...incomingBookings.filter((booking) => booking.guestId === uid),
  ];
  const liveStays = staysBetween.filter((stay) => stay.status !== "CANCELLED");
  const upcomingStays = liveStays
    .filter((stay) => !isExpired(stay.end))
    .sort((left, right) => left.start.localeCompare(right.start));
  const pastStays = liveStays
    .filter((stay) => isExpired(stay.end))
    .sort((left, right) => right.start.localeCompare(left.start));
  // A stay at YOUR place comes back from both sources; "Stays" above already has it.
  const elsewhere = theirStays.filter(
    (stay) => !staysBetween.some((shared) => shared.id === stay.id),
  );
  const incoming = incomingRequests.find((request) => request.from === uid);
  const outgoing = outgoingRequests.find((request) => request.to === uid);
  // The third route into `connectRequests`, and the rule wants it by id.
  const sharedStay = staysBetween.find((stay) => stay.status === "CONFIRMED");

  // The last fallback: a request authorises no read, so its own copies are the
  // only description of someone who reached you by link and isn't answered yet.
  const name = isSelf
    ? (myProfile?.displayName ?? "You")
    : known?.displayName ||
      profile?.displayName ||
      incoming?.fromName ||
      outgoing?.toName ||
      "Someone";
  const photoURL = isSelf
    ? (myProfile?.photoURL ?? null)
    : (known?.photoURL ??
      profile?.photoURL ??
      incoming?.fromPhotoURL ??
      outgoing?.toPhotoURL ??
      null);
  // Only on the Auth account, so a friend's is simply not available.
  const email = isSelf ? (myEmail ?? undefined) : undefined;
  // `||` not `??`: an old friend edge stores username as "", which is falsy but
  // not nullish, and the fetched profile's handle is the better answer.
  const username = isSelf
    ? myProfile?.username
    : known?.username ||
      profile?.username ||
      incoming?.fromUsername ||
      outgoing?.toUsername;
  const firstName = name.split(" ")[0];

  const rooms = isSelf
    ? myListings
    : friendListings.filter((listing) => listing.ownerId === uid);
  const windowsFor = (listingId: string) =>
    (isSelf ? myWindows : friendWindows)[listingId] ?? [];

  async function removeFriend(): Promise<void> {
    if (!friend) return;
    const ok = await confirm({
      title: `Remove ${friend.displayName}?`,
      body: "You'll both lose access to each other's places.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await unfriend(friend.uid);
      back();
    } catch (error) {
      console.error(error);
    }
  }

  async function askToConnect(): Promise<void> {
    if (!myProfile || !sharedStay) return;
    setAsking(true);
    try {
      await sendBookingConnectRequest(myProfile, sharedStay, {
        displayName: name,
        photoURL,
      });
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-7">
      <div className="flex flex-col items-center gap-3 pt-2 text-center">
        {isSelf ? (
          <ProfilePhoto name={name} photoURL={photoURL} />
        ) : (
          <Avatar
            name={name}
            photoURL={photoURL}
            className="h-20 w-20 text-2xl"
            ring
          />
        )}
        <div className="w-full min-w-0">
          {isSelf ? (
            <EditableName name={name} />
          ) : (
            <h2 className="truncate text-2xl font-extrabold tracking-[-0.03em]">
              {name}
            </h2>
          )}
          {username ? (
            <p className="mt-0.5 text-sm text-muted">@{username}</p>
          ) : null}
          {email ? (
            <a
              href={`mailto:${email}`}
              className="mx-auto mt-1 flex w-fit items-center gap-1.5 text-sm text-muted hover:text-accent-ink"
            >
              <LuMail className="shrink-0" size={14} />
              <span className="truncate">{email}</span>
            </a>
          ) : null}
        </div>
      </div>

      {isSelf ? <SelfIdentity /> : null}

      {isSelf ? (
        <Section title="Public profile">
          <p className="px-1 text-sm text-muted">
            A link anyone can open to see your places and ask to stay. Every ask
            needs your approval, and saying yes doesn't make you friends.
          </p>
          <ShareLink
            portalId={prefs.profilePortalId}
            createLabel="Share your profile"
            onCreate={async () => {
              await publishUserPortal();
            }}
            onRevoke={() => revokeUserPortal()}
          />
        </Section>
      ) : null}

      {isSelf ? null : (
        <>
          {incoming ? <RequestCard request={incoming} /> : null}

          {outgoing ? (
            <div className="flex flex-col gap-3 rounded-3xl bg-surface p-4 shadow-card sm:flex-row sm:items-center">
              <p className="min-w-0 flex-1 text-sm text-muted">
                Friend request sent — waiting for {firstName} to answer.
              </p>
              <Button
                variant="ghost"
                onClick={() => run(() => cancelRequest(outgoing))}
                className="shrink-0"
              >
                Cancel
              </Button>
            </div>
          ) : null}

          {/* The one route in for two people who met through a link. */}
          {!friend && !incoming && !outgoing && sharedStay ? (
            <Button
              variant="secondary"
              size="lg"
              onClick={() => run(askToConnect)}
              disabled={asking}
              className="w-full"
            >
              Ask to be friends
            </Button>
          ) : null}
        </>
      )}

      {upcomingStays.length > 0 ? (
        <Section title="Stays">
          <Group>
            {upcomingStays.map((stay) => (
              <BookingRow key={stay.id} booking={stay} />
            ))}
          </Group>
        </Section>
      ) : null}

      {/* Their trips generally, as against "Stays" above, which is only the ones
          involving you. Capped: this is a glance at what they're up to, and
          Trips is nobody's second inbox. */}
      {elsewhere.length > 0 ? (
        <Section title={`${firstName}'s trips`}>
          <Group>
            {elsewhere.slice(0, ELSEWHERE_PREVIEW).map((stay) => (
              <BookingRow
                key={stay.id}
                booking={stay}
                showCounterpart={false}
              />
            ))}
          </Group>
        </Section>
      ) : null}

      {pastStays.length > 0 ? (
        <Section title="Past stays">
          <Group className="opacity-70">
            {pastStays.map((stay) => (
              <BookingRow key={stay.id} booking={stay} />
            ))}
          </Group>
        </Section>
      ) : null}

      <Section title={isSelf ? "Your places" : `${firstName}'s places`}>
        {!isSelf && !friend ? (
          // An empty list would claim they share nothing, when the truth is that
          // you can't see.
          <p className="px-1 text-sm text-muted">
            Only friends can see the places {firstName} shares.
          </p>
        ) : rooms.length === 0 ? (
          <p className="px-1 text-sm text-muted">
            {isSelf
              ? "You're not sharing any places yet."
              : `${firstName} isn't sharing any places right now.`}
          </p>
        ) : (
          <div className="gap-3 sm:columns-2">
            {rooms.map((room) => (
              <div key={room.id} className="mb-3 break-inside-avoid">
                <PlaceCard
                  listing={room}
                  windows={windowsFor(room.id)}
                  showHost={false}
                />
              </div>
            ))}
          </div>
        )}
      </Section>

      {!isSelf && friend ? (
        <div className="pt-2">
          <Button variant="danger" onClick={removeFriend}>
            Remove friend
          </Button>
        </div>
      ) : null}
    </div>
  );
}
