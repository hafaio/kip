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
  // False until the signed-in user's own profile doc has resolved once, so the
  // gate can distinguish "still loading" from "loaded, needs onboarding".
  profileReady: boolean;
  // Authenticated but no display name yet → show the onboarding screen. A handle
  // is NOT part of this gate: it's optional and claimed later, from Settings.
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
  // The places my stays are at that neither of the above covers — a stay booked
  // through a share link is at a non-friend's place, readable only through the
  // guest pointer. Fetched once each; a place that can't be read is simply absent.
  tripListings: Listing[];
  incomingBookings: Booking[];
  // The other party of a booking, as anything rendering one should name them:
  // the friend edge where there is one (already loaded, costing no read), else
  // the profile resolved through the stay the two of you share. Null when they
  // can't be read at all — a pending ask from someone who arrived by link, or a
  // stay that was cancelled, which is what makes the pointer inert again.
  knownPerson: (uid: string) => Party | null;
  view: View;
  screen: Screen;
  canGoBack: boolean;
  // Increments on every history back/forward, so a screen change can be told
  // apart from a return to one.
  popped: number;
  criteria: SearchCriteria;
  setView: (view: View) => void;
  navigate: (screen: Screen) => void;
  replace: (screen: Screen) => void;
  back: () => void;
  setCriteria: (criteria: SearchCriteria) => void;
  refreshBrowse: () => Promise<void>;
  // Refetch one friend's room's dates, for after a booking changed them. The
  // whole-set refresh above is the store's own business — screens don't call it.
  refreshWindows: (listingId: string) => Promise<void>;
  signIn: () => Promise<void>;
  // One entry point for email: signs in, or makes an account if that address has
  // none. `created` says which happened, so the caller can tell the person.
  continueWithEmail: (
    email: string,
    password: string,
  ) => Promise<{ created: boolean }>;
  resetPassword: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  // Resolve to a uid, signing in anonymously if there's no session. Used only by
  // the public share-link page, whose live reads need an identity to attach a
  // proof-of-token to. Never replaces a real session.
  ensureAnonymous: () => Promise<string>;
  completeOnboarding: (displayName: string) => Promise<void>;
  updateDisplayName: (displayName: string) => Promise<void>;
  // Set the profile photo, or drop it (null) back to whatever the sign-in
  // provider gave us. Either way every copy of it is healed.
  setProfilePhoto: (file: Blob | null) => Promise<void>;
  // The photo the sign-in provider gave us, if any — what dropping an uploaded
  // one falls back to, and the reason "Remove" is only offered when there's
  // something of the user's own to remove.
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
  // Clear a cancelled booking, or every cancelled trip, off this user's list.
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

// Drop the bookings this user has cleared off their own list. Clearing is a
// per-party hide on a document both parties share, so it can only ever be a view
// filter — the other side must go on seeing theirs. It's applied here, at the two
// subscriptions, rather than at each list: every surface that renders a booking
// reads `trips`/`incomingBookings`, so one filter covers all of them and none of
// them has to remember.
function shownTo(
  uid: string,
  onChange: (bookings: Booking[]) => void,
): (bookings: Booking[]) => void {
  return (bookings) =>
    onChange(bookings.filter((booking) => !booking.hiddenBy.includes(uid)));
}

const HOME_SCREEN: Screen = { kind: "tab", tab: "home" };

// The listing editor with nothing to edit yet. Its own word, not `room/new`, so
// no listing id could ever be mistaken for it.
const NEW_PLACE = "new-place";

// The tabs, as a record so adding a `View` without giving it a route fails to
// compile instead of quietly producing an unaddressable screen.
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

// Every screen is addressable, so the browser's own back and forward walk the
// nav stack and any screen can be linked to or reloaded onto:
//
//   #/                                   Home ("#/home" is accepted too)
//   #/browse #/places #/friends #/trips #/settings
//   #/person/<uid>
//   #/room/<listingId>
//   #/room/<listingId>/slot/<windowId>   that room with one slot's sheet open
//   #/room/<listingId>/edit              the listing editor, on an existing place
//   #/new-place                          the listing editor, on a new one
//   #/booking/<bookingId>
//
// The ids are Firestore document ids and none of them is a secret: every read
// they name is gated by firestore.rules, which is the only enforcement anyway.
// The one id that IS a capability — a share link's token — belongs to /portal/,
// a different page whose fragment means something else entirely, and the router
// stays off it (see `routable`).
//
// It has to be the fragment rather than a path: the site is a static export, so
// there is no server to route anything else with.
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

