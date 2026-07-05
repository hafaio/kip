export type ListingType = "ROOM" | "FLAT" | "HOUSE";
export type WindowStatus = "OPEN" | "BOOKED";
export type BookingStatus = "REQUESTED" | "CONFIRMED" | "CANCELLED";

// Why a booking ended. Distinguishes cases that read very differently to the
// person receiving the mail — "declined" and "those dates moved" are not the same
// message, though both are a pending ask ending.
export type CancelReason =
  | "DECLINED" // host said no to a pending ask
  | "WITHDRAWN" // guest took their own ask back
  | "SLOT_MOVED" // host moved the dates, voiding a pending ask
  | "SLOT_CANCELLED" // host called off the slot entirely
  | "STAY_CANCELLED"; // either party called off a confirmed stay

export type Profile = {
  readonly uid: string;
  // The public handle friends use to find you (lowercased, unique). Empty until
  // claimed — a handle is OPTIONAL and exists only to power searchability, so an
  // account reached by a share link never needs one. Permanent once set.
  readonly username: string;
  // User-chosen; prefilled from the Google name on sign-up but editable after.
  // This is what onboarding asks for — the only required identity field.
  readonly displayName: string;
  readonly photoURL: string | null;
  // Whether this profile can be found by handle. Requires a `username` (enforced
  // in the rules). When false the profile isn't readable by anyone but friends,
  // and inbound friend requests are refused — see `discovery` in CLAUDE.md.
  readonly searchable: boolean;
  readonly createdAt: number;
  // NB: no `email`. The address lives only on the Firebase Auth account (for
  // sign-in/reset) — the owner's own email is read from `auth().currentUser`,
  // never stored on this doc.
};

// One side of a bijective friend edge, denormalized for display.
export type Friend = {
  readonly uid: string;
  readonly username: string;
  readonly displayName: string;
  readonly photoURL: string | null;
  readonly since: number;
};

// "Let's be friends." Only that — asking to STAY is a REQUESTED booking, the same
// document a friend creates, so there is one concept for it instead of two.
//
// Three routes in, differing only in how the rules authorise the write, never in
// shape: found by handle (the recipient is searchable), arrived through a share
// link (`portalId`, which also marks it so the recipient's card can say so), or
// a stay the two of you shared (`bookingId`).
// Doc id is `${from}_${to}` — exactly one pending ask per pair.
export type ConnectRequest = {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly fromName: string;
  readonly fromUsername: string;
  readonly fromPhotoURL: string | null;
  // Who you asked, as you knew them when you asked. Only the handle route has a
  // `toUsername` to offer — see `utils/requests` for where each route reads the
  // name and photo, and for why these are the one identity copy the rules leave
  // unpinned.
  readonly toName: string;
  readonly toUsername: string;
  readonly toPhotoURL: string | null;
  readonly portalId: string | null;
  readonly createdAt: number;
};

// A public-safe identity, denormalized wherever two people can't yet read each
// other's profiles (share-link requests, friend edges, bookings).
export type Party = {
  readonly uid: string;
  readonly username: string;
  readonly displayName: string;
  readonly photoURL: string | null;
};

export type GeoLocation = {
  readonly label: string;
  readonly lat: number;
  readonly lng: number;
  readonly geohash: string;
};

// A photo on a place. The `id` names the Storage object (see `photoPath` in
// photos.ts) and only the owner ever needs it, to delete one. The `url` is a
// Storage download URL — an unguessable bearer capability, the same shape as a
// share link — and is what everyone else renders, so who can see a photo is
// decided once, by who can read the listing carrying it.
export type ListingPhoto = {
  readonly id: string;
  readonly url: string;
};

export type Listing = {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly type: ListingType;
  readonly description: string;
  readonly location: GeoLocation;
  readonly photos: readonly ListingPhoto[];
  // The active public share-link token (portals/{id}), or null. Set when the
  // owner makes the listing public; revoke = delete the portal + clear this.
  readonly publicPortalId: string | null;
  readonly createdAt: number;
};

