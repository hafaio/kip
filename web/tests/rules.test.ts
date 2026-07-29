import { readFileSync } from "node:fs";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { afterAll, beforeAll, beforeEach, describe, it } from "bun:test";
import {
  collection,
  deleteDoc,
  writeBatch,
  doc,
  type Firestore,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

// Rules tests for the public-portal / friendship flow. Run via the Firestore
// emulator: `firebase emulators:exec --only firestore --project demo-kip-rules
// "cd web && bun test tests/rules.test.ts"` (see package.json `test:rules`).

let testEnv: RulesTestEnvironment;

const OWNER = "owner1";
const STRANGER = "stranger1";

function authed(uid: string): Firestore {
  return testEnv.authenticatedContext(uid).firestore() as unknown as Firestore;
}
function anon(): Firestore {
  return testEnv.unauthenticatedContext().firestore() as unknown as Firestore;
}
async function seed(fill: (db: Firestore) => Promise<void>): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await fill(ctx.firestore() as unknown as Firestore);
  });
}

// EVERY date in this suite is relative to the day it runs. Now that asking for a
// slot requires it to still be current, a hard-coded literal doesn't just age —
// it quietly changes what its test asserts, and then fails on an ordinary morning
// with nothing having been edited. Five of these were literals, and that is
// exactly how they went.
function isoIn(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// A room link: who's sharing, and which room. The room and its free dates are
// both read live, authorised by a grant.
const portal = {
  scope: "LISTING",
  ownerId: OWNER,
  ownerName: "Owner",
  ownerPhotoURL: null,
  listingId: "L1",
  createdAt: 0,
};

// A date-range link. This is the ONE scope that copies the room in, because a
// slot grant deliberately doesn't unlock the room document.
const slotPortal = {
  scope: "SLOT",
  ownerId: OWNER,
  ownerName: "Owner",
  ownerPhotoURL: null,
  listings: [
    {
      listingId: "L1",
      title: "Sunny room",
      type: "ROOM",
      description: "",
      locationLabel: "Brooklyn, NY",
      photos: [],
      windowIds: ["shared"],
    },
  ],
  createdAt: 0,
};

// "Let's be friends", arrived through a share link. Asking to STAY is a REQUESTED
// booking now, not a request — see the bookings describes below.
const request = {
  from: STRANGER,
  to: OWNER,
  fromName: "Stranger",
  fromUsername: "stranger_h",
  fromPhotoURL: null,
  toUsername: "",
  portalId: "p1",
  createdAt: 0,
};

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "demo-kip-rules",
    firestore: {
      rules: readFileSync("../firebase/firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

describe("portals", () => {
  it("owner can create their own portal", async () => {
    await assertSucceeds(setDoc(doc(authed(OWNER), "portals", "p1"), portal));
  });

  it("cannot create a portal that names someone else as owner", async () => {
    await assertFails(setDoc(doc(authed("attacker"), "portals", "p2"), portal));
  });

  it("anyone can read a portal by id, even signed out", async () => {
    await seed((db) => setDoc(doc(db, "portals", "p1"), portal));
    await assertSucceeds(getDoc(doc(anon(), "portals", "p1")));
  });

  it("cannot enumerate the portals collection", async () => {
    await seed((db) => setDoc(doc(db, "portals", "p1"), portal));
    await assertFails(getDocs(collection(authed(STRANGER), "portals")));
  });

  it("only the owner can revoke", async () => {
    await seed((db) => setDoc(doc(db, "portals", "p1"), portal));
    await assertFails(deleteDoc(doc(authed("attacker"), "portals", "p1")));
    await assertSucceeds(deleteDoc(doc(authed(OWNER), "portals", "p1")));
  });
});

// A visitor proves they hold a link by writing a grant under its token, and reads
// of the live dates check that grant against whichever token the date range
// CURRENTLY sits under. That indirection is what makes revoking and regenerating
// take effect instantly, with nothing to clean up.
// Reading a friend's place costs ONE rule lookup (the exists() on their friends
// edge), and Firestore caps a query at 20 lookups. Repeats of the same path are
// free, so the ceiling is the number of DISTINCT owners in one query — which is
// what sets BROWSE_CHUNK in utils/listings.ts. Unchunked, Browse fails outright
// for anyone with more than ~20 friends sharing places.
describe("browse query vs the rules lookup budget", () => {
  const ME = "browser1";

  async function seedFriendsWithPlaces(
    ownerCount: number,
    placeCount: number,
  ): Promise<string[]> {
    const uids = Array.from({ length: ownerCount }, (_, index) => `f${index}`);
    await seed(async (db) => {
      for (const uid of uids) {
        await setDoc(doc(db, "users", uid, "friends", ME), {
          displayName: "Me",
        });
      }
      for (let index = 0; index < placeCount; index++) {
        await setDoc(doc(db, "listings", `BL${index}`), {
          ownerId: uids[index % ownerCount],
          title: `Place ${index}`,
          publicPortalId: null,
        });
      }
    });
    return uids;
  }

  function browse(uids: string[]) {
    return getDocs(
      query(collection(authed(ME), "listings"), where("ownerId", "in", uids)),
    );
  }

  // BROWSE_CHUNK sits exactly here, so this pair is a tripwire: add a lookup
  // before or at the friend check and the first case starts failing.
  it("a chunk of 20 friends is exactly within budget", async () => {
    const uids = await seedFriendsWithPlaces(20, 20);
    await assertSucceeds(browse(uids));
  });

  it("many places across few friends is fine — repeat lookups are free", async () => {
    const uids = await seedFriendsWithPlaces(3, 30);
    await assertSucceeds(browse(uids));
  });

  it("25 distinct friends in one query exceeds the budget", async () => {
    const uids = await seedFriendsWithPlaces(25, 25);
    await assertFails(browse(uids));
  });
});

describe("portal grants (live dates)", () => {
  const VISITOR = "visitor1";
  const openWindow = {
    start: isoIn(10),
    end: isoIn(14),
    status: "OPEN",
    autoAccept: false,
    details: "",
    publicPortalId: null,
  };

  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "portals", "p1"), portal);
      await setDoc(doc(db, "listings", "L1"), {
        ownerId: OWNER,
        title: "Sunny room",
        publicPortalId: "p1",
      });
      await setDoc(doc(db, "listings", "L1", "windows", "w1"), openWindow);
    });
  });

  it("claiming a grant requires naming a link that exists", async () => {
    await assertSucceeds(
      setDoc(doc(authed(VISITOR), "portals", "p1", "grants", VISITOR), {
        expires: new Date(),
      }),
    );
    await assertFails(
      setDoc(doc(authed(VISITOR), "portals", "nope", "grants", VISITOR), {
        expires: new Date(),
      }),
    );
  });

  it("cannot claim a grant in someone else's name", async () => {
    await assertFails(
      setDoc(doc(authed(VISITOR), "portals", "p1", "grants", "someone-else"), {
        expires: new Date(),
      }),
    );
  });

  it("a grant unlocks the live dates behind that link", async () => {
    await assertFails(
      getDoc(doc(authed(VISITOR), "listings", "L1", "windows", "w1")),
    );
    await seed((db) =>
      setDoc(doc(db, "portals", "p1", "grants", VISITOR), {
        expires: new Date(),
      }),
    );
    await assertSucceeds(
      getDoc(doc(authed(VISITOR), "listings", "L1", "windows", "w1")),
    );
  });

  it("regenerating the link kills the old grant instantly", async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "portals", "p1", "grants", VISITOR), {
        expires: new Date(),
      });
      // Owner regenerates: the place now points at a fresh token.
      await setDoc(doc(db, "portals", "p2"), portal);
      await setDoc(
        doc(db, "listings", "L1"),
        { publicPortalId: "p2" },
        { merge: true },
      );
    });
    await assertFails(
      getDoc(doc(authed(VISITOR), "listings", "L1", "windows", "w1")),
    );
  });

  it("revoking the link kills the grant too", async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "portals", "p1", "grants", VISITOR), {
        expires: new Date(),
      });
      await setDoc(
        doc(db, "listings", "L1"),
        { publicPortalId: null },
        { merge: true },
      );
    });
    await assertFails(
      getDoc(doc(authed(VISITOR), "listings", "L1", "windows", "w1")),
    );
  });

  // A date-range link exposes ONE range. Holding it must not reveal the rest of
  // the host's calendar for that place.
  it("a date-range link exposes only its own dates", async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "portals", "slot1"), slotPortal);
      await setDoc(doc(db, "portals", "slot1", "grants", VISITOR), {
        expires: new Date(),
      });
      await setDoc(doc(db, "listings", "L1", "windows", "shared"), {
        ...openWindow,
        publicPortalId: "slot1",
      });
      await setDoc(
        doc(db, "listings", "L1"),
        { publicPortalId: null },
        { merge: true },
      );
    });
    await assertSucceeds(
      getDoc(doc(authed(VISITOR), "listings", "L1", "windows", "shared")),
    );
    await assertFails(
      getDoc(doc(authed(VISITOR), "listings", "L1", "windows", "w1")),
    );
  });

  it("a room-link grant unlocks the room itself, read live", async () => {
    await assertFails(getDoc(doc(authed(VISITOR), "listings", "L1")));
    await seed((db) =>
      setDoc(doc(db, "portals", "p1", "grants", VISITOR), {
        expires: new Date(),
      }),
    );
    await assertSucceeds(getDoc(doc(authed(VISITOR), "listings", "L1")));
  });

  // Sharing one set of dates is a narrower promise than sharing the room, so a
  // slot grant stops at the slot. The room's details ride along in the link's own
  // copy instead.
  it("a slot-link grant does NOT unlock the room", async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "portals", "slot1"), slotPortal);
      await setDoc(doc(db, "portals", "slot1", "grants", VISITOR), {
        expires: new Date(),
      });
      await setDoc(doc(db, "listings", "L1", "windows", "shared"), {
        ...openWindow,
        publicPortalId: "slot1",
      });
      await setDoc(
        doc(db, "listings", "L1"),
        { publicPortalId: null },
        { merge: true },
      );
    });
    await assertSucceeds(
      getDoc(doc(authed(VISITOR), "listings", "L1", "windows", "shared")),
    );
    await assertFails(getDoc(doc(authed(VISITOR), "listings", "L1")));
  });

  // A profile link names no rooms at all — the grant lets the visitor query them,
  // so a room added after the link was shared just shows up.
  it("a profile-link grant unlocks every room, queried live", async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "portals", "prof1"), {
        scope: "USER",
        ownerId: OWNER,
        ownerName: "Owner",
        ownerPhotoURL: null,
        createdAt: 0,
      });
      await setDoc(doc(db, "portals", "prof1", "grants", VISITOR), {
        expires: new Date(),
      });
      await setDoc(doc(db, "users", OWNER, "settings", "prefs"), {
        profilePortalId: "prof1",
      });
      await setDoc(doc(db, "listings", "L2"), {
        ownerId: OWNER,
        title: "Added later",
        publicPortalId: null,
      });
    });
    await assertSucceeds(getDoc(doc(authed(VISITOR), "listings", "L2")));
  });

  // The slot is the source of truth for the dates, so whoever holds it must be
  // able to read it — a share-link guest's grant lapses (30 days, or the moment
  // the host regenerates) long before their stay does.
  it("the guest holding a slot can read it without any grant", async () => {
    await seed((db) =>
      setDoc(
        doc(db, "listings", "L1", "windows", "w1"),
        { status: "BOOKED", bookedBy: VISITOR },
        { merge: true },
      ),
    );
    await assertSucceeds(
      getDoc(doc(authed(VISITOR), "listings", "L1", "windows", "w1")),
    );
    await assertFails(
      getDoc(doc(authed("nobody"), "listings", "L1", "windows", "w1")),
    );
  });

  it("a grant cannot be forged for someone else to use", async () => {
    await seed((db) =>
      setDoc(doc(db, "portals", "p1", "grants", VISITOR), {
        expires: new Date(),
      }),
    );
    await assertFails(
      getDoc(doc(authed("freeloader"), "listings", "L1", "windows", "w1")),
    );
  });

  it("grants are not enumerable", async () => {
    await assertFails(
      getDocs(collection(authed(VISITOR), "portals", "p1", "grants")),
    );
  });
});

