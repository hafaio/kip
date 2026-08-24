"use client";

import { deleteUser } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { StaleSession } from "./auth";
import { cancelBookingAsGuest } from "./bookings";
import { auth, db, errorCode } from "./firebase";
import { isExpired } from "./format";
import { unfriend } from "./friends";
import { deleteListing } from "./listings";
import { deleteAvatar, deleteListingPhoto } from "./photos";
import type { Booking, Listing } from "./types";

// Leaving, in the order the rules and the other party require.
//
// Client + rules, like everything else user-facing: an Admin-SDK callable that
// dismantled an account on request would be a server-side destructive path
// reachable by a client, which is the shape this schema keeps refusing. Every
// step below is already authorised by a rule that exists.
//
// The order is not cosmetic. Notifications are triggered by the writes in step
// 1, and those triggers read the profile — so the profile must still be there
// when they fire. And it is interruptible by design: a tab closed halfway leaves
// a partly dismantled account that running this again finishes, rather than a
// wedged one.
export async function leaveKip(
  uid: string,
  listings: readonly Listing[],
  trips: readonly Booking[],
  incoming: readonly Booking[],
  friendUids: readonly string[],
): Promise<void> {
  // 1. Tell everyone who is relying on you, while your profile still exists for
  //    the notification triggers to read. Only what is still ahead: a stay that
  //    already happened is a record for both parties, and "cancelled" is the
  //    wrong word for a visit that took place.
  const live = (booking: Booking): boolean =>
    booking.status !== "CANCELLED" && !isExpired(booking.end);

  for (const trip of trips.filter(live)) {
    await cancelBookingAsGuest(trip);
  }
  for (const listing of listings) {
    // Before the document, because `deleteListing` removes only documents and a
    // Storage object outlives its listing — still serving on its download URL,
    // with nobody left who is allowed to delete it.
    for (const photo of listing.photos) {
      await deleteListingPhoto(listing.ownerId, listing.id, photo.id).catch(
        (error) => console.error("leave: photo", error),
      );
    }
    await deleteListing(
      listing,
      incoming.filter(
        (booking) => booking.listingId === listing.id && live(booking),
      ),
    );
  }

  // 2. Unfriend from your side. Both edges go, so nobody is left with a row that
  //    renders a name and never answers.
  for (const friendUid of friendUids) {
    await unfriend(uid, friendUid);
  }

  // 3. Requests in either direction — the delete rule allows both parties. An
  //    outbound one left behind is worse than a ghost: the recipient could still
  //    ACCEPT it, manufacturing a friendship with an account nobody holds.
  for (const field of ["from", "to"] as const) {
    const snap = await getDocs(
      query(collection(db(), "connectRequests"), where(field, "==", uid)),
    );
    await Promise.all(snap.docs.map((entry) => deleteDoc(entry.ref)));
  }

  // 4. The profile link, which is the last thing still granting anything. It is
  //    read from prefs by id, NOT queried: `portals` is `allow list: if false`,
  //    so a query by owner is refused whoever asks — being non-enumerable is the
  //    point of a capability URL. Listing- and slot-scope links went with their
  //    listings in step 1. Grants go inert the moment the portal doc does, so
  //    they need no sweep.
  const prefsRef = doc(db(), "users", uid, "settings", "prefs");
  const prefs = await getDoc(prefsRef).catch(() => null);
  const profilePortalId = prefs?.data()?.profilePortalId ?? null;
  if (profilePortalId) {
    await deleteDoc(doc(db(), "portals", profilePortalId)).catch(
      () => undefined,
    );
  }
  await deleteDoc(prefsRef).catch(() => undefined);

  // 4b. The avatar, for the same reason as the listing photos: `avatars/{uid}`
  //     is owner-only in Storage, so once the account is gone nobody alive can
  //     delete it. A photo of a person outliving them by accident is the one
  //     leftover this teardown exists to prevent.
  await deleteAvatar(uid);

  // 4c. The subcollections, because deleting a parent document does NOT delete
  //     what hangs off it — and after step 6 nobody can ever authenticate as
  //     the owner to clear them. `reap.ts` refuses to reap past a profile on
  //     exactly this reasoning; leaving them here would have the two halves of
  //     the schema disagreeing.
  for (const sub of ["searches", "knownBy"] as const) {
    const snap = await getDocs(collection(db(), "users", uid, sub)).catch(
      () => null,
    );
    if (snap) {
      await Promise.all(snap.docs.map((entry) => deleteDoc(entry.ref)));
    }
  }

  // 5. The profile itself, last among documents, so every pinned check that
  //    reads it kept working through the steps above.
  await deleteDoc(doc(db(), "users", uid));

  // 6. The account. Client-side, no Admin SDK. If the tab dies before this, what
  //    is left is an account owning nothing — exactly a ticket, which the reaper
  //    collects.
  const current = auth().currentUser;
  if (!current) return;
  try {
    await deleteUser(current);
  } catch (error) {
    // Firebase refuses to delete an account whose session isn't recent. By now
    // everything social is already gone, so the honest thing is to say what is
    // left rather than to pretend it failed: what remains is an account owning
    // nothing, which is exactly a ticket, and the reaper collects it.
    if (errorCode(error) === "auth/requires-recent-login") {
      throw new StaleSession();
    }
    throw error;
  }
}
