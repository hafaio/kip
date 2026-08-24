// Drives what happens to kip's texts when the number they were agreed for
// CHANGES, which in kip is remove-then-add — two screens apart, and silent if
// nobody carries the consent across.
//
//   cd web && bun run dev:emulated      # in one shell (serves on 3001)
//   bun run check:consent               # in another
//
// While kip has no number to text from (`SMS_FROM` empty) none of that is
// reachable, so the run checks the GATE instead and stops — the switch is off,
// refuses the press, writes no consent when pressed, and says why. Provision a
// number and the five states below run as written.
//
// It signs someone in through the email door, then works the phone door and the
// Texts switch in Settings while reading the stored prefs back after every step:
// a number added by an account that never wanted texts is never asked about
// (consent must not ride along with adding a phone), a number added by one that
// did is asked ONCE with the disclosures in front of it, accepting records a
// fresh consent naming the new phone and keeps the superseded one, declining
// writes nothing operative, and removing the number stops the texts without
// destroying the record. Exits non-zero on the first failure.

import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

// The same constant Settings reads. Empty means kip has no number to text from,
// so the five states below are not merely untested but unreachable — the switch
// is off and cannot be pressed. Rather than skip, the run then checks THAT: the
// gate is the behaviour while it stands, and a check that quietly passes over a
// disabled feature is how the gate would get removed by accident.
const SMS_LIVE = /SMS_FROM\s*=\s*"([^"]*)"/.exec(
  await readFile(new URL("../utils/sms.ts", import.meta.url), "utf8"),
)?.[1];

const APP = "http://localhost:3001";
const FIRESTORE = "http://127.0.0.1:8080";
const AUTH = "http://127.0.0.1:9099";
const PROJECT = "hafaio-kip-dev";
// The two emulators namespace under different project ids: Firestore under the
// CLIENT's, Auth under the one it was started with.
const AUTH_PROJECT = "demo-kip";
const DOCS = `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents`;
const SHOTS = "/tmp/kip-consent";
const EMAIL = `consent-check-${Date.now()}@example.com`;
// Fresh every run: the emulator keeps its accounts for as long as it is up, and
// a number that already belongs to one signs INTO it rather than linking — which
// is a real product path, and here it silently hands the run somebody else's
// account.
const line = () => `+1202${Math.floor(1000000 + Math.random() * 8999999)}`;
const FIRST = line();
const SECOND = line();
const THIRD = line();

const failures = [];
function expect(what, ok, detail = "") {
  if (ok) console.log(`  ok   ${what}`);
  else {
    console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`);
    failures.push(what);
  }
}

function finish() {
  if (page.thrown.length > 0) {
    console.log("\npage exceptions:");
    for (const trace of page.thrown) console.log(`  ${trace.split("\n")[0]}`);
  }
  chrome.kill();
  console.log(
    failures.length === 0
      ? `\nall good — screenshots in ${SHOTS}`
      : `\n${failures.length} failed: ${failures.join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

async function write(path, fields) {
  const response = await fetch(`${DOCS}/${path}`, {
    method: "PATCH",
    headers: {
      Authorization: "Bearer owner",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });
  if (!response.ok) {
    throw new Error(`${path}: ${response.status} ${await response.text()}`);
  }
}

// The stored document as plain values, since every assertion here is about what
// is actually on it — a switch drawn from state nobody has read back proves the
// screen, not the write.
function plain(value) {
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("arrayValue" in value) {
    return (value.arrayValue.values ?? []).map(plain);
  }
  if ("mapValue" in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields ?? {}).map(([key, held]) => [
        key,
        plain(held),
      ]),
    );
  }
  return value;
}

async function prefsOf(uid) {
  const response = await fetch(`${DOCS}/users/${uid}/settings/prefs`, {
    headers: { Authorization: "Bearer owner" },
  });
  if (!response.ok) return {};
  const { fields = {} } = await response.json();
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, plain(value)]),
  );
}

const allOff = (map = {}) => Object.values(map).every((on) => on === false);
const allOn = (map = {}) =>
  Object.keys(map).length > 0 && Object.values(map).every((on) => on === true);

const PROFILE = "/tmp/kip-consent-check";

