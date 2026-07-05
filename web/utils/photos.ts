"use client";

import {
  deleteObject,
  getDownloadURL,
  ref,
  uploadBytes,
} from "firebase/storage";
import { firebaseConfigured, storage } from "./firebase";

import type { ListingPhoto } from "./types";

// Photos live in Storage at `listings/{ownerId}/{listingId}/{photoId}`, and the
// listing records each one's id AND its download URL. The owner is in the path so
// the Storage rule is `uid == ownerId` and nothing else: readers never go to
// Storage rules at all, they follow the URL. That's forced rather than chosen —
// cross-service rules allow only TWO Firestore lookups per request, spent whether
// a clause matches or not, and reading the listing to learn its owner is already
// one of them, so mirroring the six-way Firestore listing gate here is impossible.
// Firestore expresses it correctly inside its own 20-lookup budget, so the listing
// read is the gate and the URL rides along with it.
export const MAX_PHOTOS = 8;

// Phones produce enormous images and nobody needs them at full size. Resizing in
// the browser keeps the bucket small and the page fast — and re-encoding drops
// EXIF, including the GPS tag, which on a photo of someone's home is not a detail
// to hand out with a share link.
const MAX_EDGE = 1600;
// An avatar is never drawn bigger than the 80px circle on a person's page, so
// 512 covers a 3x screen with room to spare. Stripping EXIF matters more here
// than on a listing: a profile photo is the one people take of themselves, and
// its copies travel further — into friends' lists and share links.
const AVATAR_MAX_EDGE = 512;
const QUALITY = 0.82;

function photoPath(
  ownerId: string,
  listingId: string,
  photoId: string,
): string {
  return `listings/${ownerId}/${listingId}/${photoId}`;
}

// One object per person, overwritten in place — the uid IS the name, so there is
// nothing to record beyond the URL and nothing to clean up when it's replaced.
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
  // Re-encoding can fail on an exotic source format; the original is still a
  // valid upload, just larger, so fall back rather than losing the photo.
  return blob ?? file;
}

// Upload one photo and return what the listing has to record: its id, and the
// URL every reader will render. Only the owner can ask Storage for that URL, and
// they are the only one who ever needs to — it's minted here, once, at the point
// where the object is created.
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

// Upload a profile photo and return the URL to store on the profile. Same bearer
// -capability shape as a listing photo: the object is owner-only, the URL it
// mints is what every other reader follows, and who may see the profile is
// decided once, in Firestore.
export async function uploadAvatar(uid: string, file: Blob): Promise<string> {
  if (!firebaseConfigured()) throw new Error("Firebase isn't configured");
  const object = ref(storage(), avatarPath(uid));
  await uploadBytes(object, await shrink(file, AVATAR_MAX_EDGE));
  return getDownloadURL(object);
}

export async function deleteAvatar(uid: string): Promise<void> {
  if (!firebaseConfigured()) return;
  // Called whenever a photo is dropped, including by someone who only ever wore
  // the one their sign-in provider gave them and so has no object at all.
  await deleteObject(ref(storage(), avatarPath(uid))).catch((error) =>
    console.warn("deleteAvatar", error),
  );
}

const AVATAR_HOST = "https://lh3.googleusercontent.com/";

// The URL to actually render, or null if it isn't from somewhere we trust.
//
// A listing's `photos` is a list of maps, and Firestore rules cannot iterate a
// list — there is no way to pin each URL's origin server-side. So a crafted client
// could write any address into its OWN listing and have friends' browsers fetch
// it: not script (it only ever reaches an `<img src`), but a tracking pixel
// pointed at people who never agreed to it. The check belongs here anyway, since
// the client doing the rendering is the one at risk.
//
// A `photoURL` is the same problem one step further out: it is COPIED into friend
// edges and portals, and each copy is written by the person it
// describes — the friend-edge rule pins the name and handle on it but not the
// photo, so the other party chooses that address outright.
export function photoSrc(url: string): string | null {
  // Google's avatar host is the second trusted origin because a Google account
  // arrives already wearing a photo hosted there, which we copy onto the profile
  // untouched — we never mint that URL, so pinning its origin is the only check
  // there is. It serves images to anyone with the link and reports nothing back
  // to whoever chose it, which is what the check is guarding against.
  const bucket = `https://firebasestorage.googleapis.com/v0/b/${storage().app.options.storageBucket}/o/`;
  return url.startsWith(bucket) || url.startsWith(AVATAR_HOST) ? url : null;
}

export async function deleteListingPhoto(
  ownerId: string,
  listingId: string,
  photoId: string,
): Promise<void> {
  if (!firebaseConfigured()) return;
  // Already gone is the desired end state, and the photo is dropped from the
  // listing either way — a missing object must not block that.
  await deleteObject(
    ref(storage(), photoPath(ownerId, listingId, photoId)),
  ).catch((error) => console.warn("deleteListingPhoto", error));
}