// The inverse. Null for anything unrecognized — a typo, a truncated link, a
// fragment from some older scheme — which every caller reads as "go home",
// never as "render nothing".
function screenForHash(hash: string): Screen | null {
  let segments: string[];
  try {
    segments = hash
      .replace(/^#/, "")
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
  } catch {
    // A malformed %-escape names no screen either.
    return null;
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

// A fragment names one screen; what sits UNDER it is the app's own memory, which
// a pasted link doesn't carry. So a deep-linked entity gets Home beneath it —
// otherwise arriving on a room means arriving with no way back into the app.
function stackForHash(hash: string): Screen[] {
  const screen = screenForHash(hash) ?? HOME_SCREEN;
  return screen.kind === "tab" ? [screen] : [HOME_SCREEN, screen];
}

// What we park on each history entry: the whole stack, since the fragment only
// names its top, and how deep into this document's history we are, which is how
// back() tells "a screen of ours is behind this" from "leaving the site".
type NavState = {
  readonly kipStack?: readonly Screen[];
  readonly kipDepth?: number;
  readonly kipScroll?: number;
};

function historyDepth(): number {
  return (window.history.state as NavState | null)?.kipDepth ?? 0;
}

// Merge into the existing history.state rather than replacing it — Next's App
// Router keeps its routing data there, and clobbering it makes back/forward fall
// back to a hard page reload.
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

// Where the current entry was scrolled to, so going back can put it there again.
// Stored per history entry rather than in React state because that's what
// survives a reload and a forward — the browser already keeps one object per
// entry, and this is exactly the kind of thing it's for.
export function historyScroll(): number {
  return (window.history.state as NavState | null)?.kipScroll ?? 0;
}

// Record where we are before navigating away. Called by the page, which is the
// only place that knows which element actually scrolls.
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

// /portal/ is a separate page whose fragment is a share-link capability token,
// not a route. Both pages mount this provider, so every history write asks first.
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
  // The own profile now lives in Firestore (username + user-chosen displayName),
  // not the Auth user, so we subscribe to it rather than derive it.
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileReady, setProfileReady] = useState(false);
  // False until Firebase resolves the session once, so the gate doesn't flash
  // the sign-in screen at a user who's actually already signed in.
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
  // Client-side nav stack: base is always a tab; drilling into an entity pushes
  // a screen, back() pops. Switching tabs resets the stack. Home is only the
  // starting guess — the effect below reads the real one out of the URL, which
  // can't be done here because this also renders on the export's prerender.
  const [stack, setStack] = useState<Screen[]>([HOME_SCREEN]);
  // Counts backs and forwards. The page watches it to decide whether arriving at
  // a screen means "opened" (start at the top) or "returned" (put it back).
  const [popped, setPopped] = useState(0);
  const screen = stack[stack.length - 1];
  const baseScreen = stack[0];
  const view: View = baseScreen.kind === "tab" ? baseScreen.tab : "home";
  const canGoBack = stack.length > 1;

  // Each forward move pushes a browser history entry holding the new stack and
  // the new screen's fragment; back() delegates to history.back() and a popstate
  // listener restores the stack, so the browser/OS back button and the in-app one
  // are the same button.
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
  // Swap the top of the stack in place (same history entry) — used after
  // creating a listing to turn the form screen into the new room page, so back
  // returns to wherever the form was opened from, not to an empty form.
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
      // Nothing of ours is behind this entry — someone opened a link straight to
      // this screen. Falling back to the stack's base tab keeps Back meaning
      // "up a level" instead of "leave the site".
      const base = stack[0];
      const next: Screen[] = [base.kind === "tab" ? base : HOME_SCREEN];
      replaceEntry(next);
      setStack(next);
    }
  }, [stack]);

  useEffect(() => {
    if (!routable()) return;
    // A reload keeps this entry's state, so the whole breadcrumb survives it; a
    // pasted link carries none and is rebuilt from the fragment alone. The
    // fragment wins if the two disagree, since it's the half a user can edit.
    const saved = (window.history.state as NavState | null)?.kipStack ?? [];
    const restored =
      saved.length > 0 &&
      screenHash(saved[saved.length - 1]) === window.location.hash
        ? [...saved]
        : stackForHash(window.location.hash);
    // replaceState, never push: the entry the visitor arrived on is ours to
    // annotate, and pushing here would leave a phantom under the first Back.
    // It also canonicalizes the fragment, so a nonsense one visibly becomes #/.
    replaceEntry(restored);
    setStack(restored);

    function onPop(event: PopStateEvent): void {
      const stacked = (event.state as NavState | null)?.kipStack;
      // A pop means "you've been here before", so the page restores the offset
      // this entry was left at instead of jumping to the top. Bumped so the page
      // can tell one pop from the next even when the screen is the same.
      setPopped((count) => count + 1);
      setStack(
        stacked && stacked.length > 0
          ? [...stacked]
          : stackForHash(window.location.hash),
      );
    }
    // The fragment can also change without us: someone edits the URL bar, or
    // follows a link to another screen on the page they're already on. The
    // browser has pushed a blank entry by then, so we adopt it in place — a
    // second write here would be the double entry this whole scheme avoids.
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

  // Onboarding gate: the profile has resolved and there's no display name yet.
  // A handle is deliberately NOT required — see `discovery` in CLAUDE.md.
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

  // Track auth state.
  useEffect(() => {
    if (!configured) {
      // No project wired up: no session is possible, so the gate can settle
      // immediately on the sign-in screen.
      setAuthReady(true);
      return;
    }
    return onAuthStateChanged(auth(), (next) => {
      setUser(next);
      setAuthReady(true);
    });
  }, [configured]);

  // Live-subscribe to the signed-in user's own profile doc.
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
      // Settle the gate even if the listener errors (e.g. a permission-denied
      // during an auth-token refresh), so the app never hangs on the splash.
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
      // Skip a listing whose create isn't server-acknowledged yet (createdAt is
      // still 0 from the pending serverTimestamp). The windows read rule get()s
      // the listing, which would race the just-issued write and throw a
      // transient permission-denied; it attaches once the listing is confirmed.
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

  // Friends' listings + their windows are fetched (not live) — the working set
  // is small, and this sidesteps dynamic multi-collection listeners.
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

  // The one automatic trigger. Screens deliberately don't ask on mount: the fetch
  // is every friend's places plus a windows query each, so a screen that wanted
  // one room was pulling the whole set — and this already re-runs whenever the
  // friend list changes, which is the only thing that makes the set stale.
  useEffect(() => {
    refreshBrowse().catch((error) => console.error("refreshBrowse", error));
  }, [refreshBrowse]);

  // One room's dates again, for the screen that just changed them — a slot booked
  // or lost to someone faster. Friends' windows aren't live, and re-reading every
  // friend's place to learn about one room is the shape this replaces.
  const refreshWindows = useCallback(async (listingId: string) => {
    const windows = await fetchWindows(listingId);
    setFriendWindows((prev) => ({ ...prev, [listingId]: windows }));
  }, []);

  // A stay booked through a share link is at a place Browse never asks for — the
  // host isn't a friend — so without this the guest holds a confirmed stay against
  // a place they can't name, which is the exact thing the guest pointer exists to
  // prevent. Keyed on which listings are still missing, so a place that can't be
  // read (deleted, or a pointer gone inert with a cancelled stay) stays missing
  // and the fetch doesn't repeat.
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

  // Make sure each confirmed stay has its access pointer. Doing it here rather
  // than at confirm time covers both routes in — the owner can't write it (rules
  // read committed state, so the booking is still REQUESTED in that batch) and an
  // instant-booking guest can't either, for the same reason.
  //
  // Keyed on the stays still missing one, NOT on `trips`: that array is a fresh
  // object on every snapshot, and bookings are terminal, so keying on it wrote a
  // document for every stay the user had ever had, on every session and every
  // change to any booking — a list that only ever grows. Each id is remembered as
  // it's claimed, so a session claims each stay once. A claim that fails is left
  // to the next load, which is soon enough for a pointer that authorises nothing
  // until it's used.
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

  // Who the other side of each booking actually is. A booking names two uids and
  // nothing else about them, and the two may well not be able to read each other
  // — a share-link guest isn't their host's friend, and neither is searchable to
  // the other. What makes the read legal is the stay itself: each side writes its
  // own `knownBy` pointer at a CONFIRMED booking, exactly as a guest points at
  // the one entitling them to see the listing. The pointer IS the authorisation
  // for the fetch that follows, so the two happen in order rather than in
  // parallel.
  //
  // Keyed on the counterpart AND the stay backing them, so a request being
  // confirmed re-runs a resolution that was legitimately refused while it was
  // still pending. Friends are excluded outright: their edge is already loaded
  // and needs no read. Someone who can't be read stays missing.
  const knownUids = new Set([
    ...friends.map((friend) => friend.uid),
    ...counterparts.map((person) => person.uid),
  ]);
  const counterpartStays = new Map<string, string>();
  for (const booking of [...trips, ...incomingBookings]) {
    const otherUid =
      booking.guestId === user?.uid ? booking.ownerId : booking.guestId;
    if (knownUids.has(otherUid)) continue;
    // A confirmed stay wins over a pending one: it's the only kind the pointer
    // rule accepts, and any of them will do.
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
        // Idempotent, and it grants nothing on its own — the rules re-read the
        // stay it names on every use — so re-claiming costs a write and no risk.
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

  // An anonymous account is a throwaway identity, not a sign-up: it exists purely
  // so the rules have a uid to key a share-link grant on. Firebase auto-deletes
  // unused ones after 30 days. Creating a real account LINKS this one (see
  // utils/auth.ts), keeping the uid — but signing in to an existing account
  // can't, so callers must still re-derive anything keyed to the old uid.
  // A share-link visitor needs SOME identity to hang their proof-of-token on —
  // but only if they don't already have one. `auth().currentUser` is null for a
  // beat after load while Firebase restores the persisted session, so reading it
  // directly mistakes a signed-in visitor for a stranger and signs them in
  // anonymously, silently replacing a real session with an empty one. That's
  // what happened when you opened a link someone sent you while already signed
  // in: the app then treated you as a brand-new user and asked for a name.
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

  // Claim a permanent handle and become findable by it. Rejected (permission
  // -denied) if someone else already holds the handle.
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

  // How this user appears is copied into two places, and a copy is only worth
  // having if it stays true — so changing either half of it rewrites both. The
  // profile and the friend edges go first and together (see updateProfileIdentity:
  // the edge rule reads the COMMITTED profile), then the links you've shared,
  // which nobody else could correct for you. Bookings need nothing: the other
  // party reads this profile through the stay you share.
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

  // Renaming yourself also rewrites the copy of your name held by every link
  // you've shared — otherwise a stranger opening one would see who you used to be.
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

  // The provider's photo is read off `providerData` rather than the Auth user's
  // own `photoURL`, which is ours to overwrite — this is the original, so it's
  // still there to fall back to after an upload has been dropped.
  const providerPhotoURL =
    user?.providerData.find((entry) => entry.photoURL)?.photoURL ?? null;

  // Upload a profile photo, or drop back to the provider's. The object is
  // deleted only AFTER the profile stops pointing at it: a failed delete then
  // leaves an orphan nobody can see, where the other order would leave every copy
  // of this person pointing at a picture that no longer exists.
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

  // Ask by handle. Resolving happens here so the store can report the outcome
  // (not-found / already-friends / self) without the caller touching Firestore.
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

  // Editing a place rewrites its copy in every link that shows it. Adding or
  // removing one changes WHICH places the profile link lists, so that list is
  // rewritten whenever myListings settles (the listener already fires on both).
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

  // Photos change outside the details form — one upload or delete at a time — so
  // they need their own write, and it has to reach the copies a date-range link
  // carries for exactly the reason an edit does.
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

  // Deleting a place cancels everything booked or pending against it — the store
  // holds those live, so the caller doesn't have to gather them.
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

  // Clearing a set the caller already has in hand — a room's cancelled guests,
  // say. One batch, no query.
  const hideBookingsById = useCallback(
    (bookingIds: readonly string[]) => {
      if (!user) throw new Error("not signed in");
      return hideBookings(user.uid, bookingIds);
    },
    [user],
  );

  // `trips` is already filtered to what this user still sees, so everything
  // cancelled in it is by definition not yet hidden — no query needed.
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

  // A link copies in the stable half of what it shows — the owner and the place —
  // so publishing needs both. The dates are read live by the visitor and are
  // deliberately not passed here.
  const setNotify = useCallback(
    async (key: NotifyKind, on: boolean) => {
      if (!user) throw new Error("not signed in");
      const notify = { ...prefs.notify, [key]: on };
      setPrefsState({ ...prefs, notify });
      await setPrefs(user.uid, { notify });
    },
    [user, prefs],
  );

  // Notifications only go to a VERIFIED address — otherwise signing up as someone
  // else's email would deliver mail to a person who never gave it to you.
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
