// Drives feedback in a real browser, both halves: somebody sending one, and the
// operator reading and clearing them.
//
//   cd web && bun run dev:emulated      # in one shell (serves on 3001)
//   bun run check:feedback              # in another
//
// Every assertion here is a state the other suites cannot see. The rules suite
// proves who MAY read the collection; only a browser proves the menu row appears
// for the operator and for nobody else, that the list query the screen actually
// issues is the one the rules allow, and that a report typed into the sheet
// reaches the database at all. Exits non-zero on the first failure.

import { spawn, spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";

const APP = "http://localhost:3001";
const FIRESTORE = "http://127.0.0.1:8080";
const AUTH = "http://127.0.0.1:9099";
const PROJECT = "hafaio-kip-dev";
// The two emulators namespace under different ids: Firestore under the CLIENT's
// project, Auth under the one it was started with.
const AUTH_PROJECT = "demo-kip";
const DOCS = `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents`;
const EMAIL = `feedback-check-${Date.now()}@example.com`;
const PROFILE = "/tmp/kip-feedback-check";

const failures = [];
function expect(what, ok, detail = "") {
  if (ok) console.log(`  ok   ${what}`);
  else {
    console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`);
    failures.push(what);
  }
}
const str = (stringValue) => ({ stringValue });

async function write(path, fields) {
  const r = await fetch(`${DOCS}/${path}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
}
async function remove(path) {
  await fetch(`${DOCS}/${path}`, { method: "DELETE", headers: { Authorization: "Bearer owner" } });
}
async function listFeedback() {
  const r = await fetch(`${DOCS}/feedback`, { headers: { Authorization: "Bearer owner" } });
  return r.ok ? ((await r.json()).documents ?? []) : [];
}

let chrome;
async function browser() {
  // A browser left behind holds the debug port AND the signed-in session, so the
  // next run opens on the app rather than the door. No leading dashes in the
  // pkill pattern: it reads one as an option and matches nothing while looking
  // like it worked.
  spawnSync("pkill", ["-f", `user-data-dir=${PROFILE}`]);
  await new Promise((done) => setTimeout(done, 1500));
  await rm(PROFILE, { recursive: true, force: true });
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", "--remote-debugging-port=9338",
    `--user-data-dir=${PROFILE}`, "--disable-gpu", "--no-first-run",
    "--window-size=430,932", "about:blank",
  ], { stdio: "ignore" });
  process.on("exit", () => chrome?.kill());
  await new Promise((r) => setTimeout(r, 6000));
  const targets = await (await fetch("http://127.0.0.1:9338/json/list")).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
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
  // Bounded, or a call that never answers hangs the script on a top-level await
  // and Node kills it without running the exit handler — leaving a Chrome behind.
  const send = (method, params = {}) =>
    new Promise((done, fail) => {
      const at = ++id;
      const timer = setTimeout(() => {
        waiting.delete(at);
        fail(new Error(`${method} never answered`));
      }, 30_000);
      waiting.set(at, (result) => {
        clearTimeout(timer);
        done(result);
      });
      ws.send(JSON.stringify({ id: at, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 430, height: 932, deviceScaleFactor: 1, mobile: true,
  });
  // `app/error.tsx` paints over a render throw, so the stack survives only here.
  send("Runtime.consoleAPICalled");
  return {
    resize: (width, height) =>
      send("Emulation.setDeviceMetricsOverride", {
        width, height, deviceScaleFactor: 1, mobile: width < 768,
      }),
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

// Reusable, because proving the claim needs a SECOND sign-in: a custom claim
// reaches a session only on a fresh token, which is exactly what the operator
// does by hand after being granted the role.
async function signIn() {
  await page.go(APP);
  await page.evaluate(`
(async () => {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  const field = document.querySelector("input");
  set.call(field, ${JSON.stringify(EMAIL)});
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  document.querySelector("button[type=submit]").click();
  await new Promise(r => setTimeout(r, 6000));
})()`);
  const codes = await (await fetch(`${AUTH}/emulator/v1/projects/${AUTH_PROJECT}/oobCodes`)).json();
  const link = codes.oobCodes?.at(-1)?.oobLink;
  // Loudly, or a door that never opened surfaces as an invalid-URL stack twenty
  // lines later saying nothing about the form it never found.
  if (!link) throw new Error("no sign-in link was sent — was the form on screen?");
  const code = new URL(link).searchParams.get("oobCode");
  await page.go(
    `${APP}/continue/?mode=signIn&lang=en&apiKey=fake-api-key&oobCode=${encodeURIComponent(code)}#email=${encodeURIComponent(EMAIL)}`,
    10000,
  );
}
await signIn();
// Never off browser storage: the SDK moves a session between localStorage and
// IndexedDB as it sees fit, so a uid read from there is wrong by the next load.
const accounts = await (
  await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${AUTH_PROJECT}/accounts:query`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({}),
  })
).json();
const uid = accounts.userInfo?.find((u) => u.email === EMAIL)?.localId;
expect("signed in through the email door", Boolean(uid));
if (!uid) {
  chrome.kill();
  process.exit(1);
}
await write(`users/${uid}`, {
  displayName: str("Reporter Under Test"),
  username: str(""),
  searchable: { booleanValue: false },
});

// The menu, by its own accessible name — not by hunting for a class.
const openMenu = `(async () => {
  const you = document.querySelector('button[aria-label="You"]');
  you?.click();
  await new Promise(r => setTimeout(r, 500));
  const rows = [...document.querySelectorAll("button")].map(b => b.innerText.trim()).join("|");
  // Shut again: navigating to a FRAGMENT does not reload, so a menu left open
  // here sits over the next screen and its rows land in every innerText after.
  you?.click();
  await new Promise(r => setTimeout(r, 400));
  return rows;
})()`;

console.log("\nsending one");
await page.go(APP, 8000);
let menu = await page.evaluate(openMenu);
expect("an ordinary account is offered Send feedback", /Send feedback/.test(menu), menu.slice(0, 120));
// The row it must NOT have, which is the whole point of the role.
expect("and is not offered the inbox", !/Feedback inbox/.test(menu), menu.slice(0, 120));

// The nonce is what every assertion below matches on. A generic prefix matches
// a report left behind by an earlier run — the emulator keeps its data for as
// long as it is up — which passed this check once while nothing had been sent.
const NONCE = `r${Date.now()}`;
const REPORT = `the room page went blank ${NONCE}`;
const sent = await page.evaluate(`
(async () => {
  document.querySelector('button[aria-label="You"]')?.click();
  await new Promise(r => setTimeout(r, 500));
  [...document.querySelectorAll("button")].find(b => b.innerText.trim() === "Send feedback")?.click();
  await new Promise(r => setTimeout(r, 700));
  const box = document.querySelector("textarea");
  if (!box) return "no textarea";
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  set.call(box, ${JSON.stringify(REPORT)});
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  [...document.querySelectorAll("button")].find(b => b.innerText.trim() === "Send")?.click();
  await new Promise(r => setTimeout(r, 4000));
  return document.body.innerText.replace(/\\s+/g, " ");
})()`);
expect("the sheet says it landed", /Thank you|That's with us/.test(String(sent)), String(sent).slice(0, 140));
let stored = await listFeedback();
const mine = stored.find((d) => d.fields?.text?.stringValue === REPORT);
expect("the report reached the database", Boolean(mine), `${stored.length} stored`);
expect("carrying the sender", mine?.fields?.uid?.stringValue === uid);

console.log("\nreading them");
// A second report, older and from somebody else, so ordering is observable.
await write("feedback/seed_older", {
  uid: str("someone-else"),
  text: str("a calendar view would be nice"),
  at: { timestampValue: new Date(Date.now() - 86_400_000).toISOString() },
});

// Reaching the screen without the role: it must render, and show nothing.
await page.go(`${APP}/#/feedback`, 8000);
const denied = await page.evaluate(`document.body.innerText.replace(/\\s+/g, " ")`);
expect(
  "a non-operator opening the fragment sees no reports",
  !/calendar view/.test(String(denied)) && !String(denied).includes(NONCE),
  String(denied).slice(0, 140),
);

// The role is a claim on the ACCOUNT, so it is set through Auth rather than
// written into Firestore — and the session already open cannot see it, which is
// the behaviour rather than a limitation of the check.
const granted = await fetch(
  `${AUTH}/identitytoolkit.googleapis.com/v1/projects/${AUTH_PROJECT}/accounts:update`,
  {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ localId: uid, customAttributes: JSON.stringify({ admin: true }) }),
  },
);
expect("the claim is set on the account", granted.ok, String(granted.status));
// The claim rides in the token, so it takes a fresh one — a reload alone reuses
// the cached token and would still show nothing. Which is why this signs OUT
// and back in, exactly as the operator has to.
await page.go(APP, 8000);
const signedOut = await page.evaluate(`(async () => {
  document.querySelector('button[aria-label="You"]')?.click();
  await new Promise(r => setTimeout(r, 600));
  const exit = [...document.querySelectorAll("button")].find(b => b.innerText.trim() === "Sign out");
  if (!exit) return "no sign-out row";
  exit.click();
  await new Promise(r => setTimeout(r, 5000));
  return document.body.innerText.replace(/\s+/g, " ").slice(0, 80);
})()`);
expect("signed out again", !/no sign-out row/.test(String(signedOut)), String(signedOut));
await signIn();
await page.go(APP, 9000);
menu = await page.evaluate(openMenu);
expect("the operator is offered the inbox", /Feedback inbox/.test(menu), menu.slice(0, 160));

// The dot, before anything has been opened. Counted by the screen-reader text
// each one carries, which is the same thing a person is shown.
// `span.sr-only` and not every span whose text reads "unread": the dot WRAPS
// that text, so counting both doubles every mark. And the app renders two
// AuthMenus at once — one for phones, one for ≥md, with CSS hiding whichever
// doesn't apply — so the avatar dot is counted as present rather than counted.
const dots = `(async () => {
  const marks = [...document.querySelectorAll("span.sr-only")].filter(s => s.textContent === "unread").length;
  const onAvatar = document.querySelectorAll('button[aria-label="You"] span.rounded-full.bg-accent').length;
  return JSON.stringify({ marks, onAvatar });
})()`;
// Measured with the menu OPEN, because "Feedback inbox" is the longest label
// there and at the menu's old width it wrapped — which grew that one row a head
// taller than its neighbours and left the label centred among left-aligned ones.
// A label added later can do it again, so the shape is pinned rather than the
// width.
// SLACK, not whether anything wrapped — headless renders this text a shade
// narrower than a real browser, so the wrap that shipped ("Feedback inbox" over
// two lines, that row a head taller than its neighbours) could not be
// reproduced here at all. What CAN be measured is how close each row runs to
// its edge, and that row had exactly 0px of it: the fit depended on font
// metrics agreeing to the pixel. A label added later can do the same, so the
// margin is what gets pinned.
const rows = JSON.parse(String(await page.evaluate(`(async () => {
  document.querySelector('button[aria-label="You"]')?.click();
  await new Promise(r => setTimeout(r, 600));
  // Anchored on a row's own text: a class selector matched some other rounded
  // box and measured ITS buttons, passing happily with the defect put back. And
  // kip renders two menus at once, one per breakpoint, so the hidden one — whose
  // rows measure zero — is dropped.
  const anchor = [...document.querySelectorAll("button")]
    .filter((b) => b.innerText.trim() === "Send feedback")
    .find((b) => b.getBoundingClientRect().height > 0);
  const found = anchor ? [...anchor.parentElement.children].filter((el) => el.tagName === "BUTTON") : [];
  const out = found.map((r) => {
    const label = [...r.children].find((c) => c.tagName === "SPAN" && c.textContent.trim() && !c.className.includes("sr-only"));
    if (!label) return null;
    const style = getComputedStyle(r);
    const used = [...r.children].reduce((sum, c) => sum + c.getBoundingClientRect().width, 0);
    const gaps = (r.children.length - 1) * parseFloat(style.columnGap || "0");
    const inner = r.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return { text: label.textContent.trim(), slack: Math.round(inner - used - gaps) };
  }).filter(Boolean);
  document.querySelector('button[aria-label="You"]')?.click();
  await new Promise(r => setTimeout(r, 400));
  return JSON.stringify(out);
})()`)));
expect(
  "no menu row runs to its edge",
  rows.length >= 5 && rows.every((row) => row.slack >= 16),
  JSON.stringify(rows),
);

const before = JSON.parse(String(await page.evaluate(dots)));
expect("the avatar carries a dot while reports are unread", before.onAvatar > 0, JSON.stringify(before));

await page.go(`${APP}/#/feedback`, 9000);
const unreadRows = JSON.parse(String(await page.evaluate(dots)));
// Both reports are new to this operator, so both are marked.
expect("every unread report is marked", unreadRows.marks === 2, JSON.stringify(unreadRows));

const listed = await page.evaluate(`document.body.innerText.replace(/\\s+/g, " ")`);
expect("both reports are listed", /calendar view/.test(String(listed)) && String(listed).includes(NONCE), String(listed).slice(0, 200));
// Newest first, which is the only ordering a reader has.
expect(
  "newest first",
  String(listed).indexOf(NONCE) < String(listed).indexOf("calendar view"),
);

console.log("\nclearing one");
const cleared = await page.evaluate(`
(async () => {
  // One tap, and it is gone: there is no confirm behind this.
  document.querySelectorAll('button[aria-label="Delete"]')[0]?.click();
  await new Promise(r => setTimeout(r, 4000));
  return document.body.innerText.replace(/\\s+/g, " ");
})()`);
expect("it leaves the screen", !String(cleared).includes(NONCE), String(cleared).slice(0, 160));
stored = await listFeedback();
expect(
  "and the database",
  !stored.some((d) => d.fields?.text?.stringValue === REPORT),
  `${stored.length} stored`,
);
expect("without taking the other one with it", stored.some((d) => d.fields?.text?.stringValue === "a calendar view would be nice"));

console.log("\nand opening it is what clears the dot");
// Opening the inbox marked it seen, so coming back finds nothing waiting. This
// is a reload rather than a fragment move: the mark is written on mount, and
// the dot is drawn from a preference that has to travel back through its
// listener.
await page.go(APP, 9000);
const after = JSON.parse(String(await page.evaluate(dots)));
expect("no dot once it has been read", after.onAvatar === 0, JSON.stringify(after));

console.log("\nand the sheet covers the app, not the header");
// `backdrop-filter` makes an element a containing block for its `fixed`
// descendants, and the DESKTOP top bar carries one — so a sheet rendered inside
// the menu that lives in that bar is trapped in the bar, a strip across the top.
// Only ≥md can show it: the mobile header has no blur, so phone-width
// screenshots look right whether this is broken or not.
await page.resize(1280, 900);
await page.go(APP, 8000);
const covered = await page.evaluate(`
(async () => {
  document.querySelector('button[aria-label="You"]')?.click();
  await new Promise(r => setTimeout(r, 500));
  [...document.querySelectorAll("button")].find(b => b.innerText.trim() === "Send feedback")?.click();
  await new Promise(r => setTimeout(r, 900));
  const back = document.querySelector('button[aria-label="Dismiss"]');
  const panel = document.querySelector('[role="dialog"]');
  if (!back || !panel) return JSON.stringify({ missing: true });
  const b = back.getBoundingClientRect();
  const p = panel.getBoundingClientRect();
  return JSON.stringify({
    viewport: { w: window.innerWidth, h: window.innerHeight },
    backdrop: { top: Math.round(b.top), h: Math.round(b.height) },
    panel: { top: Math.round(p.top), h: Math.round(p.height) },
  });
})()`);
const seen = JSON.parse(String(covered));
expect(
  "the backdrop covers the viewport",
  !seen.missing && seen.backdrop.top === 0 && seen.backdrop.h >= seen.viewport.h - 2,
  covered,
);
// Centred, so it sits in the middle of the app rather than under the top bar.
expect(
  "the sheet sits in the middle of the page",
  !seen.missing && seen.panel.top > seen.viewport.h / 8,
  covered,
);

await remove("feedback/seed_older");
chrome.kill();
console.log(
  failures.length === 0
    ? "\nall good\n"
    : `\n${failures.length} failed: ${failures.join(", ")}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
