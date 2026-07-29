import { randomUUID } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { type DocumentData, getFirestore } from "firebase-admin/firestore";
import { defineSecret, projectID } from "firebase-functions/params";
import {
  onDocumentCreated,
  onDocumentUpdated,
} from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import nodemailer from "nodemailer";
import {
  ALL_OFF,
  asNotifyKind,
  formIntent,
  linkTo,
  type Notice,
  NOTIFY_LABELS,
  SETTINGS_PATH,
  type NotifyKind,
  type NotifyState,
  type Person,
  noticeForBookingChange,
  noticeForConnectRequest,
  noticeForNewBooking,
  notifyFromForm,
  notifyStateFrom,
  ONE_CLICK_BODY,
  renderEmail,
  renderNotifySaved,
  renderUnsubscribeAsk,
  renderUnsubscribeFailed,
  renderUnsubscribed,
  unsubscribeHeaders,
  unsubscribeLink,
} from "./messages";

initializeApp();
const db = getFirestore();

// Gmail SMTP with an App Password. Chosen because kip has no domain of its own
// yet, so any transactional provider would be stuck on a shared test sender —
// whereas this address is already a warm, authenticated one. Swapping later is
// this file and one secret, since nothing about the events depends on it.
//
// The address is in plain sight on purpose: it rides in the From: line of every
// email kip sends, so it is not a secret in any sense, and Secret Manager would
// only mislabel it. It is a send-only mailbox nobody reads, so its being
// scrapeable from a public repo costs nothing either.
const GMAIL_USER = "kip.hafaio.noreply@gmail.com";
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");

// Where every link in an email points. Public, and not a secret in any sense —
// it's the address of the site. The `/kip` tail is the base path GitHub Pages
// serves the export under, so dropping it would send every link to a 404.
const SITE_ORIGIN = "https://hafaio.github.io/kip";

const REGION = "us-central1";

// Where the unsubscribe link points, which is NOT the site: `unsubscribe` below
// is a function, and it answers on the Cloud Functions host. Derived rather than
// written down, since the project id is the only variable in it and a wrong host
// here breaks every unsubscribe link kip has ever sent, silently. Of the two URLs
// a 2nd-gen function answers on, this is the derivable one — the `run.app` form
// carries a generated hash nothing can reconstruct.
const UNSUBSCRIBE_FUNCTION = "unsubscribe";

function unsubscribeEndpoint(): string {
  return `https://${REGION}-${projectID.value()}.cloudfunctions.net/${UNSUBSCRIBE_FUNCTION}`;
}

function prefsPath(uid: string): string {
  return `users/${uid}/settings/prefs`;
}

// `unsubKey` is the recipient's own capability to stop this mail, minted the
// first time kip writes to them and kept until they're gone — the same shape as
// a portal id, and for the same reason: a POST from a mail provider arrives with
// no identity at all, so authority has to ride in the URL. Deliberately not an
// HMAC of a project secret, which would be one more thing to set, to store and to
// rotate, in exchange for authority nobody needs — this key speaks for exactly
// one person's mail preferences and nothing else.
//
// Minted in a transaction because two notifications to the same person can land
// at once, and a lost race would mean the losing email carrying a key that was
// already overwritten: an unsubscribe button that quietly does nothing.
async function unsubKeyFor(uid: string, existing: unknown): Promise<string> {
  if (typeof existing === "string" && existing) return existing;
  const ref = db.doc(prefsPath(uid));
  return db.runTransaction(async (tx) => {
    const stored = (await tx.get(ref)).data()?.unsubKey;
    if (typeof stored === "string" && stored) return stored;
    const minted = randomUUID();
    tx.set(ref, { unsubKey: minted }, { merge: true });
    return minted;
  });
}

