export type ListingType = "ROOM" | "FLAT" | "HOUSE";
export type WindowStatus = "OPEN" | "BOOKED";
export type BookingStatus = "REQUESTED" | "CONFIRMED" | "CANCELLED";

// Distinguished because each reads very differently in the email.
export type CancelReason =
  | "DECLINED" // host said no to a pending ask
  | "WITHDRAWN" // guest took their own ask back
  | "SLOT_MOVED" // host moved the dates, voiding a pending ask
  | "SLOT_CANCELLED" // host called off the slot entirely
  | "STAY_CANCELLED"; // either party called off a confirmed stay

export type Profile = {
  readonly uid: string;
  // Optional and permanent; exists only to power searchability, so someone
  // reached by a share link never needs one. Empty until claimed.
  readonly username: string;
  readonly displayName: string;
  readonly photoURL: string | null;
  // Off means unreadable by non-friends and no inbound requests, not just hidden.
  readonly searchable: boolean;
  readonly createdAt: number;
  // No `email`, deliberately — it lives only on the Auth account.
};

// One side of a bijective friend edge, denormalized for display.
export type Friend = {
  readonly uid: string;
  readonly username: string;
  readonly displayName: string;
  readonly photoURL: string | null;
  readonly since: number;
};

// "Let's be friends", nothing else — asking to stay is a REQUESTED booking.
// Doc id is `${from}_${to}`, so exactly one pending ask per pair.
export type ConnectRequest = {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly fromName: string;
  readonly fromUsername: string;
  readonly fromPhotoURL: string | null;
  // Who you asked, as you knew them. Rendered only in the sender's own list, so
  // unlike `fromName` the rules leave these unpinned — nobody to mislead.
  readonly toName: string;
  readonly toUsername: string;
  readonly toPhotoURL: string | null;
  readonly portalId: string | null;
  readonly createdAt: number;
};

// A public-safe identity, for wherever two people can't yet read each other.
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

// The `url` is an unguessable bearer capability, so who may see a photo is
// decided by who may read the listing carrying it.
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
  readonly publicPortalId: string | null;
  readonly createdAt: number;
};

// ISO calendar dates; `end` is the checkout day, so it's exclusive.
export type AvailabilityWindow = {
  readonly id: string;
  readonly listingId: string;
  readonly start: string;
  readonly end: string;
  readonly status: WindowStatus;
  readonly autoAccept: boolean;
  readonly details: string;
  readonly bookingId: string | null; // never a uid: every friend of the HOST reads this
  readonly publicPortalId: string | null;
  // 0 for anything written before this field existed, so it reads as "not new"
  // rather than flooding a saved search that has never seen it.
  readonly createdAt: number;
};

// Carries no names: each side self-issues a `knownBy` pointer and reads the
// other's profile live. Copies here would mean rewriting every booking a person
// was ever party to on every rename.
export type Booking = {
  readonly id: string;
  readonly listingId: string;
  readonly ownerId: string;
  readonly guestId: string;
  readonly windowId: string;
  readonly start: string;
  readonly end: string;
  readonly status: BookingStatus;
  // Stamped by whoever cancels, because a trigger can't see who wrote.
  readonly cancelledBy: string | null;
  readonly cancelReason: CancelReason | null;
  // A per-party hide, since this one document is both parties' record.
  readonly hiddenBy: readonly string[];
  readonly createdAt: number;
};

// Every email kip can send, defined once — the type, the defaults and the
// Settings rows all derive from this, so the three can't drift.
export const NOTIFY_EVENTS = {
  bookingRequested: {
    label: "Someone asks to stay",
    note: "A friend, or someone with your link, wants dates at one of your places.",
    default: true, // needs a decision from you, or someone waits forever
  },
  bookingTaken: {
    label: "Someone books instantly",
    note: "They took dates you'd marked as instant — nothing for you to do.",
    default: true, // purely news, which is why it's split from the ask above
  },
  bookingDecision: {
    label: "Your request is answered",
    note: "A host confirms or declines dates you asked for.",
    default: true,
  },
  stayCancelled: {
    label: "A confirmed stay is called off",
    note: "Either side cancels something already booked.",
    default: true, // the one you'd regret missing; Settings warns if it's off
  },
  connectRequest: {
    label: "Someone asks to be friends",
    note: "By your username, or through a link you shared.",
    default: true, // the only route in for a stranger holding your link
  },
} as const;

export type NotifyKind = keyof typeof NOTIFY_EVENTS;
export type NotifyPrefs = { readonly [K in NotifyKind]: boolean };

export const DEFAULT_NOTIFY: NotifyPrefs = Object.fromEntries(
  Object.entries(NOTIFY_EVENTS).map(([key, event]) => [key, event.default]),
) as NotifyPrefs;

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

export type PortalWindow = {
  readonly id: string;
  readonly start: string;
  readonly end: string;
  readonly details: string;
  readonly autoAccept: boolean;
  // A slot link still shows its slot when taken, so the recipient sees it went
  // rather than an empty page. Wider links drop taken dates — except the
  // visitor's own, which is what `bookedByMe` keeps.
  readonly booked: boolean;
  readonly bookedByMe: boolean;
};

// The one thing copied rather than read live, because a rule can't search a
// room's windows for a link it can't name. `windowIds` is set only for a SLOT
// link; the windows themselves are always live.
export type PortalListing = {
  readonly listingId: string;
  readonly title: string;
  readonly type: ListingType;
  readonly description: string;
  readonly locationLabel: string;
  readonly photos: readonly ListingPhoto[];
  readonly windowIds: readonly string[] | null;
};

// The doc id is the capability. Carries the stable half of the page copied;
// free dates are read live, since a friend booking one is a change no
// write-through by the owner could keep up with.
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

// The stack's base is always a tab. Every variant round-trips through
// `screenHash`/`screenForHash`, so each screen has a URL.
export type Screen =
  | { readonly kind: "tab"; readonly tab: View }
  | { readonly kind: "person"; readonly id: string }
  // `windowId` opens that slot's sheet on arrival — a slot has no screen of its
  // own, so this is how anything else points at one. Owner-only.
  | { readonly kind: "room"; readonly id: string; readonly windowId?: string }
  | { readonly kind: "booking"; readonly id: string }
  | { readonly kind: "listing-form"; readonly id: string | null }; // null id = new
