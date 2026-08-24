import { randomUUID } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getAuth, type UserRecord } from "firebase-admin/auth";
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
import { tearDownAccount } from "./teardown";
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
  renderSms,
  renderUnsubscribeChoices,
  renderUnsubscribeFailed,
  renderUnsubscribed,
  unsubscribeHeaders,
  unsubscribeLink,
  wantsEmail,
  wantsSms,
} from "./messages";

initializeApp();
const db = getFirestore();

// kip has no domain, so a transactional provider would be stuck on a shared
// test sender where this address is already warm and authenticated. The address
// rides in every From: line, so it is not a secret; only the password is.
const GMAIL_USER = "kip.hafaio.noreply@gmail.com";
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");

// Empty, so SMS is off: `smsConfigured()` is checked before anything is read,
// written or sent, the same shape `firebaseConfigured()` has on the web side.
// Filling these in is not enough on its own — until the 10DLC campaign is
// approved every US send is blocked with 30034 and billed anyway.
//
// An API Key SID and secret rather than the account auth token: revocable and
// scoped. The account SID is in the URL every request goes to, the key SID and
// the From number ride in every message, so like GMAIL_USER none of them is a
// secret; only the API secret is.
const TWILIO_ACCOUNT_SID = "";
const TWILIO_KEY_SID = "";
const TWILIO_FROM = "";

function smsConfigured(): boolean {
  return Boolean(TWILIO_ACCOUNT_SID && TWILIO_KEY_SID && TWILIO_FROM);
}

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

// From the Auth account, the only place kip keeps an address. The verified check
// is what stops someone signing up as victim@example.com and having a second
// account book them. Each skip says which it was: silence made all of them
// indistinguishable from a trigger that never ran.
async function emailIfWanted(
  uid: string,
  user: UserRecord | null,
  prefs: DocumentData,
  notice: Notice,
): Promise<void> {
  const kind = notice.kind;
  if (!user?.email) {
    logger.info("skipped: no address on the account", { uid, kind });
    return;
  }
  if (!user.emailVerified) {
    logger.info("skipped: address not verified", { uid, kind });
    return;
  }
  if (!wantsEmail(prefs.notify, kind)) {
    logger.info("skipped: turned off in Settings", { uid, kind });
    return;
  }

  await send(
    {
      uid,
      email: user.email,
      name: user.displayName ?? "",
      unsubKey: await unsubKeyFor(uid, prefs.unsubKey),
    },
    notice,
  );
}

// The Twilio credential is fetched at FIRST USE rather than declared as a
// `defineSecret` param, and that is a release decision rather than a stylistic
// one: the CLI resolves every declared secret at deploy, so a non-interactive
// one fails outright on a secret Secret Manager doesn't hold. Naming it put the
// whole site's release — rules, triggers and Pages — behind a credential only
// this switched-off branch has any use for, held up by nothing but a
// hand-created empty placeholder. Read here it is a runtime condition: a
// missing one fails the text and says so, and nothing else notices.
//
// GMAIL_APP_PASSWORD stays a declared secret. It exists, email is live, and a
// deploy that can't resolve it is a deploy worth stopping.
//
// One REST call each to the metadata server and Secret Manager, which is the
// same reason Twilio itself is a `fetch`: no dependency to add, and the runtime
// service account already carries the access.
const TWILIO_SECRET = "TWILIO_API_SECRET";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const SECRET_TIMEOUT_MS = 5000;

// Cached across a cold start's lifetime, so a burst of texts costs one lookup.
// Only a success is kept: a miss is a misconfiguration somebody is in the middle
// of fixing, and re-reading on the next text is one round trip on a path that
// runs single digits a day.
let twilioSecret: string | null = null;

async function metadataToken(): Promise<string> {
  const response = await fetch(METADATA_TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(SECRET_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`no runtime token: metadata server ${response.status}`);
  }
  const token = ((await response.json()) as { access_token?: string })
    .access_token;
  if (!token) throw new Error("no runtime token: metadata server gave none");
  return token;
}

