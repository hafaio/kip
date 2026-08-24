import { randomUUID } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import {
  type DocumentData,
  getFirestore,
  Timestamp,
} from "firebase-admin/firestore";
import { defineSecret, projectID } from "firebase-functions/params";
import {
  onDocumentCreated,
  onDocumentDeleted,
  onDocumentUpdated,
} from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { reapTickets } from "./reap";
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
  noticeForConnectAccepted,
  noticeForConnectRequest,
  noticeForNewBooking,
  notifyFromForm,
  notifyStateFrom,
  renderEmail,
  renderNotifySaved,
  renderUnsubscribeChoices,
  renderUnsubscribeFailed,
  renderUnsubscribed,
  unsubscribeHeaders,
  unsubscribeLink,
} from "./messages";

initializeApp();
const db = getFirestore();

// kip has no domain, so a transactional provider would be stuck on a shared
// test sender where this address is already warm and authenticated. The address
// rides in every From: line, so it is not a secret; only the password is.
const GMAIL_USER = "kip.hafaio.noreply@gmail.com";
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");

// The `/kip` tail is the GitHub Pages base path; dropping it 404s every link.
const SITE_ORIGIN = "https://hafaio.github.io/kip";

const REGION = "us-central1";

// Derived, not written down: a wrong host here silently breaks every
// unsubscribe link kip has ever sent. The `run.app` form can't be derived.
const UNSUBSCRIBE_FUNCTION = "unsubscribe";

function unsubscribeEndpoint(): string {
  return `https://${REGION}-${projectID.value()}.cloudfunctions.net/${UNSUBSCRIBE_FUNCTION}`;
}

function prefsPath(uid: string): string {
  return `users/${uid}/settings/prefs`;
}

// A capability in the URL, like a portal id, because a provider's POST arrives
// with no identity at all. Minted in a transaction: two notifications can land
// at once, and the loser would carry an already-overwritten key.
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

// From the Auth account, the only place kip keeps an address. The verified
// check is what stops someone signing up as victim@example.com and having a
// second account book them.
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

  // All three are legitimate, but silence made them indistinguishable from a
  // trigger that never ran.
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

// Attached, never linked: a photo URL is a bearer capability, and a remote
// image in an email is fetched and cached by the recipient's client.
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

// Bounded on every axis because the URL comes off a user's own profile. The
// size cap is checked after reading too, since `content-length` can lie. Every
// failure is a null — a notification must not die over a photo.
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

// Cosmetic: some clients list a filename even for an inline part.
function photoFilename(contentType: string, person: Person): string {
  const extension = contentType.split("/")[1] ?? "jpg";
  const stem =
    person.name.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase() || "kip";
  return `${stem}.${extension}`;
}