let chrome;
async function browser() {
  // A browser left behind by a failed run holds both the port and the SIGNED-IN
  // session, so the next run silently drives the last one's account: no sign-in
  // form, no link in the emulator, and a first failure that says nothing about
  // any of that. Killed and its profile cleared, so every run starts a stranger.
  // No leading dashes in the pattern: pkill reads one as an option of its own
  // and matches nothing, which looks exactly like there being nothing to kill.
  spawnSync("pkill", ["-f", `user-data-dir=${PROFILE}`]);
  await new Promise((done) => setTimeout(done, 1500));
  await rm(PROFILE, { recursive: true, force: true });
  process.on("exit", () => chrome?.kill());
  chrome = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      "--remote-debugging-port=9338",
      `--user-data-dir=${PROFILE}`,
      "--disable-gpu",
      "--no-first-run",
      "--window-size=430,932",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  await new Promise((done) => setTimeout(done, 6000));
  const targets = await (await fetch("http://127.0.0.1:9338/json/list")).json();
  const socket = new WebSocket(
    targets.find((target) => target.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((done) => (socket.onopen = done));
  let id = 0;
  const waiting = new Map();
  const thrown = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      thrown.push(
        message.params.exceptionDetails.exception?.description ??
          message.params.exceptionDetails.text,
      );
    }
    if (message.id && waiting.has(message.id)) {
      waiting.get(message.id)(message.result ?? message.error);
      waiting.delete(message.id);
    }
  };
  const send = (method, params = {}) => {
    const at = ++id;
    socket.send(JSON.stringify({ id: at, method, params }));
    return new Promise((done) => waiting.set(at, done));
  };
  await send("Page.enable");
  await send("Runtime.enable");
  return {
    thrown,
    shot: async (name) => {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      await writeFile(`${SHOTS}/${name}.png`, Buffer.from(data, "base64"));
    },
    // A throw inside the page is the answer, not a detail: a selector that
    // matches nothing otherwise reads as a step that did nothing, which is
    // indistinguishable from the product being broken.
    evaluate: async (expression) => {
      const answer = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (answer?.exceptionDetails) {
        throw new Error(
          answer.exceptionDetails.exception?.description ??
            answer.exceptionDetails.text,
        );
      }
      return answer?.result?.value;
    },
    go: async (url, wait = 7000) => {
      await send("Page.navigate", { url });
      await new Promise((done) => setTimeout(done, wait));
    },
  };
}

// The page's own helpers, injected once per evaluate: a door row by its name, a
// button by the words on it, and the Texts switch by its label.
const HELPERS = `
  const row = (name) => [...document.querySelectorAll("[class*='min-h-14']")]
    .find((held) => held.textContent.startsWith(name));
  const button = (text) => [...document.querySelectorAll("button")]
    .find((held) => held.textContent.trim() === text);
  const master = () => [...document.querySelectorAll("[role=switch]")]
    .find((held) => held.textContent.startsWith("Text me"));
  const setValue = (field, value) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
      .set.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
`;

const run = (body) => `(async () => {${HELPERS}${body}})()`;

async function latestCode(number) {
  const { verificationCodes = [] } = await (
    await fetch(`${AUTH}/emulator/v1/projects/${AUTH_PROJECT}/verificationCodes`)
  ).json();
  return verificationCodes.filter((sent) => sent.phoneNumber === number).at(-1)
    ?.code;
}

// The whole door: open the sheet, type the number, take the code the emulator
// would have texted, and type that.
async function addPhone(page, number) {
  await page.evaluate(
    run(`
    row("Phone").querySelector("button").click();
    await pause(600);
    setValue(document.querySelector("[role=dialog] input"), ${JSON.stringify(number)});
    await pause(400);
    document.querySelector("[role=dialog] button[type=submit]").click();
    await pause(5000);
  `),
  );
  const code = await latestCode(number);
  if (!code) throw new Error(`no code was texted to ${number}`);
  // Typed and never submitted: a full code has nothing left to decide, so the
  // field submits its own form. Setting the whole value in one event is also
  // what a paste looks like, so this covers that too. Clicking afterwards would
  // pass whether or not any of it works, and by then there is no button left.
  return page.evaluate(
    run(`
    setValue(document.querySelector("[role=dialog] input"), ${JSON.stringify(code)});
    await pause(5000);
    return !document.querySelector("[role=dialog] input[autocomplete='one-time-code']");
  `),
  );
}

async function removePhone(page) {
  await page.evaluate(
    run(`
    [...document.querySelectorAll("button")]
      .find((held) => held.getAttribute("aria-label") === "Remove Phone")
      .click();
    await pause(700);
    button("Remove").click();
    await pause(4000);
  `),
  );
}

async function answerDialog(page, label) {
  await page.evaluate(
    run(`
    button(${JSON.stringify(label)}).click();
    await pause(2500);
  `),
  );
}

const dialogAsked = (page) =>
  page.evaluate("document.body.innerText.includes('Keep texts on?')");

// The switch is below the fold on this screen, and a screenshot of the doors
// proves nothing about it.
const showTexts = (page) =>
  page.evaluate(
    run(`
    master()?.scrollIntoView({ block: "center" });
    await pause(600);
  `),
  );

