import { describe, expect, it } from "bun:test";
import {
  DELETION_LABELS,
  DELETION_PHASES,
  type DeletionPhase,
  deletionProgress,
} from "../utils/types";

// The bar is the only thing a person watching a teardown can read, and nothing
// else it draws is checkable — the phases arrive from a trigger nobody can
// hurry.
describe("the deletion bar", () => {
  it("is already moving before the first phase is reported", () => {
    expect(deletionProgress(null)).toBeGreaterThan(0);
  });

  // A full bar over work still running is the one reading that would be a lie:
  // the last phase closes the Auth account, and the document disappearing is
  // what says it finished.
  it("never fills, not even on the last phase", () => {
    for (const phase of DELETION_PHASES) {
      expect(deletionProgress(phase)).toBeLessThan(1);
    }
  });

  it("only ever moves forward", () => {
    const steps = [null, ...DELETION_PHASES].map((phase: DeletionPhase | null) =>
      deletionProgress(phase),
    );
    for (let at = 1; at < steps.length; at += 1) {
      expect(steps[at]).toBeGreaterThan(steps[at - 1]);
    }
  });

  it("names every phase it can be handed", () => {
    for (const phase of DELETION_PHASES) {
      expect(DELETION_LABELS[phase]).toBeTruthy();
    }
  });
});
