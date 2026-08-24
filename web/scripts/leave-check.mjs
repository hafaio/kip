// Drives the CLIENT half of leaving in a real browser, which is the half
// `check:teardown` cannot reach: that one is the server finishing the job, this
// one is the person watching it happen.
//
//   cd web && bun run dev:emulated      # in one shell (serves on 3001)
//   bun run check:leave                 # in another
//
// It signs someone in through the email door, plants the deletion document the
// way the client does, and checks the app stands aside for it — live, and again
// on a reload with the profile already deleted, which is the state that used to
// read as onboarding. Then it removes the document the way a finished trigger
// does, and checks the session ends. Exits non-zero on the first failure.

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const APP = "http://localhost:3001";
const FIRESTORE = "http://127.0.0.1:8080";
const AUTH = "http://127.0.0.1:9099";
const PROJECT = "hafaio-kip-dev";
const AUTH_PROJECT = "demo-kip";
const DOCS = `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents`;
const EMAIL = `leave-check-${Date.now()}@example.com`;

const failures = [];
function expect(what, ok, detail = "") {
  if (ok) console.log(`  ok   ${what}`);
  else {
    console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`);
    failures.push(what);
  }
}
const str = (stringValue) => ({ stringValue });
const ts = (timestampValue) => ({ timestampValue });

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
async function exists(path) {
  const r = await fetch(`${DOCS}/${path}`, { headers: { Authorization: "Bearer owner" } });
  return r.ok;
}

let chrome;
async function browser() {
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", "--remote-debugging-port=9336",
    "--user-data-dir=/tmp/kip-leave-check", "--disable-gpu", "--no-first-run",
    "--window-size=430,932", "about:blank",
  ], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 6000));
  const targets = await (await fetch("http://127.0.0.1:9336/json/list")).json();
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
  const send = (method, params = {}) => {
    const at = ++id;
    ws.send(JSON.stringify({ id: at, method, params }));
    return new Promise((r) => waiting.set(at, r));
  };
  await send("Page.enable");
  await send("Runtime.enable");
  return {
    shot: async (name) => {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      await writeFile(`/tmp/kip-fixes/${name}.png`, Buffer.from(data, "base64"));
    },
    evaluate: async (expression) =>
      (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))?.result?.value,
    go: async (url, wait = 7000) => {
      await send("Page.navigate", { url });
      await new Promise((r) => setTimeout(r, wait));
    },
  };
}

await mkdir("/tmp/kip-fixes", { recursive: true });
const page = await browser();
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
const code = new URL(codes.oobCodes?.at(-1)?.oobLink).searchParams.get("oobCode");
await page.go(`${APP}/continue/?mode=signIn&lang=en&apiKey=fake-api-key&oobCode=${encodeURIComponent(code)}&email=${encodeURIComponent(EMAIL)}`, 10000);
const accounts = await (await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${AUTH_PROJECT}/accounts:query`, {
  method: "POST",
  headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
  body: JSON.stringify({}),
})).json();
const uid = accounts.userInfo?.find((u) => u.email === EMAIL)?.localId;
expect("signed in", Boolean(uid));
if (!uid) { chrome.kill(); process.exit(1); }

await write(`users/${uid}`, {
  displayName: str("Leaver Under Test"),
  username: str(""),
  searchable: { booleanValue: false },
  createdAt: ts("2026-08-01T00:00:00Z"),
});
await page.go(APP, 8000);
const home = await page.evaluate("document.body.innerText.slice(0, 200)");
expect("the app renders normally first", !String(home).includes("Deleting your kip"), String(home).slice(0, 80));

console.log("\nthe teardown starts while they are looking at it");
await write(`deletions/${uid}`, { requestedAt: ts(new Date().toISOString()) });
await new Promise((r) => setTimeout(r, 3000));
const started = await page.evaluate("document.body.innerText");
expect("kip stands aside for it, live", String(started).includes("Deleting your kip"), String(started).slice(0, 120));
expect("and says it no longer needs them", String(started).includes("finishes on its own"));

