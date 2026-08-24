// Drives the HOST's side of a slot in a real browser, which is the half
// `check:portal` cannot reach: that one is a visitor asking, this one is the
// person being asked. Between them they cover both ends of one booking.
//
// It signs a host in through the email door (the Auth emulator publishes the
// link it would have mailed) and checks that returning ends in the app rather
// than on a panel about it, then seeds a place with one slot and two asks
// against it and asserts what the host actually sees — a count on the row in
// the list, and the askers themselves inside the slot.
//
//   cd web && bun run dev:emulated        # in one shell (serves on 3001)
//   bun run check:host                    # in another
//
// Exits non-zero on the first failed expectation, so it reads like a test.

import { spawn } from "node:child_process";

const APP = process.env.KIP_ORIGIN ?? "http://localhost:3001";
const FIRESTORE = "http://127.0.0.1:8080";
const AUTH = "http://127.0.0.1:9099";
// The two emulators namespace under DIFFERENT project ids, which is worth
// knowing before hunting for a link that was definitely sent. Firestore uses
// the id the CLIENT is configured with, because pointing the SDK at an emulator
// does not change the project it thinks it is talking to. Auth uses the id the
// emulator was STARTED with — the client authenticates with a fake API key, so
// there is no project in the request for it to honour.
const PROJECT = "hafaio-kip-dev";
const AUTH_PROJECT = "demo-kip";
const DOCS = `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents`;
const LISTING = "host-check-listing";
const WINDOW = "host-check-window";
const EMAIL = "host-check@example.com";

const failures = [];
function expect(what, ok, detail = "") {
  if (ok) console.log(`  ok   ${what}`);
  else {
    console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`);
    failures.push(what);
  }
}

async function put(path, fields) {
  const response = await fetch(`${DOCS}/${path}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!response.ok) throw new Error(`seed ${path}: ${response.status}`);
}

const str = (stringValue) => ({ stringValue });
const ts = (timestampValue) => ({ timestampValue });
const int = (n) => ({ integerValue: String(n) });

let chrome;
async function browser() {
  chrome = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      "--remote-debugging-port=9334",
      "--user-data-dir=/tmp/kip-host-check",
      "--disable-gpu",
      "--no-first-run",
      "--window-size=430,932",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  await new Promise((r) => setTimeout(r, 5000));
  const targets = await (await fetch("http://127.0.0.1:9334/json/list")).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const waiting = new Map();
  // Page-level events, not just replies. An exception that trips the app's own
  // error boundary is caught before any in-page hook can install, so the only
  // place its stack survives is here.
  const thrown = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      const detail = message.params?.exceptionDetails;
      thrown.push(detail?.exception?.description ?? detail?.text ?? "?");
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
      thrown.push((message.params.args ?? []).map((a) => a.description ?? a.value).join(" | "));
    }
    if (message.id && waiting.has(message.id)) {
      waiting.get(message.id)(message.result ?? message.error);
      waiting.delete(message.id);
    }
  };
  const send = (method, params = {}) => {
    const at = ++id;
    ws.send(JSON.stringify({ id: at, method, params }));
    return new Promise((r) => waiting.set(at, r));
  };
  await send("Page.enable");
  await send("Runtime.enable");
  return {
    thrown,
    evaluate: async (expression) =>
      (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))
        ?.result?.value,
    go: async (url, wait = 7000) => {
      await send("Page.navigate", { url });
      await new Promise((r) => setTimeout(r, wait));
    },
  };
}

const page = await browser();

console.log("the host gets in through the email door");
await page.go(APP);
const asked = await page.evaluate(`
(async () => {
  const type = (el, v) => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const field = document.querySelector("input");
  if (!field) return "no field on the welcome screen";
  type(field, "host-check@example.com");
  await new Promise(r => setTimeout(r, 400));
  const submit = document.querySelector("button[type=submit]");
  if (!submit || submit.disabled) return "submit unavailable";
  submit.click();
  await new Promise(r => setTimeout(r, 6000));
  return "SENT::" + document.body.innerText.slice(0, 300);
})()
`);
expect("a link is sent", String(asked).startsWith("SENT::") && !String(asked).includes("Couldn't"), String(asked).slice(0, 260));

