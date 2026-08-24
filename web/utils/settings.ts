"use client";

import {
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  Timestamp,
} from "firebase/firestore";
import { db, onSnapshotError } from "./firebase";
import {
  DEFAULT_NOTIFY,
  DEFAULT_NOTIFY_SMS,
  DEFAULT_PREFS,
  type NotifySmsPrefs,
  type Prefs,
} from "./types";

function epoch(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

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
              notifySms: { ...DEFAULT_NOTIFY_SMS, ...(data.notifySms ?? {}) },
              smsConsentAt: epoch(data.smsConsentAt),
              smsConsentVersion: data.smsConsentVersion ?? null,
              smsConsentNumber: data.smsConsentNumber ?? null,
              // Written by the sender, never by this client.
              smsStopped: data.smsStopped === true,
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

// One switch governs every SMS kind, so the map is written whole rather than a
// key at a time. Consent rides the same write it is given in — the disclosures
// and the switch are one act — and is left standing when texts go off again: it
// records what was agreed and when, which turning them off doesn't unsay.
//
// The NUMBER is part of that record, because consent is to being texted at a
// particular phone. Without it, removing a number and adding a different one
// later resumed texting on an agreement given about the first — and the switch
// meanwhile read ON over an account with no number at all.
//
// Turning it on also clears the sender's note of a carrier STOP. That note is
// only ever cleared by a send that succeeds, and no send is attempted while
// every kind is off — so a STOP landing in the moment someone switched texts off
// left a flag nothing could reach. The next refused send writes it back, which
// makes this an assertion the sender checks rather than one it takes on trust.
export async function setSmsNotify(
  uid: string,
  on: boolean,
  version: string,
  number: string,
): Promise<void> {
  const notifySms = Object.fromEntries(
    Object.keys(DEFAULT_NOTIFY_SMS).map((kind) => [kind, on]),
  ) as NotifySmsPrefs;
  await setDoc(
    doc(db(), "users", uid, "settings", "prefs"),
    on
      ? {
          notifySms,
          smsConsentAt: serverTimestamp(),
          smsConsentVersion: version,
          smsConsentNumber: number,
          smsStopped: false,
        }
      : { notifySms },
    { merge: true },
  );
}

// Taking the number off the account is the plainest way there is of saying stop
// texting me, so it withdraws the consent rather than leaving a record pointing
// at a phone kip no longer has. Re-adding the same number therefore asks again,
// which is the safe direction to be wrong in.
export async function clearSmsConsent(uid: string): Promise<void> {
  await setDoc(
    doc(db(), "users", uid, "settings", "prefs"),
    {
      notifySms: DEFAULT_NOTIFY_SMS,
      smsConsentAt: null,
      smsConsentVersion: null,
      smsConsentNumber: null,
    },
    { merge: true },
  );
}
