"use client";

import {
  deleteObject,
  getDownloadURL,
  ref,
  uploadBytes,
} from "firebase/storage";
import { firebaseConfigured, storage } from "./firebase";

import type { ListingPhoto } from "./types";

// Readers never reach Storage rules — they follow the URL — because cross-service
// rules allow only two Firestore lookups per request, which can't express the
// six-way listing gate. The Firestore listing read is the gate instead.
export const MAX_PHOTOS = 8;

// Re-encoding also drops EXIF, and a GPS tag on a photo of someone's home is not
// something to hand out with a share link.
const MAX_EDGE = 1600;
const AVATAR_MAX_EDGE = 512;
const QUALITY = 0.82;

function photoPath(
  ownerId: string,
  listingId: string,
  photoId: string,
): string {
  return `listings/${ownerId}/${listingId}/${photoId}`;
}

// The uid is the name, so replacing one leaves nothing to clean up.
function avatarPath(uid: string): string {
  return `avatars/${uid}`;
}

async function shrink(file: Blob, maxEdge: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return file;
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", QUALITY),
  );
  return blob ?? file; // exotic source formats can fail to re-encode
}

// The URL is minted once, here, because only the owner may ask Storage for it.
export async function uploadListingPhoto(
  ownerId: string,
  listingId: string,
  file: Blob,
): Promise<ListingPhoto> {
  if (!firebaseConfigured()) throw new Error("Firebase isn't configured");
  const id = crypto.randomUUID();
  const object = ref(storage(), photoPath(ownerId, listingId, id));
  await uploadBytes(object, await shrink(file, MAX_EDGE));
  return { id, url: await getDownloadURL(object) };
}

export async function uploadAvatar(uid: string, file: Blob): Promise<string> {
  if (!firebaseConfigured()) throw new Error("Firebase isn't configured");
  const object = ref(storage(), avatarPath(uid));
  await uploadBytes(object, await shrink(file, AVATAR_MAX_EDGE));
  return getDownloadURL(object);
}

export async function deleteAvatar(uid: string): Promise<void> {
  if (!firebaseConfigured()) return;
  // Someone wearing only their provider's photo has no object to delete.
  await deleteObject(ref(storage(), avatarPath(uid))).catch((error) =>
    console.warn("deleteAvatar", error),
  );
}

const AVATAR_HOST = "https://lh3.googleusercontent.com/";

// Rules can't iterate a list, so a listing's photo URLs can't be pinned to an
// origin server-side — a crafted client could point friends' browsers at a
// tracking pixel. The renderer is the one at risk, so the check belongs here.
// Google's host is trusted because a Google account arrives wearing a photo we
// copy untouched and never mint a URL for.
export function photoSrc(url: string): string | null {
  const bucket = `https://firebasestorage.googleapis.com/v0/b/${storage().app.options.storageBucket}/o/`;
  return url.startsWith(bucket) || url.startsWith(AVATAR_HOST) ? url : null;
}

export async function deleteListingPhoto(
  ownerId: string,
  listingId: string,
  photoId: string,
): Promise<void> {
  if (!firebaseConfigured()) return;
  // Already gone is the desired end state; the listing drops it either way.
  await deleteObject(
    ref(storage(), photoPath(ownerId, listingId, photoId)),
  ).catch((error) => console.warn("deleteListingPhoto", error));
}