// An available date range. `start`/`end` are ISO calendar dates (YYYY-MM-DD);
// `end` is the checkout day (exclusive of the last night). When `autoAccept` is
// set, a friend booking it is confirmed instantly (first come, first served)
// instead of waiting on the owner.
export type AvailabilityWindow = {
  readonly id: string;
  readonly listingId: string;
  readonly start: string;
  readonly end: string;
  readonly status: WindowStatus;
  readonly autoAccept: boolean;
  readonly details: string;
  readonly bookedBy: string | null; // guest uid while BOOKED, so they can release it
  readonly publicPortalId: string | null; // active SLOT-scope public link, or null
};

// A stay. Neither party's name is on it: each side self-issues a pointer at the
// booking (`users/{other}/knownBy/{me}`) and reads the other's profile live, the
// same shape as the guest marker on a listing. The names used to be copied here,
// because a guest who booked through a share link is not a friend of the host and
// neither can look the other up — but keeping those copies true meant rewriting
// every booking a person had ever been party to on every rename, which is
// unbounded. One hop instead.
export type Booking = {
  readonly id: string;
  readonly listingId: string;
  readonly ownerId: string;
  readonly guestId: string;
  readonly windowId: string;
  readonly start: string;
  readonly end: string;
  readonly status: BookingStatus;
  // Who called it off, and why. Stamped by whoever cancels (the rule requires it
  // to be them), so the notification function knows which side to write to and
  // what to say — a trigger can't see who made the write.
  readonly cancelledBy: string | null;
  readonly cancelReason: CancelReason | null;
  // Who has cleared this cancelled booking off their own list. A per-party HIDE
  // rather than a delete, because this one document is BOTH parties' record of
  // the stay — so each side may only ever add itself (rules), and the other keeps
  // seeing it. Absent on every booking written before it existed, hence the empty
  // default on read.
  readonly hiddenBy: readonly string[];
  readonly createdAt: number;
};

// Every email kip can send, defined ONCE: what it's called, what it says, and
// whether it's on to begin with. The type, the defaults and the Settings rows all
// derive from this, so adding an event is one edit and the three can't drift.
//
// Each default is a judgement about that specific event, not a blanket. They all
// happen to start on because every one is transactional — a direct consequence of
// something you or a counterparty just did — and each is separately switchable.
export const NOTIFY_EVENTS = {
  bookingRequested: {
    label: "Someone asks to stay",
    note: "A friend, or someone with your link, wants dates at one of your places.",
    // Needs a decision from you. Off, and requests sit unanswered while someone
    // waits on an answer that isn't coming.
    default: true,
  },
  bookingTaken: {
    label: "Someone books instantly",
    note: "They took dates you'd marked as instant — nothing for you to do.",
    // Purely news: it's already confirmed. The most reasonable one to turn off,
    // which is exactly why it's split out from the ask above rather than sharing
    // a switch with it.
    default: true,
  },
  bookingDecision: {
    label: "Your request is answered",
    note: "A host confirms or declines dates you asked for.",
    // You're waiting on this one, and it decides whether you have somewhere to
    // stay.
    default: true,
  },
  stayCancelled: {
    label: "A confirmed stay is called off",
    note: "Either side cancels something already booked.",
    // The one you'd genuinely regret missing — somebody losing a bed they were
    // counting on. Settings warns when this is switched off.
    default: true,
  },
  connectRequest: {
    label: "Someone asks to be friends",
    note: "By your username, or through a link you shared.",
    // Lower stakes than the rest, but it's the only route in for a stranger
    // holding your link — off, and share links quietly stop working.
    default: true,
  },
} as const;

export type NotifyKind = keyof typeof NOTIFY_EVENTS;
export type NotifyPrefs = { readonly [K in NotifyKind]: boolean };

export const DEFAULT_NOTIFY: NotifyPrefs = Object.fromEntries(
  Object.entries(NOTIFY_EVENTS).map(([key, event]) => [key, event.default]),
) as NotifyPrefs;

// Privacy preferences, private to each user. `profilePortalId` is the active
// USER-scope public link (a portal over the whole profile), or null.
export type Prefs = {
  readonly shareStaysWithFriends: boolean;
  readonly profilePortalId: string | null;
  readonly notify: NotifyPrefs;
};