describe("connectRequests (share-link route)", () => {
  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "portals", "p1"), portal);
      // The sender's claimed name/handle must match their real profile.
      await setDoc(doc(db, "users", STRANGER), {
        displayName: "Stranger",
        username: "stranger_h",
      });
    });
  });

  it("a stranger can request through a valid portal", async () => {
    await assertSucceeds(
      setDoc(doc(authed(STRANGER), "connectRequests", `${STRANGER}_${OWNER}`), request),
    );
  });

  it("forgery blocked: no link resolves to the claimed recipient", async () => {
    await assertFails(
      setDoc(doc(authed(STRANGER), "connectRequests", `${STRANGER}_victim`), {
        ...request,
        portalId: "does-not-exist",
        to: "victim",
      }),
    );
  });

  it("forgery blocked: link exists but belongs to someone else", async () => {
    await assertFails(
      setDoc(doc(authed(STRANGER), "connectRequests", `${STRANGER}_victim`), {
        ...request,
        portalId: "p1", // owned by OWNER, not "victim"
        to: "victim",
      }),
    );
  });

  it("the doc id must be ${from}_${to}", async () => {
    await assertFails(
      setDoc(doc(authed(STRANGER), "connectRequests", "mismatched-id"), request),
    );
  });

  it("only the two parties can read a request", async () => {
    await seed((db) =>
      setDoc(doc(db, "connectRequests", `${STRANGER}_${OWNER}`), request),
    );
    await assertSucceeds(
      getDoc(doc(authed(OWNER), "connectRequests", `${STRANGER}_${OWNER}`)),
    );
    await assertFails(
      getDoc(doc(authed("rando"), "connectRequests", `${STRANGER}_${OWNER}`)),
    );
  });
});

describe("accept (friend edge)", () => {
  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "portals", "p1"), portal);
      await setDoc(
        doc(db, "connectRequests", `${STRANGER}_${OWNER}`),
        request,
      );
    });
  });

  it("a connect request authorizes the sender's friend edge", async () => {
    await seed((db) =>
      setDoc(doc(db, "users", OWNER), {
        displayName: "Owner",
        username: "owner_h",
      }),
    );
    await assertSucceeds(
      setDoc(doc(authed(OWNER), "users", STRANGER, "friends", OWNER), {
        displayName: "Owner",
        username: "owner_h",
        photoURL: null,
        since: 0,
      }),
    );
  });

  // The edge an accepter writes into the sender's list describes the ACCEPTER and
  // outlives the request — so, like the request itself, it can't lie about who
  // they are or wear a handle belonging to someone else.
  it("an accepter cannot install themselves under a false identity", async () => {
    await seed((db) =>
      setDoc(doc(db, "users", OWNER), {
        displayName: "Owner",
        username: "owner_h",
      }),
    );
    await assertFails(
      setDoc(doc(authed(OWNER), "users", STRANGER, "friends", OWNER), {
        displayName: "kip Support",
        username: "owner_h",
        photoURL: null,
        since: 0,
      }),
    );
    await assertFails(
      setDoc(doc(authed(OWNER), "users", STRANGER, "friends", OWNER), {
        displayName: "Owner",
        username: "someone_elses_handle",
        photoURL: null,
        since: 0,
      }),
    );
  });

  it("cannot write into someone's friends list without a request", async () => {
    await assertFails(
      setDoc(doc(authed(OWNER), "users", "stranger2", "friends", OWNER), {
        displayName: "Owner",
        photoURL: null,
        since: 0,
      }),
    );
  });
});

// Asking to stay is ONE thing regardless of who's asking: a REQUESTED booking.
// A friend is authorised by friendship, a share-link visitor by their grant — and
// the visitor can never skip approval, however the slot is configured.
describe("bookings via a share link", () => {
  const VISITOR = "visitor2";
  const stay = {
    listingId: "L1",
    ownerId: OWNER,
    guestId: VISITOR,
    windowId: "w1",
    start: isoIn(10),
    end: isoIn(14),
    status: "REQUESTED",
    hostName: "Owner",
    hostPhotoURL: null,
    guestName: "Visitor",
    guestPhotoURL: null,
    createdAt: 0,
  };

  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "portals", "p1"), portal);
      await setDoc(doc(db, "users", VISITOR), { displayName: "Visitor" });
      await setDoc(doc(db, "users", OWNER), { displayName: "Owner" });
      await setDoc(doc(db, "listings", "L1"), {
        ownerId: OWNER,
        title: "Sunny room",
        publicPortalId: "p1",
      });
      await setDoc(doc(db, "listings", "L1", "windows", "w1"), {
        start: isoIn(10),
        end: isoIn(14),
        status: "OPEN",
        autoAccept: true,
        details: "",
        publicPortalId: null,
      });
    });
  });

  it("without a grant, a visitor cannot ask to stay", async () => {
    await assertFails(
      setDoc(doc(authed(VISITOR), "bookings", "bv1"), stay),
    );
  });

  it("cannot lodge a booking pre-stamped as cancelled", async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "users", VISITOR), { displayName: "Visitor" });
      await setDoc(doc(db, "users", OWNER), { displayName: "Owner" });
      await setDoc(doc(db, "portals", "p1", "grants", VISITOR), {
        expires: new Date(),
      });
    });
    await assertFails(
      setDoc(doc(authed(VISITOR), "bookings", "bv7"), {
        ...stay,
        cancelledBy: OWNER,
        cancelReason: "DECLINED",
      }),
    );
  });

  it("with a grant, a visitor can ask to stay", async () => {
    await seed((db) =>
      setDoc(doc(db, "portals", "p1", "grants", VISITOR), {
        expires: new Date(),
      }),
    );
    await assertSucceeds(
      setDoc(doc(authed(VISITOR), "bookings", "bv2"), stay),
    );
  });

  // The slot auto-accepts, so a FRIEND could self-confirm it. Someone holding a
  // link cannot: instant booking is first-come-first-served among friends, and a
  // link is not friendship.
  it("a share-link visitor can never skip approval, even on an instant slot", async () => {
    await seed((db) =>
      setDoc(doc(db, "portals", "p1", "grants", VISITOR), {
        expires: new Date(),
      }),
    );
    await assertFails(
      setDoc(doc(authed(VISITOR), "bookings", "bv3"), {
        ...stay,
        status: "CONFIRMED",
      }),
    );
  });

  it("the dates must match the slot being asked for", async () => {
    await seed((db) =>
      setDoc(doc(db, "portals", "p1", "grants", VISITOR), {
        expires: new Date(),
      }),
    );
    await assertFails(
      setDoc(doc(authed(VISITOR), "bookings", "bv4"), {
        ...stay,
        start: isoIn(10),
        end: isoIn(30),
      }),
    );
  });

  // Between asking and confirming the slot sits OPEN, so the host may still edit
  // it. Confirming re-checks, rather than silently moving the stay.
  it("confirming is refused once the slot's dates have moved", async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "bookings", "bv5"), stay);
      await setDoc(
        doc(db, "listings", "L1", "windows", "w1"),
        { start: isoIn(15), end: isoIn(19) },
        { merge: true },
      );
    });
    await assertFails(
      updateDoc(doc(authed(OWNER), "bookings", "bv5"), {
        status: "CONFIRMED",
      }),
    );
  });
});

