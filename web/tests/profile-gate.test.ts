import { describe, expect, test } from "bun:test";
import {
  classifySnapshot,
  type GateEvent,
  type GateState,
  gateStep,
  NO_SESSION,
  attempt,
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

  test("an absence from cache proves nothing", () => {
    // Probed against the SDK, not reasoned: this snapshot is byte-identical
    // for "no profile" and "offline with nothing cached". It used to be read as
    // the offline verdict, on the belief that the SDK raised it only once it
    // stopped waiting — but a target carrying a resume token from a previous
    // visit has it raised AT ATTACH, before the SDK has spoken to anyone. So
    // every ordinary reload by an account with no profile yet put "Can't reach
    // kip right now" on screen for one server round trip (80-170ms, measured)
    // between the splash and the app. Which of the two raised it is the cache's
    // answer to give, not this function's.
    expect(classifySnapshot(false, true)).toBe("unproven");
  });
});

// The bug these pin: a cache read outliving the listener that started it, then
// answering `null` for a person who has a profile — which reads as "no name
// yet" and opens the identity sheet over someone who already has one. A late
// silence is the same shape and flips the can't-reach-kip screen instead.
describe("an answer belongs to one attempt", () => {
  test("a minted check is current until something displaces it", () => {
    const run = attempt();
    const first = run.mint();
    expect(first()).toBe(true);
  });

  test("a later attempt retires an earlier one", () => {
    const run = attempt();
    const first = run.mint();
    const second = run.mint();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  // The half that was missing: a re-attach opens a new listener for the SAME
  // uid, so no uid-keyed guard anywhere can reject the straggler.
  test("teardown retires every answer still outstanding", () => {
    const run = attempt();
    const first = run.mint();
    const second = run.mint();
    run.stop();
    expect(first()).toBe(false);
    expect(second()).toBe(false);
  });
});
