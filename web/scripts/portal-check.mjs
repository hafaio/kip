// Drives the share-link path in a real browser against the emulators, because
// nothing else can: it needs a page, a session and a portal, so lint, the unit
// suite and the rules suite all pass while it is broken. Every bug this path has
// shipped got through exactly that way.
//
// It cannot gate CI — it wants a browser and a dev server — and that is not a
// reason to skip it. Run it by hand after touching the portal, the identity
// sheet, or anything in `utils/auth.ts`:
//
//   cd web && bun run dev:emulated        # in one shell (serves on 3001)
//   bun run check:portal                  # in another
//
// Set KIP_ORIGIN if the dev server isn't on 3001.
//
// Exits non-zero with the first failed expectation, so it reads like a test.

import { spawn } from "node:child_process";

// 3001, not Next's default — Erik's own dev server lives on 3000, and an
// emulated server there would quietly answer for it. `dev:emulated` pins the
// same port, so the two cannot drift apart.
const APP = process.env.KIP_ORIGIN ?? "http://localhost:3001";
const FIRESTORE = "http://127.0.0.1:8080";
// The CLIENT's project id, not the emulator's `--project` flag. Pointing the
// SDK at an emulator does not change the project it thinks it is talking to, and
// the emulator namespaces data per project — so seeding under the flag's name
// writes into a namespace the app never reads, and every link reads as dead.
const PROJECT = "hafaio-kip-dev";
const DOCS = `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents`;
const TOKEN = "portal-check-token";
const HOST = "host-portal-check";

const failures = [];
function expect(what, ok, detail = "") {
  if (ok) console.log(`  ok   ${what}`);
  else {
    console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`);
    failures.push(what);
  }
}

// Admin writes: the emulator accepts `Bearer owner` and skips rules, which is
// what lets this build a host without pretending to be one.
async function put(path, fields) {
  const response = await fetch(`${DOCS}/${path}`, {
    method: "PATCH",
    headers: {
      Authorization: "Bearer owner",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });
  if (!response.ok) throw new Error(`seed ${path}: ${response.status}`);
}

const str = (stringValue) => ({ stringValue });
const ts = (timestampValue) => ({ timestampValue });

async function seed() {
  await put(`users/${HOST}`, {
    displayName: str("Sam Host"),
    username: str(""),
    searchable: { booleanValue: false },
    createdAt: ts("2026-08-01T00:00:00Z"),
  });
  await put(`users/${HOST}/settings/prefs`, { profilePortalId: str(TOKEN) });
  await put(`portals/${TOKEN}`, {
    scope: str("USER"),
    ownerId: str(HOST),
    ownerName: str("Sam Host"),
    ownerPhotoURL: { nullValue: null },
    createdAt: ts("2026-08-01T00:00:00Z"),
  });
  await put(`listings/portal-check-listing`, {
    ownerId: str(HOST),
    title: str("The spare room"),
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
  // Far enough out that `isExpired` can never age the fixture into a failure —
  // the same trap `isoIn` exists to avoid in the rules suite.
  const year = new Date().getUTCFullYear() + 1;
  await put(`listings/portal-check-listing/windows/w1`, {
    start: str(`${year}-10-01`),
    end: str(`${year}-10-05`),
    status: str("OPEN"),
    bookingId: { nullValue: null },
    autoAccept: { booleanValue: false },
    details: str(""),
    publicPortalId: { nullValue: null },
    createdAt: ts("2026-08-01T00:00:00Z"),
  });
}

let chrome;
async function browser() {
  chrome = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      "--remote-debugging-port=9333",
      "--user-data-dir=/tmp/kip-portal-check",
      "--disable-gpu",
      "--no-first-run",
      "--window-size=430,932",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  await new Promise((r) => setTimeout(r, 5000));
  const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
  const ws = new WebSocket(
    targets.find((t) => t.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
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
    send,
    evaluate: async (expression) =>
      (
        await send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        })
      )?.result?.value,
    go: async (url, wait = 7000) => {
      await send("Page.navigate", { url });
      await new Promise((r) => setTimeout(r, wait));
    },
  };
}

const page = await (async () => {
  await seed();
  console.log("seeded a USER-scope portal with one room and one open slot\n");
  return browser();
})();

console.log("share link resolves");
await page.send("Page.navigate", { url: `${APP}/portal/#${TOKEN}` });
await new Promise((r) => setTimeout(r, 1200));
await page.evaluate(`
  window.__errs = [];
  const orig = console.error;
  console.error = (...a) => { window.__errs.push(a.map(x => x && x.code ? x.code + " :: " + x.message : String(x)).join(" | ")); orig(...a); };
`);
await new Promise((r) => setTimeout(r, 8000));
const logged = await page.evaluate("window.__errs");
if (logged?.length) console.log("  console:", JSON.stringify(logged));
const shown = await page.evaluate("document.body.innerText");
expect("does not report the link as inactive", !shown.includes("isn't active"), shown.slice(0, 90));
expect("names the host", shown.includes("Sam Host"));
expect("shows the room", shown.includes("The spare room"));
expect("offers to ask", shown.includes("Ask to be friends") || shown.includes("Request"));

console.log("\nasking opens the identity sheet");
const sheet = await page.evaluate(`
(async () => {
  const ask = [...document.querySelectorAll("button")].find(b => /ask|request/i.test(b.textContent));
  if (!ask) return "no ask control";
  ask.click();
  await new Promise(r => setTimeout(r, 1500));
  const inputs = [...document.querySelectorAll("input")].length;
  const labels = [...document.querySelectorAll("form button")].map(b => b.textContent.trim());
  return JSON.stringify({ inputs, labels, text: document.body.innerText.slice(-200) });
})()
`);
expect("a sheet with fields opens", String(sheet).includes('"inputs":2'), String(sheet).slice(0, 160));
// Google is its own path — below the submit, after a divider — because it
// authenticates FIRST and takes the name from the account rather than the form.
expect(
  "Google is offered below the submit",
  String(sheet).includes("with Google") &&
    String(sheet).indexOf("with Google") > String(sheet).indexOf("Send request"),
  String(sheet).slice(-140),
);

console.log("\nasking actually sends");
const sent = await page.evaluate(`
(async () => {
  const type = (el, v) => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const inputs = [...document.querySelectorAll("input")];
  if (inputs.length < 1) return "no fields";
  type(inputs[0], "Wandering Guest");
  await new Promise(r => setTimeout(r, 400));
  const submit = document.querySelector("button[type=submit]");
  if (!submit) return "no submit";
  if (submit.disabled) return "submit disabled with a valid name";
  submit.click();
  await new Promise(r => setTimeout(r, 10000));
  return JSON.stringify({ errs: window.__errs, tail: document.body.innerText.slice(-260) });
})()
`);
expect("the submit went through", !String(sent).startsWith("no ") && !String(sent).includes("disabled"), String(sent).slice(0, 120));

// The point of the whole flow: a real REQUESTED booking against the host's slot,
// and a profile carrying the name that was typed a moment before it. A booking
// deliberately carries no name — the host reads it off the profile through the
// `knownBy` hop — so the two are checked separately.
async function query(collectionId, field, value) {
  const rows = await (
    await fetch(`${DOCS}:runQuery`, {
      method: "POST",
      headers: {
        Authorization: "Bearer owner",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId }],
          where: {
            fieldFilter: {
              field: { fieldPath: field },
              op: "EQUAL",
              value: { stringValue: value },
            },
          },
        },
      }),
    })
  ).json();
  return rows.filter((row) => row.document).map((row) => row.document);
}

