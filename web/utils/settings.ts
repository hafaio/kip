"use client";

import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { db, onSnapshotError } from "./firebase";
import { DEFAULT_NOTIFY, DEFAULT_PREFS, type Prefs } from "./types";

export function watchPrefs(
  uid: string,
  onChange: (prefs: Prefs) => void,
): () => void {
  return onSnapshot(
    doc(db(), "users", uid, "settings", "prefs"),
    (snap) => {
      const data = snap.data();
      onChange(
        data
          ? {
              // A doc written before this field existed carries no consent.
              shareStaysWithFriends: data.shareStaysWithFriends ?? false,
              profilePortalId: data.profilePortalId ?? null,
              notify: { ...DEFAULT_NOTIFY, ...(data.notify ?? {}) },
            }
          : DEFAULT_PREFS,
      );
    },
    onSnapshotError("prefs"),
  );
}

export async function setPrefs(
  uid: string,
  prefs: Partial<Prefs>,
): Promise<void> {
  await setDoc(doc(db(), "users", uid, "settings", "prefs"), prefs, {
    merge: true,
  });
}