describe("users + usernames (get-not-query privacy)", () => {
  // A profile is readable by exactly three parties: yourself, your friends, and —
  // only when you've turned searchability on — anyone holding your uid. Holding a
  // uid is deliberately NOT sufficient, so an ex-friend who kept it still can't
  // read a profile that has since gone private.
  it("can GET your own profile", async () => {
    await seed((db) => setDoc(doc(db, "users", "u1"), { displayName: "U" }));
    await assertSucceeds(getDoc(doc(authed("u1"), "users", "u1")));
  });

  it("can GET a searchable profile by id", async () => {
    await seed((db) =>
      setDoc(doc(db, "users", "u1"), {
        displayName: "U",
        username: "u_one",
        searchable: true,
      }),
    );
    await assertSucceeds(getDoc(doc(authed("someone"), "users", "u1")));
  });

  it("cannot GET a private profile, even knowing the uid", async () => {
    await seed((db) =>
      setDoc(doc(db, "users", "u1"), { displayName: "U", username: "u_one" }),
    );
    await assertFails(getDoc(doc(authed("someone"), "users", "u1")));
  });

  it("a friend can GET a private profile", async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "users", "u1"), { displayName: "U" });
      await setDoc(doc(db, "users", "u1", "friends", "buddy"), {
        displayName: "Buddy",
      });
    });
    await assertSucceeds(getDoc(doc(authed("buddy"), "users", "u1")));
  });

  it("cannot enumerate the users collection", async () => {
    await assertFails(getDocs(collection(authed("someone"), "users")));
  });

  // Being searchable opens the PROFILE DOC and nothing else. Places, dates,
  // stays, your friends list and your settings all stay friends-gated, so
  // becoming findable never turns into becoming readable.
  it("searchable exposes the profile and nothing else", async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "users", "u1"), {
        displayName: "U",
        username: "u_one",
        searchable: true,
      });
      await setDoc(doc(db, "users", "u1", "settings", "prefs"), {
        shareStaysWithFriends: true,
      });
      await setDoc(doc(db, "users", "u1", "friends", "pal"), {
        displayName: "Pal",
      });
      await setDoc(doc(db, "listings", "L9"), { ownerId: "u1", title: "Room" });
      await setDoc(doc(db, "listings", "L9", "windows", "w9"), {
        start: isoIn(10),
        end: isoIn(14),
        status: "OPEN",
      });
      await setDoc(doc(db, "bookings", "b9"), {
        listingId: "L9",
        ownerId: "u1",
        guestId: "pal",
        status: "CONFIRMED",
      });
    });

    const stranger = authed("stranger9");
    await assertSucceeds(getDoc(doc(stranger, "users", "u1")));
    await assertFails(getDoc(doc(stranger, "users", "u1", "settings", "prefs")));
    await assertFails(getDoc(doc(stranger, "users", "u1", "friends", "pal")));
    await assertFails(getDoc(doc(stranger, "listings", "L9")));
    await assertFails(getDoc(doc(stranger, "listings", "L9", "windows", "w9")));
    await assertFails(getDoc(doc(stranger, "bookings", "b9")));
  });

  it("can resolve a username to a uid by exact handle", async () => {
    await seed((db) => setDoc(doc(db, "usernames", "maya"), { uid: "u1" }));
    await assertSucceeds(getDoc(doc(authed("someone"), "usernames", "maya")));
  });

  it("cannot enumerate the username registry", async () => {
    await assertFails(getDocs(collection(authed("someone"), "usernames")));
  });

  it("can claim an unclaimed handle mapping to your own uid", async () => {
    await assertSucceeds(
      setDoc(doc(authed("u1"), "usernames", "freehandle"), { uid: "u1" }),
    );
  });

  it("cannot claim a handle mapping to someone else's uid", async () => {
    await assertFails(
      setDoc(doc(authed("u1"), "usernames", "freehandle"), {
        uid: "someone-else",
      }),
    );
  });

  it("cannot claim a handle carrying extra fields", async () => {
    await assertFails(
      setDoc(doc(authed("u1"), "usernames", "freehandle"), {
        uid: "u1",
        listings: [],
      }),
    );
  });

  it("cannot steal a handle someone else already holds", async () => {
    // The doc exists, so a set() takes the update path; the owner-only update rule
    // (resource.uid must equal the writer) denies a non-owner — this is what makes
    // a claim collision fail before the profile write.
    await seed((db) => setDoc(doc(db, "usernames", "taken"), { uid: "owner" }));
    await assertFails(
      setDoc(doc(authed("attacker"), "usernames", "taken"), {
        uid: "attacker",
      }),
    );
  });

  it("owner can idempotently re-write their own handle (retry)", async () => {
    await seed((db) => setDoc(doc(db, "usernames", "mine"), { uid: "u1" }));
    await assertSucceeds(
      setDoc(doc(authed("u1"), "usernames", "mine"), { uid: "u1" }),
    );
  });

  // Mirrors the denylist in the usernames create rule (and utils/username.ts's
  // RESERVED). Looping every entry means dropping a name from the rule surfaces
  // here instead of silently un-reserving it at the security boundary.
  const RESERVED = [
    "admin",
    "kip",
    "support",
    "help",
    "root",
    "system",
    "about",
    "settings",
  ];
  it("cannot claim any reserved handle", async () => {
    for (const handle of RESERVED) {
      await assertFails(
        setDoc(doc(authed("u1"), "usernames", handle), { uid: "u1" }),
      );
    }
  });

  it("cannot claim a malformed handle (bad chars / too short / leading digit)", async () => {
    await assertFails(
      setDoc(doc(authed("u1"), "usernames", "ab"), { uid: "u1" }),
    );
    await assertFails(
      setDoc(doc(authed("u1"), "usernames", "1abc"), { uid: "u1" }),
    );
    await assertFails(
      setDoc(doc(authed("u1"), "usernames", "Bad_Caps"), { uid: "u1" }),
    );
  });

  // A handle is permanent — there's no delete, even for its owner. That's what
  // makes turning searchability off safe: your name can't be released and then
  // squatted by someone else while you're private.
  it("cannot release a handle, even your own", async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "usernames", "mine"), { uid: "u1" });
      await setDoc(doc(db, "usernames", "theirs"), { uid: "u2" });
    });
    await assertFails(deleteDoc(doc(authed("u1"), "usernames", "mine")));
    await assertFails(deleteDoc(doc(authed("u1"), "usernames", "theirs")));
  });

  it("cannot mark yourself searchable without a handle", async () => {
    await assertFails(
      setDoc(doc(authed("u1"), "users", "u1"), {
        displayName: "U",
        searchable: true,
      }),
    );
  });

  it("can mark yourself searchable with a handle you own", async () => {
    await seed((db) => setDoc(doc(db, "usernames", "mine"), { uid: "u1" }));
    await assertSucceeds(
      setDoc(doc(authed("u1"), "users", "u1"), {
        displayName: "U",
        username: "mine",
        searchable: true,
      }),
    );
  });

  it("can write your profile with a handle you own", async () => {
    await seed((db) => setDoc(doc(db, "usernames", "mine"), { uid: "u1" }));
    await assertSucceeds(
      setDoc(doc(authed("u1"), "users", "u1"), {
        username: "mine",
        displayName: "U",
      }),
    );
  });

  it("cannot display a handle you never claimed in the registry", async () => {
    // usernames/alice belongs to someone else; u1 must not be able to show it.
    await seed((db) => setDoc(doc(db, "usernames", "alice"), { uid: "alice" }));
    await assertFails(
      setDoc(doc(authed("u1"), "users", "u1"), {
        username: "alice",
        displayName: "Not Alice",
      }),
    );
  });
});

