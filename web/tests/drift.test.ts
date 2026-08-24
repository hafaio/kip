import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import {
  NOTIFY_DEFAULTS,
  NOTIFY_SMS_DEFAULTS,
} from "../../functions/src/messages";
import { SMS_FROM } from "../utils/sms";
import {
  DEFAULT_NOTIFY,
  DEFAULT_NOTIFY_SMS,
  DELETION_PHASES,
  NOTIFY_EVENTS,
} from "../utils/types";

// `functions/` is a separate package on a different runtime, so it can't import
// from `web/` — it keeps its own copy of the vocabulary they share, and nothing
// forces the two to agree. The sender fails CLOSED on a kind it doesn't know, so
// a rename now costs silence rather than a message to someone who opted out —
// but silence about a cancelled stay is its own bug, and nobody reports a text
// they never got. This pins them together so drift breaks CI instead.
const FUNCTIONS_SOURCE = readFileSync("../functions/src/messages.ts", "utf8");
const TRIGGERS_SOURCE = readFileSync("../functions/src/index.ts", "utf8");
const TEARDOWN_SOURCE = readFileSync("../functions/src/teardown.ts", "utf8");

function arrayMembers(source: string, name: string): string[] {
  const declaration = source.split(`const ${name} = [`)[1];
  if (!declaration) throw new Error(`no ${name} array in functions source`);
  return [...declaration.split("]")[0].matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );
}

function unionMembers(typeName: string): string[] {
  const declaration = FUNCTIONS_SOURCE.split(`type ${typeName} =`)[1];
  if (!declaration) throw new Error(`no ${typeName} union in functions source`);
  return [...declaration.split(";")[0].matchAll(/"([^"]+)"/g)]
    .map((match) => match[1])
    .sort();
}

describe("web and functions share a vocabulary", () => {
  it("notification event keys match exactly", () => {
    expect(unionMembers("NotifyKind")).toEqual(
      Object.keys(NOTIFY_EVENTS).sort(),
    );
  });

  it("the texted subset matches", () => {
    expect(unionMembers("NotifySmsKind")).toEqual(
      Object.entries(NOTIFY_EVENTS)
        .filter(([, event]) => event.sms)
        .map(([kind]) => kind)
        .sort(),
    );
  });

  // The values, not just the keys: the sender answers for a kind nobody has
  // stored anything for out of its own copy of this table.
  it("both channels default the same way on each side", () => {
    expect(NOTIFY_DEFAULTS).toEqual(DEFAULT_NOTIFY);
    expect(NOTIFY_SMS_DEFAULTS).toEqual(DEFAULT_NOTIFY_SMS);
  });

  // The map PATH is the one thing nothing else pins, and the new one is a typo
  // away from reading email's answers to decide whether to text.
  it("reads each channel's preferences from its own map", () => {
    expect(TRIGGERS_SOURCE).toContain("wantsEmail(prefs.notify, kind)");
    expect(TRIGGERS_SOURCE).toContain("wantsSms(prefs.notifySms, kind)");
  });

  // The one thing binding a stored consent to the phone it was given about, and
  // the failure it prevents is a text to someone who never agreed to one.
  it("checks a text against the number consent names", () => {
    expect(TRIGGERS_SOURCE).toContain("prefs.smsConsentNumber !== number");
  });

  // In ORDER, not as a set: the deletion screen draws a determinate bar over
  // these and numbers the steps, so a phase the web side has never heard of
  // renders as a blank one, and a reordering renumbers someone's progress.
  // Settings tells someone whose carrier is blocking kip to text START to this
  // number, and that instruction is only true of the number kip actually sends
  // from. Wrong, it sends them to a phone kip has never texted from, where the
  // message goes through and changes nothing — worse than saying nothing, and
  // invisible until someone is already stuck. Both are empty until a number is
  // provisioned, so this holds today and starts biting the moment one is.
  it("the number Settings names is the number the sender texts from", () => {
    const declared = TRIGGERS_SOURCE.split("const TWILIO_FROM = ")[1];
    if (!declared) throw new Error("no TWILIO_FROM in the triggers source");
    expect(declared.split(";")[0].trim()).toBe(JSON.stringify(SMS_FROM));
  });

  it("the teardown phases match, in order", () => {
    expect(arrayMembers(TEARDOWN_SOURCE, "DELETION_PHASES")).toEqual([
      ...DELETION_PHASES,
    ]);
  });

  it("every cancel reason the client writes is handled or defaulted", () => {
    // The function only special-cases SLOT_MOVED and lets the rest fall through
    // to a generic message. That's fine — but it must at least still MATCH one
    // the client writes, or the wording silently degrades for everyone.
    expect(FUNCTIONS_SOURCE).toContain('"SLOT_MOVED"');
  });
});