const textsRow = (page) =>
  page.evaluate(
    run(`
    const held = master();
    return held
      ? { on: held.getAttribute("aria-checked") === "true", text: held.innerText, disabled: held.disabled }
      : null;
  `),
  );

await mkdir(SHOTS, { recursive: true });
const page = await browser();

// The email door, which the emulator publishes the link for — the only way to
// sign someone in here unattended.
await page.go(APP);
await page.evaluate(
  run(`
  setValue(document.querySelector("input"), ${JSON.stringify(EMAIL)});
  await pause(400);
  document.querySelector("button[type=submit]").click();
  await pause(6000);
`),
);
const codes = await (
  await fetch(`${AUTH}/emulator/v1/projects/${AUTH_PROJECT}/oobCodes`)
).json();
const sent = codes.oobCodes?.findLast((held) => held.email === EMAIL);
if (!sent) {
  // The door said nothing, so say what was on screen — an unsigned-out browser
  // and a changed welcome screen look identical from here otherwise.
  const screen = await page.evaluate("document.body.innerText");
  throw new Error(`no link was sent to ${EMAIL}. On screen: ${screen}`);
}
const link = new URL(sent.oobLink).searchParams.get("oobCode");
await page.go(
  `${APP}/continue/?mode=signIn&lang=en&apiKey=fake-api-key&oobCode=${encodeURIComponent(link)}#email=${encodeURIComponent(EMAIL)}`,
  10000,
);
const accounts = await (
  await fetch(
    `${AUTH}/identitytoolkit.googleapis.com/v1/projects/${AUTH_PROJECT}/accounts:query`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer owner",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    },
  )
).json();
const uid = accounts.userInfo?.find((account) => account.email === EMAIL)
  ?.localId;
expect("signed in through the email door", Boolean(uid));
if (!uid) {
  chrome.kill();
  process.exit(1);
}

await write(`users/${uid}`, {
  displayName: { stringValue: "Consent Under Test" },
  username: { stringValue: "" },
  searchable: { booleanValue: false },
  createdAt: { timestampValue: "2026-08-01T00:00:00Z" },
});
// A fragment change is not a load, and the app has been sitting on a screen
// with no profile since the sign-in landed — its identity sheet is up over
// everything. Reloaded, so the profile just written is there from the first
// render.
await page.go(`${APP}/#/settings`, 1500);
await page.evaluate("location.reload()");
await new Promise((done) => setTimeout(done, 9000));

console.log("\nan account that has never wanted texts is not asked about them");
expect("a full code submits itself", await addPhone(page, FIRST));

// Everything past here is about a consent kip can act on. With no sender there
// is none to give, so the run checks the gate instead and stops: the switch is
// off and refuses the press, adding a number asked nothing, and the row says
// why rather than sitting greyed out with no reason on it.
if (!SMS_LIVE) {
  console.log("\nwith no number to text from, texts cannot be turned on");
  await showTexts(page);
  await page.shot("0-texts-unavailable");
  const gated = await textsRow(page);
  expect("the switch is off", gated?.on === false, JSON.stringify(gated));
  expect("and refuses the press", gated?.disabled === true);
  expect(
    "the row says kip has no number, rather than nothing",
    (gated?.text ?? "").includes("no number to text from"),
    gated?.text?.replace(/\n/g, " ").slice(0, 160),
  );
  await page.evaluate(run(`master().click(); await pause(2000);`));
  const pressed = await prefsOf(uid);
  expect(
    "pressing it writes no consent",
    pressed.smsConsentNumber === undefined || pressed.smsConsentNumber === null,
    JSON.stringify(pressed.smsConsentNumber),
  );
  expect("and turns no kind on", allOff(pressed.notifySms));
  // Both channels list the same kinds, in the same order: a text column shorter
  // than the email one above it reads as having forgotten some.
  const rows = await page.evaluate(
    run(`
    const groups = [...document.querySelectorAll("[class*='divide-y']")];
    const texts = groups.at(-1);
    return JSON.stringify([...texts.children]
      .map((held) => held.innerText.split("\\n")[0])
      .slice(1));
  `),
  );
  const labels = JSON.parse(rows ?? "[]");
  expect(
    "every kind is listed under Texts",
    labels.length === 6,
    JSON.stringify(labels),
  );
  finish();
}
await showTexts(page);
await page.shot("1-first-number-added");
expect("no dialog when there is no consent to carry", !(await dialogAsked(page)));
const fresh = await prefsOf(uid);
expect(
  "nothing operative was written by adding a number",
  fresh.smsConsentNumber === undefined || fresh.smsConsentNumber === null,
  JSON.stringify(fresh.smsConsentNumber),
);
const beforeConsent = await textsRow(page);
expect(
  "the switch is off, with the number in its copy",
  beforeConsent?.on === false && beforeConsent.text.includes(FIRST),
  beforeConsent?.text?.replace(/\n/g, " ").slice(0, 120),
);