// The handle registry is the only legitimate route into this collection, so a
// request is refused unless the recipient is actually findable by handle. Going
// private therefore stops inbound requests outright — not just in the UI — even
// from someone who already knows the uid.
// The name and handle on a request are what the recipient sees and what goes in
// their email, and they can't check them — the two parties can't read each other's
// profiles yet. So they have to be the sender's real ones.
describe("connectRequests cannot spoof an identity", () => {
  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "users", "u1"), {
        displayName: "Target",
        username: "u_one",
        searchable: true,
      });
      await setDoc(doc(db, "users", "sender"), {
        displayName: "Real Sender",
        username: "real_sender",
        searchable: true,
      });
    });
  });

  const base = {
    from: "sender",
    to: "u1",
    fromPhotoURL: null,
    toUsername: "u_one",
    portalId: null,
    createdAt: 0,
  };

  it("can ask under your own name and handle", async () => {
    await assertSucceeds(
      setDoc(doc(authed("sender"), "connectRequests", "sender_u1"), {
        ...base,
        fromName: "Real Sender",
        fromUsername: "real_sender",
      }),
    );
  });

  it("cannot invent a display name", async () => {
    await assertFails(
      setDoc(doc(authed("sender"), "connectRequests", "sender_u1"), {
        ...base,
        fromName: "Chase Fraud Alert",
        fromUsername: "real_sender",
      }),
    );
  });

  it("cannot wear someone else's handle", async () => {
    await assertFails(
      setDoc(doc(authed("sender"), "connectRequests", "sender_u1"), {
        ...base,
        fromName: "Real Sender",
        fromUsername: "chase_support",
      }),
    );
  });
});

describe("connectRequests (handle route, searchable gate)", () => {
  const req = {
    from: "sender",
    to: "u1",
    fromName: "Sender",
    fromUsername: "sender_h",
    fromPhotoURL: null,
    toUsername: "u_one",
    portalId: null,
    createdAt: 0,
  };

  it("can request a searchable user", async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "users", "u1"), {
        displayName: "U",
        username: "u_one",
        searchable: true,
      });
      await setDoc(doc(db, "users", "sender"), {
        displayName: "Sender",
        username: "sender_h",
      });
    });
    await assertSucceeds(
      setDoc(doc(authed("sender"), "connectRequests", "sender_u1"), req),
    );
  });

  it("cannot request a private user, even knowing their uid", async () => {
    await seed((db) =>
      setDoc(doc(db, "users", "u1"), { displayName: "U", username: "u_one" }),
    );
    await assertFails(
      setDoc(doc(authed("sender"), "connectRequests", "sender_u1"), req),
    );
  });

  it("cannot request a user who has no profile at all", async () => {
    await assertFails(
      setDoc(doc(authed("sender"), "connectRequests", "sender_u1"), req),
    );
  });

  it("cannot send a request on someone else's behalf", async () => {
    await seed((db) =>
      setDoc(doc(db, "users", "u1"), {
        displayName: "U",
        username: "u_one",
        searchable: true,
      }),
    );
    await assertFails(
      setDoc(doc(authed("impostor"), "connectRequests", "sender_u1"), req),
    );
  });
});

// A guest's sight of a listing is a POINTER at the booking that justifies it,
// re-read on every use — so it dies with the booking rather than needing a
// cleanup path that some cancel route could forget.
describe("guest access is only as live as its booking", () => {
  const GUEST = "guest9";
  const confirmed = {
    listingId: "LG",
    ownerId: OWNER,
    guestId: GUEST,
    windowId: "wg",
    start: isoIn(10),
    end: isoIn(14),
    status: "CONFIRMED",
    hostName: "Owner",
    hostPhotoURL: null,
    guestName: "Guest",
    guestPhotoURL: null,
    createdAt: 0,
  };

  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "listings", "LG"), {
        ownerId: OWNER,
        title: "Sunny room",
        publicPortalId: null,
      });
      await setDoc(doc(db, "bookings", "bg"), confirmed);
    });
  });

  it("a guest can self-issue access naming their own confirmed booking", async () => {
    await assertSucceeds(
      setDoc(doc(authed(GUEST), "listings", "LG", "guests", GUEST), {
        bookingId: "bg",
      }),
    );
  });

  // The client re-claims off the guest's own trips on every load, so after the
  // first claim every one of them is a rewrite. Without an update rule the writes
  // are denied for the rest of the stay — harmless, but a permanent stream of
  // permission-denied is exactly how a real failure gets missed.
  it("re-claiming is idempotent, not denied", async () => {
    await seed((db) =>
      setDoc(doc(db, "listings", "LG", "guests", GUEST), { bookingId: "bg" }),
    );
    await assertSucceeds(
      setDoc(doc(authed(GUEST), "listings", "LG", "guests", GUEST), {
        bookingId: "bg",
      }),
    );
  });

  it("cannot rewrite an existing pointer onto a booking that isn't theirs", async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "listings", "LG", "guests", GUEST), {
        bookingId: "bg",
      });
      await setDoc(doc(db, "bookings", "bstranger"), {
        listingId: "LG",
        ownerId: OWNER,
        guestId: "someone-else",
        status: "CONFIRMED",
      });
    });
    await assertFails(
      setDoc(doc(authed(GUEST), "listings", "LG", "guests", GUEST), {
        bookingId: "bstranger",
      }),
    );
  });

  it("cannot point at someone else's booking", async () => {
    await assertFails(
      setDoc(
        doc(authed("freeloader"), "listings", "LG", "guests", "freeloader"),
        { bookingId: "bg" },
      ),
    );
  });

  it("cannot point at a booking for a different listing", async () => {
    await seed((db) =>
      setDoc(doc(db, "listings", "LOTHER"), { ownerId: OWNER }),
    );
    await assertFails(
      setDoc(doc(authed(GUEST), "listings", "LOTHER", "guests", GUEST), {
        bookingId: "bg",
      }),
    );
  });

  it("the pointer unlocks the listing while the booking stands", async () => {
    await assertFails(getDoc(doc(authed(GUEST), "listings", "LG")));
    await seed((db) =>
      setDoc(doc(db, "listings", "LG", "guests", GUEST), { bookingId: "bg" }),
    );
    await assertSucceeds(getDoc(doc(authed(GUEST), "listings", "LG")));
  });

  // The whole point: no cancel path has to remember to tear the pointer down.
  it("cancelling the booking revokes the listing, pointer left in place", async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "listings", "LG", "guests", GUEST), {
        bookingId: "bg",
      });
      await setDoc(doc(db, "bookings", "bg"), {
        ...confirmed,
        status: "CANCELLED",
      });
    });
    await assertFails(getDoc(doc(authed(GUEST), "listings", "LG")));
  });

  it("a pointer at a booking that no longer exists grants nothing", async () => {
    await seed((db) =>
      setDoc(doc(db, "listings", "LG", "guests", GUEST), {
        bookingId: "vanished",
      }),
    );
    await assertFails(getDoc(doc(authed(GUEST), "listings", "LG")));
  });

  it("bookings can never be deleted, by either party", async () => {
    await assertFails(deleteDoc(doc(authed(OWNER), "bookings", "bg")));
    await assertFails(deleteDoc(doc(authed(GUEST), "bookings", "bg")));
  });
});

// The name and photo a friend sees are copied onto the edge, so rendering a
// friends list costs no extra reads. That copy is only correctable by the person
// it describes — nothing else can reach into someone else's friends list — so
// without this it would be stale forever after a rename.
describe("friend edges heal on rename", () => {
  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "users", "me"), {
        displayName: "New Name",
        username: "me_h",
      });
      await setDoc(doc(db, "users", "them", "friends", "me"), {
        username: "me_h",
        displayName: "Old Name",
        photoURL: null,
        since: 0,
      });
    });
  });

  it("you can heal the entry describing YOU to your real name", async () => {
    await assertSucceeds(
      updateDoc(doc(authed("me"), "users", "them", "friends", "me"), {
        displayName: "New Name",
      }),
    );
  });

  it("only your name and photo — not the handle or anything else", async () => {
    await assertFails(
      updateDoc(doc(authed("me"), "users", "them", "friends", "me"), {
        username: "stolen_h",
      }),
    );
  });

  // Scoping WHICH fields may change is not the same as checking their values —
  // without this, healing your name to "kip Support" in every friend's list was
  // permitted by a rule whose test looked like it forbade exactly that.
  it("cannot heal your name to something that isn't yours", async () => {
    await assertFails(
      updateDoc(doc(authed("me"), "users", "them", "friends", "me"), {
        displayName: "kip Support",
      }),
    );
  });

  it("you cannot rewrite someone else's entry", async () => {
    await assertFails(
      updateDoc(doc(authed("impostor"), "users", "them", "friends", "me"), {
        displayName: "Impostor",
      }),
    );
  });
});

