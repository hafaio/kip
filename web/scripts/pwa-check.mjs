// Checks the two claims installing kip makes: that a browser will offer to
// install it at all, and that it opens with no network.
//
//   cd web && bun run check:pwa
//
// It builds the export and serves it itself, because both claims are about the
// PRODUCTION bundle: `next dev` serves modules a cache would hand back stale, so
// the worker deliberately does not register there and none of this is reachable
// from the dev server the other checks use. No emulator either — nothing here
// signs in.
//
// What it does NOT cover is a signed-in kip offline: that rests on Firestore's
// own IndexedDB persistence, which needs a real session against the real project
// to exercise.

import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";

const PORT = 4173;
// Under a base path, because that is what production is: Pages serves kip from
// /<repo>, and manifest scope, the worker's registration path and the offline
// key are all built from it. Served out of a directory holding `kip -> out`, so
// the URLs are the deployed ones rather than a root-served approximation.
const BASE = "/kip";
const APP = `http://localhost:${PORT}${BASE}`;
const SERVE = "/tmp/kip-pwa-serve";
const PROFILE = "/tmp/kip-pwa-check";

const failures = [];
function expect(what, ok, detail = "") {
  if (ok) console.log(`  ok   ${what}`);
  else {
    console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`);
    failures.push(what);
  }
}

function runExport() {
  const done = spawnSync("bun", ["run", "export"], {
    stdio: "inherit",
    env: { ...process.env, NEXT_PUBLIC_BASE_PATH: BASE },
  });
  if (done.status !== 0) throw new Error("export failed");
}

console.log("building the export");
// The base path is what production builds with; `bun export` alone would test a
// shape nothing ships.
runExport();
await rm(SERVE, { recursive: true, force: true });
await mkdir(SERVE, { recursive: true });
await symlink(resolve("out"), `${SERVE}${BASE}`);

// Serving `out/` rather than pointing at Pages: the worker needs a secure
// context, and localhost is one.
const server = spawn("python3", ["-m", "http.server", String(PORT)], {
  cwd: SERVE,
  stdio: "ignore",
});
process.on("exit", () => server.kill());
await new Promise((done) => setTimeout(done, 2500));

let chrome;
async function browser() {
  // See consent-check: a browser left behind holds the port and the session.
  spawnSync("pkill", ["-f", `user-data-dir=${PROFILE}`]);
  await new Promise((done) => setTimeout(done, 1500));
  await rm(PROFILE, { recursive: true, force: true });
  chrome = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      "--remote-debugging-port=9391",
      `--user-data-dir=${PROFILE}`,
      "--disable-gpu",
      "--no-first-run",
      "--window-size=430,932",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  // Reaped on any throw, not just the last line: the server has had this since
  // it was written and the browser did not, so a failed assertion left a Chrome
  // holding the debug port and the profile.
  process.on("exit", () => chrome?.kill());
  await new Promise((done) => setTimeout(done, 5000));
  const targets = await (
    await fetch("http://127.0.0.1:9391/json/list")
  ).json();
  const socket = new WebSocket(
    targets.find((target) => target.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((done) => (socket.onopen = done));
  let id = 0;
  const waiting = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      waiting.get(message.id)(message.result ?? message.error);
      waiting.delete(message.id);
    }
  };
  // Every round trip is bounded. A call that never comes back hangs the script
  // on a top-level await, and Node kills that without running the exit handler
  // — which left a headless Chrome holding the debug port and the profile. A
  // rejection instead unwinds to the exit handler, which reaps it.
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
      socket.send(JSON.stringify({ id: at, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
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
    go: async (url, wait = 9000) => {
      await send("Page.navigate", { url });
      await new Promise((done) => setTimeout(done, wait));
    },
  };
}

const page = await browser();
// Before the document runs, or the event has already fired by the time anything
// here could listen for it.
await page.send("Page.addScriptToEvaluateOnNewDocument", {
  source:
    "window.addEventListener('beforeinstallprompt', () => { window.__kipInstallOffered = true; });",
});
await page.go(APP);

console.log("\na browser is willing to install it");
// Chrome's own parse, not a read of the JSON: a manifest this file agrees with
// and Chrome rejects would pass a hand-rolled check and install nowhere.
const manifest = await page.send("Page.getAppManifest");
expect(
  "the manifest parses with no errors",
  (manifest.errors ?? []).length === 0,
  JSON.stringify(manifest.errors ?? []),
);
const parsed = JSON.parse(manifest.data ?? "{}");
expect(
  "it is standalone, with a start_url",
  parsed.display === "standalone" && Boolean(parsed.start_url),
  JSON.stringify({ display: parsed.display, start_url: parsed.start_url }),
);
// The maskable one is separate on purpose: without it Android crops the disc.
expect(
  "it names a 512 and a maskable icon",
  (parsed.icons ?? []).some((i) => i.sizes === "512x512" && !i.purpose) &&
    (parsed.icons ?? []).some((i) => i.purpose === "maskable"),
  JSON.stringify(parsed.icons ?? []),
);

// Chrome's own verdict, and the strongest one available: it fires this only for
// a page it is actually willing to install. Armed before the load below.
const offered = await page.evaluate("window.__kipInstallOffered === true");
expect("Chrome offers to install it", offered === true, String(offered));

const worker = await page.evaluate(`(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return "none";
  await navigator.serviceWorker.ready;
  return reg.active ? "active" : "registered, not active";
})()`);
expect("the worker registers and activates", worker === "active", String(worker));

console.log("\nand it writes no capability into the cache");
// A navigation's `request.url` carries the query AND the fragment — measured in
// Chrome, not assumed — so caching the request as it comes stores a portal token
// and a one-time sign-in code somewhere with no expiry that any same-origin
// script can read, undoing the whole point of `/portal/`'s fragment.
await page.go(`${APP}/portal/#PORTALTOKEN123`, 5000);
await page.go(
  `${APP}/continue/?oobCode=OOBCODE456&mode=signIn#idToken=IDTOKEN789`,
  5000,
);
const keys = JSON.parse(
  (await page.evaluate(`(async () => {
  const out = [];
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) out.push(request.url);
  }
  return JSON.stringify(out);
})()`)) ?? "[]",
);
for (const [what, secret] of [
  ["a portal token", "PORTALTOKEN123"],
  ["a one-time code", "OOBCODE456"],
  ["an ID token", "IDTOKEN789"],
]) {
  expect(
    `${what} never reaches the cache`,
    !keys.some((key) => key.includes(secret)),
    keys.filter((key) => key.includes(secret)).join(" "),
  );
}
// And the pages themselves are still cached, under their own paths — otherwise
// the assertions above would pass by caching nothing at all.
expect(
  "the pages are cached, keyed on the path alone",
  keys.some((key) => key.endsWith(`${BASE}/portal/`)) &&
    keys.some((key) => key.endsWith(`${BASE}/continue/`)),
  keys.filter((key) => !key.includes("/_next/")).join(" "),
);

console.log(
  "  documents held:",
  keys.filter((key) => !key.includes("/_next/")).join(" ") || "(none)",
);

console.log("\nand it opens with the network pulled");
// Back to the entry point, and note it is a NAVIGATION rather than a reload:
// the assertions above left the page on /continue/, and reloading there proved
// only that /continue/ was cached while the thing about to be opened offline
// was the root.
await page.go(APP, 7000);
const held = await page.evaluate(`(async () => {
  const names = await caches.keys();
  if (!names.length) return 0;
  const cache = await caches.open(names[0]);
  return (await cache.keys()).length;
})()`);
expect("the shell is cached", Number(held) > 0, `${held} entries`);

// Both layers, because they fail independently. Killing the server is what
// makes the DOCUMENT come from the cache: CDP's offline emulation does not
// reach a service worker's fetches, so the version of this that used it alone
// watched the shell render over a live network and credited the cache — it
// passed with the offline fallback deleted. CDP is what stops the PAGE reaching
// Firebase, which is a different host and still up.
server.kill();
await page.send("Network.emulateNetworkConditions", {
  offline: true,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
});
await new Promise((done) => setTimeout(done, 1000));
await page.go(APP);
const screen = String((await page.evaluate("document.body.innerText")) ?? "")
  .replace(/\s+/g, " ")
  .trim();
// A share link opened with no signal. It must not claim the link was revoked:
// the read failed, which says nothing about the link, and telling someone to go
// ask for a fresh one is the wrong instruction as well as a false statement.
await page.go(`${APP}/portal/#SOMETOKEN`, 6000);
const offlinePortal = String(
  (await page.evaluate("document.body.innerText")) ?? "",
).replace(/\s+/g, " ");
expect(
  "an offline share link does not claim to be revoked",
  !/isn't active|turned off or regenerated/.test(offlinePortal),
  offlinePortal.slice(0, 100),
);

expect(
  "kip renders with no network at all",
  // kip's own words, not the absence of an error: a blank page and a browser
  // error page both pass a blacklist. Either state counts — the portal visit
  // above signs this browser in anonymously, so what renders here is Home
  // rather than the door.
  /Spare rooms and empty flats|Welcome back/.test(screen),
  screen.slice(0, 100),
);

chrome.kill();
server.kill();
console.log(
  failures.length === 0
    ? "\nall good\n"
    : `\n${failures.length} failed: ${failures.join(", ")}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
