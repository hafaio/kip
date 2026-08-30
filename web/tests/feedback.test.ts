import { describe, expect, it } from "bun:test";
import { EMAIL_DOOR, GOOGLE_DOOR, PHONE_DOOR } from "../utils/auth";
import { credentialed } from "../utils/feedback";

// A copy of `hasCredential()` from firestore.rules, which the rules suite pins
// on its own side. What this pins is the COPY: the two disagreeing shows up as
// a menu row that is missing, or one whose write is refused with no
// explanation, and neither says which half is wrong.
describe("who may send feedback", () => {
  const door = (providerId: string) => [{ providerId, value: null }];

  it("a phone or Google door proves itself", () => {
    expect(credentialed(door(PHONE_DOOR), false)).toBe(true);
    expect(credentialed(door(GOOGLE_DOOR), false)).toBe(true);
  });

  // Firebase verifies no password signup, and the web API key is public, so an
  // address nobody answered is the one door that has to be checked.
  it("an email door counts only once the address is verified", () => {
    expect(credentialed(door(EMAIL_DOOR), true)).toBe(true);
    expect(credentialed(door(EMAIL_DOOR), false)).toBe(false);
  });

  // What a share-link visitor has: an account, and nothing behind it.
  it("a ticket has no door at all", () => {
    expect(credentialed([], true)).toBe(false);
  });
});