// A slot may hold at most one stay. A booked slot's dates are frozen, so date
// equality alone would happily match a second ask — and confirming it would
// overwrite the first guest's `bookedBy`, taking away their right to release it.
// Confirming is two writes — the booking and the slot — and the rules require
// them to travel together. Alone, the booking write leaves the slot OPEN, so the
// next confirm passes the same check and a host can promise one slot to several
// guests. The client transaction only guards honest races.
describe("a confirm must hand over the slot", () => {
  const G1 = "cg1";
  const G2 = "cg2";
  const seedBooking = (id: string, guestId: string) => ({
    listingId: "LH",
    ownerId: OWNER,
    guestId,
    windowId: "wh",
    start: isoIn(10),
    end: isoIn(14),
    status: "REQUESTED",
    cancelledBy: null,
    cancelReason: null,
    guestName: "G",
    createdAt: 0,
    id,
  });

  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "listings", "LH"), { ownerId: OWNER });
      await setDoc(doc(db, "listings", "LH", "windows", "wh"), {
        start: isoIn(10),
        end: isoIn(14),
        status: "OPEN",
        autoAccept: false,
        details: "",
        bookedBy: null,
      });
      await setDoc(doc(db, "bookings", "h1"), seedBooking("h1", G1));
      await setDoc(doc(db, "bookings", "h2"), seedBooking("h2", G2));
    });
  });

  it("confirming without flipping the slot is refused", async () => {
    await assertFails(
      updateDoc(doc(authed(OWNER), "bookings", "h1"), { status: "CONFIRMED" }),
    );
  });

  it("confirming together with the slot flip is allowed", async () => {
    const db = authed(OWNER);
    const batch = writeBatch(db);
    batch.update(doc(db, "bookings", "h1"), { status: "CONFIRMED" });
    batch.update(doc(db, "listings", "LH", "windows", "wh"), {
      status: "BOOKED",
      bookedBy: G1,
    });
    await assertSucceeds(batch.commit());
  });

  it("the slot must be handed to THAT guest, not another", async () => {
    const db = authed(OWNER);
    const batch = writeBatch(db);
    batch.update(doc(db, "bookings", "h1"), { status: "CONFIRMED" });
    batch.update(doc(db, "listings", "LH", "windows", "wh"), {
      status: "BOOKED",
      bookedBy: G2,
    });
    await assertFails(batch.commit());
  });
});

describe("a slot holds one stay", () => {
  const A = "guestA";
  const B = "guestB";
  const ask = {
    listingId: "LS",
    ownerId: OWNER,
    windowId: "ws",
    start: isoIn(10),
    end: isoIn(14),
    status: "REQUESTED",
    hostName: "Owner",
    hostPhotoURL: null,
    guestName: "Guest",
    guestPhotoURL: null,
    createdAt: 0,
  };

  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "listings", "LS"), { ownerId: OWNER });
      await setDoc(doc(db, "users", OWNER, "friends", A), { displayName: "A" });
      await setDoc(doc(db, "users", OWNER, "friends", B), { displayName: "B" });
      await setDoc(doc(db, "listings", "LS", "windows", "ws"), {
        start: isoIn(10),
        end: isoIn(14),
        status: "BOOKED",
        autoAccept: false,
        details: "",
        bookedBy: A,
      });
    });
  });

  it("cannot ask for a slot someone else already holds", async () => {
    await assertFails(
      setDoc(doc(authed(B), "bookings", "b2"), { ...ask, guestId: B }),
    );
  });

  it("cannot confirm a second stay onto a held slot", async () => {
    await seed((db) =>
      setDoc(doc(db, "bookings", "b3"), { ...ask, guestId: B }),
    );
    await assertFails(
      updateDoc(doc(authed(OWNER), "bookings", "b3"), { status: "CONFIRMED" }),
    );
  });

  it("a slot is born free — the owner cannot create one already held", async () => {
    await assertFails(
      setDoc(doc(authed(OWNER), "listings", "LS", "windows", "sneaky"), {
        start: isoIn(40),
        end: isoIn(44),
        status: "BOOKED",
        autoAccept: false,
        details: "",
        bookedBy: "someone",
      }),
    );
    await assertSucceeds(
      setDoc(doc(authed(OWNER), "listings", "LS", "windows", "fine"), {
        start: isoIn(40),
        end: isoIn(44),
        status: "OPEN",
        autoAccept: false,
        details: "",
        bookedBy: null,
      }),
    );
  });
});

describe("mail is not a client-writable collection", () => {
  it("nobody can enqueue mail", async () => {
    await assertFails(
      setDoc(doc(authed(OWNER), "mail", "m1"), {
        to: ["someone@example.com"],
        message: { subject: "hi", text: "hi" },
      }),
    );
  });
});

// Cancelling stamps who did it and why: a Firestore trigger can't see the writer,
// and the notice depends entirely on that. You may only ever stamp yourself.
describe("cancellation attribution", () => {
  const GUEST = "cg";
  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "listings", "LC"), { ownerId: OWNER });
      await setDoc(doc(db, "listings", "LC", "windows", "wc"), {
        start: isoIn(10),
        end: isoIn(14),
        status: "OPEN",
        autoAccept: false,
        details: "",
        bookedBy: null,
      });
      await setDoc(doc(db, "bookings", "bc"), {
        listingId: "LC",
        ownerId: OWNER,
        guestId: GUEST,
        windowId: "wc",
        start: isoIn(10),
        end: isoIn(14),
        status: "REQUESTED",
        cancelledBy: null,
        cancelReason: null,
        hostName: "Owner",
        hostPhotoURL: null,
        guestName: "Guest",
        guestPhotoURL: null,
        createdAt: 0,
      });
    });
  });

  it("the host can decline, stamping themselves", async () => {
    await assertSucceeds(
      updateDoc(doc(authed(OWNER), "bookings", "bc"), {
        status: "CANCELLED",
        cancelledBy: OWNER,
        cancelReason: "DECLINED",
      }),
    );
  });

  it("cannot pin the cancellation on the other party", async () => {
    await assertFails(
      updateDoc(doc(authed(OWNER), "bookings", "bc"), {
        status: "CANCELLED",
        cancelledBy: GUEST,
        cancelReason: "WITHDRAWN",
      }),
    );
  });

  it("still nothing but status and attribution may change", async () => {
    await assertFails(
      updateDoc(doc(authed(OWNER), "bookings", "bc"), {
        status: "CANCELLED",
        cancelledBy: OWNER,
        guestName: "Someone Else",
      }),
    );
  });
});