// The phase is the function's word, and this is what the app makes of it.
await write(`deletions/${uid}`, { requestedAt: ts(new Date().toISOString()), phase: str("friends") });
await new Promise((r) => setTimeout(r, 2000));
const phased = await page.evaluate("document.body.innerText");
expect("the bar follows the phase", String(phased).includes("step 3 of 5"), String(phased).slice(0, 160));

console.log("\nand on a reload, with the profile already deleted");
await remove(`users/${uid}`);
await page.go(APP, 9000);
const reloaded = await page.evaluate("document.body.innerText");
expect(
  "it is still the teardown, never onboarding",
  String(reloaded).includes("Deleting your kip"),
  String(reloaded).slice(0, 160),
);

// The state that used to be a dead end: the trigger has stopped trying, and
// this document is what the app gates on — so with no way to clear it the
// account was locked out of kip on every device, permanently, and only an
// operator with the Admin SDK could undo it.
console.log("\nthe teardown gives up");
await write(`deletions/${uid}`, {
  requestedAt: ts(new Date().toISOString()),
  phase: str("friends"),
  attempts: { integerValue: "5" },
  error: str("gave-up"),
});
await new Promise((r) => setTimeout(r, 3000));
const stalled = await page.evaluate("document.body.innerText");
expect("it says so rather than spinning", String(stalled).includes("couldn't finish"), String(stalled).slice(0, 200));
expect("and says what already happened", String(stalled).includes("doesn't come back"));
expect("both ways out are offered", String(stalled).includes("Try deleting again") && String(stalled).includes("Keep my account"));
await page.shot("deletion-failed");

const kept = await page.evaluate(`
(async () => {
  [...document.querySelectorAll("button")].find((b) => b.innerText.includes("Keep my account")).click();
  await new Promise(r => setTimeout(r, 4000));
  return document.body.innerText;
})()`);
expect("keeping the account clears the request", !(await exists(`deletions/${uid}`)));
// Not merely "no longer the deletion screen": clearing the request used to be
// read as the teardown FINISHING, which signed them out of an account that is
// still there — and the welcome screen is not the deletion screen either.
expect(
  "and hands the app back, still signed in",
  !String(kept).includes("couldn't finish") && !String(kept).includes("Come in"),
  String(kept).slice(0, 120),
);
await page.shot("deletion-escaped");

// Asking again from the same screen, which is a delete and a fresh create — so
// the function's attempt budget starts over rather than resuming a dead one.
await write(`deletions/${uid}`, {
  requestedAt: ts(new Date().toISOString()),
  phase: str("friends"),
  attempts: { integerValue: "5" },
  error: str("gave-up"),
});
await new Promise((r) => setTimeout(r, 3000));
const back = await page.evaluate("document.body.innerText");
expect("the failed state comes back", String(back).includes("couldn't finish"), String(back).slice(0, 160));
const again = await page.evaluate(`
(async () => {
  [...document.querySelectorAll("button")].find((b) => b.innerText.includes("Try deleting again")).click();
  await new Promise(r => setTimeout(r, 4000));
  return document.body.innerText;
})()`);
expect("asking again puts the teardown back", String(again).includes("Deleting your kip"), String(again).slice(0, 160));
expect("and the request is standing again", await exists(`deletions/${uid}`));

console.log("\nthe trigger finishes");
await remove(`deletions/${uid}`);
await new Promise((r) => setTimeout(r, 4000));
const ended = await page.evaluate("document.body.innerText");
// The welcome screen's door, not the absence of a word: an inert sheet's title
// sits in the DOM on every screen, so "is the name form up?" answers yes even
// when nothing is showing.
expect(
  "the session ends rather than dropping them into a nameless kip",
  !String(ended).includes("Deleting your kip") && String(ended).includes("Come in"),
  String(ended).slice(0, 120),
);

console.log(failures.length === 0 ? "\nall good\n" : `\n${failures.length} failed\n`);
chrome.kill();
process.exit(failures.length === 0 ? 0 : 1);
