import { getAuth } from "firebase-admin/auth";
import {
  type DocumentData,
  type DocumentReference,
  getFirestore,
} from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { logger } from "firebase-functions/v2";
import { cancellationFor } from "./leaving";

// Dismantling an account, with the Admin SDK, on a retry budget.
//
// This used to run in the browser as a serial chain of writes, and the profile
// was deleted near the END of it — so a tab closed during the slow early phases
// left an account with a profile, friends and places, whose owner's stays were
// already cancelled. The reaper collects only accounts with NOTHING attached, so
// it skipped exactly that account forever. A trigger finishes without the
// person's participation, which is the whole reason this moved.
//
// The phases are the same steps in the same order, and the order is not
// cosmetic: the writes in `stays` and `friends` fire the notification triggers,
// and those read the leaver's profile to build their messages, so the profile
// has to outlive them. Being admin removes one constraint the browser had —
// nothing here is checked by rules — but it removes none of the ordering.
export const DELETION_PHASES = [
  "stays",
  "places",
  "friends",
  "profile",
  "account",
] as const;

export type DeletionPhase = (typeof DELETION_PHASES)[number];

// Firestore caps a batch at 500 writes.
const BATCH_LIMIT = 400;

// The notification triggers our own writes just fired run CONCURRENTLY with
// this, and each reads the leaver's profile for a name. Ordering alone was
// enough when a browser took a round trip per step; a server takes the same
// walk in under a second, which is a race the client version never had to be
// this careful about. Costs a few seconds of a function nobody is waiting on,
// and the worst case if it is still too short is an email that says "Someone".
const NOTIFY_SETTLE_MS = 5000;

function db() {
  return getFirestore();
}

// UTC, matching `isExpired` on the web side — a stay is live through its last
// day, and getting that boundary wrong cancels a visit someone is on.
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function deleteAll(refs: readonly DocumentReference[]): Promise<void> {
  for (let at = 0; at < refs.length; at += BATCH_LIMIT) {
    const batch = db().batch();
    for (const ref of refs.slice(at, at + BATCH_LIMIT)) batch.delete(ref);
    await batch.commit();
  }
}

// Objects outlive the documents that point at them, and after this nobody is
// left who may delete one — so a leaked photo of someone's home is permanent.
// Still not allowed to block: every object here is named by uid, so a later
// sweep can always finish the job, while a bucket that is refusing us would
// otherwise strand a person who asked to leave. Logged loudly for that reason.
async function sweepStorage(
  uid: string,
  what: string,
  remove: () => Promise<unknown>,
): Promise<void> {
  try {
    await remove();
  } catch (error) {
    logger.error("teardown: storage sweep failed", { uid, what, error });
  }
}

// Both directions in one pass. Only what is still AHEAD: a stay that already
// happened is a record for both parties, and "cancelled" is the wrong word for
// a visit that took place.
async function cancelStays(uid: string): Promise<void> {
  const [asGuest, asHost] = await Promise.all([
    db().collection("bookings").where("guestId", "==", uid).get(),
    db().collection("bookings").where("ownerId", "==", uid).get(),
  ]);
  const bookings = new Map<string, DocumentData>();
  for (const snap of [...asGuest.docs, ...asHost.docs]) {
    bookings.set(snap.id, snap.data());
  }

  const cutoff = today();
  for (const [bookingId, booking] of bookings) {
    const decided = cancellationFor(booking, uid, cutoff);
    if (!decided) continue;
    const { releasesSlot, ...update } = decided;

    const bookingRef = db().doc(`bookings/${bookingId}`);
    const slot = releasesSlot
      ? db().doc(`listings/${booking.listingId}/windows/${booking.windowId}`)
      : null;

    const batch = db().batch();
    batch.update(bookingRef, update);
    if (slot) batch.update(slot, { status: "OPEN", bookingId: null });
    try {
      await batch.commit();
    } catch (error) {
      // The slot may be gone already — a host can delete one out from under a
      // stay — and `update` on a missing document fails the whole batch. The
      // booking still has to be cancelled, and there is then nothing to release.
      if (!slot || (error as { code?: number }).code !== 5) throw error;
      await bookingRef.update(update);
    }
  }

  await dropPointers(uid, bookings);
}

// A stay plants two pointers at the leaver that live in OTHER people's data: a
// `knownBy` note under the other party, letting them read this profile, and a
// guest marker under the listing. Both are keyed BY the uid rather than
// referring to one, so there is nothing to rewrite and no sentinel to invent —
// they are simply deletable, and at paths every booking above already names.
//
// EVERY booking, not the ones just cancelled: a stay that already happened, or
// was called off years ago, planted its pointers exactly the same way, and the
// cancel loop deliberately skips both. They are inert either way — each is
// re-read against a booking that no longer permits anything — so this is litter
// rather than exposure, but the privacy page says leaving deletes your data.
//
// Retry-safe by construction: bookings are terminal and nothing here deletes
// one, so a second attempt re-derives the identical set, and deleting a
// document that has already gone is a no-op.
async function dropPointers(
  uid: string,
  bookings: Map<string, DocumentData>,
): Promise<void> {
  // By path: two stays with the same host name the same `knownBy` document, and
  // a batch refuses the same reference twice.
  const refs = new Map<string, DocumentReference>();
  for (const booking of bookings.values()) {
    const other = booking.guestId === uid ? booking.ownerId : booking.guestId;
    if (other) refs.set(`k:${other}`, db().doc(`users/${other}/knownBy/${uid}`));
    if (booking.guestId === uid && booking.listingId) {
      refs.set(
        `g:${booking.listingId}`,
        db().doc(`listings/${booking.listingId}/guests/${uid}`),
      );
    }
  }
  await deleteAll([...refs.values()]);
}

