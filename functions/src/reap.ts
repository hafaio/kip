import { getAuth, type UserRecord } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";

// Firebase's own anonymous auto-delete cannot read Firestore, so it cannot tell
// a one-visit ticket from someone carrying a name, a live ask and friendships —
// which under this design is the same kind of Auth account. It must stay OFF,
// and this replaces it with a reaper that looks before it kills.
//
// The asymmetry that makes this safe: deleting a real ticket is INVISIBLE to
// whoever held it, because the capability was the URL, not the uid — they come
// back, get a fresh ticket, and the link opens exactly as before. Deleting a
// person is unrecoverable. So every ambiguity here resolves to keep.

const REAP_AFTER_DAYS = 30;
// A predicate bug costs one bounded batch before the logs are read, not the pile.
const MAX_PER_RUN = 2000;
// Long enough that the rules still let a host look up a guest they hosted:
// `stayPermitsSight` runs 60 days past checkout, and reaping inside that window
// would have the schema disagreeing with itself.
const STAY_SIGHT_DAYS = 60;

function daysAgo(days: number): number {
  return Date.now() - days * 86_400_000;
}

function lastActive(user: UserRecord): number {
  const { lastRefreshTime, lastSignInTime, creationTime } = user.metadata;
  const stamp = lastRefreshTime ?? lastSignInTime ?? creationTime;
  return stamp ? Date.parse(stamp) : Date.now();
}

// Reapable SHAPES, both of which mean "never became anybody".
//
// A ticket is truly anonymous — no provider, no address, no number — the state
// of someone who opened a link and left.
//
// A credential with nothing behind it is the other one, and it was leaking:
// mistyping an address on the returning door mints a real account via
// `signInWithEmailLink`, and an email excluded it from collection forever. What
// makes it safe to reap is the same thing that makes a ticket safe — the edge
// checks below, which refuse to delete anyone holding a profile or anything
// social. Someone who signed in and never typed a name has, by construction,
// participated in nothing.
function isCollectable(user: UserRecord): boolean {
  if (user.providerData.length === 0) {
    return !user.email && !user.phoneNumber;
  }
  return true;
}

// An edge only counts while it is CURRENT. Bookings are never deleted, so
// counting cancelled and finished ones would make one stay from years ago keep
// an abandoned account alive for good.
async function hasCurrentEdges(uid: string): Promise<boolean> {
  const db = getFirestore();
  const cutoff = new Date(daysAgo(STAY_SIGHT_DAYS)).toISOString().slice(0, 10);

  const checks: Promise<boolean>[] = [
    // As guest and as host: a booking outlives the listing it points at.
    //
    // ONE equality filter, then the rest in memory. Adding `status` and `end` to
    // the query would need a composite index — `firestore.indexes.json` is empty
    // by design and nothing here deploys one, so the query would fail at runtime
    // and this would silently never delete anybody. A candidate has been idle a
    // month and holds few bookings, so reading them is cheaper than the index.
    ...(["guestId", "ownerId"] as const).map(async (field) => {
      const snap = await db.collection("bookings").where(field, "==", uid).get();
      return snap.docs.some((entry) => {
        const booking = entry.data();
        return (
          (booking.status === "REQUESTED" || booking.status === "CONFIRMED") &&
          typeof booking.end === "string" &&
          booking.end >= cutoff
        );
      });
    }),
    ...(["from", "to"] as const).map(async (field) => {
      const snap = await db
        .collection("connectRequests")
        .where(field, "==", uid)
        .limit(1)
        .get();
      return !snap.empty;
    }),
    (async () => {
      const snap = await db
        .collection("listings")
        .where("ownerId", "==", uid)
        .limit(1)
        .get();
      return !snap.empty;
    })(),
    (async () => {
      const snap = await db
        .collection("portals")
        .where("ownerId", "==", uid)
        .limit(1)
        .get();
      return !snap.empty;
    })(),
    (async () => {
      const snap = await db
        .collection("users")
        .doc(uid)
        .collection("friends")
        .limit(1)
        .get();
      return !snap.empty;
    })(),
    // A profile means someone typed their name, which is the act of becoming a
    // participant. It also cannot be cleaned up from here — this deletes Auth
    // accounts, not documents — so reaping past it would strand a profile,
    // prefs and saved searches under a uid nobody can ever authenticate as.
    (async () => (await db.collection("users").doc(uid).get()).exists)(),
  ];

  return (await Promise.all(checks)).some(Boolean);
}

export type ReapReport = {
  scanned: number;
  candidates: number;
  deleted: readonly string[];
  kept: number;
  errors: number;
};

// `dryRun` logs what it would delete and touches nothing. At 30 days the very
// first run already has real candidates, so a rehearsal is something the caller
// has to ask for — see REAP_DRY_RUN in index.ts.
export async function reapTickets(dryRun: boolean): Promise<ReapReport> {
  const auth = getAuth();
  const report = { scanned: 0, candidates: 0, kept: 0, errors: 0 };
  const doomed: string[] = [];
  let pageToken: string | undefined;

  do {
    const page = await auth.listUsers(1000, pageToken);
    pageToken = page.pageToken;

    for (const user of page.users) {
      report.scanned += 1;
      if (doomed.length >= MAX_PER_RUN) continue;
      if (!isCollectable(user)) continue;
      if (lastActive(user) > daysAgo(REAP_AFTER_DAYS)) continue;
      report.candidates += 1;

      try {
        if (await hasCurrentEdges(user.uid)) {
          report.kept += 1;
          continue;
        }
      } catch (error) {
        // A check that could not answer is not a licence to delete.
        report.errors += 1;
        report.kept += 1;
        logger.warn("reap: check failed, keeping", { uid: user.uid, error });
        continue;
      }
      doomed.push(user.uid);
    }
  } while (pageToken);

  if (!dryRun) {
    // 100, not 1000: `getUsers` caps identifiers at a hundred and THROWS past
    // it, so a re-read sized to `deleteUsers`' limit killed the whole run before
    // a single delete — invisibly, because dry-run skips this block entirely.
    for (let at = 0; at < doomed.length; at += 100) {
      const batch = doomed.slice(at, at + 100);
      // Re-read immediately before deleting. Auth and Firestore share no
      // transaction, so a candidate idle for a month who acts during this run is
      // a race nothing can close — this narrows it to the seconds between.
      const fresh = await auth.getUsers(batch.map((uid) => ({ uid })));
      const stillIdle = fresh.users
        .filter((user) => lastActive(user) <= daysAgo(REAP_AFTER_DAYS))
        .map((user) => user.uid);
      const result = await auth.deleteUsers(stillIdle);
      if (result.failureCount > 0) {
        report.errors += result.failureCount;
        logger.warn("reap: some deletes failed", {
          failures: result.errors.length,
        });
      }
    }
  }

  // The uid of a deleted anonymous account identifies nobody, and it is the only
  // thing that makes a wrong reap investigable at all.
  logger.info("reap", { ...report, deleted: doomed.length, dryRun });
  return { ...report, deleted: doomed };
}