async function twilioApiSecret(): Promise<string> {
  if (twilioSecret) return twilioSecret;
  const response = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${projectID.value()}/secrets/${TWILIO_SECRET}/versions/latest:access`,
    {
      headers: { Authorization: `Bearer ${await metadataToken()}` },
      signal: AbortSignal.timeout(SECRET_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`no ${TWILIO_SECRET}: Secret Manager ${response.status}`);
  }
  const payload = ((await response.json()) as { payload?: { data?: string } })
    .payload;
  const value = Buffer.from(payload?.data ?? "", "base64").toString().trim();
  if (!value) throw new Error(`no ${TWILIO_SECRET}: the version is empty`);
  twilioSecret = value;
  return value;
}

// A message resource carries `error_code`, an API refusal carries `code`, and
// 30034 can arrive either way.
const TWILIO_STOPPED = 21610;
const TWILIO_UNREGISTERED = 30034;
const SMS_TIMEOUT_MS = 10000;

type TwilioResult = {
  sid?: string;
  status?: string;
  code?: number | null;
  error_code?: number | null;
  message?: string;
};

// One form-encoded POST, so the provider is ~30 lines rather than a dependency.
// Attempted even when the carrier has already taken a STOP: Twilio refuses those
// before a message is created, so nothing is billed, and the refusal ceasing is
// the only way a later START can be noticed.
async function sendText(
  uid: string,
  to: string,
  body: string,
  kind: NotifyKind,
  stopped: boolean,
): Promise<void> {
  // Outside the try, so a credential that can't be read leaves this the way a
  // missing one should: raised, settled by `deliver`, logged, and with the
  // email beside it entirely unaffected.
  const credentials = Buffer.from(
    `${TWILIO_KEY_SID}:${await twilioApiSecret()}`,
  ).toString("base64");
  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body }),
        signal: AbortSignal.timeout(SMS_TIMEOUT_MS),
      },
    );
    const result = (await response.json().catch(() => ({}))) as TwilioResult;
    const code = result.code ?? result.error_code ?? 0;

    if (code === TWILIO_STOPPED) {
      // Carrier-enforced and above kip's Settings, so it is recorded rather than
      // obeyed: Settings renders the switch off and says kip can't undo it.
      logger.info("skipped: the carrier has a STOP for this number", {
        uid,
        kind,
      });
      if (!stopped) {
        await db.doc(prefsPath(uid)).set({ smsStopped: true }, { merge: true });
      }
    } else if (code === TWILIO_UNREGISTERED) {
      // The paperwork, not the code: an unregistered 10DLC campaign is a hard
      // carrier block on every US send, and Twilio bills for it anyway.
      logger.error("blocked: the 10DLC campaign is not registered", {
        uid,
        kind,
        message: result.message,
      });
    } else if (!response.ok || code) {
      logger.error("text failed", {
        uid,
        kind,
        status: response.status,
        code,
        message: result.message,
      });
    } else {
      logger.info("texted", { kind, sid: result.sid, status: result.status });
      if (stopped) {
        await db
          .doc(prefsPath(uid))
          .set({ smsStopped: false }, { merge: true });
      }
    }
  } catch (error) {
    logger.error("text failed", { uid, kind, error });
  }
}

// A second channel, never a fallback: texting only where there is no address
// would make the Settings switch a lie for anyone holding both, and route the
// most urgent message to the slower channel for people who are mid-travel.
async function textIfWanted(
  uid: string,
  user: UserRecord | null,
  prefs: DocumentData,
  notice: Notice,
): Promise<void> {
  const kind = notice.kind;
  if (!smsConfigured()) {
    logger.info("skipped: no SMS provider configured", { uid, kind });
    return;
  }

  // Null is a fact about the event, not about this person, so it says nothing.
  const text = renderSms(notice, SITE_ORIGIN);
  if (!text) return;

  const number = user?.phoneNumber ?? "";
  if (!number) {
    logger.info("skipped: no number on the account", { uid, kind });
    return;
  }
  // The Auth region allowlist is US-only, but a number can reach an account by
  // routes the web form doesn't own, and this one is checked before spending.
  if (!number.startsWith("+1")) {
    logger.info("skipped: number outside the SMS region", { uid, kind });
    return;
  }
  if (!prefs.smsConsentAt) {
    logger.info("skipped: no SMS consent recorded", { uid, kind });
    return;
  }
  // Consent is to being texted at a PARTICULAR phone, so a record naming
  // another number is a record about somebody else's. Fails closed, which also
  // covers every consent stored before the number was part of one.
  if (prefs.smsConsentNumber !== number) {
    logger.info("skipped: consent was given for a different number", {
      uid,
      kind,
    });
    return;
  }
  if (!wantsSms(prefs.notifySms, kind)) {
    logger.info("skipped: texts turned off in Settings", { uid, kind });
    return;
  }

  await sendText(uid, number, text, kind, prefs.smsStopped === true);
}

// Both channels answer for the same person, so the account and the preferences
// are read once. Settled rather than raced: a Twilio failure must never reach
// the email path, and neither has anything to say to the other.
async function deliver(uid: string, notice: Notice): Promise<void> {
  const [user, stored] = await Promise.all([
    getAuth()
      .getUser(uid)
      .catch(() => null),
    db.doc(prefsPath(uid)).get(),
  ]);
  const prefs = stored.data() ?? {};

  const outcomes = await Promise.allSettled([
    emailIfWanted(uid, user, prefs, notice),
    textIfWanted(uid, user, prefs, notice),
  ]);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      logger.error("delivery failed", {
        uid,
        kind: notice.kind,
        error: outcome.reason,
      });
    }
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
    await deliver(booking.ownerId, notice);
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
    await deliver(uid, notice);
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
    await deliver(request.to, notice);
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
    await deliver(request.from, notice);
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

// How many attempts a teardown gets before it stops asking. Retries are the
// entire reason this is a function, so the budget is generous — but an endless
// one means a person watching a bar that will never move, and Cloud Functions
// would keep re-running a failure for a week either way.
const MAX_TEARDOWN_ATTEMPTS = 5;

// Kept in the same shape as a client-written diagnostic even though admin
// bypasses the rule that pins it, so a stalled teardown lands where every other
// incident does. Fourteen days is the rule's ceiling and the TTL is the only
// thing that removes one.
const INCIDENT_KEEP_DAYS = 14;

// Leaving. The client writes `deletions/{uid}` and this dismantles the account
// with the Admin SDK — `retry: true` because the whole point is that it finishes
// without the person's participation. A browser doing this walked away mid-chain
// and left an account that still had a profile, friends and places, which the
// reaper then skipped forever: it collects only accounts with nothing attached.
//
// It reports its phase back into the document, which is both the progress bar
// the app draws and the only way a stuck teardown is visible at all.
export const onAccountDeletionRequested = onDocumentCreated(
  {
    document: "deletions/{uid}",
    region: REGION,
    retry: true,
    timeoutSeconds: 540,
  },
  async (event) => {
    const uid = event.params.uid;
    const ref = db.doc(`deletions/${uid}`);
    // Re-read rather than trusting the event: it carries the document as
    // CREATED, so it says nothing about what earlier attempts got through, and a
    // duplicate delivery after a finished teardown finds nothing here at all.
    const snap = await ref.get();
    if (!snap.exists) return;

    const attempts = (snap.data()?.attempts ?? 0) + 1;
    if (attempts > MAX_TEARDOWN_ATTEMPTS) {
      // Returning rather than throwing: more retries would repeat the same
      // failure, and the document has to survive to say so — it is what the app
      // is watching, and deleting it would report the account as gone.
      const detail = { attempts, phase: snap.data()?.phase ?? null };
      await ref.set({ error: "gave-up" }, { merge: true });
      logger.error("teardown: giving up", { uid, ...detail });
      await db.collection("debug").add({
        uid,
        kind: "teardown-stalled",
        detail: JSON.stringify(detail),
        at: Timestamp.now(),
        expires: Timestamp.fromMillis(
          Date.now() + INCIDENT_KEEP_DAYS * 86_400_000,
        ),
      });
      return;
    }

    // Before the work, so a run that dies without returning still spends from
    // the budget — the failures worth capping are the ones that take the
    // process with them.
    await ref.set({ attempts }, { merge: true });
    await tearDownAccount(uid);
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
