// Drives the account teardown end to end against the emulators — Firestore,
// Auth and Functions — because the whole claim of this design is that the
// SERVER finishes what the browser used to abandon, and nothing else here can
// see a trigger run.
//
//   cd web && bun run check:teardown
//
// It seeds an account with everything a real one has attached — stays on both
// sides, a place with slots and share links, friends, requests, a saved search —
// asks for deletion the way the client does, and then asserts what is left. It
// exits non-zero on the first failed expectation, so it reads like a test.
//
// Both emulators run under the id `emulators:exec` was started with, which is
// why this seeds `demo-kip` and not the client's project: the function's Admin
// SDK reads `GCLOUD_PROJECT` from the emulator, and a fixture under any other
// id is invisible to it.

const PROJECT = "demo-kip";
const FIRESTORE = "http://127.0.0.1:8080";
const AUTH = "http://127.0.0.1:9099";
const DOCS = `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents`;
// Long enough to cover the function's own settle delay (it waits for the
// notification triggers its writes fired to read the profile) plus a cold start.
const FINISH_TIMEOUT_MS = 120_000;

const failures = [];
function expect(what, ok, detail = "") {
  if (ok) console.log(`  ok   ${what}`);
  else {
    console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`);
    failures.push(what);
  }
}

const str = (stringValue) => ({ stringValue });
const int = (n) => ({ integerValue: String(n) });
const bool = (booleanValue) => ({ booleanValue });
const nul = () => ({ nullValue: null });
const ts = (timestampValue) => ({ timestampValue });
const arr = (values) => ({ arrayValue: { values } });
const map = (fields) => ({ mapValue: { fields } });

function iso(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function put(path, fields) {
  const response = await fetch(`${DOCS}/${path}`, {
    method: "PATCH",
    headers: {
      Authorization: "Bearer owner",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });
  if (!response.ok) {
    throw new Error(`seed ${path}: ${response.status} ${await response.text()}`);
  }
}

// Null for "not there", which is the answer most of these assertions want.
async function read(path) {
  const response = await fetch(`${DOCS}/${path}`, {
    headers: { Authorization: "Bearer owner" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`read ${path}: ${response.status}`);
  return (await response.json()).fields ?? {};
}

async function makeAccount(email) {
  const response = await fetch(
    `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "sekret1", returnSecureToken: true }),
    },
  );
  if (!response.ok) throw new Error(`signUp: ${await response.text()}`);
  return (await response.json()).localId;
}