// Fire-and-forget: the document is already committed, so throwing would only
// retry an email nobody is waiting on.
async function send(to: Recipient, notice: Notice): Promise<void> {
  try {
    const photo = await fetchPhoto(notice.person.photoURL);
    // One url for header and footer, so the two can never diverge.
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
      // Points at the function, not Settings: Settings is behind a sign-in and
      // a one-click POST arrives with no session.
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
    // The one durable record there is — nothing about a sent email is stored.
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

// A trigger has no session to hop with, but runs as admin, so it reads both
// profiles directly — from Firestore, since the Auth record is only a mirror.
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

// The before snapshot is compared for a status change, never for identity, so
// it borrows the after snapshot's names rather than reading two profiles twice.
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

// Which side hears depends on who acted, which is why cancelling stamps
// `cancelledBy` — a trigger can't see the writer.
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

// The event a client-written mail queue could never have authorised: two people
// who aren't connected yet share no booking to check against.
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

// Both are server timestamps written by Firestore, so the order between them is
// exact rather than a comparison of two clients' clocks.
function later(after: unknown, before: unknown): boolean {
  return (
    after instanceof Timestamp &&
    before instanceof Timestamp &&
    after.toMillis() > before.toMillis()
  );
}

// Accepting deletes the request in the same batch that writes both friend
// edges, so the delete is the only event there is — and declining or
// withdrawing deletes the same document. The edge is what tells them apart, and
// it has to POSTDATE the ask: two people who are already friends can still send
// and drop a request (a friend opening your share link is offered one), and
// their edge would otherwise report that withdrawal as a yes.
export const onConnectAnswered = onDocumentDeleted(
  { document: "connectRequests/{requestId}", region: REGION, secrets },
  async (event) => {
    const request = event.data?.data();
    if (!request) return;

    const edge = (
      await db.doc(`users/${request.from}/friends/${request.to}`).get()
    ).data();
    if (!edge || !later(edge.since, request.createdAt)) return;

    const notice = noticeForConnectAccepted({
      uid: request.to,
      displayName: edge.displayName,
      photoURL: edge.photoURL,
    });
    const to = await recipientFor(request.from, notice.kind);
    if (to) await send(to, notice);
  },
);

// Fails closed and identically on every bad input, or a public endpoint becomes
// a way to ask whether an account exists. Returns the prefs it had to read
// anyway, since the page shows the state it's about to change.
async function authorisedPrefs(
  uid: string,
  key: string,
): Promise<Record<string, unknown> | null> {
  try {
    const prefs = (await db.doc(prefsPath(uid)).get()).data() ?? {};
    // An unguessable id compared whole, exactly as a portal token is.
    const stored = prefs.unsubKey;
    return typeof stored === "string" && stored === key ? prefs : null;
  } catch (error) {
    logger.warn("unsubscribe lookup failed", { error });
    return null;
  }
}

// Merged, so a provider retrying lands on the same state and nothing but the
// named kinds is touched. Unguarded on purpose: a throw here means Firestore is
// having a bad minute, and a 500 asking for a retry is the right answer.
async function saveNotify(
  uid: string,
  notify: Partial<NotifyState>,
): Promise<void> {
  await db.doc(prefsPath(uid)).set({ notify }, { merge: true });
}

// RFC 8058 one-click, so it must be `invoker: "public"` — a provider's POST
// never has a session. BOTH verbs act, and the GET doing so is a trade made with
// eyes open: someone who pressed Unsubscribe has said what they want, and a page
// that answers "are you sure?" is how "report spam" happens instead — but the
// url is a link in the message body too, so a mail gateway that fetches every
// link silences that one kind for someone who never clicked. Bounded (one kind,
// never the account), visibly undoable on the page itself, and Settings always
// shows the truth.
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

    // The body carries no authority — the key in the url is the whole of it —
    // so demanding an exact one would just break unfamiliar providers.

    const uid = typeof request.query.uid === "string" ? request.query.uid : "";
    const key = typeof request.query.key === "string" ? request.query.key : "";
    const kind = asNotifyKind(request.query.kind);
    // Null for every way this can go wrong, indistinguishably.
    const prefs = uid && key && kind ? await authorisedPrefs(uid, key) : null;

    // The url holds the key, so nothing downstream may cache the answer.
    response.set("Cache-Control", "no-store");

    // A browser asks for HTML and a provider doesn't care.
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
      logger.info("unsubscribing", { uid, kind, intent: "one" });
      // Before rendering, so the switches show what is stored rather than what
      // is about to be. `prefs` is the read that authorised this one, taken
      // before the write, which is why the page applies the same change again.
      await saveNotify(uid, { [kind]: false });
      respond(
        200,
        renderUnsubscribeChoices(
          kind,
          notifyStateFrom(prefs.notify),
          unsubscribeLink(unsubscribeEndpoint(), uid, kind, key),
        ),
        `Unsubscribed from: ${NOTIFY_LABELS[kind]}\n`,
      );
    } else {
      const intent = formIntent(request.body);
      logger.info("unsubscribing", { uid, kind, intent });
      if (intent === "one") {
        // The narrowest action, and the default for anything unfamiliar.
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

// The only function here that is not a reaction to a write, and the only one
// that needs the Admin SDK for something rules categorically cannot express:
// enumerating and deleting Auth accounts. It sits in no request path — it runs
// on a timer, reacting to nobody — and it replaces a server-side process that
// already existed, Firebase's own anonymous auto-delete, with one that reads the
// database before it kills.
//
// Weekly, because nothing here is urgent and a small candidate set per run keeps
// a mistake small too.
//
// A constant rather than the `REAP_DRY_RUN` env var it replaces, which defaulted
// to a dry run when unset — and `functions/` has no `.env`, so this had never
// once deleted anything while the privacy page promised abandoned sessions were
// collected after thirty days. A rehearsal is this line flipped and redeployed:
// visible in review, and impossible to be in without meaning to.
const REAP_DRY_RUN = false;

export const reapAnonymousTickets = onSchedule(
  { schedule: "every monday 04:00", region: REGION, timeoutSeconds: 540 },
  async () => {
    await reapTickets(REAP_DRY_RUN);
  },
);