console.log("\nturning texts on records a consent naming that number");
await page.evaluate(
  run(`
  master().click();
  await pause(2500);
`),
);
await showTexts(page);
await page.shot("2-texts-on-for-first");
const consented = await prefsOf(uid);
expect(
  "the record names the number it was given for",
  consented.smsConsentNumber === FIRST,
  JSON.stringify(consented.smsConsentNumber),
);
expect("every texted kind is on", allOn(consented.notifySms));
expect("nothing is superseded yet", consented.smsConsentLog === undefined);
const firstAt = consented.smsConsentAt;
const firstVersion = consented.smsConsentVersion;
expect("it says what wording was agreed", Boolean(firstVersion), firstVersion);

console.log("\nremoving the number stops the texts and keeps the record");
await removePhone(page);
await showTexts(page);
await page.shot("3-number-removed");
const removed = await prefsOf(uid);
const removalScreen = await page.evaluate(
  "document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 200)",
);
expect(
  "the texted kinds are all off",
  allOff(removed.notifySms),
  removalScreen,
);
expect(
  "the consent record survives the number leaving",
  removed.smsConsentNumber === FIRST && removed.smsConsentAt === firstAt,
  JSON.stringify(removed.smsConsentNumber),
);
const afterRemoval = await textsRow(page);
expect(
  "the switch reads off and has nothing to act on",
  afterRemoval?.on === false && afterRemoval.disabled === true,
);

console.log("\nre-adding the SAME number asks rather than resuming");
await addPhone(page, FIRST);
await page.shot("4-same-number-asks");
expect("the dialog is up", await dialogAsked(page));
await answerDialog(page, "No texts");
const declinedSame = await prefsOf(uid);
expect("declining leaves the kinds off", allOff(declinedSame.notifySms));
expect(
  "and writes nothing operative",
  declinedSame.smsConsentAt === firstAt,
  JSON.stringify(declinedSame.smsConsentAt),
);

console.log("\na NEW number is asked about, and accepting names it");
await removePhone(page);
await addPhone(page, SECOND);
await page.shot("5-new-number-asks");
const asked = await page.evaluate("document.body.innerText");
expect("the dialog is up", String(asked).includes("Keep texts on?"));
expect(
  "it names the new number and carries the disclosures",
  String(asked).includes(SECOND) &&
    String(asked).includes("automated texts") &&
    String(asked).includes("Reply STOP to stop, HELP for help"),
);
await answerDialog(page, "Text this number");
await showTexts(page);
await page.shot("6-texts-on-for-new-number");
const carried = await prefsOf(uid);
expect(
  "the operative record names the new number",
  carried.smsConsentNumber === SECOND,
  JSON.stringify(carried.smsConsentNumber),
);
expect(
  "it is a fresh agreement, not the old one moved",
  carried.smsConsentAt !== firstAt &&
    carried.smsConsentVersion === firstVersion,
);
expect("every texted kind is on again", allOn(carried.notifySms));
expect(
  "the superseded consent is kept, naming the old number",
  carried.smsConsentLog?.length === 1 &&
    carried.smsConsentLog[0].number === FIRST &&
    carried.smsConsentLog[0].at === firstAt,
  JSON.stringify(carried.smsConsentLog),
);
const afterCarry = await textsRow(page);
expect(
  "the switch is on and its copy names the new number",
  afterCarry?.on === true && afterCarry.text.includes(SECOND),
  afterCarry?.text?.replace(/\n/g, " ").slice(0, 120),
);

console.log("\ndeclining for a third number changes nothing operative");
await removePhone(page);
await addPhone(page, THIRD);
expect("the dialog is up", await dialogAsked(page));
await answerDialog(page, "No texts");
await showTexts(page);
await page.shot("7-declined-for-third");
const declined = await prefsOf(uid);
expect("the kinds stay off", allOff(declined.notifySms));
expect(
  "the record still names the number it was last given for",
  declined.smsConsentNumber === SECOND &&
    declined.smsConsentAt === carried.smsConsentAt,
  JSON.stringify(declined.smsConsentNumber),
);
expect(
  "and nothing was appended for a consent never given",
  declined.smsConsentLog?.length === 1,
  JSON.stringify(declined.smsConsentLog),
);
const afterDecline = await textsRow(page);
expect(
  "the switch reads off",
  afterDecline?.on === false,
  afterDecline?.text?.replace(/\n/g, " ").slice(0, 120),
);

finish();