async function accountExists(uid) {
  const response = await fetch(
    `${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer owner",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    },
  );
  const { userInfo = [] } = await response.json();
  return userInfo.some((user) => user.localId === uid);
}

const FRIEND = "teardown-friend";
const ASKED = "teardown-asked";
const ASKER = "teardown-asker";
const HOST = "teardown-host";
const GUEST = "teardown-guest";
const PENDING_GUEST = "teardown-guest-pending";
const MINE = "teardown-listing";
const THEIRS = "teardown-host-listing";

async function seed(leaver) {
  await put(`users/${leaver}`, {
    displayName: str("Leaver"),
    username: str(""),
    searchable: bool(false),
    createdAt: ts(new Date().toISOString()),
  });
  await put(`users/${leaver}/settings/prefs`, {
    profilePortalId: str("teardown-portal-user"),
    shareStaysWithFriends: bool(true),
  });
  await put(`users/${leaver}/searches/s1`, { label: str("Lisbon") });
  await put(`users/${leaver}/knownBy/${HOST}`, {
    bookingId: str("teardown-booking-guest"),
  });
  // The other direction, which is the half that used to be left behind: notes
  // OTHER people hold about the leaver, and a marker under someone else's
  // listing. Both inert, both keyed by a uid that is about to mean nobody.
  await put(`users/${HOST}/knownBy/${leaver}`, {
    bookingId: str("teardown-booking-guest"),
  });
  // Planted by a stay that has already BEEN. Nothing cancels it, so nothing in
  // the cancel loop would ever reach these — which is why the sweep reads every
  // booking rather than the ones it just touched.
  await put(`listings/${THEIRS}/guests/${leaver}`, {
    bookingId: str("teardown-booking-past"),
  });

  // Both sides of one friendship: a one-sided delete leaves a row that renders
  // a name and never answers.
  await put(`users/${leaver}/friends/${FRIEND}`, {
    displayName: str("Friend"),
    username: str("friend_h"),
    photoURL: nul(),
    since: ts(new Date().toISOString()),
  });
  await put(`users/${FRIEND}/friends/${leaver}`, {
    displayName: str("Leaver"),
    username: str(""),
    photoURL: nul(),
    since: ts(new Date().toISOString()),
  });

  await put(`connectRequests/${leaver}_${ASKED}`, {
    from: str(leaver),
    to: str(ASKED),
    fromName: str("Leaver"),
    fromUsername: str(""),
    createdAt: ts(new Date().toISOString()),
  });
  await put(`connectRequests/${ASKER}_${leaver}`, {
    from: str(ASKER),
    to: str(leaver),
    fromName: str("Asker"),
    fromUsername: str("asker_h"),
    createdAt: ts(new Date().toISOString()),
  });

  await put("portals/teardown-portal-user", {
    scope: str("USER"),
    ownerId: str(leaver),
    ownerName: str("Leaver"),
    ownerPhotoURL: nul(),
    createdAt: int(0),
  });
  await put("portals/teardown-portal-listing", {
    scope: str("LISTING"),
    ownerId: str(leaver),
    ownerName: str("Leaver"),
    ownerPhotoURL: nul(),
    listingId: str(MINE),
    createdAt: int(0),
  });
  // A visitor's proof they hold the link. Deleting the portal does not delete
  // what hangs off it, so this is somebody ELSE's uid left inside the leaver's
  // own data — the mirror of the pointers above, and the easier one to fix.
  await put("portals/teardown-portal-user/grants/visitor-uid", {
    expires: int(0),
  });

  await put(`listings/${MINE}`, {
    ownerId: str(leaver),
    title: str("Spare room"),
    type: str("ROOM"),
    description: str(""),
    location: map({ label: str("Lisbon"), lat: nul(), lng: nul() }),
    photos: arr([map({ id: str("p1"), url: str("https://example.invalid/p1") })]),
    publicPortalId: str("teardown-portal-listing"),
    createdAt: int(1),
  });
  await put(`listings/${MINE}/windows/w1`, {
    start: str(iso(10)),
    end: str(iso(14)),
    status: str("OPEN"),
    autoAccept: bool(false),
    details: str(""),
    bookingId: nul(),
    createdAt: int(1),
  });
  await put(`listings/${MINE}/windows/w2`, {
    start: str(iso(20)),
    end: str(iso(24)),
    status: str("BOOKED"),
    autoAccept: bool(false),
    details: str(""),
    bookingId: str("teardown-booking-incoming"),
    createdAt: int(1),
  });
  await put(`listings/${MINE}/guests/${GUEST}`, {
    bookingId: str("teardown-booking-incoming"),
  });

  // Someone else's place, where the leaver is the guest — the one slot that has
  // to be HANDED BACK rather than deleted.
  await put(`listings/${THEIRS}`, {
    ownerId: str(HOST),
    title: str("Their flat"),
    type: str("FLAT"),
    description: str(""),
    location: map({ label: str("Porto"), lat: nul(), lng: nul() }),
    photos: arr([]),
    publicPortalId: nul(),
    createdAt: int(1),
  });
  await put(`listings/${THEIRS}/windows/hw1`, {
    start: str(iso(30)),
    end: str(iso(34)),
    status: str("BOOKED"),
    autoAccept: bool(false),
    details: str(""),
    bookingId: str("teardown-booking-guest"),
    createdAt: int(1),
  });

  const bookings = {
    // As guest, still ahead: cancelled, and its slot released.
    "teardown-booking-guest": {
      listingId: THEIRS,
      ownerId: HOST,
      guestId: leaver,
      windowId: "hw1",
      start: iso(30),
      end: iso(34),
      status: "CONFIRMED",
    },
    // As guest, already been: a record for both parties, not an obligation.
    "teardown-booking-past": {
      listingId: THEIRS,
      ownerId: HOST,
      guestId: leaver,
      windowId: "hw0",
      start: iso(-20),
      end: iso(-16),
      status: "CONFIRMED",
    },
    // As host, confirmed: the guest hears their stay was called off.
    "teardown-booking-incoming": {
      listingId: MINE,
      ownerId: leaver,
      guestId: GUEST,
      windowId: "w2",
      start: iso(20),
      end: iso(24),
      status: "CONFIRMED",
    },
    // As host, still pending: an ask that can never now be answered.
    "teardown-booking-pending": {
      listingId: MINE,
      ownerId: leaver,
      guestId: PENDING_GUEST,
      windowId: "w1",
      start: iso(10),
      end: iso(14),
      status: "REQUESTED",
    },
  };
  for (const [id, booking] of Object.entries(bookings)) {
    await put(`bookings/${id}`, {
      listingId: str(booking.listingId),
      ownerId: str(booking.ownerId),
      guestId: str(booking.guestId),
      windowId: str(booking.windowId),
      start: str(booking.start),
      end: str(booking.end),
      status: str(booking.status),
      cancelledBy: nul(),
      cancelReason: nul(),
      hiddenBy: arr([]),
      createdAt: ts(new Date().toISOString()),
    });
  }
}

// The client's whole part in leaving: one document, and it may close the tab.
async function askToLeave(leaver) {
  await put(`deletions/${leaver}`, { requestedAt: ts(new Date().toISOString()) });
}

async function waitForFinish(leaver) {
  const seen = [];
  const deadline = Date.now() + FINISH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const request = await read(`deletions/${leaver}`);
    if (!request) return { finished: true, seen };
    const phase = request.phase?.stringValue;
    if (phase && seen[seen.length - 1] !== phase) seen.push(phase);
    if (request.error) return { finished: false, seen, error: request.error.stringValue };
    await new Promise((resume) => setTimeout(resume, 250));
  }
  return { finished: false, seen, error: "timed out" };
}

const leaver = await makeAccount(`teardown-${Date.now()}@example.com`);
console.log(`\nseeding an account with things attached (uid ${leaver})`);
await seed(leaver);

console.log("asking to leave, then walking away");
await askToLeave(leaver);
const { finished, seen, error } = await waitForFinish(leaver);

console.log(`\nphases reported: ${seen.join(" -> ") || "(none seen)"}`);
expect("the teardown finished on its own", finished, error);
expect(
  "it reported its progress on the way",
  seen.length > 0 && seen.every((phase) =>
    ["stays", "places", "friends", "profile", "account"].includes(phase),
  ),
  seen.join(","),
);

console.log("\nwhat the leaver had:");
expect("the profile is gone", (await read(`users/${leaver}`)) === null);
expect("prefs are gone", (await read(`users/${leaver}/settings/prefs`)) === null);
expect(
  "saved searches are gone",
  (await read(`users/${leaver}/searches/s1`)) === null,
);
expect(
  "the knownBy pointer is gone",
  (await read(`users/${leaver}/knownBy/${HOST}`)) === null,
);
expect("their place is gone", (await read(`listings/${MINE}`)) === null);
expect(
  "its slots went with it",
  (await read(`listings/${MINE}/windows/w1`)) === null &&
    (await read(`listings/${MINE}/windows/w2`)) === null,
);
expect(
  "so did the guest pointer under it",
  (await read(`listings/${MINE}/guests/${GUEST}`)) === null,
);
expect(
  "both share links are revoked",
  (await read("portals/teardown-portal-user")) === null &&
    (await read("portals/teardown-portal-listing")) === null,
);
expect(
  "and took their visitors' notes with them",
  (await read("portals/teardown-portal-user/grants/visitor-uid")) === null,
);
expect(
  "nobody is left holding a note about them",
  (await read(`users/${HOST}/knownBy/${leaver}`)) === null,
);
expect(
  "including from a stay that already happened",
  (await read(`listings/${THEIRS}/guests/${leaver}`)) === null,
);
expect("the Auth account is gone", !(await accountExists(leaver)));

console.log("\nwhat other people had:");
expect(
  "the friend's copy of them is gone too",
  (await read(`users/${FRIEND}/friends/${leaver}`)) === null,
);
expect(
  "their own side of it is gone",
  (await read(`users/${leaver}/friends/${FRIEND}`)) === null,
);
expect(
  "the request they sent is gone",
  (await read(`connectRequests/${leaver}_${ASKED}`)) === null,
);
expect(
  "the request they were sent is gone",
  (await read(`connectRequests/${ASKER}_${leaver}`)) === null,
);

const mine = await read("bookings/teardown-booking-guest");
expect(
  "their stay at someone else's place is cancelled, by them",
  mine?.status?.stringValue === "CANCELLED" &&
    mine?.cancelledBy?.stringValue === leaver &&
    mine?.cancelReason?.stringValue === "STAY_CANCELLED",
  JSON.stringify(mine?.status ?? null),
);
const released = await read(`listings/${THEIRS}/windows/hw1`);
expect(
  "that host has their nights back",
  released?.status?.stringValue === "OPEN" && "nullValue" in (released?.bookingId ?? {}),
  JSON.stringify(released?.status ?? null),
);
const incoming = await read("bookings/teardown-booking-incoming");
expect(
  "their guest's confirmed stay is cancelled",
  incoming?.status?.stringValue === "CANCELLED" &&
    incoming?.cancelledBy?.stringValue === leaver,
);
const pending = await read("bookings/teardown-booking-pending");
expect(
  "a pending ask against their place is cancelled",
  pending?.status?.stringValue === "CANCELLED" &&
    pending?.cancelReason?.stringValue === "SLOT_CANCELLED",
);
// The line between a record and an obligation: cancelling a visit that already
// happened would tell someone their stay was called off after they had been.
const past = await read("bookings/teardown-booking-past");
expect(
  "a stay that already happened is left alone",
  past?.status?.stringValue === "CONFIRMED",
);

console.log(
  failures.length === 0
    ? "\nteardown check passed\n"
    : `\nteardown check FAILED (${failures.length})\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