describe("bookings (field validation)", () => {
  const GUEST = "guest1";
  const base = {
    listingId: "L1",
    ownerId: OWNER,
    guestId: GUEST,
    windowId: "w-normal",
    start: isoIn(10),
    end: isoIn(14),
    guestName: "Guest One",
    hostName: "Owner One",
    createdAt: 0,
  };

  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "listings", "L1"), { ownerId: OWNER });
      await setDoc(doc(db, "users", GUEST), { displayName: "Guest One" });
      await setDoc(doc(db, "users", OWNER), { displayName: "Owner One" });
      await setDoc(doc(db, "users", OWNER, "friends", GUEST), { since: 0 });
      await setDoc(doc(db, "listings", "L1", "windows", "w-normal"), {
        start: base.start, end: base.end, status: "OPEN", autoAccept: false, details: "",
      });
      await setDoc(doc(db, "listings", "L1", "windows", "w-auto"), {
        start: base.start, end: base.end, status: "OPEN", autoAccept: true, details: "",
      });
      await setDoc(doc(db, "listings", "L1", "windows", "w-auto-booked"), {
        start: base.start, end: base.end, status: "BOOKED", autoAccept: true, details: "",
        bookedBy: "someone-else",
      });
    });
  });

  it("a friend can create a REQUESTED booking", async () => {
    await assertSucceeds(
      setDoc(doc(authed(GUEST), "bookings", "bk1"), { ...base, status: "REQUESTED" }),
    );
  });

  it("a friend cannot self-create a CONFIRMED booking on a non-auto window", async () => {
    await assertFails(
      setDoc(doc(authed(GUEST), "bookings", "bk2"), { ...base, status: "CONFIRMED" }),
    );
  });

  // Instant booking is two writes as well: the booking and the slot flip must
  // arrive together, or the slot stays open for the next person to take too.
  it("a friend CAN instant-book, taking the slot in the same commit", async () => {
    const db = authed(GUEST);
    const batch = writeBatch(db);
    batch.set(doc(db, "bookings", "bk3"), {
      ...base,
      windowId: "w-auto",
      status: "CONFIRMED",
    });
    batch.update(doc(db, "listings", "L1", "windows", "w-auto"), {
      status: "BOOKED",
      bookedBy: GUEST,
    });
    await assertSucceeds(batch.commit());
  });

  it("instant-booking without taking the slot is refused", async () => {
    await assertFails(
      setDoc(doc(authed(GUEST), "bookings", "bk3b"), {
        ...base,
        windowId: "w-auto",
        status: "CONFIRMED",
      }),
    );
  });

  it("a friend cannot double-book an already-BOOKED auto-accept window", async () => {
    await assertFails(
      setDoc(doc(authed(GUEST), "bookings", "bk3b"), {
        ...base,
        windowId: "w-auto-booked",
        status: "CONFIRMED",
      }),
    );
  });

  it("cannot set ownerId to someone who doesn't own the listing", async () => {
    // GUEST is a friend of "victim" too, so the friend check passes — it's the
    // ownerId-must-be-the-listing-owner check that blocks the injection.
    await seed((db) => setDoc(doc(db, "users", "victim", "friends", GUEST), { since: 0 }));
    await assertFails(
      setDoc(doc(authed(GUEST), "bookings", "bk4"), {
        ...base,
        ownerId: "victim",
        status: "REQUESTED",
      }),
    );
  });

  it("a guest cannot self-confirm their pending booking via update", async () => {
    await seed((db) =>
      setDoc(doc(db, "bookings", "bk5"), { ...base, status: "REQUESTED" }),
    );
    await assertFails(
      updateDoc(doc(authed(GUEST), "bookings", "bk5"), { status: "CONFIRMED" }),
    );
  });

  it("a guest can cancel their own booking via update", async () => {
    await seed((db) =>
      setDoc(doc(db, "bookings", "bk6"), { ...base, status: "REQUESTED" }),
    );
    await assertSucceeds(
      updateDoc(doc(authed(GUEST), "bookings", "bk6"), { status: "CANCELLED" }),
    );
  });

  it("the owner can confirm a pending booking, taking the slot with it", async () => {
    await seed((db) =>
      setDoc(doc(db, "bookings", "bk7"), { ...base, status: "REQUESTED" }),
    );
    const db = authed(OWNER);
    const batch = writeBatch(db);
    batch.update(doc(db, "bookings", "bk7"), { status: "CONFIRMED" });
    batch.update(doc(db, "listings", "L1", "windows", "w-normal"), {
      status: "BOOKED",
      bookedBy: GUEST,
    });
    await assertSucceeds(batch.commit());
  });

  it("neither party can rewrite a link/party field", async () => {
    await seed((db) =>
      setDoc(doc(db, "bookings", "bk8"), { ...base, status: "CONFIRMED" }),
    );
    await assertFails(
      updateDoc(doc(authed(OWNER), "bookings", "bk8"), { guestId: "intruder" }),
    );
  });
});

// A confirmed stay is an agreement about specific nights. The host can cancel it,
// but must not be able to quietly move it.
describe("windows (a booked slot's dates are frozen)", () => {
  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "listings", "LW"), { ownerId: OWNER });
      await setDoc(doc(db, "listings", "LW", "windows", "wb"), {
        start: isoIn(20),
        end: isoIn(24),
        status: "BOOKED",
        autoAccept: false,
        details: "",
        bookedBy: STRANGER,
      });
      await setDoc(doc(db, "listings", "LW", "windows", "wo"), {
        start: isoIn(30),
        end: isoIn(34),
        status: "OPEN",
        autoAccept: false,
        details: "",
        bookedBy: null,
      });
    });
  });

  it("the host cannot move a booked slot's dates", async () => {
    await assertFails(
      updateDoc(doc(authed(OWNER), "listings", "LW", "windows", "wb"), {
        start: isoIn(60),
        end: isoIn(64),
      }),
    );
  });

  it("the host can still edit a booked slot's notes", async () => {
    await assertSucceeds(
      updateDoc(doc(authed(OWNER), "listings", "LW", "windows", "wb"), {
        details: "Back late on the first night",
      }),
    );
  });

  it("the host can freely edit an open slot", async () => {
    await assertSucceeds(
      updateDoc(doc(authed(OWNER), "listings", "LW", "windows", "wo"), {
        start: isoIn(60),
        end: isoIn(64),
      }),
    );
  });

  it("the host can still release a booked slot (cancel)", async () => {
    await assertSucceeds(
      updateDoc(doc(authed(OWNER), "listings", "LW", "windows", "wb"), {
        status: "OPEN",
        bookedBy: null,
      }),
    );
  });
});

// Dates that have been and gone stop being availability. The UI already hides the
// fields; this is the backstop, and it matters because reviving an old slot would
// also revive the stale asks still pointing at it.
describe("windows (an expired slot's dates are frozen)", () => {
  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "listings", "LX"), { ownerId: OWNER });
      await setDoc(doc(db, "listings", "LX", "windows", "wpast"), {
        start: isoIn(-30),
        end: isoIn(-26),
        status: "OPEN",
        autoAccept: false,
        details: "",
        bookedBy: null,
      });
    });
  });

  it("the host cannot move an expired slot into the future", async () => {
    await assertFails(
      updateDoc(doc(authed(OWNER), "listings", "LX", "windows", "wpast"), {
        start: isoIn(10),
        end: isoIn(14),
      }),
    );
  });

  it("nor nudge it by a single day", async () => {
    await assertFails(
      updateDoc(doc(authed(OWNER), "listings", "LX", "windows", "wpast"), {
        start: isoIn(-29),
        end: isoIn(-25),
      }),
    );
  });

  // Everything that isn't the dates still works, so the slot can be cleared off
  // the calendar and a stay that already happened stays legible.
  it("the host can still edit an expired slot's notes", async () => {
    await assertSucceeds(
      updateDoc(doc(authed(OWNER), "listings", "LX", "windows", "wpast"), {
        details: "They left the keys with the neighbour",
      }),
    );
  });

  it("the host can still delete an expired slot", async () => {
    await assertSucceeds(
      deleteDoc(doc(authed(OWNER), "listings", "LX", "windows", "wpast")),
    );
  });

  // The rule compares against yesterday in UTC, because `request.time` is UTC
  // while the client's `isExpired` is local — a slot ending today must stay
  // editable for someone west of UTC, where "today" hasn't caught up yet.
  it("a slot ending today is still editable", async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "listings", "LX", "windows", "wtoday"), {
        start: isoIn(-3),
        end: isoIn(0),
        status: "OPEN",
        autoAccept: false,
        details: "",
        bookedBy: null,
      });
    });
    await assertSucceeds(
      updateDoc(doc(authed(OWNER), "listings", "LX", "windows", "wtoday"), {
        start: isoIn(5),
        end: isoIn(9),
      }),
    );
  });
});

describe("windows (guest field pinning)", () => {
  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "listings", "L1"), { ownerId: OWNER });
      await setDoc(doc(db, "users", OWNER, "friends", STRANGER), { since: 0 });
      await setDoc(doc(db, "listings", "L1", "windows", "w-auto"), {
        start: isoIn(10),
        end: isoIn(14),
        status: "OPEN",
        autoAccept: true,
        details: "",
        bookedBy: null,
        publicPortalId: "pp1",
      });
    });
  });

  it("a friend can claim an auto-accept window (OPEN -> BOOKED)", async () => {
    await assertSucceeds(
      updateDoc(doc(authed(STRANGER), "listings", "L1", "windows", "w-auto"), {
        status: "BOOKED",
        bookedBy: STRANGER,
      }),
    );
  });

  it("a claiming friend cannot also change the slot's portal link", async () => {
    await assertFails(
      updateDoc(doc(authed(STRANGER), "listings", "L1", "windows", "w-auto"), {
        status: "BOOKED",
        bookedBy: STRANGER,
        publicPortalId: null,
      }),
    );
  });
});

// The two people in a confirmed stay are the one pair who demonstrably know each
// other — and, if they met through a share link, the one pair the other two routes
// in can't serve: a link guest is neither searchable nor someone whose link the
// host holds.
describe("connectRequests (shared-booking route)", () => {
  const HOST = "sbhost";
  const GUEST = "sbguest";
  const stay = {
    listingId: "LSB",
    ownerId: HOST,
    guestId: GUEST,
    windowId: "wsb",
    start: isoIn(70),
    end: isoIn(74),
    status: "CONFIRMED",
    cancelledBy: null,
    cancelReason: null,
  };

  beforeEach(async () => {
    await seed(async (db) => {
      // Neither is searchable, and neither holds the other's link.
      await setDoc(doc(db, "users", HOST), { displayName: "Host" });
      await setDoc(doc(db, "users", GUEST), { displayName: "Guest" });
      await setDoc(doc(db, "bookings", "bsb"), stay);
      await setDoc(doc(db, "bookings", "bsb-pending"), {
        ...stay,
        status: "REQUESTED",
      });
      await setDoc(doc(db, "bookings", "bsb-other"), {
        ...stay,
        guestId: "someone-else",
      });
    });
  });

  const ask = (from: string, to: string, bookingId: string) =>
    setDoc(doc(authed(from), "connectRequests", `${from}_${to}`), {
      from,
      to,
      fromName: from === HOST ? "Host" : "Guest",
      fromUsername: "",
      fromPhotoURL: null,
      toUsername: "",
      bookingId,
      createdAt: 0,
    });

  it("a host can ask a guest they hosted", async () => {
    await assertSucceeds(ask(HOST, GUEST, "bsb"));
  });

  it("and the guest can ask the host — it's order-free", async () => {
    await assertSucceeds(ask(GUEST, HOST, "bsb"));
  });

  it("a stay that was only ever asked for doesn't count", async () => {
    await assertFails(ask(HOST, GUEST, "bsb-pending"));
  });

  it("cannot ride someone else's booking to reach a stranger", async () => {
    await assertFails(ask(HOST, GUEST, "bsb-other"));
  });

  it("cannot name a booking that doesn't exist", async () => {
    await assertFails(ask(HOST, GUEST, "no-such-booking"));
  });

  it("still refuses with no route at all", async () => {
    await assertFails(
      setDoc(doc(authed(HOST), "connectRequests", `${HOST}_${GUEST}`), {
        from: HOST,
        to: GUEST,
        fromName: "Host",
        fromUsername: "",
        fromPhotoURL: null,
        toUsername: "",
        createdAt: 0,
      }),
    );
  });
});

