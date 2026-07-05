// What to say, and to whom — with no Firebase in sight, so every branch can be
// tested directly. `index.ts` keeps the I/O (resolving an address from Auth,
// reading preferences, sending) and calls in here to decide.
//
// Splitting it this way is the only reason these branches are testable at all:
// the triggers themselves need emulators, Auth accounts and an SMTP server, so in
// practice they'd never be exercised, and the wording of a cancellation is
// exactly the sort of thing that quietly goes wrong.

export type NotifyKind =
  | "bookingRequested"
  | "bookingTaken"
  | "bookingDecision"
  | "stayCancelled"
  | "connectRequest";

export type Party = "host" | "guest" | "recipient";

export type Notice = {
  to: Party;
  kind: NotifyKind;
  subject: string;
  body: string;
};

// Enough of a booking to decide what to say about it.
export type BookingLike = {
  status: string;
  start: string;
  end: string;
  ownerId: string;
  hostName?: string;
  guestName?: string;
  cancelledBy?: string | null;
  cancelReason?: string | null;
};

export type RequestLike = {
  fromName?: string;
  fromUsername?: string;
  portalId?: string | null;
};

export function dateRange(start: string, end: string): string {
  return `${start} to ${end}`;
}

export function firstName(name: string | undefined): string {
  return (name ?? "").split(" ")[0] || "Someone";
}

// A booking appearing. Asking to stay and instant-booking are different events:
// one wants a decision from the host, the other is already settled and is only
// news, so they're separately switchable.
export function noticeForNewBooking(booking: BookingLike): Notice {
  const who = firstName(booking.guestName);
  const when = dateRange(booking.start, booking.end);

  if (booking.status === "CONFIRMED") {
    return {
      to: "host",
      kind: "bookingTaken",
      subject: `${who} booked your place`,
      body: `${who} took ${when}. It auto-accepts, so it's already confirmed — nothing for you to do.`,
    };
  }
  return {
    to: "host",
    kind: "bookingRequested",
    subject: `${who} asked to stay`,
    body: `${who} would like ${when}. Open kip to confirm or decline.`,
  };
}

// A booking changing state. Returns null when there's nothing worth sending —
// a status that didn't move, or someone taking back their own request, which the
// other side never knew about in a way that needs closing off.
export function noticeForBookingChange(
  before: BookingLike,
  after: BookingLike,
): Notice | null {
  if (before.status === after.status) return null;

  const when = dateRange(after.start, after.end);
  const host = firstName(after.hostName);
  const guest = firstName(after.guestName);

  if (after.status === "CONFIRMED") {
    return {
      to: "guest",
      kind: "bookingDecision",
      subject: `${host} confirmed your stay`,
      body: `You're all set for ${when}.`,
    };
  }

  if (after.status !== "CANCELLED") return null;

  const byHost = after.cancelledBy === after.ownerId;
  const wasPending = before.status === "REQUESTED";

  if (wasPending) {
    // The guest withdrawing their own ask needs no announcement.
    if (!byHost) return null;
    if (after.cancelReason === "SLOT_MOVED") {
      return {
        to: "guest",
        kind: "bookingDecision",
        subject: "Those dates changed",
        body: `${host} moved the dates you asked about (${when}), so your request was cancelled. Open kip to see what's free now.`,
      };
    }
    return {
      to: "guest",
      kind: "bookingDecision",
      subject: `${host} couldn't host those dates`,
      body: `Your request for ${when} wasn't taken up.`,
    };
  }

  // A confirmed stay called off — tell whichever side didn't do it.
  if (byHost) {
    return {
      to: "guest",
      kind: "stayCancelled",
      subject: "Your stay was cancelled",
      body: `${host} can no longer host ${when}.`,
    };
  }
  return {
    to: "host",
    kind: "stayCancelled",
    subject: `${guest} cancelled their stay`,
    body: `${when} is free again.`,
  };
}

export function noticeForConnectRequest(request: RequestLike): Notice {
  const who = request.fromName || "Someone";
  const handle = request.fromUsername ? ` (@${request.fromUsername})` : "";
  const how = request.portalId
    ? "They opened a link you shared."
    : "They found you by your username.";

  return {
    to: "recipient",
    kind: "connectRequest",
    subject: `${firstName(who)} wants to connect on kip`,
    body: `${who}${handle} asked to be friends. ${how} Open kip to accept or decline.`,
  };
}
