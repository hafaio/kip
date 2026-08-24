import { describe, expect, it } from "bun:test";
import { isForeignNumber, parseDestination } from "../utils/destination";

describe("parseDestination", () => {
  it("reads an address", () => {
    expect(parseDestination("sam@example.com")).toEqual({
      kind: "email",
      value: "sam@example.com",
    });
  });

  // Addresses are compared elsewhere and typed by hand here; a stored capital
  // would make the same person look like two.
  it("lowercases an address", () => {
    expect(parseDestination("  Sam@Example.COM  ")).toEqual({
      kind: "email",
      value: "sam@example.com",
    });
  });

  it("reads a bare ten-digit number", () => {
    expect(parseDestination("4155550123")).toEqual({
      kind: "phone",
      value: "+14155550123",
    });
  });

  // The punctuation people actually type, none of which should be their problem.
  it.each([
    "(415) 555-0123",
    "415-555-0123",
    "415.555.0123",
    "+1 415 555 0123",
    "1 (415) 555 0123",
  ])("reads %s", (raw) => {
    expect(parseDestination(raw)).toEqual({
      kind: "phone",
      value: "+14155550123",
    });
  });

  // The whole point of the parse: the Segmented control is a keyboard hint, so
  // being in the "wrong" one must never decide the outcome.
  it("routes on what was typed, not on any mode", () => {
    expect(parseDestination("sam@example.com").kind).toBe("email");
    expect(parseDestination("4155550123").kind).toBe("phone");
  });

  it.each(["", "   ", "sam@", "@example.com", "sam example.com", "hello"])(
    "refuses %p",
    (raw) => {
      expect(parseDestination(raw)).toEqual({ kind: "unknown" });
    },
  );

  // Long enough to be a real number, short enough not to be a US one.
  it("refuses a number kip cannot text", () => {
    expect(parseDestination("+44 20 7946 0958")).toEqual({ kind: "unknown" });
  });
});

describe("isForeignNumber", () => {
  // The difference decides the advice: "use email instead" versus "check that".
  it("tells a foreign number from gibberish", () => {
    expect(isForeignNumber("+44 20 7946 0958")).toBe(true);
    expect(isForeignNumber("hello")).toBe(false);
    expect(isForeignNumber("sam@example.com")).toBe(false);
  });

  it("does not claim a US number", () => {
    expect(isForeignNumber("4155550123")).toBe(false);
    expect(isForeignNumber("+1 415 555 0123")).toBe(false);
  });
});