// Clearing a cancelled booking is a HIDE, not a delete: one document is the record
// for both parties, so a delete by one would erase the other's history.
describe("bookings (clearing a cancelled one)", () => {
  const HOST = "hbhost";
  const GUEST = "hbguest";
  const cancelled = {
    listingId: "LHB",
    ownerId: HOST,
    guestId: GUEST,
    windowId: "whb",
    start: isoIn(70),
    end: isoIn(74),
    status: "CANCELLED",
    cancelledBy: HOST,
    cancelReason: "STAY_CANCELLED",
  };

  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "bookings", "hb"), cancelled);
      await setDoc(doc(db, "bookings", "hb-live"), {
        ...cancelled,
        status: "CONFIRMED",
        cancelledBy: null,
        cancelReason: null,
      });
      await setDoc(doc(db, "bookings", "hb-theirs"), {
        ...cancelled,
        hiddenBy: [HOST],
      });
    });
  });

  // The second writer must APPEND — replacing the list would clear the first
  // party's entry, and the rule refuses that. The client uses arrayUnion.
  it("either party can clear it from their own list", async () => {
    await assertSucceeds(
      updateDoc(doc(authed(GUEST), "bookings", "hb"), { hiddenBy: [GUEST] }),
    );
    await assertSucceeds(
      updateDoc(doc(authed(HOST), "bookings", "hb"), {
        hiddenBy: [GUEST, HOST],
      }),
    );
  });

  it("clearing yours leaves theirs alone", async () => {
    await assertSucceeds(
      updateDoc(doc(authed(GUEST), "bookings", "hb-theirs"), {
        hiddenBy: [HOST, GUEST],
      }),
    );
  });

  it("cannot clear it on the other party's behalf", async () => {
    await assertFails(
      updateDoc(doc(authed(GUEST), "bookings", "hb"), { hiddenBy: [HOST] }),
    );
  });

  it("cannot un-hide it for the other party", async () => {
    await assertFails(
      updateDoc(doc(authed(GUEST), "bookings", "hb-theirs"), {
        hiddenBy: [GUEST],
      }),
    );
  });

  it("a live stay cannot be tidied away", async () => {
    await assertFails(
      updateDoc(doc(authed(GUEST), "bookings", "hb-live"), {
        hiddenBy: [GUEST],
      }),
    );
  });

  it("hiding cannot smuggle another field through", async () => {
    await assertFails(
      updateDoc(doc(authed(GUEST), "bookings", "hb"), {
        hiddenBy: [GUEST],
        start: isoIn(100),
      }),
    );
  });

  it("a stranger cannot touch it at all", async () => {
    await assertFails(
      updateDoc(doc(authed("nosy"), "bookings", "hb"), { hiddenBy: ["nosy"] }),
    );
  });
});

// A friend edge carries copies of your name, handle and photo so a friends list
// costs no extra reads. All three are pinned to your real profile, and all three
// have to stay healable — a copy is only worth having if it can be corrected.
describe("friend edges (healing every copy of you)", () => {
  const ME = "healer";
  const FRIEND = "healfriend";

  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "users", ME), {
        displayName: "New Name",
        username: "claimed_later",
        photoURL: "https://example.com/new.png",
      });
      // The edge as it was written before the handle and photo existed.
      await setDoc(doc(db, "users", FRIEND, "friends", ME), {
        displayName: "Old Name",
        username: "",
        photoURL: null,
        since: 0,
      });
    });
  });

  // The case that used to be unfixable: befriend someone, claim a handle later,
  // and the stored edge's empty username no longer matches the profile — so
  // EVERY heal was denied for that friend, name and photo alike.
  it("can bring a pre-handle edge up to date", async () => {
    await assertSucceeds(
      updateDoc(doc(authed(ME), "users", FRIEND, "friends", ME), {
        displayName: "New Name",
        username: "claimed_later",
        photoURL: "https://example.com/new.png",
      }),
    );
  });

  it("still refuses a name that isn't yours", async () => {
    await assertFails(
      updateDoc(doc(authed(ME), "users", FRIEND, "friends", ME), {
        displayName: "kip Support",
        username: "claimed_later",
        photoURL: "https://example.com/new.png",
      }),
    );
  });

  // The photo is a copy the holder can't check, shown beside your name.
  it("refuses a photo that isn't the one on your profile", async () => {
    await assertFails(
      updateDoc(doc(authed(ME), "users", FRIEND, "friends", ME), {
        displayName: "New Name",
        username: "claimed_later",
        photoURL: "https://evil.example.com/tracker.png",
      }),
    );
  });

  it("cannot wear a handle registered to someone else", async () => {
    await assertFails(
      updateDoc(doc(authed(ME), "users", FRIEND, "friends", ME), {
        displayName: "New Name",
        username: "someone_else",
        photoURL: "https://example.com/new.png",
      }),
    );
  });

  it("cannot smuggle another field through the heal", async () => {
    await assertFails(
      updateDoc(doc(authed(ME), "users", FRIEND, "friends", ME), {
        displayName: "New Name",
        username: "claimed_later",
        photoURL: "https://example.com/new.png",
        since: 999,
      }),
    );
  });
});

// A share-link guest and their host are neither friends nor searchable to each
// other, so neither could read the other at all — which is why their names and
// photos were copied onto every booking and rewritten on every rename. That copy
// was unbounded; this is one hop, gated on the stay itself.
describe("reading someone you share a stay with", () => {
  const HOST = "hopowner";
  const GUEST = "hopguest";
  const stay = {
    listingId: "LHOP",
    ownerId: HOST,
    guestId: GUEST,
    windowId: "whop",
    start: isoIn(70),
    end: isoIn(74),
    status: "CONFIRMED",
  };

  beforeEach(async () => {
    await seed(async (db) => {
      // Neither searchable, no friendship between them.
      await setDoc(doc(db, "users", HOST), { displayName: "Host" });
      await setDoc(doc(db, "users", GUEST), { displayName: "Guest" });
      await setDoc(doc(db, "bookings", "bhop"), stay);
      await setDoc(doc(db, "bookings", "bhop-pending"), {
        ...stay,
        status: "REQUESTED",
      });
      await setDoc(doc(db, "bookings", "bhop-other"), {
        ...stay,
        guestId: "a-stranger",
      });
    });
  });

  const point = (reader: string, subject: string, bookingId: string) =>
    setDoc(doc(authed(reader), "users", subject, "knownBy", reader), {
      bookingId,
    });

  it("is refused with no pointer", async () => {
    await assertFails(getDoc(doc(authed(GUEST), "users", HOST)));
  });

  it("the pointer is self-issued, and then the profile reads", async () => {
    await assertSucceeds(point(GUEST, HOST, "bhop"));
    await assertSucceeds(getDoc(doc(authed(GUEST), "users", HOST)));
  });

  it("works in the other direction too", async () => {
    await assertSucceeds(point(HOST, GUEST, "bhop"));
    await assertSucceeds(getDoc(doc(authed(HOST), "users", GUEST)));
  });

  it("cannot be issued for a stay that was only asked for", async () => {
    await assertFails(point(GUEST, HOST, "bhop-pending"));
  });

  it("cannot ride someone else's booking to reach a stranger", async () => {
    await assertFails(point(GUEST, HOST, "bhop-other"));
  });

  it("cannot be issued in someone else's name", async () => {
    await assertFails(
      setDoc(doc(authed("nosy"), "users", HOST, "knownBy", GUEST), {
        bookingId: "bhop",
      }),
    );
  });

  // The pointer is re-read on every use, so it dies with the stay rather than
  // needing any cancel path to remember to tear it down.
  it("goes inert when the stay is cancelled", async () => {
    await assertSucceeds(point(GUEST, HOST, "bhop"));
    await seed((db) =>
      setDoc(doc(db, "bookings", "bhop"), { ...stay, status: "CANCELLED" }),
    );
    await assertFails(getDoc(doc(authed(GUEST), "users", HOST)));
  });

  it("is useless to anyone else", async () => {
    await assertSucceeds(point(GUEST, HOST, "bhop"));
    await assertFails(getDoc(doc(authed("nosy"), "users", HOST)));
  });
});