// Photos first: `deleteFiles` is keyed on the owner's uid, not on any document,
// so it needs nothing that the deletes below take away — but a listing deleted
// with its objects still there is the leftover nobody can clear.
async function removePlaces(uid: string): Promise<void> {
  await sweepStorage(uid, "photos", () =>
    getStorage()
      .bucket()
      .deleteFiles({ prefix: `listings/${uid}/` }),
  );

  const listings = await db()
    .collection("listings")
    .where("ownerId", "==", uid)
    .get();
  const refs: DocumentReference[] = [];
  for (const listing of listings.docs) {
    // Deleting a document does not delete what hangs off it, and after this
    // nobody can reach these paths at all.
    const [windows, guests] = await Promise.all([
      listing.ref.collection("windows").get(),
      listing.ref.collection("guests").get(),
    ]);
    refs.push(...windows.docs.map((entry) => entry.ref));
    refs.push(...guests.docs.map((entry) => entry.ref));
    refs.push(listing.ref);
  }
  await deleteAll(refs);
}

// Friend edges BEFORE requests: `onConnectAnswered` fires on a request being
// deleted and tells a yes from a no by whether the edge now exists, so an edge
// still standing would report every withdrawal as an acceptance.
async function removeConnections(uid: string): Promise<void> {
  const friends = await db()
    .collection("users")
    .doc(uid)
    .collection("friends")
    .get();
  // Both sides. A one-sided delete leaves a row that renders a name and never
  // answers.
  await deleteAll(
    friends.docs.flatMap((edge) => [
      edge.ref,
      db().doc(`users/${edge.id}/friends/${uid}`),
    ]),
  );

  const [sent, received] = await Promise.all([
    db().collection("connectRequests").where("from", "==", uid).get(),
    db().collection("connectRequests").where("to", "==", uid).get(),
  ]);
  // An outbound one left behind is worse than a ghost: the recipient could still
  // accept it, manufacturing a friendship with an account nobody holds.
  await deleteAll(
    [...sent.docs, ...received.docs].map((entry) => entry.ref),
  );
}

// Every portal in one query, which the browser could not do: `portals` is
// `allow list: if false`, so the client had to read the one id it had stored and
// take the rest on trust from having deleted them alongside their listings.
async function removeProfile(uid: string): Promise<void> {
  const portals = await db()
    .collection("portals")
    .where("ownerId", "==", uid)
    .get();
  // The grants first, and this is the mirror of the pointers above: deleting a
  // document does not delete what hangs off it, so a link removed on the way out
  // left its visitors' uids behind inside the leaver's own data. Same trap
  // `removePlaces` already avoids for a listing's windows and guests.
  for (const portal of portals.docs) {
    const grants = await portal.ref.collection("grants").get();
    await deleteAll(grants.docs.map((entry) => entry.ref));
  }
  await deleteAll(portals.docs.map((entry) => entry.ref));

  // The exact object, not a prefix: one uid can be the start of another.
  await sweepStorage(uid, "avatar", () =>
    getStorage()
      .bucket()
      .file(`avatars/${uid}`)
      .delete({ ignoreNotFound: true }),
  );

  for (const sub of ["settings", "searches", "knownBy", "friends"]) {
    const docs = await db().collection("users").doc(uid).collection(sub).get();
    await deleteAll(docs.docs.map((entry) => entry.ref));
  }
  await db().collection("users").doc(uid).delete();
}

async function removeAccount(uid: string): Promise<void> {
  try {
    await getAuth().deleteUser(uid);
  } catch (error) {
    // Already gone, from an attempt that died after this step.
    if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
  }
}

// Named the phase it is ENTERING, so a teardown that stalls says where. Nothing
// else can see inside this — the person watching holds one document, and it is
// the only progress there is to draw.
async function report(uid: string, phase: DeletionPhase): Promise<void> {
  await db().doc(`deletions/${uid}`).set({ phase }, { merge: true });
}

// Every step is a no-op on what is already gone, because retries mean this runs
// again over a partly dismantled account: a cancelled booking is skipped, a
// missing document deletes cleanly, and a deleted Auth account answers
// `user-not-found`.
export async function tearDownAccount(uid: string): Promise<void> {
  await report(uid, "stays");
  await cancelStays(uid);

  await report(uid, "places");
  await removePlaces(uid);

  await report(uid, "friends");
  await removeConnections(uid);

  await new Promise((resume) => setTimeout(resume, NOTIFY_SETTLE_MS));

  await report(uid, "profile");
  await removeProfile(uid);

  await report(uid, "account");
  await removeAccount(uid);

  // Last, and the only completion signal there is: the app watches for this
  // document to vanish, and its session dies with the account above.
  await db().doc(`deletions/${uid}`).delete();
}
