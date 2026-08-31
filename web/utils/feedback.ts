"use client";

import type { User } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { type Door, EMAIL_DOOR, GOOGLE_DOOR, PHONE_DOOR } from "./auth";
import { auth, db } from "./firebase";

// The rule caps this, so the form has to as well or the write is simply refused
// and the report is lost along with whatever it was about.
export const MAX_FEEDBACK = 2_000;

// Mirrors `hasCredential()` in firestore.rules, which is what a report is gated
// on. Read from store state rather than off the Auth user: Firebase mutates that
// object in place, so a linked door changes the fields without changing the
// reference and nothing re-renders.
//
// A mirror can drift from the rule it copies. The cost is bounded either way —
// a control that is missing, or one whose write is refused — and the honest
// alternative, asking the server, is a round trip to draw a menu row.
export function credentialed(
  doors: readonly Door[],
  emailVerified: boolean,
): boolean {
  return doors.some(
    ({ providerId }) =>
      providerId === PHONE_DOOR ||
      providerId === GOOGLE_DOOR ||
      (providerId === EMAIL_DOOR && emailVerified),
  );
}

export async function sendFeedback(text: string): Promise<void> {
  const uid = auth().currentUser?.uid;
  if (!uid) throw new Error("not signed in");
  await addDoc(collection(db(), "feedback"), {
    uid,
    text: text.trim().slice(0, MAX_FEEDBACK),
    at: serverTimestamp(),
  });
}

// One page of them. There is no paging control: the operator clears what they
// have dealt with, so a list that needs paging is a backlog, not a UI problem.
const PAGE = 100;

export type Report = {
  readonly id: string;
  readonly uid: string;
  readonly text: string;
  readonly at: number;
};

// Whether this account operates kip, read off the token it already holds — no
// round trip, and the same claim `firestore.rules` reads, so the app and the
// rules cannot disagree about who is one.
//
// It follows a token REFRESH, not a reload: a granted claim reaches a live
// session at the next refresh (hourly), so the way to see it now is to sign out
// and back in, which mints a fresh one. `scripts/admin.ts` says so.
export async function readAdmin(user: User): Promise<boolean> {
  try {
    return (await user.getIdTokenResult()).claims.admin === true;
  } catch (error) {
    console.warn("admin", error);
    return false;
  }
}

// Fetched, not watched: nothing else writes while it is open except the
// operator's own deletes, which are applied locally.
export async function fetchFeedback(): Promise<readonly Report[]> {
  const found = await getDocs(
    query(collection(db(), "feedback"), orderBy("at", "desc"), limit(PAGE)),
  );
  return found.docs.map((report) => {
    const data = report.data();
    return {
      id: report.id,
      uid: String(data.uid ?? ""),
      // A server timestamp is null for the instant between the local write and
      // the round trip, which is not a moment this list is ever read in — but
      // sorting on NaN would scatter the list rather than fail visibly.
      at: data.at?.toMillis?.() ?? 0,
      text: String(data.text ?? ""),
    };
  });
}

export async function deleteFeedback(id: string): Promise<void> {
  await deleteDoc(doc(db(), "feedback", id));
}

// Is there anything the operator hasn't looked at? One document at most, because
// the answer is a dot rather than a number — asking for a count would read the
// whole collection to draw one pixel.
//
// `seenAt` of null means the inbox has never been opened, so everything counts.
export async function hasUnreadFeedback(
  seenAt: number | null,
): Promise<boolean> {
  try {
    const since = query(
      collection(db(), "feedback"),
      ...(seenAt === null ? [] : [where("at", ">", new Date(seenAt))]),
      orderBy("at", "desc"),
      limit(1),
    );
    return !(await getDocs(since)).empty;
  } catch (error) {
    // A non-admin is refused, which is the same answer as nothing to see.
    console.warn("unread", error);
    return false;
  }
}

// Written with the SERVER's clock, because it is compared against `at`, which is
// also the server's — a client reading would drift against it, marking reports
// unread forever on a slow clock and read before they arrived on a fast one.
// Merged straight in rather than through `setPrefs`, whose `Prefs` type says
// this is a number, which is what it is by the time anything reads it back.
export async function markFeedbackSeen(uid: string): Promise<void> {
  await setDoc(
    doc(db(), "users", uid, "settings", "prefs"),
    { feedbackSeenAt: serverTimestamp() },
    { merge: true },
  );
}
