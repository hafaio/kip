import { describe, expect, it } from "bun:test";
import { slotVerdict } from "../utils/bookings";

const WINDOW = { id: "w1", start: "2026-09-01", end: "2026-09-04" };
const OPEN = {
  exists: true,
  status: "OPEN",
  start: WINDOW.start,
  end: WINDOW.end,
};

describe("slotVerdict", () => {
  it("lets an unchanged open slot through", () => {
    expect(slotVerdict(OPEN, WINDOW, false)).toBeNull();
  });

  // The one that matters, and the one that had it backwards: a read that never
  // happened must not refuse the ask. Firestore queues the write and lands it on
  // reconnect, which is the property the whole flow is documented to have —
  // treating a failed read as "removed" drops the ask and blames the host.
  it("lets the ask through when the read failed", () => {
    expect(slotVerdict(null, WINDOW, false)).toBeNull();
  });

  // Distinct from a failed read, and the distinction is the whole point: this
  // one ANSWERED, and the answer was that the slot is gone.
  it("refuses a slot that answered and is not there", () => {
    expect(slotVerdict({ exists: false }, WINDOW, false)).toBe("removed");
  });

  it("names each cause rather than refusing generically", () => {
    expect(slotVerdict({ ...OPEN, status: "BOOKED" }, WINDOW, false)).toBe(
      "taken",
    );
    expect(slotVerdict({ ...OPEN, start: "2026-09-02" }, WINDOW, false)).toBe(
      "moved",
    );
    expect(slotVerdict({ ...OPEN, end: "2026-09-05" }, WINDOW, false)).toBe(
      "moved",
    );
    expect(slotVerdict(OPEN, WINDOW, true)).toBe("past");
  });

  // Order is load-bearing: a slot someone else took is worth saying so even if
  // its dates have also lapsed, because "someone got there first" is the true
  // account of what happened to this ask.
  it("reports taken ahead of past", () => {
    expect(slotVerdict({ ...OPEN, status: "BOOKED" }, WINDOW, true)).toBe(
      "taken",
    );
  });
});
