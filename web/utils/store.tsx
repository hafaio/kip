"use client";

import {
  signOut as fbSignOut,
  onAuthStateChanged,
  sendEmailVerification,
  signInAnonymously,
  type User,
  updateProfile,
} from "firebase/auth";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  authSettled,
  emailContinue,
  googleSignIn,
  passwordReset,
} from "./auth";
import {
  type BookingOutcome,
  cancelBookingAsGuest,
  cancelBookingAsOwner,
  cancelWindowAsOwner,
  claimGuestAccess,
  claimKnownBy,
  confirmBooking,
  hideBooking as fbHideBooking,
  hideBookings,
  requestBooking,
  watchIncomingBookings,
  watchMyTrips,
} from "./bookings";
import { auth, firebaseConfigured } from "./firebase";
import {
  setSearchable as fbSetSearchable,
  unfriend as fbUnfriend,
  fetchUserProfile,
  findUserByUsername,
  updateProfileIdentity,
  watchFriends,
  watchOwnProfile,
} from "./friends";
import {
  addWindow as fbAddWindow,
  createListing as fbCreateListing,
  deleteListing as fbDeleteListing,
  setListingPhotos as fbSetListingPhotos,
  setWindowAutoAccept as fbSetWindowAutoAccept,
  updateListing as fbUpdateListing,
  updateWindow as fbUpdateWindow,
  fetchFriendListings,
  fetchListing,
  fetchWindows,
  type ListingInput,
  watchMyListings,
  watchWindows,
} from "./listings";
import { deleteAvatar, uploadAvatar } from "./photos";
import {
  publishListingPortal as fbPublishPortal,
  publishSlotPortal as fbPublishSlotPortal,
  publishUserPortal as fbPublishUserPortal,
  revokeListingPortal as fbRevokePortal,
  revokeSlotPortal as fbRevokeSlotPortal,
  revokeUserPortal as fbRevokeUserPortal,
  ownedPortalIds,
  propagateListing,
  propagateProfile,
} from "./portals";
import {
  acceptRequest as fbAcceptRequest,
  declineRequest as fbDeclineRequest,
  sendRequest as fbSendRequest,
  watchIncomingConnectRequests,
  watchOutgoingConnectRequests,
} from "./requests";
import { EMPTY_CRITERIA, type SearchCriteria } from "./search";
import { setPrefs, watchPrefs } from "./settings";
import {
  type AvailabilityWindow,
  type Booking,
  type ConnectRequest,
  DEFAULT_PREFS,
  type Friend,
  type Listing,
  type ListingPhoto,
  type NotifyKind,
  type Party,
  type Prefs,
  type Profile,
  type Screen,
  type View,
} from "./types";
import { createProfile, claimUsername as fbClaimUsername } from "./username";

type WindowMap = Readonly<Record<string, readonly AvailabilityWindow[]>>;