// A stay is the only thing here that ends without anything writing to it —
// nothing marks a booking completed, the app just compares `end` to today. So
// the pointers hanging off one have to age out on the date itself, or someone
// you hosted once reads your profile forever.
describe("a stay stops granting sight once it's well past", () => {
  const HOST = "sightowner";
  const GUEST = "sightguest";
  const stay = (id: string, endOffset: number, status = "CONFIRMED") => ({
    id,
    doc: {
      listingId: "LSIGHT",
      ownerId: HOST,
      guestId: GUEST,
      windowId: "wsight",
      start: isoIn(endOffset - 3),
      end: isoIn(endOffset),
      status,
    },
  });

  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "users", HOST), { displayName: "Host" });
      await setDoc(doc(db, "users", GUEST), { displayName: "Guest" });
      for (const [id, offset, status] of [
        ["recent", -10, "CONFIRMED"],
        ["ancient", -400, "CONFIRMED"],
        ["asked", 20, "REQUESTED"],
      ] as const) {
        const built = stay(`b_${id}`, offset, status);
        await setDoc(doc(db, "bookings", built.id), built.doc);
      }
    });
  });

  const point = (reader: string, subject: string, bookingId: string) =>
    setDoc(doc(authed(reader), "users", subject, "knownBy", reader), {
      bookingId,
    });

  it("a stay from last week still lets them look you up", async () => {
    await assertSucceeds(point(GUEST, HOST, "b_recent"));
    await assertSucceeds(getDoc(doc(authed(GUEST), "users", HOST)));
  });

  it("a stay from last year does not", async () => {
    await assertFails(point(GUEST, HOST, "b_ancient"));
  });

  // The pointer is re-checked on every read, so one issued while the stay was
  // fresh stops working on its own — no sweep, nothing to remember to revoke.
  it("a pointer issued while it was fresh goes inert with age", async () => {
    await assertSucceeds(point(GUEST, HOST, "b_recent"));
    await seed((db) =>
      setDoc(doc(db, "bookings", "b_recent"), stay("b_recent", -400).doc),
    );
    await assertFails(getDoc(doc(authed(GUEST), "users", HOST)));
  });

  // Confirming a stranger called "Someone" is the moment identity matters most.
  it("a host can look up whoever asked, before confirming", async () => {
    await assertSucceeds(point(HOST, GUEST, "b_asked"));
    await assertSucceeds(getDoc(doc(authed(HOST), "users", GUEST)));
  });

  // Being asked is not consent to be looked up.
  it("but asking does not let the guest look up the host", async () => {
    await assertFails(point(GUEST, HOST, "b_asked"));
  });
});

// A booking's status machine, not just its fields.
describe("booking transitions", () => {
  const HOST = "transowner";
  const GUEST = "transguest";
  const base = {
    listingId: "LTRANS",
    ownerId: HOST,
    guestId: GUEST,
    windowId: "wtrans",
    start: isoIn(10),
    end: isoIn(14),
    cancelledBy: null,
    cancelReason: null,
  };

  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "listings", "LTRANS"), { ownerId: HOST });
      await setDoc(doc(db, "listings", "LTRANS", "windows", "wtrans"), {
        start: isoIn(10),
        end: isoIn(14),
        status: "OPEN",
        autoAccept: false,
        details: "",
        bookedBy: null,
      });
      await setDoc(doc(db, "bookings", "t_cancelled"), {
        ...base,
        status: "CANCELLED",
        cancelledBy: GUEST,
        cancelReason: "WITHDRAWN",
      });
      await setDoc(doc(db, "bookings", "t_confirmed"), {
        ...base,
        status: "CONFIRMED",
      });
    });
  });

  // The race that made this reachable without any crafted client: the guest
  // withdraws, the host's screen still says Pending, the host taps Confirm.
  it("a withdrawn ask cannot be confirmed back to life", async () => {
    await assertFails(
      updateDoc(doc(authed(HOST), "bookings", "t_cancelled"), {
        status: "CONFIRMED",
      }),
    );
  });

  it("a cancelled booking cannot be reopened as a request either", async () => {
    await assertFails(
      updateDoc(doc(authed(HOST), "bookings", "t_cancelled"), {
        status: "REQUESTED",
      }),
    );
  });

  it("a confirmed stay cannot be pushed back to pending", async () => {
    await assertFails(
      updateDoc(doc(authed(HOST), "bookings", "t_confirmed"), {
        status: "REQUESTED",
      }),
    );
  });

  it("cancelling a confirmed stay still works", async () => {
    await assertSucceeds(
      updateDoc(doc(authed(HOST), "bookings", "t_confirmed"), {
        status: "CANCELLED",
        cancelledBy: HOST,
        cancelReason: "STAY_CANCELLED",
      }),
    );
  });
});

// A request already sitting in someone's inbox must not outlive the route that
// put it there — otherwise revoking a link stops new asks but not a refresh of
// the one already pending, and its `portalId` could be rewritten to claim a
// provenance it no longer has.
describe("connectRequests (a route you no longer have)", () => {
  const SENDER = "routesender";
  const OWNER = "routeowner";
  const id = `${SENDER}_${OWNER}`;
  const asked = {
    from: SENDER,
    to: OWNER,
    fromName: "Sender",
    fromUsername: "",
    fromPhotoURL: null,
    toName: "",
    toPhotoURL: null,
    toUsername: "",
    portalId: "routeportal",
    createdAt: 0,
  };

  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "users", SENDER), { displayName: "Sender" });
      // Not searchable: the link is the only way in.
      await setDoc(doc(db, "users", OWNER), { displayName: "Owner" });
      await setDoc(doc(db, "portals", "routeportal"), {
        scope: "USER",
        ownerId: OWNER,
        ownerName: "Owner",
        ownerPhotoURL: null,
        createdAt: 0,
      });
      await setDoc(doc(db, "connectRequests", id), asked);
    });
  });

  it("can be re-sent while the link is live", async () => {
    await assertSucceeds(
      setDoc(doc(authed(SENDER), "connectRequests", id), {
        ...asked,
        createdAt: 1,
      }),
    );
  });

  it("cannot be refreshed once that link is revoked", async () => {
    await seed((db) => deleteDoc(doc(db, "portals", "routeportal")));
    await assertFails(
      setDoc(doc(authed(SENDER), "connectRequests", id), {
        ...asked,
        createdAt: 1,
      }),
    );
  });

  it("cannot be rewritten to claim a link that was never theirs", async () => {
    await seed((db) =>
      setDoc(doc(db, "portals", "someone-elses"), {
        scope: "USER",
        ownerId: "a-third-party",
        ownerName: "Other",
        ownerPhotoURL: null,
        createdAt: 0,
      }),
    );
    await assertFails(
      setDoc(doc(authed(SENDER), "connectRequests", id), {
        ...asked,
        portalId: "someone-elses",
      }),
    );
  });
});

// The client filters expired slots out of every surface, so an honest one never
// offers this — but an untouched lapsed slot is still OPEN.
describe("bookings (dates that have already gone)", () => {
  const HOST = "pastowner";
  const GUEST = "pastguest";

  beforeEach(async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "users", HOST), { displayName: "Host" });
      await setDoc(doc(db, "users", GUEST), { displayName: "Guest" });
      await setDoc(doc(db, "listings", "LPAST"), { ownerId: HOST });
      await setDoc(doc(db, "users", HOST, "friends", GUEST), { since: 0 });
      await setDoc(doc(db, "listings", "LPAST", "windows", "wgone"), {
        start: isoIn(-40),
        end: isoIn(-36),
        status: "OPEN",
        autoAccept: false,
        details: "",
        bookedBy: null,
      });
      await setDoc(doc(db, "listings", "LPAST", "windows", "wsoon"), {
        start: isoIn(10),
        end: isoIn(14),
        status: "OPEN",
        autoAccept: false,
        details: "",
        bookedBy: null,
      });
    });
  });

  const ask = (windowId: string, start: string, end: string) =>
    setDoc(doc(authed(GUEST), "bookings", `bp_${windowId}`), {
      listingId: "LPAST",
      ownerId: HOST,
      guestId: GUEST,
      windowId,
      start,
      end,
      status: "REQUESTED",
      cancelledBy: null,
      cancelReason: null,
      hiddenBy: [],
      createdAt: 0,
    });

  it("cannot ask for a slot whose nights have passed", async () => {
    await assertFails(ask("wgone", isoIn(-40), isoIn(-36)));
  });

  it("a live slot is unaffected", async () => {
    await assertSucceeds(ask("wsoon", isoIn(10), isoIn(14)));
  });
});