// The emulator publishes the link it would have mailed, which is the whole
// reason this can run unattended.
const codes = await (await fetch(`${AUTH}/emulator/v1/projects/${AUTH_PROJECT}/oobCodes`)).json();
const link = codes.oobCodes?.at(-1)?.oobLink;
expect("the emulator captured it", Boolean(link), JSON.stringify(codes).slice(0, 160));
if (!link) {
  console.log(`\n${failures.length} failed`);
  chrome?.kill();
  process.exit(1);
}

// The link points at the emulator's own action page, which would redirect. The
// app's `/continue/` is what has to handle the code, so hand it there directly —
// the same query Firebase's redirect would arrive with.
const followed = new URL(link);
const code = followed.searchParams.get("oobCode");
await page.go(
  `${APP}/continue/?mode=signIn&lang=en&apiKey=fake-api-key&oobCode=${encodeURIComponent(code)}&email=${encodeURIComponent(EMAIL)}`,
  10000,
);

// Asked of the emulator, not of the browser. The SDK moves a session between
// localStorage and IndexedDB as it sees fit, so scraping storage reported a uid
// that was real once and wrong by the next page load — and everything seeded
// against it then belonged to nobody.
const accounts = await (
  await fetch(
    `${AUTH}/identitytoolkit.googleapis.com/v1/projects/${AUTH_PROJECT}/accounts:query`,
    {
      method: "POST",
      headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  )
).json();
const uid = accounts.userInfo?.find((u) => u.email === EMAIL)?.localId;
expect("the link signs the host in", Boolean(uid), JSON.stringify(accounts).slice(0, 200));
if (!uid) {
  console.log(`\n${failures.length} failed`);
  chrome?.kill();
  process.exit(1);
}

// The link's whole job is to put someone back in kip, so returning ends in the
// app. It used to stop at "Welcome back" and an Open kip link — a step between
// someone and the thing they had already asked for.
const landed = JSON.parse(
  await page.evaluate(
    `JSON.stringify({ href: location.href, text: document.body.innerText.slice(0, 200) })`,
  ),
);
expect("returning lands in the app", !/\/continue\//.test(landed.href), landed.href);
// Matched on the panel's own words: the app's Home greets a returning host
// with "Welcome back" too, so that phrase proves nothing either way.
expect(
  "and not on an interstitial",
  !/Open kip|signed in on this device/.test(landed.text),
  landed.text.replace(/\n+/g, " | ").slice(0, 160),
);
// The code is spent by the time this lands: carrying it into the app's URL
// would leave a dead one-time link in history for a Back to find.
expect("the one-time code is left behind", !/oobCode/.test(landed.href), landed.href);
await page.evaluate(`history.back(); "going"`);
await new Promise((r) => setTimeout(r, 2000));
const behind = await page.evaluate(`location.href`);
expect(
  "Back does not return to the spent link",
  !/\/continue\//.test(String(behind)),
  String(behind),
);

console.log("\nseeding a place with one slot and two asks");
const year = new Date().getUTCFullYear() + 1;
await put(`users/${uid}`, {
  displayName: str("Host Under Test"),
  username: str(""),
  searchable: { booleanValue: false },
  createdAt: ts("2026-08-01T00:00:00Z"),
});
await put(`listings/${LISTING}`, {
  ownerId: str(uid),
  title: str("The tested room"),
  location: {
    mapValue: {
      fields: {
        label: str("Lisbon"),
        lat: { doubleValue: 38.7223 },
        lng: { doubleValue: -9.1393 },
        geohash: str("eycs0p"),
      },
    },
  },
  type: str("ROOM"),
  description: str("A room"),
  photos: { arrayValue: {} },
  createdAt: ts("2026-08-01T00:00:00Z"),
});
await put(`listings/${LISTING}/windows/${WINDOW}`, {
  start: str(`${year}-11-01`),
  end: str(`${year}-11-05`),
  status: str("OPEN"),
  bookingId: { nullValue: null },
  autoAccept: { booleanValue: false },
  details: str(""),
  publicPortalId: { nullValue: null },
  createdAt: int(0),
});
for (const [id, guest, at] of [
  ["host-check-ask-1", "guest-early", 1000],
  ["host-check-ask-2", "guest-late", 2000],
]) {
  await put(`users/${guest}`, {
    displayName: str(guest === "guest-early" ? "Early Asker" : "Late Asker"),
    username: str(""),
    searchable: { booleanValue: false },
    createdAt: ts("2026-08-01T00:00:00Z"),
  });
  await put(`bookings/${id}`, {
    listingId: str(LISTING),
    ownerId: str(uid),
    guestId: str(guest),
    windowId: str(WINDOW),
    start: str(`${year}-11-01`),
    end: str(`${year}-11-05`),
    status: str("REQUESTED"),
    cancelledBy: { nullValue: null },
    cancelReason: { nullValue: null },
    hiddenBy: { arrayValue: {} },
    createdAt: int(at),
  });
}

console.log("\nthe list says the slot has been asked about");
await page.go(`${APP}/#/room/${LISTING}`, 9000);
const row = await page.evaluate(`
(async () => {
  for (let i = 0; i < 20; i++) {
    if (/Availability/.test(document.body.innerText)) break;
    await new Promise(r => setTimeout(r, 500));
  }
  return document.body.innerText;
})()
`);
// An exception here trips the app's error boundary, which renders a tidy
// "couldn't load" over the failure — so the stack is worth printing before the
// assertions describe the symptom instead of the cause.
if (page.thrown.length)
  console.log("  threw:", page.thrown.join("\n         ").slice(0, 1200));
expect(
  "the room is the host's own view",
  String(row).includes("Availability"),
  String(row).replace(/\n+/g, " | ").slice(0, 200),
);
// Without this a slot two people are waiting on looks exactly like an untouched
// one, and the requests inside the sheet are unreachable without opening every
// slot in turn.
expect("the row carries a count", /2 asked/.test(String(row)), String(row).slice(0, 400));

console.log("\nopening the slot shows who asked");
const sheet = await page.evaluate(`
(async () => {
  const row = [...document.querySelectorAll("[role=button], button")]
    .find(el => /asked/.test(el.innerText || ""));
  if (!row) return "no slot row";
  row.click();
  await new Promise(r => setTimeout(r, 2500));
  const dialog = document.querySelector("[role=dialog]") || document.body;
  return dialog.innerText;
})()
`);
expect("both askers are named", String(sheet).includes("Early Asker") && String(sheet).includes("Late Asker"), String(sheet).slice(0, 300));
// Oldest first: they are queueing for one slot and who asked first is the only
// ordering the host has reason to read.
expect(
  "oldest first",
  String(sheet).indexOf("Early Asker") < String(sheet).indexOf("Late Asker"),
  String(sheet).slice(0, 300),
);
// Naming who is waiting ABOVE the date fields is what makes the confirm that
// cancels them legible before the host touches a date.
expect(
  "they sit above the dates",
  String(sheet).indexOf("Early Asker") < String(sheet).indexOf("From"),
  String(sheet).slice(0, 300),
);
// The sheet is component state, so leaving for a booking and coming back has to
// go through the URL or the host lands on a room that forgot which slot was open.
const addressed = await page.evaluate(`location.hash`);
expect("the open slot is in the URL", String(addressed).includes(`/slot/${WINDOW}`), String(addressed));

console.log("\na booked slot still shows who missed out, below the stay itself");
// Confirming does not cancel the losers — `confirmBooking` touches only the
// winner and the window — and nothing else ever reaches them from these dates.
// The order is the assertion: the stay that HOLDS the nights outranks the asks
// that missed them, and reversing it reads as though nobody has these dates.
await put(`bookings/host-check-won`, {
  listingId: str(LISTING),
  ownerId: str(uid),
  guestId: str("guest-early"),
  windowId: str(WINDOW),
  start: str(`${year}-11-01`),
  end: str(`${year}-11-05`),
  status: str("CONFIRMED"),
  cancelledBy: { nullValue: null },
  cancelReason: { nullValue: null },
  hiddenBy: { arrayValue: {} },
  createdAt: int(500),
});
await put(`listings/${LISTING}/windows/${WINDOW}`, {
  start: str(`${year}-11-01`),
  end: str(`${year}-11-05`),
  status: str("BOOKED"),
  bookingId: str("host-check-won"),
  autoAccept: { booleanValue: false },
  details: str(""),
  publicPortalId: { nullValue: null },
  createdAt: int(0),
});
await page.go(`${APP}/#/room/${LISTING}/slot/${WINDOW}`, 10000);
const held = await page.evaluate(`
(async () => {
  for (let i = 0; i < 20; i++) {
    if (/Confirmed/.test(document.body.innerText)) break;
    await new Promise(r => setTimeout(r, 500));
  }
  return document.body.innerText;
})()
`);
expect("the stay is named", String(held).includes("Confirmed"), String(held).replace(/\n+/g, " | ").slice(0, 200));
expect(
  "the losers are still listed",
  /people asked/.test(String(held)),
  String(held).replace(/\n+/g, " | ").slice(0, 200),
);
expect(
  "the stay comes first",
  String(held).indexOf("Confirmed") < String(held).indexOf("people asked"),
  String(held).replace(/\n+/g, " | ").slice(0, 240),
);
// A dead end has to say so: these can never be confirmed, because
// `bookingMatchesOpenSlot` requires an OPEN slot.
expect(
  "and says they can only be declined",
  String(held).includes("went to someone else"),
  String(held).replace(/\n+/g, " | ").slice(0, 240),
);

console.log("\nopening a slot keeps the host's place in the list");
// A sheet is an overlay on the room, not a different screen. It was counted as
// one, so the page under it jumped to the top on open and again on close — and
// a host with a year of dates lost their place on every tap.
await put(`listings/${LISTING}/windows/${WINDOW}`, {
  start: str(`${year}-11-01`),
  end: str(`${year}-11-05`),
  status: str("OPEN"),
  bookingId: { nullValue: null },
  autoAccept: { booleanValue: false },
  details: str(""),
  publicPortalId: { nullValue: null },
  createdAt: int(0),
});
await page.go(`${APP}/#/room/${LISTING}`, 9000);
const kept = await page.evaluate(`
(async () => {
  const scroller = document.querySelector("main") || document.scrollingElement;
  const where = () => Math.round(scroller.scrollTop || window.scrollY);
  scroller.scrollTo({ top: 400, behavior: "instant" });
  window.scrollTo({ top: 400, behavior: "instant" });
  await new Promise(r => setTimeout(r, 600));
  const before = where();
  if (before === 0) return "the page does not scroll at this size";
  const row = [...document.querySelectorAll("[role=button], button")]
    .find(el => /nights/.test(el.innerText || ""));
  if (!row) return "no slot row";
  row.click();
  await new Promise(r => setTimeout(r, 2500));
  // Without this the probe passes by doing nothing at all: a click that never
  // opened the sheet also never navigates, so nothing could have scrolled.
  if (!/Save changes/.test(document.body.innerText)) return "the sheet did not open";
  return JSON.stringify({ before, after: where(), hash: location.hash });
})()
`);
expect(
  "the scroll position survives opening a slot",
  !String(kept).startsWith("no ") &&
    !String(kept).includes("does not scroll") &&
    !String(kept).includes("did not open") &&
    (() => {
      const seen = JSON.parse(String(kept));
      return Math.abs(seen.after - seen.before) < 40;
    })(),
  String(kept).slice(0, 160),
);

process.on("exit", () => chrome?.kill());
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall good");
process.exit(0);
