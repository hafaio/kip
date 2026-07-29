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
import { isExpired } from "../utils/format";
import { fetchUserProfile } from "../utils/friends";
import { sendBookingConnectRequest } from "../utils/requests";
import { useKip } from "../utils/store";
import type { Profile } from "../utils/types";
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

// Your display name, edited where it's read: the heading itself becomes the
// field. Enter or moving focus away commits it, Escape puts it back — there's no
// Save button because there's no form for one to belong to, and the card that
// used to hold one only duplicated the heading it sat under.
function EditableName({ name }: { name: string }): ReactElement {
  const { profile, updateDisplayName } = useKip();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  // Escape has to beat the blur that follows it: the blur handler closes over the
  // draft as it was BEFORE the key, so without this it would commit the very edit
  // that was just abandoned.
  const reverting = useRef(false);

  // "Saved." is an acknowledgement, not a state. Once the field is a heading
  // again there's nothing for it to sit beside, so it goes on its own.
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [saved]);

  function open(): void {
    // The revert flag is only consumed by a blur, and a blur isn't guaranteed to
    // arrive — clearing it here is what stops a discarded edit from swallowing
    // the NEXT one's commit.
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
    // An editor with no surface of its own has nowhere to argue, so a name that
    // can't be saved just reverts — the note under the field already said why
    // while it was being typed.
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

// Small circles that sit ON the avatar. They carry their own surface and shadow
// because what's behind them is a photo — the same reason the listing strip's
// overlay controls do.
const PHOTO_CONTROL =
  "grid h-7 w-7 place-items-center rounded-full bg-surface text-text shadow-card transition hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-50";

// Your own avatar, with the two controls it needs sitting on it: choose a photo,
// and drop the one you chose. They're small circles on the picture rather than a
// section of their own — the photo IS the control's label, and there is nothing
// else to say about it. Removing falls back to the photo your sign-in provider
// gave you, so it only appears when you're wearing one of your own.
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
        file
          ? "That didn't upload. Check your connection and try again."
          : "Couldn't remove that. Try again.",
      );
    } finally {
      setBusy(false);
      // Choosing the same file twice fires no change event unless the input is
      // cleared, which is exactly what a failed upload invites you to do.
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
            // Only ever a file here: cancelling the picker fires nothing, and
            // null on this path would mean "remove", which nobody asked for.
            const chosen = event.target.files?.[0];
            if (chosen) change(chosen);
          }}
        />
      </div>
      {error ? <FieldNote tone="danger">{error}</FieldNote> : null}
    </div>
  );
}

// The rest of who you are on kip: the permanent handle, and whether it can find
// you. One card rather than a settings stack — it belongs to the header above it,
// not to a screen of unrelated preferences. Self view only; Settings mirrors the
// switch.
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
    // Becoming findable needs something to be found by, so send a handle-less
    // user through the claim form instead of writing a doomed `searchable: true`.
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

// Full page for a person: who they are, everything already between the two of
// you, and the spaces they share. Works for a friend (their listings, fetched),
// for yourself (your own listings, live — this is also where you share your whole
// profile) and for someone you've only hosted or stayed with: a share-link guest
// is neither searchable nor a friend, so the confirmed stay between you is the
// only thing that makes either of you readable to the other.
export default function PersonPage({ uid }: { uid: string }): ReactElement {
  const {
    user,
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
  // The friend edge, or the profile the store already resolved through a stay
  // the two of you share. Either way it's loaded, so the fetch below is only for
  // a person neither covers — someone searchable, reached from anywhere else.
  const known = knownPerson(uid);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (isSelf || known) return;
    fetchUserProfile(uid)
      .then(setProfile)
      .catch((error) => console.error("fetchUserProfile", error));
  }, [isSelf, known, uid]);

  // Every stay between the two of you, in both directions, from state the store
  // already holds live. Listed on the same upcoming/past boundary Trips uses;
  // cancelled ones are left to Trips, since this is a summary of what's between
  // you rather than a second copy of that screen — but they still count as
  // having met, so they stay in `staysBetween` for the identity fallback below.
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
  const incoming = incomingRequests.find((request) => request.from === uid);
  const outgoing = outgoingRequests.find((request) => request.to === uid);
  // A confirmed stay is the third route into `connectRequests` — the only one
  // open to a pair who met through a share link, and the rule wants it by id.
  const sharedStay = staysBetween.find((stay) => stay.status === "CONFIRMED");

  // A pending ask in either direction is the last fallback: both sides carry a
  // copy of the other, and it's the only description of someone who reached you
  // through a link and hasn't been answered yet — a request authorises no read,
  // and a stay only does so once it's confirmed.
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
  // Email lives only on the Auth account, never on the profile doc. Show your own
  // (from the Auth user) on your own page; a friend's is simply not available.
  const email = isSelf ? (user?.email ?? undefined) : undefined;
  // `||` not `??`: a pre-migration friend edge stores username as "" (falsy but
  // not nullish), and we'd rather fall back to the freshly-fetched profile handle.
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

          {/* A stay you've already shared is the one route in for two people who
              can't otherwise reach each other — no handle, no link. */}
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
          // Not "nothing to show": their places are readable to friends only, so
          // an empty list here would claim they share nothing when the truth is
          // that you can't see.
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
