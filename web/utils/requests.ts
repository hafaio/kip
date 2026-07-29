"use client";

import {
  collection,
  type DocumentData,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  type QueryDocumentSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  where,
  writeBatch,
} from "firebase/firestore";
import { db, onSnapshotError } from "./firebase";
import type { Booking, ConnectRequest, Party, Portal, Profile } from "./types";

function epoch(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : 0;
}

export function toConnectRequest(
  snap: QueryDocumentSnapshot<DocumentData>,
): ConnectRequest {
  const data = snap.data();
  return {
    id: snap.id,
    from: data.from,
    to: data.to,
    fromName: data.fromName ?? "",
    fromUsername: data.fromUsername ?? "",
    fromPhotoURL: data.fromPhotoURL ?? null,
    toName: data.toName ?? "",
    toUsername: data.toUsername ?? "",
    toPhotoURL: data.toPhotoURL ?? null,
    portalId: data.portalId ?? null,
    createdAt: epoch(data.createdAt),
  };
}

// Someone asking you for something, and your answer. ONE collection covers every
// route in, because they only ever differed in how the rules authorise them,
// never in shape:
//
//   by handle     the recipient is `searchable`
//   by share link the sender names a live link of yours (`portalId`)
//   by stay       the sender names a confirmed booking of yours (`bookingId`)
//
// Doc id is `${from}_${to}`: deterministic, so the rule letting the accepter write
// into the sender's friends list can find it, and re-asking overwrites instead of
// piling up.
//
// Every route knows who it is addressing, and says so in `toName`/`toPhotoURL` —
// only the first also has a handle to record. Without it a pending ask names
// nobody, since the recipient is by construction someone the sender usually can't
// read: not searchable, not yet a friend.
//
// The `to*` copies are deliberately NOT pinned by the rules, unlike the `from*`
// ones sitting beside them in every literal below. Those are pinned because the
// RECIPIENT can't check them and they go into a notification email — a free
// `fromName` is an invitation from "Chase Fraud Alert". A `to*` copy is the
// sender's own note of who they asked, rendered only in the sender's own pending
// list, on a document only the two parties can read. There is nobody to mislead.

export function watchIncomingConnectRequests(
  uid: string,
  onChange: (requests: ConnectRequest[]) => void,
): () => void {
  return onSnapshot(
    query(collection(db(), "connectRequests"), where("to", "==", uid)),
    (snap) => onChange(snap.docs.map(toConnectRequest)),
    onSnapshotError("incomingConnectRequests"),
  );
}

export function watchOutgoingConnectRequests(
  uid: string,
  onChange: (requests: ConnectRequest[]) => void,
): () => void {
  return onSnapshot(
    query(collection(db(), "connectRequests"), where("from", "==", uid)),
    (snap) => onChange(snap.docs.map(toConnectRequest)),
    onSnapshotError("outgoingConnectRequests"),
  );
}

// The caller's own pending request with someone, if any — so the share-link page
// can still show "sent" after a reload. The read rule names `resource.data`, and
// a document that isn't there has none, so "no pending request" arrives as a
// permission-denied rather than an empty snapshot; both mean the same thing here.
export async function fetchMyConnectRequest(
  fromUid: string,
  toUid: string,
): Promise<ConnectRequest | null> {
  const snap = await getDoc(
    doc(db(), "connectRequests", `${fromUid}_${toUid}`),
  ).catch((error) => {
    if (error?.code !== "permission-denied") throw error;
    return null;
  });
  if (!snap?.exists()) return null;
  return toConnectRequest(snap as QueryDocumentSnapshot);
}

// Ask someone found by their handle to be friends.
export async function sendRequest(me: Profile, target: Profile): Promise<void> {
  await setDoc(doc(db(), "connectRequests", `${me.uid}_${target.uid}`), {
    from: me.uid,
    to: target.uid,
    fromName: me.displayName,
    fromUsername: me.username,
    fromPhotoURL: me.photoURL,
    toName: target.displayName,
    toUsername: target.username,
    toPhotoURL: target.photoURL,
    portalId: null,
    createdAt: serverTimestamp(),
  });
}

// Reach out through a share link to connect. `portalId` both authorises the write
// (the rule checks the link is live and belongs to the recipient) and marks the
// request as having arrived that way.
export async function sendPortalConnectRequest(
  portal: Portal,
  sender: Party,
): Promise<void> {
  await setDoc(
    doc(db(), "connectRequests", `${sender.uid}_${portal.ownerId}`),
    {
      from: sender.uid,
      to: portal.ownerId,
      fromName: sender.displayName,
      fromUsername: sender.username,
      fromPhotoURL: sender.photoURL,
      // The link already carries whose it is — it's what the share page renders.
      toName: portal.ownerName,
      toUsername: "",
      toPhotoURL: portal.ownerPhotoURL,
      portalId: portal.id,
      createdAt: serverTimestamp(),
    },
  );
}

// Ask the other party of a stay you shared to be friends. Neither of the routes
// above can serve this pair when they met through a share link — the guest isn't
// searchable and the host holds no link of theirs — yet they're the one pair who
// demonstrably know each other. `bookingId` is what the rule reads: it must name
// a CONFIRMED stay whose host and guest are exactly these two, in either order,
// which is why the recipient is derived from the booking rather than passed in.
// How they're NAMED does have to be passed: the booking says who they are and
// nothing about them, and the caller has already read their profile through the
// very stay that authorises this.
export async function sendBookingConnectRequest(
  me: Party,
  booking: Booking,
  target: { displayName: string; photoURL: string | null },
): Promise<void> {
  const hosting = booking.ownerId === me.uid;
  const to = hosting ? booking.guestId : booking.ownerId;
  await setDoc(doc(db(), "connectRequests", `${me.uid}_${to}`), {
    from: me.uid,
    to,
    fromName: me.displayName,
    fromUsername: me.username,
    fromPhotoURL: me.photoURL,
    toName: target.displayName,
    // Left blank: a handle is optional, and this copy is only the sender's own
    // note of who they asked.
    toUsername: "",
    toPhotoURL: target.photoURL,
    portalId: null,
    bookingId: booking.id,
    createdAt: serverTimestamp(),
  });
}

// Accept: both friend edges and the request cleared, in one batch so there's no
// half-formed friendship. Names come off the REQUEST — at this moment the two
// parties still can't read each other's profiles.
export async function acceptRequest(
  me: Party,
  request: ConnectRequest,
): Promise<void> {
  const batch = writeBatch(db());
  batch.set(doc(db(), "users", me.uid, "friends", request.from), {
    username: request.fromUsername,
    displayName: request.fromName,
    photoURL: request.fromPhotoURL,
    since: serverTimestamp(),
  });
  batch.set(doc(db(), "users", request.from, "friends", me.uid), {
    username: me.username,
    displayName: me.displayName,
    photoURL: me.photoURL,
    since: serverTimestamp(),
  });
  batch.delete(doc(db(), "connectRequests", request.id));
  await batch.commit();
}

// Decline (recipient) or withdraw (sender) — the same delete either way.
export async function declineRequest(request: ConnectRequest): Promise<void> {
  await deleteDoc(doc(db(), "connectRequests", request.id));
}
