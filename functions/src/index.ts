import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import {
  onDocumentCreated,
  onDocumentUpdated,
} from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import nodemailer from "nodemailer";
import {
  type NotifyKind,
  noticeForBookingChange,
  noticeForConnectRequest,
  noticeForNewBooking,
} from "./messages";

initializeApp();
const db = getFirestore();

// Gmail SMTP with an App Password. Chosen because kip has no domain of its own
// yet, so any transactional provider would be stuck on a shared test sender —
// whereas this address is already a warm, authenticated one. Swapping later is
// this file and two secrets, since nothing about the events depends on it.
const GMAIL_USER = defineSecret("GMAIL_USER");
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");

const REGION = "us-central1";

type Recipient = { email: string; name: string };

// Resolve someone's address from their AUTH account — the only place kip keeps
// it. Returns null when they have none, when it isn't verified, or when they've
// turned this kind of mail off.
//
// The verified check is a spam gate, not a formality: without it, signing up as
// victim@example.com and having a second account book you would deliver mail to
// someone who never gave you their address.
async function recipientFor(
  uid: string,
  kind: NotifyKind,
): Promise<Recipient | null> {
  const [user, prefs] = await Promise.all([
    getAuth()
      .getUser(uid)
      .catch(() => null),
    db.doc(`users/${uid}/settings/prefs`).get(),
  ]);

  if (!user?.email || !user.emailVerified) return null;
  if (prefs.data()?.notify?.[kind] === false) return null;

  return { email: user.email, name: user.displayName ?? "" };
}

function transport() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: GMAIL_USER.value(),
      pass: GMAIL_APP_PASSWORD.value(),
    },
  });
}

// Fire-and-forget: a bounced notification must never fail the write that caused
// it. The document is already committed by the time a trigger runs, so throwing
// here would only produce retries of an email nobody is waiting on.
async function send(
  to: Recipient,
  subject: string,
  body: string,
): Promise<void> {
  try {
    await transport().sendMail({
      from: `kip <${GMAIL_USER.value()}>`,
      to: to.email,
      subject,
      text: `${body}\n\nYou can turn these off in kip under Settings.`,
    });
  } catch (error) {
    logger.error("send failed", { subject, error });
  }
}

const secrets = [GMAIL_USER, GMAIL_APP_PASSWORD];

// Someone asked to stay. Both routes in land here — a friend picking dates and a
// share-link visitor asking — because both create the same REQUESTED booking.
export const onBookingCreated = onDocumentCreated(
  { document: "bookings/{bookingId}", region: REGION, secrets },
  async (event) => {
    const booking = event.data?.data();
    if (!booking) return;

    const notice = noticeForNewBooking(booking as never);
    const to = await recipientFor(booking.ownerId, notice.kind);
    if (to) await send(to, notice.subject, notice.body);
  },
);

// Every confirmation and every ending. Which side hears about it depends on who
// acted, which is why cancelling stamps `cancelledBy` — a trigger can't see the
// writer.
export const onBookingChanged = onDocumentUpdated(
  { document: "bookings/{bookingId}", region: REGION, secrets },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;

    const notice = noticeForBookingChange(before as never, after as never);
    if (!notice) return;

    const uid = notice.to === "host" ? after.ownerId : after.guestId;
    const to = await recipientFor(uid, notice.kind);
    if (to) await send(to, notice.subject, notice.body);
  },
);

// Someone asked to be friends — by handle, or through a share link. This is the
// event a client-written mail queue could never have authorised: there's no
// booking shared between two people who aren't connected yet.
export const onConnectRequested = onDocumentCreated(
  { document: "connectRequests/{requestId}", region: REGION, secrets },
  async (event) => {
    const request = event.data?.data();
    if (!request) return;

    const notice = noticeForConnectRequest(request as never);
    const to = await recipientFor(request.to, notice.kind);
    if (to) await send(to, notice.subject, notice.body);
  },
);
