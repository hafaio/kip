"use client";

import {
  arrayUnion,
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
  type NotifySmsKind,
  type NotifySmsPrefs,
  type Prefs,
} from "./types";

function epoch(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

// The probe stamps are plain clock readings, not server timestamps: the client
// picks the value and the trigger writes the SAME one back, so "still checking"
// is one comparison and needs no clock agreement between the two. Reading them
// through `epoch` returned null for every one of them, which left the spinner
// unable to persist and the "still blocked" line unable to render at all —
// the one message that stops the button looking like it did nothing.
function millis(value: unknown): number | null {
  return typeof value === "number" ? value : epoch(value);
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
              feedbackSeenAt: millis(data.feedbackSeenAt) || null,
              profilePortalId: data.profilePortalId ?? null,
              notify: { ...DEFAULT_NOTIFY, ...(data.notify ?? {}) },
              notifySms: { ...DEFAULT_NOTIFY_SMS, ...(data.notifySms ?? {}) },
              smsConsentAt: epoch(data.smsConsentAt),
              smsConsentVersion: data.smsConsentVersion ?? null,
              smsConsentNumber: data.smsConsentNumber ?? null,
              // Set only by the sender. A client may CLEAR it — turning texts
              // on does — but the rules refuse a client write that sets it,
              // which is what keeps the check below from being a way to spend.
              smsStopped: data.smsStopped === true,
              smsProbeAt: millis(data.smsProbeAt),
              smsProbeDoneAt: millis(data.smsProbeDoneAt),
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

// What was agreed, when, and for which phone.
export type SmsConsent = {
  readonly at: number;
  readonly version: string;
  readonly number: string;
};

// The consent on record, or null where there isn't one. Also what tells someone
// changing numbers from someone who has never wanted texts, which is why the
// record outlives the number it names.
export function standingConsent(prefs: Prefs): SmsConsent | null {
  return prefs.smsConsentAt !== null &&
    prefs.smsConsentVersion !== null &&
    prefs.smsConsentNumber !== null
    ? {
        at: prefs.smsConsentAt,
        version: prefs.smsConsentVersion,
        number: prefs.smsConsentNumber,
      }
    : null;
}

// One switch governs every SMS kind, so the map is written whole rather than a
// key at a time. Consent rides the same write it is given in — the disclosures
// and the switch are one act.
//
// The NUMBER is part of that record, because consent is to being texted at a
// particular phone. Without it, removing a number and adding a different one
// later resumed texting on an agreement given about the first — and the switch
// meanwhile read ON over an account with no number at all.
//
// A record this replaces is kept in `smsConsentLog` when it named another phone
// or agreed to other wording, which is the least that leaves texts ALREADY SENT
// explainable — the point of holding a record at all. Re-agreeing to the same
// terms supersedes nothing, so nothing is logged.
//
// Turning it on also clears the sender's note of a carrier STOP. That note is
// only ever cleared by a send that succeeds, and no send is attempted while
// every kind is off — so a STOP landing in the moment someone switched texts off
// left a flag nothing could reach. The next refused send writes it back, which
// makes this an assertion the sender checks rather than one it takes on trust.
export async function giveSmsConsent(
  uid: string,
  version: string,
  number: string,
  superseded: SmsConsent | null,
): Promise<void> {
  const notifySms = Object.fromEntries(
    Object.keys(DEFAULT_NOTIFY_SMS).map((kind) => [kind, true]),
  ) as NotifySmsPrefs;
  const stale =
    superseded !== null &&
    (superseded.number !== number || superseded.version !== version);
  await setDoc(
    doc(db(), "users", uid, "settings", "prefs"),
    {
      notifySms,
      smsConsentAt: serverTimestamp(),
      smsConsentVersion: version,
      smsConsentNumber: number,
      smsStopped: false,
      ...(stale
        ? {
            smsConsentLog: arrayUnion({
              at: Timestamp.fromMillis(superseded.at),
              version: superseded.version,
              number: superseded.number,
            }),
          }
        : {}),
    },
    { merge: true },
  );
}

// Stopping is only ever the map. The consent record says what was agreed and
// when, which turning texts off doesn't unsay — and the sender needs no help
// from it stopping, since it already refuses a kind nobody has switched on.
export async function stopTexts(uid: string): Promise<void> {
  await setDoc(
    doc(db(), "users", uid, "settings", "prefs"),
    { notifySms: DEFAULT_NOTIFY_SMS },
    { merge: true },
  );
}

// One kind at a time, once the consent above has been given. It writes no
// consent of its own and clears no STOP: those are the master switch's, and a
// row here can only narrow what it turned on.
// Asks the sender to try one text NOW, rather than waiting for whatever kip
// would have texted about next. It is a WRITE and not a call: the answer arrives
// on the prefs listener the app already holds, so nothing here sits in a request
// path — the same shape every other trigger in this project has.
//
// The value is a clock reading rather than a flag, so a second press while the
// first is still running is a new question and not a no-op.
export async function requestTextCheck(uid: string, at: number): Promise<void> {
  await setDoc(
    doc(db(), "users", uid, "settings", "prefs"),
    { smsProbeAt: at },
    { merge: true },
  );
}

export async function setTextNotify(
  uid: string,
  kind: NotifySmsKind,
  on: boolean,
): Promise<void> {
  await setDoc(
    doc(db(), "users", uid, "settings", "prefs"),
    { notifySms: { [kind]: on } },
    { merge: true },
  );
}