type ContextShape = {
  configured: boolean;
  authReady: boolean;
  user: User | null;
  profile: Profile | null;
  // Distinguishes "still loading" from "loaded, needs onboarding".
  profileReady: boolean;
  // Gated on displayName only — a handle is optional and claimed from Settings.
  needsOnboarding: boolean;
  prefs: Prefs;
  friends: Friend[];
  incomingRequests: ConnectRequest[];
  outgoingRequests: ConnectRequest[];
  myListings: Listing[];
  myWindows: WindowMap;
  friendListings: Listing[];
  friendWindows: WindowMap;
  trips: Booking[];
  // Places a stay points at that aren't a friend's — readable only through the
  // guest pointer, so nothing else fetches them.
  tripListings: Listing[];
  incomingBookings: Booking[];
  // The friend edge where there is one (no read), else the profile resolved
  // through the shared stay. Null when they can't be read at all.
  knownPerson: (uid: string) => Party | null;
  view: View;
  screen: Screen;
  canGoBack: boolean;
  // Increments on back/forward, so arriving can be told from returning.
  popped: number;
  criteria: SearchCriteria;
  setView: (view: View) => void;
  navigate: (screen: Screen) => void;
  replace: (screen: Screen) => void;
  back: () => void;
  setCriteria: (criteria: SearchCriteria) => void;
  refreshBrowse: () => Promise<void>;
  refreshWindows: (listingId: string) => Promise<void>;
  signIn: () => Promise<void>;
  // Signs in, or makes an account if that address has none.
  continueWithEmail: (
    email: string,
    password: string,
  ) => Promise<{ created: boolean }>;
  resetPassword: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  // For the share-link page only, whose live reads need an identity to hang a
  // grant on. Never replaces a real session.
  ensureAnonymous: () => Promise<string>;
  completeOnboarding: (displayName: string) => Promise<void>;
  updateDisplayName: (displayName: string) => Promise<void>;
  // Null drops back to the provider's photo. Either way every copy is healed.
  setProfilePhoto: (file: Blob | null) => Promise<void>;
  providerPhotoURL: string | null;
  claimUsername: (username: string) => Promise<void>;
  setSearchable: (searchable: boolean) => Promise<void>;
  sendFriendRequest: (
    username: string,
  ) => Promise<"sent" | "not-found" | "already-friends" | "self">;
  acceptRequest: (request: ConnectRequest) => Promise<void>;
  declineRequest: (request: ConnectRequest) => Promise<void>;
  cancelRequest: (request: ConnectRequest) => Promise<void>;
  unfriend: (friendUid: string) => Promise<void>;
  createListing: (input: ListingInput) => Promise<string>;
  updateListing: (listingId: string, input: ListingInput) => Promise<void>;
  setListingPhotos: (
    listingId: string,
    photos: readonly ListingPhoto[],
  ) => Promise<void>;
  deleteListing: (listing: Listing) => Promise<void>;
  addWindow: (
    listingId: string,
    window: {
      start: string;
      end: string;
      autoAccept: boolean;
      details: string;
    },
  ) => Promise<void>;
  setWindowAutoAccept: (
    listingId: string,
    windowId: string,
    autoAccept: boolean,
  ) => Promise<void>;
  updateWindow: (
    listingId: string,
    windowId: string,
    fields: { start: string; end: string; details: string },
  ) => Promise<void>;
  cancelWindow: (listingId: string, windowId: string) => Promise<void>;
  requestBooking: (
    listing: Listing,
    window: AvailabilityWindow,
  ) => Promise<BookingOutcome>;
  confirmBooking: (booking: Booking) => Promise<BookingOutcome>;
  cancelTrip: (booking: Booking) => Promise<void>;
  declineBooking: (booking: Booking) => Promise<void>;
  // A hide, not a delete — the other party keeps their copy.
  hideBooking: (bookingId: string) => Promise<void>;
  hideCancelledTrips: () => Promise<void>;
  hideBookingsById: (bookingIds: readonly string[]) => Promise<void>;
  publishListingPortal: (listing: Listing) => Promise<string>;
  revokeListingPortal: (listing: Listing) => Promise<void>;
  publishUserPortal: () => Promise<string>;
  revokeUserPortal: () => Promise<void>;
  publishSlotPortal: (
    listingId: string,
    window: AvailabilityWindow,
  ) => Promise<string>;
  revokeSlotPortal: (
    listingId: string,
    window: AvailabilityWindow,
  ) => Promise<void>;
  setShareStays: (share: boolean) => Promise<void>;
  setNotify: (key: NotifyKind, on: boolean) => Promise<void>;
  resendVerification: () => Promise<void>;
};

const Ctx = createContext<ContextShape | null>(null);

const EMPTY_FRIENDS: Friend[] = [];
const EMPTY_REQUESTS: ConnectRequest[] = [];
const EMPTY_LISTINGS: Listing[] = [];
const EMPTY_BOOKINGS: Booking[] = [];
const EMPTY_PROFILES: Profile[] = [];
const EMPTY_WINDOWS: WindowMap = {};

// Applied at the two subscriptions rather than per list, so every surface
// honours a hide without each one remembering to.
function shownTo(
  uid: string,
  onChange: (bookings: Booking[]) => void,
): (bookings: Booking[]) => void {
  return (bookings) =>
    onChange(bookings.filter((booking) => !booking.hiddenBy.includes(uid)));
}

const HOME_SCREEN: Screen = { kind: "tab", tab: "home" };

// Its own word, not `room/new`, so no listing id can be mistaken for it.
const NEW_PLACE = "new-place";

// A record, so adding a `View` without a route fails to compile.
const TAB_ROUTES: Readonly<Record<View, true>> = {
  home: true,
  browse: true,
  places: true,
  friends: true,
  trips: true,
  settings: true,
};

function isTab(name: string): name is View {
  return name in TAB_ROUTES;
}

// The fragment rather than a path, because the site is a static export with no
// server to route with. The ids are not secrets — every read they name is gated
// by the rules. The one id that IS a capability lives on /portal/, which the
// router stays off entirely (see `routable`).
function screenHash(screen: Screen): string {
  switch (screen.kind) {
    case "tab":
      return screen.tab === "home" ? "#/" : `#/${screen.tab}`;
    case "person":
      return `#/person/${encodeURIComponent(screen.id)}`;
    case "room":
      return screen.windowId === undefined
        ? `#/room/${encodeURIComponent(screen.id)}`
        : `#/room/${encodeURIComponent(screen.id)}/slot/${encodeURIComponent(
            screen.windowId,
          )}`;
    case "booking":
      return `#/booking/${encodeURIComponent(screen.id)}`;
    case "listing-form":
      return screen.id === null
        ? `#/${NEW_PLACE}`
        : `#/room/${encodeURIComponent(screen.id)}/edit`;
  }
}

