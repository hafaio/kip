import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";

// Every surface that asks for an email or a number reserves its message slot at
// the height of its own standing copy and swaps the text, so a line that runs
// one longer than the reservation pushes the button under it — the exact jump
// the reserved height was added to remove. Shortening the copy has been tried
// before and did not hold, because nothing enforced a budget; this is the
// budget.
//
// 42 characters, measured rather than reasoned: the narrowest slot is 342px (the
// line under the door's card, at 390px less the page's px-6) and the sheets are
// ~350px, and mixed-case prose in Plus Jakarta Sans at 14px crosses that at 48.
// Kept at 42 with that headroom because a count is a proxy for a width — the
// densest copy here runs 7.3px a character, so anything landing near the cap
// wants looking at in a browser rather than trusting to the number.
const BUDGET = 42;

// Read rather than imported: every one of these lives in a "use client" module
// that pulls in React, the store and Firebase, and a copy-length check should
// not need a browser to run. Scanning the source also picks up a line added
// later, which is the half of this that a fixed list would miss.
const PANEL = readFileSync("components/auth-panel.tsx", "utf8");
const GATE = readFileSync("components/name-gate.tsx", "utf8");
const PORTAL = readFileSync("app/portal/page.tsx", "utf8");
const SETTINGS = readFileSync("components/settings-view.tsx", "utf8");
const FIELD = readFileSync("components/reach-field.tsx", "utf8");
const AUTH = readFileSync("utils/auth.ts", "utf8");

function literals(source: string): string[] {
  return [...source.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)]
    .map((match) => match[1])
    // Prose, as against an error code, a mode or a class name — every line the
    // slot can show is a sentence, and nothing else here has a space in it.
    .filter((text) => text.includes(" "));
}

// Everything from a top-level declaration to the bare `}` that ends it. The
// terminator has to be the WHOLE line: a destructured parameter list closes
// with `}: {` in the first column too, which cut a component's body off at its
// own signature and left the scan below finding nothing.
function body(source: string, declaration: string): string {
  const after = source.split(declaration)[1];
  if (!after) throw new Error(`no ${declaration} in source`);
  const lines = after.split("\n");
  const end = lines.findIndex((line) => line === "}" || line === "};");
  if (end < 0) throw new Error(`${declaration} never closes`);
  return lines.slice(0, end).join("\n");
}

// Everything handed to `setError`, including the literal it compares against to
// decide whether `authErrorMessage` said anything useful. Only the errors: the
// standing captions these slots show the rest of the time are as long as their
// own reservation allows, and it is the SWAP that has to fit.
function errors(source: string): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(/setError\(/g)) {
    let depth = 1;
    let end = match.index + match[0].length;
    while (depth > 0) {
      const character = source[end];
      if (character === undefined) throw new Error("unclosed setError call");
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      end += 1;
    }
    calls.push(source.slice(match.index + match[0].length, end - 1));
  }
  return calls.flatMap(literals);
}

describe("every reach surface's message slot shares one copy budget", () => {
  const sources: Array<[string, () => string[]]> = [
    ["auth-panel", () => errors(PANEL)],
    ["name-gate", () => errors(GATE)],
    // Scoped to the form, since the two files also report elsewhere: the
    // portal's own notice sits under the sheet with room to wrap, and
    // Settings' Notifications card is not a slot at all.
    ["the portal's name form", () => errors(body(PORTAL, "function NameForm"))],
    ["the doors sheets", () => errors(body(SETTINGS, "function DoorsSection"))],
    ["reachError", () => literals(body(FIELD, "export function reachError"))],
    [
      "authErrorMessage",
      () => literals(body(AUTH, "export function authErrorMessage")),
    ],
  ];

  for (const [name, collect] of sources) {
    it(`finds ${name}'s lines`, () => {
      expect(collect().length).toBeGreaterThan(2);
    });

    it(`keeps ${name}'s lines to one rendered line`, () => {
      // Reported as a list so a failure names the line that is too long
      // instead of a number that is too big.
      expect(collect().filter((line) => line.length > BUDGET)).toEqual([]);
    });
  }
});
