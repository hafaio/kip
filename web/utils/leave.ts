"use client";

import {
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { db, onSnapshotError } from "./firebase";
import {
  DELETION_PHASES,
  type DeletionPhase,
  type DeletionRequest,
} from "./types";

// Leaving is one write, and a Cloud Function does the rest.
//
// It used to be a serial chain of writes from here — cancel every stay, delete
// every place and photo, unfriend both sides, then the profile and the Auth
// account. The profile went near the END of that chain, so a tab closed during
// the slow early phases left an account that still had a profile, friends and
// places, while its owner's stays were already cancelled and their friends had
// watched them vanish. The reaper collects only accounts with NOTHING attached,
// deliberately, so it skipped that account for good: the one thing that finished
// it was the person coming back and pressing the button again.
//
// A trigger retries without them, which is the whole reason this moved.
export async function requestDeletion(uid: string): Promise<void> {
  const ref = doc(db(), "deletions", uid);
  try {
    await setDoc(ref, { requestedAt: serverTimestamp() });
  } catch (error) {
    // The rule allows a create and nothing else, so a second press — a double
    // tap, a second tab, two surfaces each holding their own `leaving` flag —
    // is refused as an update to a request that is already running. That is the
    // answer being asked for and not a failure; reported as one it said
    // "nothing has been deleted" over a teardown halfway through the account.
    if (!(await getDoc(ref)).exists()) throw error;
  }
}

// The one document here a client may remove, and only once the trigger has
// written the error it stops on: while a teardown is still running there is
// nothing to cancel out of, and half a dismantled account is not a state to hand
// anyone back. A cleared request is also how leaving is asked for again — the
// new document is a create, so the attempt budget starts over.
export async function clearDeletion(uid: string): Promise<void> {
  await deleteDoc(doc(db(), "deletions", uid));
}

function toPhase(value: unknown): DeletionPhase | null {
  return DELETION_PHASES.includes(value as DeletionPhase)
    ? (value as DeletionPhase)
    : null;
}

// Absence is the completion signal: the function deletes this last, after the
// Auth account it belongs to. Silence is reported separately from an answer,
// because "no document" means finished and guessing it would sign someone out
// mid-teardown.
export function watchDeletion(
  uid: string,
  onAnswer: (request: DeletionRequest | null) => void,
  onSilence: () => void,
): () => void {
  const log = onSnapshotError("deletion");
  return onSnapshot(
    doc(db(), "deletions", uid),
    (snap) => {
      const data = snap.data();
      onAnswer(
        data
          ? {
              phase: toPhase(data.phase),
              attempts: typeof data.attempts === "number" ? data.attempts : 0,
              failed: typeof data.error === "string",
            }
          : null,
      );
    },
    (error) => {
      log(error);
      onSilence();
    },
  );
}