// The inverse. Null for anything unrecognized, which callers read as "go home"
// rather than "render nothing".
function screenForHash(hash: string): Screen | null {
  let segments: string[];
  try {
    segments = hash
      .replace(/^#/, "")
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
  } catch {
    return null; // a malformed %-escape names no screen either
  }
  const [first, second, third, fourth] = segments;
  switch (segments.length) {
    case 0:
      return HOME_SCREEN;
    case 1:
      if (isTab(first)) {
        return { kind: "tab", tab: first };
      } else {
        return first === NEW_PLACE ? { kind: "listing-form", id: null } : null;
      }
    case 2:
      switch (first) {
        case "person":
          return { kind: "person", id: second };
        case "room":
          return { kind: "room", id: second };
        case "booking":
          return { kind: "booking", id: second };
        default:
          return null;
      }
    case 3:
      return first === "room" && third === "edit"
        ? { kind: "listing-form", id: second }
        : null;
    case 4:
      return first === "room" && third === "slot"
        ? { kind: "room", id: second, windowId: fourth }
        : null;
    default:
      return null;
  }
}

// A fragment names only the top screen, so a pasted link gets Home seeded
// beneath it — otherwise arriving on a room means arriving with no way back.
function stackForHash(hash: string): Screen[] {
  const screen = screenForHash(hash) ?? HOME_SCREEN;
  return screen.kind === "tab" ? [screen] : [HOME_SCREEN, screen];
}

// `kipDepth` is how back() tells "a screen of ours is behind this" from
// "leaving the site".
type NavState = {
  readonly kipStack?: readonly Screen[];
  readonly kipDepth?: number;
  readonly kipScroll?: number;
};

function historyDepth(): number {
  return (window.history.state as NavState | null)?.kipDepth ?? 0;
}

// Merged, not replaced: Next's router keeps its own data in history.state, and
// clobbering it turns back/forward into a hard reload.
function entryState(
  stack: readonly Screen[],
  depth: number,
  scroll = 0,
): unknown {
  return {
    ...window.history.state,
    kipStack: stack,
    kipDepth: depth,
    kipScroll: scroll,
  };
}

// Per history entry rather than in React state, since that's what survives a
// reload and a forward.
export function historyScroll(): number {
  return (window.history.state as NavState | null)?.kipScroll ?? 0;
}

// Called by the page, the only place that knows which element scrolls.
export function rememberScroll(offset: number): void {
  if (!routable()) return;
  const state = window.history.state as NavState | null;
  if (!state?.kipStack) return;
  window.history.replaceState(
    { ...window.history.state, kipScroll: offset },
    "",
    window.location.hash,
  );
}

// /portal/'s fragment is a capability token, not a route, and it mounts this
// same provider — so every history write asks first.
function routable(): boolean {
  return !/\/portal\/?$/.test(window.location.pathname);
}

function pushEntry(stack: readonly Screen[]): void {
  if (!routable()) return;
  window.history.pushState(
    entryState(stack, historyDepth() + 1),
    "",
    screenHash(stack[stack.length - 1]),
  );
}

function replaceEntry(stack: readonly Screen[], depth = historyDepth()): void {
  if (!routable()) return;
  window.history.replaceState(
    entryState(stack, depth),
    "",
    screenHash(stack[stack.length - 1]),
  );
}

export function KipProvider({ children }: { children: ReactNode }) {
  const configured = firebaseConfigured();

  const [user, setUser] = useState<User | null>(null);
  // Lives in Firestore, not on the Auth user, so it's subscribed not derived.
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileReady, setProfileReady] = useState(false);
  // Firebase restores a session asynchronously, so this stops the gate flashing
  // the sign-in screen at someone already signed in.
  const [authReady, setAuthReady] = useState(false);
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS);
  const [friends, setFriends] = useState<Friend[]>(EMPTY_FRIENDS);
  const [incomingRequests, setIncoming] =
    useState<ConnectRequest[]>(EMPTY_REQUESTS);
  const [outgoingRequests, setOutgoing] =
    useState<ConnectRequest[]>(EMPTY_REQUESTS);
  const [myListings, setMyListings] = useState<Listing[]>(EMPTY_LISTINGS);
  const [myWindows, setMyWindows] = useState<WindowMap>(EMPTY_WINDOWS);
  const [friendListings, setFriendListings] =
    useState<Listing[]>(EMPTY_LISTINGS);
  const [friendWindows, setFriendWindows] = useState<WindowMap>(EMPTY_WINDOWS);
  const [trips, setTrips] = useState<Booking[]>(EMPTY_BOOKINGS);
  const [tripListings, setTripListings] = useState<Listing[]>(EMPTY_LISTINGS);
  const [incomingBookings, setIncomingBookings] =
    useState<Booking[]>(EMPTY_BOOKINGS);
  const [counterparts, setCounterparts] = useState<Profile[]>(EMPTY_PROFILES);
  // Home is only the starting guess — the effect below reads the real stack out
  // of the URL, which can't happen here because this also runs at prerender.
  const [stack, setStack] = useState<Screen[]>([HOME_SCREEN]);
  const [popped, setPopped] = useState(0);
  const screen = stack[stack.length - 1];
  const baseScreen = stack[0];
  const view: View = baseScreen.kind === "tab" ? baseScreen.tab : "home";
  const canGoBack = stack.length > 1;

  // Every forward move pushes a real history entry and back() delegates to
  // history.back(), so the OS back button and the in-app one are one button.
  const setView = useCallback((tab: View) => {
    const next: Screen[] = [{ kind: "tab", tab }];
    pushEntry(next);
    setStack(next);
  }, []);
  const navigate = useCallback(
    (target: Screen) => {
      const next = [...stack, target];
      pushEntry(next);
      setStack(next);
    },
    [stack],
  );
  // Same history entry, so after creating a listing back returns to where the
  // form was opened from rather than to an empty form.
  const replace = useCallback(
    (target: Screen) => {
      const next = [...stack.slice(0, -1), target];
      replaceEntry(next);
      setStack(next);
    },
    [stack],
  );
  const back = useCallback(() => {
    if (historyDepth() > 0) {
      window.history.back();
    } else {
      // Nothing of ours behind this entry, so Back means "up a level" rather
      // than "leave the site".
      const base = stack[0];
      const next: Screen[] = [base.kind === "tab" ? base : HOME_SCREEN];
      replaceEntry(next);
      setStack(next);
    }
  }, [stack]);

  useEffect(() => {
    if (!routable()) return;
    // The fragment wins when the two disagree, being the half a user can edit.
    const saved = (window.history.state as NavState | null)?.kipStack ?? [];
    const restored =
      saved.length > 0 &&
      screenHash(saved[saved.length - 1]) === window.location.hash
        ? [...saved]
        : stackForHash(window.location.hash);
    // Never push: the arrival entry is ours to annotate, and pushing would leave
    // a phantom under the first Back.
    replaceEntry(restored);
    setStack(restored);

    function onPop(event: PopStateEvent): void {
      const stacked = (event.state as NavState | null)?.kipStack;
      // Bumped so the page can tell one pop from the next even on the same screen.
      setPopped((count) => count + 1);
      setStack(
        stacked && stacked.length > 0
          ? [...stacked]
          : stackForHash(window.location.hash),
      );
    }
    // The browser has already pushed a blank entry by the time this fires, so we
    // adopt it in place — a second write is the double entry this scheme avoids.
    function onHashChange(): void {
      const current = (window.history.state as NavState | null)?.kipStack;
      const showing = current?.[current.length - 1];
      if (showing && screenHash(showing) === window.location.hash) return;
      const next = stackForHash(window.location.hash);
      replaceEntry(next, Math.max(historyDepth(), 1));
      setStack(next);
    }
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);
  const [criteria, setCriteria] = useState<SearchCriteria>(EMPTY_CRITERIA);

  const needsOnboarding = Boolean(
    user && profileReady && !profile?.displayName,
  );

  // The owner's public identity as copied into share links.
  const asParty = useCallback(
    () => ({
      uid: profile?.uid ?? "",
      username: profile?.username ?? "",
      displayName: profile?.displayName ?? "",
      photoURL: profile?.photoURL ?? null,
    }),
    [profile],
  );

  useEffect(() => {
    if (!configured) {
      // No project, so no session is possible and the gate can settle at once.
      setAuthReady(true);
      return;
    }
    return onAuthStateChanged(auth(), (next) => {
      setUser(next);
      setAuthReady(true);
    });
  }, [configured]);

  useEffect(() => {
    if (!configured || !user) {
      setProfile(null);
      setProfileReady(false);
      return;
    }
    setProfileReady(false);
    return watchOwnProfile(
      user.uid,
      (next) => {
        setProfile(next);
        setProfileReady(true);
      },
      // Settle even on error, so the app never hangs on the splash.
      () => setProfileReady(true),
    );
  }, [configured, user]);

  // Subscribe to everything owned by the signed-in user.
  useEffect(() => {
    if (!configured || !user) {
      setFriends(EMPTY_FRIENDS);
      setIncoming(EMPTY_REQUESTS);
      setOutgoing(EMPTY_REQUESTS);
      setMyListings(EMPTY_LISTINGS);
      setTrips(EMPTY_BOOKINGS);
      setIncomingBookings(EMPTY_BOOKINGS);
      setPrefsState(DEFAULT_PREFS);
      return;
    }
    const uid = user.uid;
    const unsubs = [
      watchFriends(uid, setFriends),
      watchIncomingConnectRequests(uid, setIncoming),
      watchOutgoingConnectRequests(uid, setOutgoing),
      watchMyListings(uid, setMyListings),
      watchMyTrips(uid, shownTo(uid, setTrips)),
      watchIncomingBookings(uid, shownTo(uid, setIncomingBookings)),
      watchPrefs(uid, setPrefsState),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [configured, user]);

  // Live windows for each of my own listings.
  useEffect(() => {
    if (!configured || !user) {
      setMyWindows(EMPTY_WINDOWS);
      return;
    }
    const unsubs = myListings
      // The windows read rule get()s the listing, so attaching before the
      // create is server-acknowledged races it into a permission-denied.
      .filter((listing) => listing.createdAt > 0)
      .map((listing) =>
        watchWindows(listing.id, (windows) =>
          setMyWindows((prev) => ({ ...prev, [listing.id]: windows })),
        ),
      );
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [configured, user, myListings]);

  // Fetched, not live: the working set is small and this sidesteps dynamic
  // multi-collection listeners.
  const friendUidsKey = friends.map((friend) => friend.uid).join(",");
  const refreshBrowse = useCallback(async () => {
    if (!configured || !user) {
      setFriendListings(EMPTY_LISTINGS);
      setFriendWindows(EMPTY_WINDOWS);
      return;
    }
    const uids = friendUidsKey ? friendUidsKey.split(",") : [];
    if (uids.length === 0) {
      setFriendListings(EMPTY_LISTINGS);
      setFriendWindows(EMPTY_WINDOWS);
      return;
    }
    const listings = await fetchFriendListings(uids);
    const windowLists = await Promise.all(
      listings.map((listing) => fetchWindows(listing.id)),
    );
    const windows: Record<string, readonly AvailabilityWindow[]> = {};
    listings.forEach((listing, index) => {
      windows[listing.id] = windowLists[index];
    });
    setFriendListings(listings);
    setFriendWindows(windows);
  }, [configured, user, friendUidsKey]);

  // The only automatic trigger — screens don't ask on mount, since one wanting a
  // single room would pull every friend's places. The friend list changing is
  // the only thing that makes the set stale, and it re-keys this.
  useEffect(() => {
    refreshBrowse().catch((error) => console.error("refreshBrowse", error));
  }, [refreshBrowse]);

  // One room's dates, for the screen that just changed them.
  const refreshWindows = useCallback(async (listingId: string) => {
    const windows = await fetchWindows(listingId);
    setFriendWindows((prev) => ({ ...prev, [listingId]: windows }));
  }, []);

  // A share-link stay is at a place Browse never asks for, so without this the
  // guest holds a stay against a place they can't name. Keyed on what's still
  // missing, so an unreadable place stays missing rather than refetching.
  const knownListingIds = new Set(
    [...myListings, ...friendListings, ...tripListings].map(
      (listing) => listing.id,
    ),
  );
  const missingListingsKey = [
    ...new Set(
      trips
        .map((trip) => trip.listingId)
        .filter((listingId) => !knownListingIds.has(listingId)),
    ),
  ]
    .sort()
    .join(",");
  useEffect(() => {
    if (!configured || !user) {
      setTripListings(EMPTY_LISTINGS);
      return;
    }
    if (!missingListingsKey) return;
    Promise.all(missingListingsKey.split(",").map(fetchListing))
      .then((found) => {
        const listings = found.filter((listing) => listing !== null);
        if (listings.length > 0) {
          setTripListings((prev) => [...prev, ...listings]);
        }
      })
      .catch((error) => console.error("fetchListing", error));
  }, [configured, user, missingListingsKey]);

  // Here rather than at confirm time because neither confirm path can write it:
  // the rules still see the booking as REQUESTED inside both commits. Keyed on
  // the stays still missing one, NOT on `trips` — that array is fresh on every
  // snapshot, so keying on it rewrote every stay the user ever had.
  const claimedStays = useRef(new Set<string>());
  const unclaimedStaysKey = trips
    .filter(
      (trip) =>
        trip.status === "CONFIRMED" && !claimedStays.current.has(trip.id),
    )
    .map((trip) => `${trip.id}:${trip.listingId}`)
    .sort()
    .join(",");
  useEffect(() => {
    if (!configured || !user || !unclaimedStaysKey) return;
    for (const entry of unclaimedStaysKey.split(",")) {
      const [bookingId, listingId] = entry.split(":");
      claimedStays.current.add(bookingId);
      claimGuestAccess(listingId, user.uid, bookingId).catch((error) =>
        console.error("claimGuestAccess", error),
      );
    }
  }, [configured, user, unclaimedStaysKey]);

  // A booking names two uids and nothing else, and the two may not be able to
  // read each other — the `knownBy` pointer written below IS the authorisation
  // for the fetch that follows it, which is why they run in order. Keyed on the
  // stay too, so confirming re-runs a resolution refused while it was pending.
  const knownUids = new Set([
    ...friends.map((friend) => friend.uid),
    ...counterparts.map((person) => person.uid),
  ]);
  const counterpartStays = new Map<string, string>();
  for (const booking of [...trips, ...incomingBookings]) {
    const otherUid =
      booking.guestId === user?.uid ? booking.ownerId : booking.guestId;
    if (knownUids.has(otherUid)) continue;
    // Only a confirmed stay satisfies the pointer rule, and any one will do.
    if (!counterpartStays.get(otherUid)) {
      counterpartStays.set(
        otherUid,
        booking.status === "CONFIRMED" ? booking.id : "",
      );
    }
  }
  const counterpartsKey = [...counterpartStays]
    .map(([otherUid, bookingId]) => `${otherUid}:${bookingId}`)
    .sort()
    .join(",");
  useEffect(() => {
    if (!configured || !user) {
      setCounterparts(EMPTY_PROFILES);
      return;
    }
    if (!counterpartsKey) return;
    Promise.all(
      counterpartsKey.split(",").map(async (entry) => {
        const [otherUid, bookingId] = entry.split(":");
        if (bookingId) {
          await claimKnownBy(user.uid, otherUid, bookingId).catch((error) =>
            console.error("claimKnownBy", error),
          );
        }
        return fetchUserProfile(otherUid);
      }),
    )
      .then((found) => {
        const people = found.filter((person) => person !== null);
        if (people.length > 0) {
          setCounterparts((prev) => [...prev, ...people]);
        }
      })
      .catch((error) => console.error("fetchUserProfile", error));
  }, [configured, user, counterpartsKey]);

  const knownPerson = useCallback(
    (uid: string): Party | null =>
      friends.find((friend) => friend.uid === uid) ??
      counterparts.find((person) => person.uid === uid) ??
      null,
    [friends, counterparts],
  );

  const signIn = useCallback(async () => {
    await googleSignIn();
  }, []);

  const continueWithEmail = useCallback(
    (email: string, password: string) => emailContinue(email, password),
    [],
  );

  const resetPassword = useCallback(
    (email: string) => passwordReset(email),
    [],
  );

  const signOut = useCallback(async () => {
    await fbSignOut(auth());
  }, []);

  // Awaits `authSettled` rather than reading `currentUser`, which is null for a
  // beat after load while Firebase restores a persisted session — reading it
  // directly replaced a real session with an empty anonymous one.
  const ensureAnonymous = useCallback(async () => {
    const restored = await authSettled();
    if (restored) return restored.uid;
    return (await signInAnonymously(auth())).user.uid;
  }, []);

  // Write the profile with the chosen display name, and mirror it onto the Auth
  // user so anything still reading that (fallbacks) stays consistent. No handle
  // is claimed here — that happens later, from Settings, and only to turn
  // searchability on.
  const completeOnboarding = useCallback(async (displayName: string) => {
    const current = auth().currentUser;
    if (!current) throw new Error("not signed in");
    await createProfile(current.uid, {
      displayName,
      photoURL: current.photoURL ?? null,
    });
    await updateProfile(current, { displayName }).catch((error) =>
      console.error("updateProfile", error),
    );
  }, []);

  // A handle already taken fails on the registry's owner-only update rule.
  const claimUsername = useCallback(async (username: string) => {
    const current = auth().currentUser;
    if (!current) throw new Error("not signed in");
    await fbClaimUsername(current.uid, username);
  }, []);

  const setSearchable = useCallback(
    (searchable: boolean) => {
      if (!user) throw new Error("not signed in");
      return fbSetSearchable(user.uid, searchable);
    },
    [user],
  );

  // Profile and friend edges first, since the edge rule reads the COMMITTED
  // profile; then the links you've shared, which nobody else could fix for you.
  // Bookings need nothing — they carry no names.
  const spreadIdentity = useCallback(
    async (uid: string, displayName: string, photoURL: string | null) => {
      await updateProfileIdentity(
        uid,
        { displayName, photoURL },
        friends.map((friend) => friend.uid),
      );
      await propagateProfile(
        { ...asParty(), displayName, photoURL },
        ownedPortalIds(prefs.profilePortalId, myListings, myWindows),
      ).catch((error) => console.error("propagateProfile", error));
    },
    [asParty, friends, prefs.profilePortalId, myListings, myWindows],
  );

  const updateDisplayName = useCallback(
    async (displayName: string) => {
      const current = auth().currentUser;
      if (!current) throw new Error("not signed in");
      await spreadIdentity(current.uid, displayName, profile?.photoURL ?? null);
      await updateProfile(current, { displayName }).catch((error) =>
        console.error("updateProfile", error),
      );
    },
    [spreadIdentity, profile],
  );

  // Off `providerData`, not the Auth user's `photoURL`, which is ours to
  // overwrite — this is the original to fall back to.
  const providerPhotoURL =
    user?.providerData.find((entry) => entry.photoURL)?.photoURL ?? null;

  // The object is deleted only after the profile stops pointing at it, so a
  // failed delete leaves an invisible orphan rather than broken images.
  const setProfilePhoto = useCallback(
    async (file: Blob | null) => {
      const current = auth().currentUser;
      if (!current) throw new Error("not signed in");
      const photoURL = file
        ? await uploadAvatar(current.uid, file)
        : providerPhotoURL;
      await spreadIdentity(
        current.uid,
        profile?.displayName ?? "",
        photoURL ?? null,
      );
      if (!file) await deleteAvatar(current.uid);
    },
    [spreadIdentity, profile, providerPhotoURL],
  );

  // Resolved here so the caller gets an outcome without touching Firestore.
  const sendFriendRequest = useCallback(
    async (username: string) => {
      if (!profile) throw new Error("not signed in");
      const target = await findUserByUsername(username);
      if (!target) return "not-found" as const;
      if (target.uid === profile.uid) return "self" as const;
      const friend = friends.find((entry) => entry.uid === target.uid);
      if (friend) return "already-friends" as const;
      await fbSendRequest(profile, target);
      return "sent" as const;
    },
    [profile, friends],
  );

  const acceptRequest = useCallback(
    (request: ConnectRequest) => {
      if (!profile) throw new Error("not signed in");
      return fbAcceptRequest(asParty(), request);
    },
    [profile, asParty],
  );

  const unfriend = useCallback(
    (friendUid: string) => {
      if (!user) throw new Error("not signed in");
      return fbUnfriend(user.uid, friendUid);
    },
    [user],
  );

  const createListing = useCallback(
    (input: ListingInput) => {
      if (!user) throw new Error("not signed in");
      return fbCreateListing(user.uid, input);
    },
    [user],
  );

  // Rewrites the place's copy in every link that carries one.
  const updateListing = useCallback(
    async (listingId: string, input: ListingInput) => {
      await fbUpdateListing(listingId, input);
      const listing = myListings.find(
        (candidate) => candidate.id === listingId,
      );
      if (!listing) return;
      await propagateListing(
        {
          ...listing,
          title: input.title,
          type: input.type,
          description: input.description,
          location: { ...listing.location, ...input.location },
        },
        myWindows[listingId] ?? [],
      ).catch((error) => console.error("propagateListing", error));
    },
    [myListings, myWindows],
  );

  const setListingPhotos = useCallback(
    async (listingId: string, photos: readonly ListingPhoto[]) => {
      await fbSetListingPhotos(listingId, photos);
      const listing = myListings.find(
        (candidate) => candidate.id === listingId,
      );
      if (!listing) return;
      await propagateListing(
        { ...listing, photos: [...photos] },
        myWindows[listingId] ?? [],
      ).catch((error) => console.error("propagateListing", error));
    },
    [myListings, myWindows],
  );

  const requestBookingAction = useCallback(
    (listing: Listing, window: AvailabilityWindow) => {
      if (!profile) throw new Error("not signed in");
      return requestBooking(profile.uid, listing, window);
    },
    [profile],
  );

  // The store holds the bookings live, so the caller needn't gather them.
  const deleteListing = useCallback(
    (listing: Listing) => fbDeleteListing(listing, incomingBookings),
    [incomingBookings],
  );

  const updateWindow = useCallback(
    (
      listingId: string,
      windowId: string,
      fields: { start: string; end: string; details: string },
    ) => fbUpdateWindow(listingId, windowId, fields, incomingBookings),
    [incomingBookings],
  );

  const cancelWindow = useCallback(
    (listingId: string, windowId: string) => {
      const bookingsOnWindow = incomingBookings.filter(
        (booking) =>
          booking.listingId === listingId && booking.windowId === windowId,
      );
      return cancelWindowAsOwner(listingId, windowId, bookingsOnWindow);
    },
    [incomingBookings],
  );

  const hideBooking = useCallback(
    (bookingId: string) => {
      if (!user) throw new Error("not signed in");
      return fbHideBooking(user.uid, bookingId);
    },
    [user],
  );

  const hideBookingsById = useCallback(
    (bookingIds: readonly string[]) => {
      if (!user) throw new Error("not signed in");
      return hideBookings(user.uid, bookingIds);
    },
    [user],
  );

  // `trips` is already filtered to what this user sees, so no query is needed.
  const hideCancelledTrips = useCallback(() => {
    if (!user) throw new Error("not signed in");
    return hideBookings(
      user.uid,
      trips
        .filter((trip) => trip.status === "CANCELLED")
        .map((trip) => trip.id),
    );
  }, [user, trips]);

  const setShareStays = useCallback(
    async (share: boolean) => {
      if (!user) throw new Error("not signed in");
      setPrefsState({ ...prefs, shareStaysWithFriends: share });
      await setPrefs(user.uid, { shareStaysWithFriends: share });
    },
    [user, prefs],
  );

  const setNotify = useCallback(
    async (key: NotifyKind, on: boolean) => {
      if (!user) throw new Error("not signed in");
      const notify = { ...prefs.notify, [key]: on };
      setPrefsState({ ...prefs, notify });
      await setPrefs(user.uid, { notify });
    },
    [user, prefs],
  );

  // Mail only ever goes to a verified address, so this is the way out of that.
  const resendVerification = useCallback(async () => {
    const current = auth().currentUser;
    if (!current) throw new Error("not signed in");
    await sendEmailVerification(current);
  }, []);

  const publishListingPortal = useCallback(
    (listing: Listing) => {
      if (!profile) throw new Error("not signed in");
      return fbPublishPortal(listing, asParty());
    },
    [profile, asParty],
  );

  const revokeListingPortal = useCallback(
    (listing: Listing) =>
      listing.publicPortalId
        ? fbRevokePortal(listing.id, listing.publicPortalId)
        : Promise.resolve(),
    [],
  );

  const publishUserPortal = useCallback(() => {
    if (!profile) throw new Error("not signed in");
    return fbPublishUserPortal(asParty());
  }, [profile, asParty]);

  const revokeUserPortal = useCallback(
    () =>
      user && prefs.profilePortalId
        ? fbRevokeUserPortal(user.uid, prefs.profilePortalId)
        : Promise.resolve(),
    [user, prefs.profilePortalId],
  );

  const publishSlotPortal = useCallback(
    (listingId: string, window: AvailabilityWindow) => {
      if (!profile) throw new Error("not signed in");
      const listing = myListings.find(
        (candidate) => candidate.id === listingId,
      );
      if (!listing) throw new Error("listing missing");
      return fbPublishSlotPortal(listing, window, asParty());
    },
    [profile, asParty, myListings],
  );

  const revokeSlotPortal = useCallback(
    (listingId: string, window: AvailabilityWindow) =>
      window.publicPortalId
        ? fbRevokeSlotPortal(listingId, window.id, window.publicPortalId)
        : Promise.resolve(),
    [],
  );

  const value: ContextShape = {
    configured,
    authReady,
    user,
    profile,
    profileReady,
    needsOnboarding,
    prefs,
    friends,
    incomingRequests,
    outgoingRequests,
    myListings,
    myWindows,
    friendListings,
    friendWindows,
    trips,
    tripListings,
    incomingBookings,
    knownPerson,
    view,
    screen,
    canGoBack,
    popped,
    criteria,
    setView,
    navigate,
    replace,
    back,
    setCriteria,
    refreshBrowse,
    refreshWindows,
    signIn,
    continueWithEmail,
    resetPassword,
    signOut,
    ensureAnonymous,
    completeOnboarding,
    updateDisplayName,
    setProfilePhoto,
    providerPhotoURL,
    claimUsername,
    setSearchable,
    sendFriendRequest,
    acceptRequest,
    declineRequest: fbDeclineRequest,
    cancelRequest: fbDeclineRequest,
    unfriend,
    createListing,
    updateListing,
    setListingPhotos,
    deleteListing,
    addWindow: fbAddWindow,
    setWindowAutoAccept: fbSetWindowAutoAccept,
    updateWindow,
    cancelWindow,
    requestBooking: requestBookingAction,
    confirmBooking,
    cancelTrip: cancelBookingAsGuest,
    declineBooking: cancelBookingAsOwner,
    hideBooking,
    hideCancelledTrips,
    hideBookingsById,
    publishListingPortal,
    revokeListingPortal,
    publishUserPortal,
    revokeUserPortal,
    publishSlotPortal,
    revokeSlotPortal,
    setShareStays,
    setNotify,
    resendVerification,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useKip(): ContextShape {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useKip must be used within KipProvider");
  return ctx;
}
