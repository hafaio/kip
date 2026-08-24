import { describe, expect, test } from "bun:test";
import { CHECK_ABANDON_MS, checkStep } from "../../functions/src/messages";
import { CHECK_STALL_MS, formatUsNumber, probeState } from "../utils/sms";

// The bug this pins: the check button stuck disabled with a spinner, across
// reloads, because the only thing that could ever clear it was a write from a
// trigger that had already failed. A deadline makes the giving-up visible.
describe("a check that never came back says so", () => {
  test("no ask is not a check in progress", () => {
    expect(probeState(null, null, 1_000)).toBe("idle");
  });

  test("an ask newer than its answer is still running", () => {
    expect(probeState(1_000, null, 1_500)).toBe("checking");
    expect(probeState(2_000, 1_000, 2_500)).toBe("checking");
  });

  test("past the deadline it has stalled", () => {
    expect(probeState(1_000, null, 1_000 + CHECK_STALL_MS)).toBe("stalled");
  });

  // Not terminal: the trigger's answer can still land, and does the moment the
  // write it failed on succeeds.
  test("a late answer settles a stall", () => {
    const late = 1_000 + CHECK_STALL_MS * 3;
    expect(probeState(1_000, 1_000, late)).toBe("answered");
  });

  test("the stamps land equal, which is how an answer is recognised", () => {
    expect(probeState(5, 5, 6)).toBe("answered");
  });
});

describe("a number is shown the way it would be dialled", () => {
  test("US numbers are grouped", () => {
    expect(formatUsNumber("+15555550123")).toBe("(555) 555-0123");
  });

  test("anything else is left exactly as stored", () => {
    expect(formatUsNumber("+445555550123")).toBe("+445555550123");
    expect(formatUsNumber("")).toBe("");
  });
});

describe("the sender gives up later than the screen does", () => {
  // The invariant that actually matters across the two packages: if the server
  // abandoned first, the button would say "checking" over a question nothing is
  // still working on, which is the exact state this pair exists to end.
  test("the server never abandons while a spinner is still up", () => {
    expect(CHECK_ABANDON_MS).toBeGreaterThan(CHECK_STALL_MS);
  });

  test("an answered ask is not re-run", () => {
    expect(checkStep(5, 5, 1_000)).toBe("skip");
    expect(checkStep(4, 5, 1_000)).toBe("skip");
  });

  test("a fresh ask is probed", () => {
    expect(checkStep(1_000, 0, 1_500)).toBe("probe");
  });

  // Without this a failure that always fails — a credential that cannot be
  // read is the realistic one — retries for days on a question the client gave
  // up on in thirty seconds.
  test("an old one is stamped and dropped rather than retried for ever", () => {
    expect(checkStep(1_000, 0, 1_000 + CHECK_ABANDON_MS + 1)).toBe("abandon");
  });
});
