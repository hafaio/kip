import { describe, expect, it } from "bun:test";
import {
  noticeForBookingChange,
  noticeForConnectRequest,
  noticeForNewBooking,
} from "../../functions/src/messages";

// The notification triggers themselves need emulators, real Auth accounts and an
// SMTP server, so in practice they never get exercised — which is how they sat
// entirely untested up to the point of being deployed. The DECISIONS they make
// don't need any of that, so they live in a pure module and get tested here:
// which of the two parties hears about something, under which preference, and
// what it actually says.

const booking = {
  status: "REQUESTED",
  start: "2026-08-14",
  end: "2026-08-19",
  ownerId: "host",
  hostName: "Maya Rivera",
  guestName: "Sam Okafor",
  cancelledBy: null as string | null,
  cancelReason: null as string | null,
};

describe("a booking appearing", () => {
  it("an ask goes to the host, needing a decision", () => {
    const notice = noticeForNewBooking(booking);
    expect(notice.to).toBe("host");
    expect(notice.kind).toBe("bookingRequested");
    expect(notice.subject).toBe("Sam asked to stay");
    expect(notice.body).toContain("confirm or decline");
  });

  // Separately switchable, because one wants something from you and the other
  // is just news.
  it("an instant booking is news, under its own preference", () => {
    const notice = noticeForNewBooking({ ...booking, status: "CONFIRMED" });
    expect(notice.to).toBe("host");
    expect(notice.kind).toBe("bookingTaken");
    expect(notice.body).toContain("nothing for you to do");
  });

  it("falls back gracefully when a name is missing", () => {
    const notice = noticeForNewBooking({ ...booking, guestName: undefined });
    expect(notice.subject).toBe("Someone asked to stay");
  });
});

describe("a booking changing", () => {
  const confirmed = { ...booking, status: "CONFIRMED" };
  const cancelledByHost = {
    ...booking,
    status: "CANCELLED",
    cancelledBy: "host",
  };
  const cancelledByGuest = {
    ...booking,
    status: "CANCELLED",
    cancelledBy: "guest",
  };

  it("says nothing when the status didn't move", () => {
    expect(noticeForBookingChange(booking, { ...booking })).toBeNull();
  });

  it("a confirmation goes to the guest", () => {
    const notice = noticeForBookingChange(booking, confirmed);
    expect(notice?.to).toBe("guest");
    expect(notice?.kind).toBe("bookingDecision");
    expect(notice?.subject).toBe("Maya confirmed your stay");
  });

  it("a decline goes to the guest", () => {
    const notice = noticeForBookingChange(booking, {
      ...cancelledByHost,
      cancelReason: "DECLINED",
    });
    expect(notice?.to).toBe("guest");
    expect(notice?.subject).toContain("couldn't host");
  });

  // Distinct from a decline: nothing was refused, and there may well be other
  // dates worth asking about — so it points them back rather than apologising.
  it("moved dates read differently from a decline", () => {
    const notice = noticeForBookingChange(booking, {
      ...cancelledByHost,
      cancelReason: "SLOT_MOVED",
    });
    expect(notice?.subject).toBe("Those dates changed");
    expect(notice?.body).toContain("see what's free now");
  });

  it("a guest withdrawing their own ask tells nobody", () => {
    expect(noticeForBookingChange(booking, cancelledByGuest)).toBeNull();
  });

  it("a host calling off a confirmed stay tells the guest", () => {
    const notice = noticeForBookingChange(confirmed, {
      ...cancelledByHost,
      cancelReason: "STAY_CANCELLED",
    });
    expect(notice?.to).toBe("guest");
    expect(notice?.kind).toBe("stayCancelled");
    expect(notice?.subject).toBe("Your stay was cancelled");
  });

  // The mirror case — and the one most easily got backwards, since both are a
  // confirmed stay ending.
  it("a guest cancelling a confirmed stay tells the host", () => {
    const notice = noticeForBookingChange(confirmed, {
      ...cancelledByGuest,
      cancelReason: "STAY_CANCELLED",
    });
    expect(notice?.to).toBe("host");
    expect(notice?.kind).toBe("stayCancelled");
    expect(notice?.subject).toBe("Sam cancelled their stay");
    expect(notice?.body).toContain("free again");
  });

  it("says nothing about a status kip doesn't recognise", () => {
    expect(
      noticeForBookingChange(booking, { ...booking, status: "WEIRD" }),
    ).toBeNull();
  });
});

describe("a connect request", () => {
  it("names how they reached you — by handle", () => {
    const notice = noticeForConnectRequest({
      fromName: "Priya Raman",
      fromUsername: "priya_r",
      portalId: null,
    });
    expect(notice.to).toBe("recipient");
    expect(notice.subject).toBe("Priya wants to connect on kip");
    expect(notice.body).toContain("(@priya_r)");
    expect(notice.body).toContain("found you by your username");
  });

  it("names how they reached you — by link", () => {
    const notice = noticeForConnectRequest({
      fromName: "Priya Raman",
      fromUsername: "",
      portalId: "abc123",
    });
    expect(notice.body).toContain("opened a link you shared");
    // No handle claimed, so none shown — rather than a dangling "(@)".
    expect(notice.body).not.toContain("(@");
  });

  it("survives a sender with no name at all", () => {
    const notice = noticeForConnectRequest({});
    expect(notice.subject).toBe("Someone wants to connect on kip");
  });
});
