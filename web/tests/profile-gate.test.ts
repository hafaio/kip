import { describe, expect, test } from "bun:test";
import {
  classifySnapshot,
  type GateEvent,
  type GateState,
  gateStep,
  NO_SESSION,
} from "../utils/profile-gate";

const UID = "uid-a";
const OTHER = "uid-b";

function run(events: readonly GateEvent[]): GateState {
  return events.reduce(gateStep, NO_SESSION);
}

const attach: GateEvent = { kind: "attach", uid: UID };
const answered: GateEvent = { kind: "answered", uid: UID };
const silent: GateEvent = { kind: "silence", uid: UID };

describe("profile gate", () => {
  test("a fresh attach is shut and not unreachable", () => {
    expect(run([attach])).toEqual({
      openFor: null,
      triedFor: UID,
      unreachable: false,
    });
  });

  test("an answer opens the gate", () => {
    expect(run([attach, answered]).openFor).toBe(UID);
  });

  test("silence while shut is unreachable", () => {
    const state = run([attach, silent]);
    expect(state.unreachable).toBe(true);
    expect(state.openFor).toBeNull();
  });

  test("a retry for the same session keeps the verdict", () => {
    // The re-attach ladder runs at 500ms/2s/6s; clearing the verdict on each
    // attach flashed splash → error → splash at every step.
    expect(run([attach, silent, attach]).unreachable).toBe(true);
  });

  test("an answer clears the verdict", () => {
    const state = run([attach, silent, attach, answered]);
    expect(state).toEqual({ openFor: UID, triedFor: UID, unreachable: false });
  });

  test("silence once open changes nothing", () => {
    // A listener dying mid-session belongs to the re-attach machinery; shutting
    // the gate would splash over an open sheet and any half-typed form.
    const open = run([attach, answered]);
    expect(gateStep(open, silent)).toEqual(open);
  });

  test("a re-attach while open stays open", () => {
    expect(run([attach, answered, attach]).openFor).toBe(UID);
  });

  test("a new session starts clean", () => {
    const state = run([attach, silent, { kind: "attach", uid: OTHER }]);
    expect(state).toEqual({
      openFor: null,
      triedFor: OTHER,
      unreachable: false,
    });
  });

  test("a gate open for one uid is shut for another", () => {
    // A stale open would claim the NEW session's profile is loaded, rendering
    // the app around whatever the last one left behind.
    expect(run([attach, answered, { kind: "attach", uid: OTHER }])).toEqual({
      openFor: null,
      triedFor: OTHER,
      unreachable: false,
    });
  });

  test("a stale answer settles nothing", () => {
    expect(run([attach, { kind: "answered", uid: OTHER }]).openFor).toBeNull();
  });

  test("stale silence shuts nothing", () => {
    expect(run([attach, { kind: "silence", uid: OTHER }]).unreachable).toBe(
      false,
    );
  });

  test("signing out resets everything", () => {
    expect(run([attach, silent, { kind: "signedOut" }])).toEqual(NO_SESSION);
  });

  test("never open and unreachable at once", () => {
    // Page.tsx renders Unreachable only behind a shut gate, so an open gate
    // carrying the flag would silently never show it.
    const events: GateEvent[] = [
      attach,
      answered,
      silent,
      { kind: "attach", uid: OTHER },
      { kind: "answered", uid: OTHER },
      { kind: "silence", uid: OTHER },
      { kind: "signedOut" },
    ];
    let states: GateState[] = [NO_SESSION];
    for (let depth = 0; depth < 4; depth += 1) {
      states = states.flatMap((state) =>
        events.map((event) => gateStep(state, event)),
      );
      for (const state of states) {
        expect(state.openFor !== null && state.unreachable).toBe(false);
      }
    }
  });
});

describe("snapshot classification", () => {
  test("an existing profile answers, cached or not", () => {
    // Their own profile out of their own cache is believable.
    expect(classifySnapshot(true, true)).toBe("answered");
    expect(classifySnapshot(true, false)).toBe("answered");
  });

  test("a server-confirmed absence answers", () => {
    expect(classifySnapshot(false, false)).toBe("answered");
  });

  test("an absence from cache is silence", () => {
    // Probed against the SDK, not reasoned: this snapshot is byte-identical
    // for "no profile" and "offline with nothing cached".
    expect(classifySnapshot(false, true)).toBe("silence");
  });
});