type Recipient = { uid: string; email: string; name: string; unsubKey: string };

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
    db.doc(prefsPath(uid)).get(),
  ]);

  // Say WHY nothing was sent. All three of these are legitimate and none is an
  // error, but silence made them indistinguishable from a trigger that never ran.
  if (!user?.email) {
    logger.info("skipped: no address on the account", { uid, kind });
    return null;
  }
  if (!user.emailVerified) {
    logger.info("skipped: address not verified", { uid, kind });
    return null;
  }
  if (prefs.data()?.notify?.[kind] === false) {
    logger.info("skipped: turned off in Settings", { uid, kind });
    return null;
  }

  return {
    uid,
    email: user.email,
    name: user.displayName ?? "",
    unsubKey: await unsubKeyFor(uid, prefs.data()?.unsubKey),
  };
}

function transport() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD.value(),
    },
  });
}

// The other party's photo rides along as an inline attachment rather than a URL,
// because a URL in an email is fetched by the RECIPIENT's client — Gmail proxies
// and caches it — and a kip-hosted photo URL is an unguessable bearer
// capability. Putting one in an email hands it out. Attaching the bytes also
// renders more reliably, since many clients block remote images by default.
const PHOTO_CID = "kip-photo";
const PHOTO_MAX_BYTES = 512 * 1024;
const PHOTO_TIMEOUT_MS = 5000;
const PHOTO_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

type Photo = { content: Buffer; contentType: string };

// Bounded on every axis, because the URL comes off a user's own profile: https
// only (so this can't be pointed at a local or metadata address), a timeout, an
// image content type, and a size cap checked before AND after reading — a
// missing or lying `content-length` is not a reason to buffer something huge.
//
// Every failure is a null, never a throw: an email without a face is a fine
// email, and a notification must not die over a photo.
async function fetchPhoto(
  url: string | null | undefined,
): Promise<Photo | null> {
  if (!url) return null;
  try {
    if (new URL(url).protocol !== "https:") return null;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const [declaredType = ""] = (
      response.headers.get("content-type") ?? ""
    ).split(";");
    const contentType = declaredType.trim().toLowerCase();
    if (!PHOTO_TYPES.has(contentType)) return null;

    const declared = Number(response.headers.get("content-length"));
    if (declared > PHOTO_MAX_BYTES) return null;

    const content = Buffer.from(await response.arrayBuffer());
    if (content.byteLength > PHOTO_MAX_BYTES) return null;

    return { content, contentType };
  } catch (error) {
    logger.warn("photo fetch failed", { error });
    return null;
  }
}

// A name for the attachment, since some clients list one even for an inline
// part. Nothing depends on it — the `cid` is what the template references.
function photoFilename(contentType: string, person: Person): string {
  const extension = contentType.split("/")[1] ?? "jpg";
  const stem =
    person.name.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase() || "kip";
  return `${stem}.${extension}`;
}

// Fire-and-forget: a bounced notification must never fail the write that caused
// it. The document is already committed by the time a trigger runs, so throwing
// here would only produce retries of an email nobody is waiting on.
async function send(to: Recipient, notice: Notice): Promise<void> {
  try {
    const photo = await fetchPhoto(notice.person.photoURL);
    // One url for the header and the footer link both, so what a provider acts
    // on and what a person clicks can never be two different things.
    const unsubscribeUrl = unsubscribeLink(
      unsubscribeEndpoint(),
      to.uid,
      notice.kind,
      to.unsubKey,
    );
    const email = renderEmail(notice, {
      origin: SITE_ORIGIN,
      photoCid: photo ? PHOTO_CID : null,
      unsubscribeUrl,
    });

    const result = await transport().sendMail({
      from: `kip <${GMAIL_USER}>`,
      to: to.name ? { name: to.name, address: to.email } : to.email,
      // Notification mail without a List-Unsubscribe header looks, to a spam
      // filter, like mail that doesn't expect to be refused. It points at the
      // `unsubscribe` function rather than the Settings screen, because Settings
      // is behind a sign-in and a one-click POST arrives with no session — an
      // unsubscribe a provider can't complete is one it will eventually stop
      // offering.
      headers: unsubscribeHeaders(unsubscribeUrl),
      subject: email.subject,
      text: email.text,
      html: email.html,
      attachments: photo
        ? [
            {
              filename: photoFilename(photo.contentType, notice.person),
              content: photo.content,
              contentType: photo.contentType,
              cid: PHOTO_CID,
            },
          ]
        : [],
    });
    // Success used to be silent, which made "sent" and "silently skipped"
    // indistinguishable from the outside — the only way to tell was to ask
    // someone whether mail had arrived. What the server said is the one durable
    // record there is, since nothing about a sent email is stored anywhere.
    logger.info("sent", {
      kind: notice.kind,
      subject: notice.subject,
      accepted: result.accepted,
      rejected: result.rejected,
      response: result.response,
    });
  } catch (error) {
    logger.error("send failed", { subject: notice.subject, error });
  }
}

