import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { NOTIFY_EVENTS } from "../utils/types";

// `functions/` is a separate package on a different runtime, so it can't import
// from `web/` — it keeps its own copy of the vocabulary they share. Nothing forces
// the two to agree, and the drift FAILS OPEN: the function reads
// `prefs.notify[kind]`, and a key the web side never writes comes back
// `undefined`, which `=== false` treats as "not disabled". So a renamed event
// doesn't error, it silently starts emailing people who opted out.
//
// This pins them together so drift breaks CI instead.
const FUNCTIONS_SOURCE = readFileSync("../functions/src/messages.ts", "utf8");

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

  it("every cancel reason the client writes is handled or defaulted", () => {
    // The function only special-cases SLOT_MOVED and lets the rest fall through
    // to a generic message. That's fine — but it must at least still MATCH one
    // the client writes, or the wording silently degrades for everyone.
    expect(FUNCTIONS_SOURCE).toContain('"SLOT_MOVED"');
  });
});
