"use client";

import {
  addDoc,
  collection,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import { auth, db } from "./firebase";

// The rule caps this, so the client has to as well or the write is simply
// refused and the diagnosis is lost along with the failure it described.
const MAX_DETAIL = 2_000;

// Long enough to still be there when someone reports a problem a few days later,
// short enough that the collection isn't a standing record of who visited.
const KEEP_DAYS = 7;

// These failures throw nothing, so the state that made the decision is all
// there is to report.
export type DebugDetail = Readonly<Record<string, string | number | boolean>>;

// Slicing the encoded string would be the obvious cap and would store JSON that
// no reader can parse. An oversized payload is a bug in the caller, so the head
// is kept only as a lead — short enough that escaping it can't breach the cap.
export function encodeDetail(detail: DebugDetail): string {
  const encoded = JSON.stringify(detail);
  return encoded.length <= MAX_DETAIL
    ? encoded
    : JSON.stringify({
        oversized: encoded.length,
        head: encoded.slice(0, 200),
      });
}

// Swallows its own errors: a diagnostic that can fail the thing it is
// diagnosing is worse than no diagnostic. Best-effort by nature — this write
// goes to the same Firestore that may be what's broken.
export function recordDebugEvent(kind: string, detail: DebugDetail): void {
  const uid = auth().currentUser?.uid;
  if (!uid) return;
  addDoc(collection(db(), "debug"), {
    uid,
    kind,
    detail: encodeDetail(detail),
    at: serverTimestamp(),
    expires: Timestamp.fromMillis(Date.now() + KEEP_DAYS * 86_400_000),
  }).catch((error: unknown) => console.warn("debug", error));
}

// Tells the network apart from the tab from us. Read at the moment of failure:
// `visibilityState` is worthless a second later.
export function clientState(): DebugDetail {
  return {
    online: navigator.onLine,
    visibility: document.visibilityState,
    sinceLoad: Math.round(performance.now()),
    ua: navigator.userAgent.slice(0, 180),
  };
}