const secrets = [GMAIL_APP_PASSWORD];

// Someone asked to stay. Both routes in land here — a friend picking dates and a
// share-link visitor asking — because both create the same REQUESTED booking.
// The names and photos a booking email needs are no longer stored on the booking
// — each party reads the other's profile live, through a pointer only the two of
// them can hold. A trigger has no session to hop with, but it runs as admin, so
// it just reads both profiles. Deliberately Firestore and not
// `getAuth().getUser()`: the kip display name lives in Firestore and the Auth
// record is only a mirror of it.
async function withIdentities(booking: DocumentData): Promise<DocumentData> {
  const [host, guest] = await Promise.all([
    db.doc(`users/${booking.ownerId}`).get(),
    db.doc(`users/${booking.guestId}`).get(),
  ]);
  return {
    ...booking,
    hostName: host.data()?.displayName ?? "",
    hostPhotoURL: host.data()?.photoURL ?? null,
    guestName: guest.data()?.displayName ?? "",
    guestPhotoURL: guest.data()?.photoURL ?? null,
  };
}

// The identity fields only, so the BEFORE snapshot can carry the same names as
// the after one — it is compared for a status change, never for who these people
// are, and reading two profiles twice would be waste.
function pickIdentities(booking: DocumentData): DocumentData {
  return {
    hostName: booking.hostName,
    hostPhotoURL: booking.hostPhotoURL,
    guestName: booking.guestName,
    guestPhotoURL: booking.guestPhotoURL,
  };
}

export const onBookingCreated = onDocumentCreated(
  { document: "bookings/{bookingId}", region: REGION, secrets },
  async (event) => {
    const booking = event.data?.data();
    if (!booking) return;

    const notice = noticeForNewBooking(
      (await withIdentities(booking)) as never,
      event.params.bookingId,
    );
    const to = await recipientFor(booking.ownerId, notice.kind);
    if (to) await send(to, notice);
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

    const named = await withIdentities(after);
    const notice = noticeForBookingChange(
      { ...before, ...pickIdentities(named) } as never,
      named as never,
      event.params.bookingId,
    );
    if (!notice) return;

    const uid = notice.to === "host" ? after.ownerId : after.guestId;
    const to = await recipientFor(uid, notice.kind);
    if (to) await send(to, notice);
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
    if (to) await send(to, notice);
  },
);

// The whole of the authorisation: the key in the url against the key in their
// preferences. Fails closed and identically on every bad input — a key that
// doesn't match, a uid that was never a user, a uid not even shaped like a
// document path. A distinguishable answer would make a public endpoint into a way
// of asking whether an account exists.
//
// Returns the preferences it had to read anyway, since the page shows the state
// it's about to change. That's the one thing the key now discloses beyond the
// power to silence — this user's own notification switches, to someone already
// holding a link out of their inbox.
async function authorisedPrefs(
  uid: string,
  key: string,
): Promise<Record<string, unknown> | null> {
  try {
    const prefs = (await db.doc(prefsPath(uid)).get()).data() ?? {};
    // A key is an unguessable id compared whole, exactly as a portal token is.
    const stored = prefs.unsubKey;
    return typeof stored === "string" && stored === key ? prefs : null;
  } catch (error) {
    logger.warn("unsubscribe lookup failed", { error });
    return null;
  }
}

