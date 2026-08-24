import { describe, expect, it } from "bun:test";
import { cancellationFor } from "../../functions/src/leaving";

const LEAVER = "leaver";
const OTHER = "other";
const TODAY = "2026-08-22";

function booking(fields: Record<string, unknown>): Record<string, unknown> {
  return { guestId: LEAVER, ownerId: OTHER, end: "2026-09-01", ...fields };
}

// The teardown is a trigger with a retry budget, so every one of these decisions
// is made again over an account it has already partly dismantled — and each write
// it makes fires `onBookingChanged`, which mails the other party.
describe("what leaving does to a booking", () => {
  // The guard the whole retry design rests on, and the only one nothing else
  // would catch: a second attempt that re-cancels tells a host their guest
  // cancelled twice, and there is no undoing a delivered email.
  it("leaves a booking it has already cancelled alone", () => {
    expect(
      cancellationFor(
        booking({ status: "CANCELLED", cancelledBy: LEAVER }),
        LEAVER,
        TODAY,
      ),
    ).toBeNull();
  });

  it("decides nothing a second time, whatever it decided first", () => {
    for (const status of ["REQUESTED", "CONFIRMED"]) {
      const first = cancellationFor(booking({ status }), LEAVER, TODAY);
      expect(first).not.toBeNull();
      const after = booking({ status: first?.status, ...first });
      expect(cancellationFor(after, LEAVER, TODAY)).toBeNull();
    }
  });

  it("leaves a stay that already happened as the record it is", () => {
    expect(
      cancellationFor(
        booking({ status: "CONFIRMED", end: "2026-08-21" }),
        LEAVER,
        TODAY,
      ),
    ).toBeNull();
  });

  // The last day counts as ahead, matching `isExpired` on the web side: getting
  // this boundary wrong cancels a visit someone is on.
  it("still cancels a stay ending today", () => {
    expect(
      cancellationFor(
        booking({ status: "CONFIRMED", end: TODAY }),
        LEAVER,
        TODAY,
      )?.cancelReason,
    ).toBe("STAY_CANCELLED");
  });

  it("gives the host their nights back, and only at someone else's place", () => {
    expect(
      cancellationFor(booking({ status: "CONFIRMED" }), LEAVER, TODAY),
    ).toEqual({
      status: "CANCELLED",
      cancelledBy: LEAVER,
      cancelReason: "STAY_CANCELLED",
      releasesSlot: true,
    });
    expect(
      cancellationFor(
        booking({ status: "CONFIRMED", guestId: OTHER, ownerId: LEAVER }),
        LEAVER,
        TODAY,
      )?.releasesSlot,
    ).toBe(false);
  });

  // The two sides of an unanswered ask reach the other party as different
  // sentences, and they are the easiest pair to get backwards.
  it("tells a withdrawn ask from a slot going away", () => {
    expect(
      cancellationFor(booking({ status: "REQUESTED" }), LEAVER, TODAY)
        ?.cancelReason,
    ).toBe("WITHDRAWN");
    expect(
      cancellationFor(
        booking({ status: "REQUESTED", guestId: OTHER, ownerId: LEAVER }),
        LEAVER,
        TODAY,
      )?.cancelReason,
    ).toBe("SLOT_CANCELLED");
  });

  it("leaves a booking with no dates on it alone", () => {
    expect(
      cancellationFor(booking({ status: "CONFIRMED", end: null }), LEAVER, TODAY),
    ).toBeNull();
  });
});