const bookings = await query("bookings", "ownerId", HOST);
const booking = bookings[0]?.fields;
expect("a request reached the host", Boolean(booking), JSON.stringify(bookings).slice(0, 140));
expect(
  "it is REQUESTED, never confirmed from a link",
  booking?.status?.stringValue === "REQUESTED",
  booking?.status?.stringValue,
);
expect(
  "it holds the dates that were shown",
  booking?.start?.stringValue?.endsWith("-10-01"),
  booking?.start?.stringValue,
);

const guestUid = booking?.guestId?.stringValue;
const profile = guestUid
  ? await (
      await fetch(`${DOCS}/users/${guestUid}`, {
        headers: { Authorization: "Bearer owner" },
      })
    ).json()
  : null;
expect(
  "the guest's profile carries the name they typed",
  profile?.fields?.displayName?.stringValue === "Wandering Guest",
  profile?.fields?.displayName?.stringValue,
);

console.log("\nthe field routes on what was typed, not on the mode");
// The Segmented only sets the keyboard and the autofill hint: a NUMBER typed
// while it reads Email must still be recognised, because being in the "wrong"
// mode can never be the thing that decides. instead: type a US number into the email-mode
// input and confirm the form accepts it rather than calling it invalid.
await page.go(`${APP}/portal/#${TOKEN}`);
const typedNumber = await page.evaluate(`
(async () => {
  const ask = [...document.querySelectorAll("button")].find(b => /ask to be friends/i.test(b.textContent));
  if (!ask) return "no connect control";
  ask.click();
  await new Promise(r => setTimeout(r, 1500));
  const type = (el, v) => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const inputs = [...document.querySelectorAll("input")];
  if (inputs.length < 2) return "no reach field";
  const reach = inputs[inputs.length - 1];
  if (reach.inputMode !== "email") return "field was not in email mode: " + reach.inputMode;
  type(inputs[0], "Number Typer");
  type(reach, "(415) 555-0123");
  await new Promise(r => setTimeout(r, 600));
  const submit = document.querySelector("button[type=submit]");
  return JSON.stringify({
    disabled: submit.disabled,
    body: document.body.innerText.slice(-220),
  });
})()
`);
expect(
  "a phone number typed in email mode is accepted",
  !String(typedNumber).includes('"disabled":true') &&
    !String(typedNumber).includes("doesn't look like"),
  String(typedNumber).slice(0, 200),
);

// In a finally, or a thrown expectation leaves a headless Chrome running and a
// profile directory behind for the next run to inherit.
process.on("exit", () => chrome?.kill());
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall good");
process.exit(0);
