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

// One collection for all three routes in — they differ only in how the rules
// authorise them, never in shape. Doc id is `${from}_${to}` so the accept rule
// can find it deterministically and re-asking overwrites.
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

// The read rule names `resource.data`, so a missing doc arrives as
// permission-denied rather than an empty snapshot. Both mean "none" here.
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

// `portalId` both authorises the write and marks how the request arrived.
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
      toName: portal.ownerName,
      toUsername: "",
      toPhotoURL: portal.ownerPhotoURL,
      portalId: portal.id,
      createdAt: serverTimestamp(),
    },
  );
}

// The only route open to a share-link guest and their host, who are neither
// searchable to nor linked by each other. The recipient is derived from the
// booking because that's what the rule checks; their name has to be passed,
// since a booking carries none.
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
    toUsername: "",
    toPhotoURL: target.photoURL,
    portalId: null,
    bookingId: booking.id,
    createdAt: serverTimestamp(),
  });
}

// One batch, so a half-formed friendship is never persisted. Names come off the
// request because the two still can't read each other's profiles.
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
