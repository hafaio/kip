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

// Every notification kip can send, defined once — the types, the defaults and
// the Settings rows all derive from this, so they can't drift. `sms` marks the
// four worth interrupting someone for; the rest are news, to people who have an
// address anyway.
export const NOTIFY_EVENTS = {
  bookingRequested: {
    label: "Someone asks to stay",
    note: "A friend, or someone with your link, wants dates at one of your places.",
    default: true, // needs a decision from you, or someone waits forever
    sms: true,
  },
  bookingTaken: {
    label: "Someone books instantly",
    note: "They took dates you'd marked as instant — nothing for you to do.",
    default: true, // purely news, which is why it's split from the ask above
    sms: false,
  },
  bookingDecision: {
    label: "Your request is answered",
    note: "A host confirms or declines dates you asked for.",
    default: true,
    sms: true,
  },
  stayCancelled: {
    label: "A confirmed stay is called off",
    note: "Either side cancels something already booked.",
    default: true, // the one you'd regret missing; Settings warns if it's off
    sms: true,
  },
  connectRequest: {
    label: "Someone asks to be friends",
    note: "By your username, or through a link you shared.",
    default: true, // the only route in for a stranger holding your link
    sms: false, // reaches an established user, who has an address
  },
  connectAccepted: {
    label: "Someone agrees to be friends",
    note: "You asked to connect and they said yes.",
    default: true, // a decline says nothing, so silence would read as one
    sms: true, // reaches the share-link visitor, who may have no address
  },
} as const;

export type NotifyKind = keyof typeof NOTIFY_EVENTS;
export type NotifyPrefs = { readonly [K in NotifyKind]: boolean };

export const DEFAULT_NOTIFY: NotifyPrefs = Object.fromEntries(
  Object.entries(NOTIFY_EVENTS).map(([key, event]) => [key, event.default]),
) as NotifyPrefs;

// Read off the table rather than listed again, so marking an event `sms` is the
// only edit adding one takes.
export type NotifySmsKind = {
  [K in NotifyKind]: (typeof NOTIFY_EVENTS)[K]["sms"] extends true ? K : never;
}[NotifyKind];
export type NotifySmsPrefs = { readonly [K in NotifySmsKind]: boolean };

// All off, unlike email: a verified number proves possession, never consent, so
// nothing is texted until the switch that carries the disclosures is turned on.
export const DEFAULT_NOTIFY_SMS: NotifySmsPrefs = Object.fromEntries(
  Object.entries(NOTIFY_EVENTS)
    .filter(([, event]) => event.sms)
    .map(([key]) => [key, false]),
) as NotifySmsPrefs;

export type Prefs = {
  readonly shareStaysWithFriends: boolean;
  readonly profilePortalId: string | null;
  readonly notify: NotifyPrefs;
  // A sibling map, not a channel inside `notify`: that shape is already stored
  // and the unsubscribe function writes `{[kind]: false}` straight into it.
  readonly notifySms: NotifySmsPrefs;
  // What wording was agreed to, when, and FOR WHICH NUMBER. Kept when the switch
  // goes off again — a consent record you can't produce is one you didn't take —
  // but a number that has since changed makes it a record about somebody else's
  // phone, so the sender checks it and Settings reads the switch as off.
  readonly smsConsentAt: number | null;
  readonly smsConsentVersion: string | null;
  readonly smsConsentNumber: string | null;
  // Written by the sender when Twilio reports the carrier's STOP. Cleared by the
  // next send that succeeds, or by turning texts back on — kip can't lift the
  // carrier's block, so Settings says so and the next refused send says it
  // again.
  readonly smsStopped: boolean;
  // A check the owner asked for, and the sender's answer to it. The client sets
  // `smsProbeAt`; the trigger stamps `smsProbeDoneAt` with the SAME value once
  // it has tried. So "still checking" is `smsProbeAt > smsProbeDoneAt`, and the
  // write that answers cannot re-trigger itself — which it would, since the
  // answer lands in the very document the trigger watches.
  readonly smsProbeAt: number | null;
  readonly smsProbeDoneAt: number | null;
};

export const DEFAULT_PREFS: Prefs = {
  // Off until asked for; `guestSharesStays` reads an absent doc the same way.
  shareStaysWithFriends: false,
  profilePortalId: null,
  notify: DEFAULT_NOTIFY,
  notifySms: DEFAULT_NOTIFY_SMS,
  smsConsentAt: null,
  smsConsentVersion: null,
  smsConsentNumber: null,
  smsStopped: false,
  smsProbeAt: null,
  smsProbeDoneAt: null,
};

// The wording currently shown beside the switch. Bump it when that changes, or
// a stored consent claims agreement to text nobody saw.
export const SMS_CONSENT_VERSION = "2026-08-23";

// The teardown a Cloud Function runs once `deletions/{uid}` appears, in order.
// A fixed, named list because the app draws a determinate bar over it: how long
// this takes depends on how many stays, places and photos there are, which
// nothing knows without counting first, so an ETA could only be a guess wearing
// a number. `functions/src/teardown.ts` keeps the same list — pinned together by
// tests/drift.test.ts, since a phase only one side knows renders as a blank step.
export const DELETION_PHASES = [
  "stays",
  "places",
  "friends",
  "profile",
  "account",
] as const;

export type DeletionPhase = (typeof DELETION_PHASES)[number];

export const DELETION_LABELS: Record<DeletionPhase, string> = {
  stays: "Cancelling your stays",
  places: "Removing your places",
  friends: "Removing you from friends' lists",
  profile: "Deleting your profile",
  account: "Closing your account",
};

export type DeletionRequest = {
  // Null between the client's write and the function's first report.
  readonly phase: DeletionPhase | null;
  readonly attempts: number;
  // Set only when the function has stopped retrying; the document then stays.
  readonly failed: boolean;
};

// Counting the wait BEFORE the first phase as a step of its own, and never
// filling: the bar is what has finished, and the last phase is still running
// when it is drawn. So it starts visibly moving rather than empty, and a full
// bar never sits over unfinished work.
export function deletionProgress(phase: DeletionPhase | null): number {
  const index = phase ? DELETION_PHASES.indexOf(phase) : -1;
  return (index + 2) / (DELETION_PHASES.length + 2);
}

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