export const DEFAULT_PREFS: Prefs = {
  shareStaysWithFriends: true,
  profilePortalId: null,
  notify: DEFAULT_NOTIFY,
};

export type View =
  | "home"
  | "browse"
  | "places"
  | "friends"
  | "trips"
  | "settings";

export type PortalScope = "USER" | "LISTING" | "SLOT";

// A bookable window as projected into a public portal (denormalized so a
// non-friend can see it without reading the friends-gated `windows` subcollection).
export type PortalWindow = {
  readonly id: string;
  readonly start: string;
  readonly end: string;
  readonly details: string;
  readonly autoAccept: boolean;
  // True when someone already has these dates. A slot-scope link still shows its
  // slot in this state rather than hiding it — the person you sent it to should
  // see that it went, not find an empty page.
  readonly booked: boolean;
  // ...and true when that someone is the visitor reading the page. A wider link
  // lists what's free, so a taken range is normally dropped; theirs is kept, and
  // showing it as merely "Booked" would be the worse half of the same mistake.
  readonly bookedByMe: boolean;
};

// A listing as projected into a portal. These fields are COPIED into the portal
// doc and written through when the owner edits the place — they're the stable
// half of the page, and copying them is what lets a SLOT link show the room it
// belongs to (a rule can't search a room's windows for a link it can't name).
//
// `windowIds` is set only for a SLOT link, naming the single date range it
// covers; wider links leave it null and the client lists the room's windows.
// Either way the windows themselves are read LIVE — they're never copied.
export type PortalListing = {
  readonly listingId: string;
  readonly title: string;
  readonly type: ListingType;
  readonly description: string;
  readonly locationLabel: string;
  // Carried like the rest of the shell: the token in each URL is what opens the
  // object, so a link-holder sees the same cover a friend would.
  readonly photos: readonly ListingPhoto[];
  readonly windowIds: readonly string[] | null;
};

// A public share link. The doc id IS an unguessable UUID — knowing it is the
// capability. World-readable BY ID only (never enumerable); revoke = delete the
// doc, regenerate = a new uuid plus deleting the old.
//
// It carries a copied, public-safe projection of the STABLE half of the page —
// the owner's name and photo, and the places in scope — so a visitor never
// touches the friends-gated listing docs. Those copies are written through when
// the owner edits (see `propagateProfile` / `propagateListing` in utils/portals).
// The volatile half — which dates are still free — is deliberately NOT copied and
// is read live, because a friend booking a slot changes it and no write-through
// by the owner could keep up.
export type Portal = {
  readonly id: string;
  readonly scope: PortalScope;
  readonly ownerId: string;
  readonly ownerName: string;
  readonly ownerPhotoURL: string | null;
  readonly listings: readonly PortalListing[];
  readonly createdAt: number;
};

// A portal's copied listings, joined with the live dates fetched for each.
export type PortalContent = {
  readonly portal: Portal;
  readonly windows: Readonly<Record<string, readonly PortalWindow[]>>;
};

// A screen in the client-side nav stack: either one of the bottom-bar tabs, or
// a dedicated entity page reached by drilling in. The stack's base is always a
// tab; navigate() pushes an entity, back() pops. Every variant is addressable —
// `screenHash` in utils/store maps it to the URL fragment that names it, and
// browser back/forward walk the stack through real history entries.
export type Screen =
  | { readonly kind: "tab"; readonly tab: View }
  | { readonly kind: "person"; readonly id: string }
  // `windowId` names a slot on that room to open on arrival. A slot's controls
  // live in a sheet on the room page rather than on a screen of their own, so
  // this is how anything elsewhere in the app can point at one — omitted, and
  // the room opens with no sheet. Owner-only, since only they have that sheet.
  | { readonly kind: "room"; readonly id: string; readonly windowId?: string }
  | { readonly kind: "booking"; readonly id: string }
  // The listing editor as a full-screen stacked screen (back = cancel).
  // `id` is null for a new listing, or the listing id when editing.
  | { readonly kind: "listing-form"; readonly id: string | null };