// Merged, so it's idempotent (a provider retrying, or someone submitting twice,
// lands on the same state) and touches nothing but the kinds named — never the
// key, never the rest of the preferences. Deliberately unguarded: the path is
// already proven to be a readable document, so a throw here means Firestore is
// having a bad minute, and a 500 asking the provider to retry is right for that.
async function saveNotify(
  uid: string,
  notify: Partial<NotifyState>,
): Promise<void> {
  await db.doc(prefsPath(uid)).set({ notify }, { merge: true });
}

// RFC 8058 one-click: the mail provider POSTs this URL itself, with no cookies,
// no session and no user in front of it, which is why it must be `invoker:
// "public"` — a signed-in caller is precisely what it will never have.
//
// Only the POST acts. A GET renders the same page with a form on it and changes
// nothing, because mail travels through link scanners and security proxies that
// fetch every url in a message: a GET that acted would unsubscribe people who
// never clicked, and neither side would ever know — they'd just stop getting mail
// nobody has a record of them refusing. That's also why the form's target is this
// same url rather than a second endpoint; there is one way in, and it's the one
// the header advertises.
export const unsubscribe = onRequest(
  { region: REGION, invoker: "public" },
  async (request, response) => {
    if (request.method !== "GET" && request.method !== "POST") {
      response
        .status(405)
        .set("Allow", "GET, POST")
        .type("text/plain")
        .send("Method not allowed\n");
      return;
    }

    // The POST body (`List-Unsubscribe=One-Click`) is deliberately not checked.
    // It carries no authority — the key in the url is the whole of it — so
    // demanding an exact body would only turn a provider that phrases it
    // differently into a broken unsubscribe.

    const uid = typeof request.query.uid === "string" ? request.query.uid : "";
    const key = typeof request.query.key === "string" ? request.query.key : "";
    const kind = asNotifyKind(request.query.kind);
    // Null for every way this can go wrong — a missing parameter, an unknown
    // kind, a key that doesn't match, a user that was never there.
    const prefs = uid && key && kind ? await authorisedPrefs(uid, key) : null;

    // The url holds the key, so nothing between here and the reader may keep a
    // copy of the answer.
    response.set("Cache-Control", "no-store");

    // A browser asks for HTML and a provider doesn't care, so both get something
    // meant for them: a page, or a line saying what to POST.
    const wantsPage = (request.headers.accept ?? "").includes("text/html");
    const settingsUrl = linkTo(SITE_ORIGIN, SETTINGS_PATH);
    const respond = (status: number, page: string, plain: string): void => {
      response
        .status(status)
        .type(wantsPage ? "text/html" : "text/plain")
        .send(wantsPage ? page : plain);
    };

    if (!kind || !prefs) {
      logger.info("unsubscribe refused", { uid, kind, method: request.method });
      respond(
        400,
        renderUnsubscribeFailed(settingsUrl),
        "This unsubscribe link no longer works.\n",
      );
    } else if (request.method === "GET") {
      logger.info("unsubscribe asked", { uid, kind });
      respond(
        200,
        renderUnsubscribeAsk(
          kind,
          notifyStateFrom(prefs.notify),
          unsubscribeLink(unsubscribeEndpoint(), uid, kind, key),
        ),
        `POST this url with "${ONE_CLICK_BODY}" to stop these emails: ${NOTIFY_LABELS[kind]}\n`,
      );
    } else {
      const intent = formIntent(request.body);
      logger.info("unsubscribing", { uid, kind, intent });
      if (intent === "one") {
        // What a provider's one-click sends, and what the page's first button
        // sends: the narrowest thing, and the default for anything unfamiliar.
        await saveNotify(uid, { [kind]: false });
        respond(
          200,
          renderUnsubscribed(kind, settingsUrl),
          `Unsubscribed from: ${NOTIFY_LABELS[kind]}\n`,
        );
      } else {
        const notify = intent === "all" ? ALL_OFF : notifyFromForm(request.body);
        await saveNotify(uid, notify);
        respond(
          200,
          renderNotifySaved(notify, settingsUrl),
          `Saved: ${JSON.stringify(notify)}\n`,
        );
      }
    }
  },
);
