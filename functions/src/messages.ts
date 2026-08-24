// Pure decisions and rendering, no Firebase. Split out because the triggers need
// emulators, Auth accounts and SMTP to exercise, so in practice they never are —
// and the wording of a cancellation is exactly what quietly goes wrong.

export type NotifyKind =
  | "bookingRequested"
  | "bookingTaken"
  | "bookingDecision"
  | "stayCancelled"
  | "connectRequest"
  | "connectAccepted";

export type Party = "host" | "guest" | "recipient" | "sender";

// The OTHER party — never the person being emailed.
export type Person = {
  name: string;
  photoURL?: string | null;
};

export type Notice = {
  to: Party;
  kind: NotifyKind;
  subject: string;
  body: string;
  // A fragment path; `index.ts` owns the origin it's joined to.
  path: string;
  // Label on the button that follows `path`.
  cta: string;
  // Whose face belongs on this email — see `Person`.
  person: Person;
};

// Enough of a booking to decide what to say about it.
export type BookingLike = {
  status: string;
  start: string;
  end: string;
  ownerId: string;
  hostName?: string;
  hostPhotoURL?: string | null;
  guestName?: string;
  guestPhotoURL?: string | null;
  cancelledBy?: string | null;
  cancelReason?: string | null;
};

export type RequestLike = {
  fromName?: string;
  fromUsername?: string;
  fromPhotoURL?: string | null;
  portalId?: string | null;
  bookingId?: string | null;
};

// Real fragment routes — see `screenHash` in the web store.
const FRIENDS_PATH = "#/friends";
export const SETTINGS_PATH = "#/settings";

function bookingPath(bookingId: string): string {
  return `#/booking/${encodeURIComponent(bookingId)}`;
}

function personPath(uid: string): string {
  return `#/person/${encodeURIComponent(uid)}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// Parsed by hand, not with `Date`: `new Date("2026-08-14")` is UTC midnight and
// renders as the 13th west of Greenwich — the one day people would notice.
export function dateRange(start: string, end: string): string {
  return `${niceDate(start)} – ${niceDate(end)}`;
}

function niceDate(iso: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!parts) return iso;
  const month = MONTHS[Number(parts[2]) - 1];
  return month ? `${month} ${Number(parts[3])}` : iso;
}

export function firstName(name: string | undefined): string {
  return (name ?? "").split(" ")[0] || "Someone";
}

// Asking and instant-booking are separately switchable: one wants a decision,
// the other is only news.
export function noticeForNewBooking(
  booking: BookingLike,
  bookingId: string,
): Notice {
  const who = firstName(booking.guestName);
  const when = dateRange(booking.start, booking.end);
  // Whoever is asking; the host is the one reading.
  const person: Person = {
    name: booking.guestName || "Someone",
    photoURL: booking.guestPhotoURL,
  };

  if (booking.status === "CONFIRMED") {
    return {
      to: "host",
      kind: "bookingTaken",
      subject: `${who} booked your place`,
      body: `${who} took ${when}. It auto-accepts, so it's already confirmed — nothing for you to do.`,
      path: bookingPath(bookingId),
      cta: "See the booking",
      person,
    };
  }
  return {
    to: "host",
    kind: "bookingRequested",
    subject: `${who} asked to stay`,
    body: `${who} would like ${when}. Open kip to confirm or decline.`,
    path: bookingPath(bookingId),
    cta: "Review the request",
    person,
  };
}

// Null when there's nothing worth sending.
export function noticeForBookingChange(
  before: BookingLike,
  after: BookingLike,
  bookingId: string,
): Notice | null {
  if (before.status === after.status) return null;

  const when = dateRange(after.start, after.end);
  const host = firstName(after.hostName);
  const guest = firstName(after.guestName);
  const path = bookingPath(bookingId);
  // Every branch but the last is read by the guest; the last one flips.
  const theHost: Person = {
    name: after.hostName || "Someone",
    photoURL: after.hostPhotoURL,
  };

  if (after.status === "CONFIRMED") {
    return {
      to: "guest",
      kind: "bookingDecision",
      subject: `${host} confirmed your stay`,
      body: `You're all set for ${when}.`,
      path,
      cta: "See your booking",
      person: theHost,
    };
  }

  if (after.status !== "CANCELLED") return null;

  const byHost = after.cancelledBy === after.ownerId;
  const wasPending = before.status === "REQUESTED";

  if (wasPending) {
    // Withdrawing your own ask needs no announcement.
    if (!byHost) return null;
    if (after.cancelReason === "SLOT_MOVED") {
      return {
        to: "guest",
        kind: "bookingDecision",
        subject: "Those dates changed",
        body: `${host} moved the dates you asked about (${when}), so your request was cancelled. Open kip to see what's free now.`,
        path,
        cta: "See the request",
        person: theHost,
      };
    }
    return {
      to: "guest",
      kind: "bookingDecision",
      subject: `${host} couldn't host those dates`,
      body: `Your request for ${when} wasn't taken up.`,
      path,
      cta: "See the request",
      person: theHost,
    };
  }

  // Tell whichever side didn't do it.
  if (byHost) {
    return {
      to: "guest",
      kind: "stayCancelled",
      subject: "Your stay was cancelled",
      body: `${host} can no longer host ${when}.`,
      path,
      cta: "See the booking",
      person: theHost,
    };
  }
  return {
    to: "host",
    kind: "stayCancelled",
    subject: `${guest} cancelled their stay`,
    body: `${when} is free again.`,
    path,
    cta: "See the booking",
    person: {
      name: after.guestName || "Someone",
      photoURL: after.guestPhotoURL,
    },
  };
}

// How they reached you is the main thing you need in order to answer: a stranger
// with your link is not the person you hosted last month.
export function noticeForConnectRequest(request: RequestLike): Notice {
  const who = request.fromName || "Someone";
  const handle = request.fromUsername ? ` (@${request.fromUsername})` : "";
  const how = request.bookingId
    ? "You two have stayed together on kip."
    : request.portalId
      ? "They opened a link you shared."
      : "They found you by your username.";

  return {
    to: "recipient",
    kind: "connectRequest",
    subject: `${firstName(who)} wants to connect on kip`,
    body: `${who}${handle} asked to be friends. ${how} Open kip to accept or decline.`,
    path: FRIENDS_PATH,
    cta: "See the request",
    person: { name: who, photoURL: request.fromPhotoURL },
  };
}

// The friend edge the accept wrote, which the rules pin to the accepter's own
// profile — so this is their real name, not the sender's guess at it.
export type FriendLike = {
  uid: string;
  displayName?: string;
  photoURL?: string | null;
};

// Only the yes is announced. A decline deletes the same document and is not
// something the person who asked needs told.
export function noticeForConnectAccepted(friend: FriendLike): Notice {
  const who = friend.displayName || "Someone";
  return {
    to: "sender",
    kind: "connectAccepted",
    subject: `${firstName(who)} agreed to be friends`,
    body: `You and ${who} are connected on kip now, so you can see each other's places and ask to stay.`,
    path: personPath(friend.uid),
    cta: "See their profile",
    person: { name: who, photoURL: friend.photoURL },
  };
}

// Light values from the web palette; the dark ones sit in a media query below.
const TERRA = {
  canvas: "#f6f1ea",
  surface: "#ffffff",
  text: "#241a13",
  muted: "#8a7a6c",
  accent: "#dd5f38",
  accentSoft: "#fbeadf",
  accentInk: "#c14a25",
  gradient: "linear-gradient(135deg,#e2582f 0%,#ee8438 55%,#f6b24a 100%)",
} as const;

// Email clients won't load a webfont, so this is the closest native stack.
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

// Every gradient is painted over a solid of the same family, because clients
// that drop `background-image` would leave white text on nothing.
const ACCENT_FILL = `background-color:${TERRA.accent};background-image:${TERRA.gradient};`;

export type EmailAssets = {
  origin: string;
  // Null falls back to an initial in a circle.
  photoCid: string | null;
  // Required, not optional: an email without one looks fine and has no way out.
  unsubscribeUrl: string;
};

export type Email = {
  subject: string;
  text: string;
  html: string;
};

// Names, handles and dates all reach this from user-controlled documents.
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function linkTo(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, "")}/${path}`;
}

// A second copy of the web app's `NOTIFY_EVENTS` labels, since this package
// can't import across. A full Record, so a new kind can't reach the URL nameless.
export const NOTIFY_LABELS: Record<NotifyKind, string> = {
  bookingRequested: "Someone asks to stay",
  bookingTaken: "Someone books instantly",
  bookingDecision: "Your request is answered",
  stayCancelled: "A confirmed stay is called off",
  connectRequest: "Someone asks to be friends",
  connectAccepted: "Someone agrees to be friends",
};

// The web app's defaults, copied because this package can't import across — and
// the VALUES, not just the keys, because the read below has to answer for a kind
// nobody has stored anything for.
export const NOTIFY_DEFAULTS: Record<NotifyKind, boolean> = {
  bookingRequested: true,
  bookingTaken: true,
  bookingDecision: true,
  stayCancelled: true,
  connectRequest: true,
  connectAccepted: true,
};

// The four worth interrupting someone for. `bookingTaken` and `connectRequest`
// are news, to people who have an address anyway.
export type NotifySmsKind =
  | "bookingRequested"
  | "bookingDecision"
  | "stayCancelled"
  | "connectAccepted";

// Every one off: a verified number proves possession, never consent, so a text
// is sent only where a switch carrying the disclosures turned one on.
export const NOTIFY_SMS_DEFAULTS: Record<NotifySmsKind, boolean> = {
  bookingRequested: false,
  bookingDecision: false,
  stayCancelled: false,
  connectAccepted: false,
};

// Fails CLOSED on a kind it doesn't recognise. Reading the stored map directly
// answered `undefined` for a renamed key, and `!== false` took that for "not
// disabled" — so drift started sending to people who had opted out, where it now
// costs silence, which someone reports.
function wanted<Kind extends string>(
  defaults: Record<Kind, boolean>,
  stored: unknown,
  kind: string,
): boolean {
  if (!Object.hasOwn(defaults, kind)) return false;
  const map =
    typeof stored === "object" && stored
      ? (stored as Record<string, unknown>)
      : {};
  const chosen = map[kind];
  return typeof chosen === "boolean" ? chosen : defaults[kind as Kind];
}

export function wantsEmail(stored: unknown, kind: string): boolean {
  return wanted(NOTIFY_DEFAULTS, stored, kind);
}

export function wantsSms(stored: unknown, kind: string): boolean {
  return wanted(NOTIFY_SMS_DEFAULTS, stored, kind);
}

// Unrecognised is null, never a default — silencing the wrong thing is worse
// than not working. `hasOwn`, not `in`, or `?kind=toString` would pass.
export function asNotifyKind(value: unknown): NotifyKind | null {
  return typeof value === "string" && Object.hasOwn(NOTIFY_LABELS, value)
    ? (value as NotifyKind)
    : null;
}

// The URL carries its own authority, the same shape a portal has. It names ONE
// kind: silencing everything on the strength of one unwanted email is not what
// "unsubscribe from this" means.
export function unsubscribeLink(
  endpoint: string,
  uid: string,
  kind: NotifyKind,
  key: string,
): string {
  const query = new URLSearchParams({ uid, kind, key });
  return `${endpoint.replace(/\/+$/, "")}?${query}`;
}

// The machine path: what a provider POSTs unattended. The page's own form always
// says what it wants explicitly instead.
export const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";

// Both or neither — Gmail ignores `List-Unsubscribe` without the -Post header,
// so they're built together and can't drift apart.
export function unsubscribeHeaders(link: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${link}>`,
    "List-Unsubscribe-Post": ONE_CLICK_BODY,
  };
}

const KINDS = Object.keys(NOTIFY_LABELS) as NotifyKind[];

export type NotifyState = Record<NotifyKind, boolean>;

export const ALL_OFF: NotifyState = Object.fromEntries(
  KINDS.map((kind) => [kind, false]),
) as NotifyState;

// The same test the sender applies, so the page can't lie about what will
// actually arrive.
export function notifyStateFrom(stored: unknown): NotifyState {
  return Object.fromEntries(
    KINDS.map((kind) => [kind, wantsEmail(stored, kind)]),
  ) as NotifyState;
}

// An unexpected content type leaves the body raw, and reading only the parsed
// form would turn a full set of choices into an empty one.
function formFields(body: unknown): Map<string, string> {
  if (typeof body === "object" && body !== null) {
    return new Map(
      Object.entries(body as Record<string, unknown>).map(([name, value]) => [
        name,
        String(Array.isArray(value) ? value[0] : value),
      ]),
    );
  }
  return new Map(new URLSearchParams(String(body ?? "")));
}

// Anything unrecognised — RFC 8058's own body included — means the narrowest
// action, so an unfamiliar client can never widen one.
export type UnsubscribeIntent = "one" | "all" | "set";

export function formIntent(body: unknown): UnsubscribeIntent {
  const action = formFields(body).get("action");
  return action === "all" || action === "set" ? action : "one";
}

// HTML omits unticked checkboxes entirely, which is why the form lists them all.
export function notifyFromForm(body: unknown): NotifyState {
  const fields = formFields(body);
  return Object.fromEntries(
    KINDS.map((kind) => [kind, fields.has(kind)]),
  ) as NotifyState;
}

// Named in full, because "your choices are saved" says nothing about what will
// now arrive.
function listKinds(state: NotifyState): string {
  const names = KINDS.filter((kind) => state[kind]).map(
    (kind) => NOTIFY_LABELS[kind],
  );
  const last = names.pop();
  return names.length ? `${names.join(", ")} and ${last}` : (last ?? "");
}

// Self-contained because a function has no assets to serve. `no-referrer`
// because this page's own url carries the uid and key, which following the
// Settings link would otherwise leak — a fragment can't help, since the server
// has to read the key.
function unsubscribePage(heading: string, body: string, action: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(heading)} · kip</title>
<style>
:root { color-scheme: light dark; --rest-fill:#efe7dd; --rest-ink:#a08e7d; }
* { box-sizing:border-box; }
body { margin:0; background:${TERRA.canvas}; color:${TERRA.text}; font-family:${FONT}; }
.wrap { min-height:100vh; padding:48px 20px; display:flex; align-items:center; justify-content:center; }
.card { width:100%; max-width:460px; background:${TERRA.surface}; border-radius:26px; padding:34px 30px; box-shadow:0 18px 40px -22px rgba(60,32,16,.45), 0 2px 8px -3px rgba(60,32,16,.18); }
.brand { display:flex; align-items:center; gap:10px; margin-bottom:26px; }
.tile { width:34px; height:34px; border-radius:11px; ${ACCENT_FILL} color:#fff; font-weight:800; font-size:19px; line-height:34px; text-align:center; }
.name { font-weight:800; font-size:21px; letter-spacing:-.5px; }
h1 { margin:0; font-size:25px; line-height:32px; font-weight:800; letter-spacing:-.6px; }
p { margin:12px 0 0; font-size:16px; line-height:25px; }
.quiet { color:${TERRA.muted}; }
.act { margin:26px 0 0; }
.cta { display:inline-block; padding:14px 28px; border:0; border-radius:999px; ${ACCENT_FILL} color:#fff; font-family:inherit; font-weight:700; font-size:16px; line-height:20px; text-decoration:none; cursor:pointer; }
.label { margin:22px 0 4px; font-size:15px; font-weight:600; }
.row { position:relative; display:flex; align-items:center; gap:14px; padding:11px 0; cursor:pointer; }
.row .text { flex:1; min-width:0; font-size:15px; font-weight:600; line-height:21px; }
.row input { position:absolute; width:1px; height:1px; margin:0; opacity:0; }
.track { position:relative; flex:none; width:44px; height:26px; border-radius:999px; background:var(--rest-fill); }
.track::before { content:""; position:absolute; inset:0; border-radius:999px; ${ACCENT_FILL}opacity:0; transition:opacity .18s; }
.track::after { content:""; position:absolute; top:2px; left:2px; width:22px; height:22px; border-radius:999px; background:#fff; box-shadow:0 1px 2px rgba(50,25,8,.05); transition:transform .18s; }
.row input:checked ~ .track { box-shadow:0 6px 18px rgba(221,95,56,.34); }
.row input:checked ~ .track::before { opacity:1; }
.row input:checked ~ .track::after { transform:translateX(18px); }
.row input:focus-visible ~ .track { outline:2px solid ${TERRA.accent}; outline-offset:3px; }
.tag { display:inline-block; margin-left:8px; padding:2px 9px; border-radius:999px; background:${TERRA.accentSoft}; color:${TERRA.accentInk}; font-size:12px; font-weight:700; line-height:18px; vertical-align:2px; }
@media (prefers-reduced-motion: reduce) {
  .track::before, .track::after { transition:none; }
}
.save { margin-top:22px; }
/* Only ever set by the script at the foot of the form, so a page whose script
   didn't run has an ordinary working Save rather than one nothing can revive.
   Flat rather than faded: dropping opacity over the gradient left white text on
   pale orange and the label couldn't be read, so it wears the same neutral this
   page already gives a switch that's off. */
.save:disabled { background-image:none; background-color:var(--rest-fill); color:var(--rest-ink); cursor:default; }
.plain { display:block; margin:14px 0 0; padding:0; background:none; border:0; color:${TERRA.muted}; font-family:inherit; font-size:15px; text-decoration:underline; cursor:pointer; }
.after { margin-top:16px; font-size:15px; }
.after a { color:${TERRA.accentInk}; }
@media (prefers-color-scheme: dark) {
  :root { --rest-fill:#33291e; --rest-ink:#a9998a; }
  body { background:#161009; color:#f4ece2; }
  .card { background:#221a12; box-shadow:none; }
  .quiet { color:#a9998a; }
  .track::after { box-shadow:0 1px 2px rgba(0,0,0,.4); }
  .tag { background:#3b2417; color:#f4936c; }
  .plain { color:#a9998a; }
  .after a { color:#f4936c; }
}
</style>
</head>
<body>
<div class="wrap"><div class="card">
<div class="brand"><div class="tile">k</div><div class="name">kip</div></div>
<h1>${escapeHtml(heading)}</h1>
<p class="quiet">${escapeHtml(body)}</p>
${action}
</div></div>
</body>
</html>`;
}

// This page deliberately has no such link: a second one of equal weight beside
// "turn off all kip email" makes the destructive one easier to mis-hit.
function settingsButton(settingsUrl: string): string {
  return `<p class="act"><a class="cta" href="${escapeHtml(settingsUrl)}">Open kip Settings</a></p>`;
}

// The only script on any of these pages, and nothing depends on it: if it never
// runs, Save is simply always pressable and pressing it writes back the state
// already stored. It exists because CSS can style a disabled button but cannot
// make one, and a button that merely looks disabled is still announced as
// available to a screen reader and still submits on Enter. The `checked`
// ATTRIBUTE is the state a box was rendered with and doesn't move when clicked,
// so a box where that disagrees with `.checked` is a box someone moved.
const SAVE_SCRIPT = `<script>
const form = document.querySelector("form");
const boxes = [...form.querySelectorAll(".row input")];
const save = form.querySelector(".save");
const sync = () => {
  save.disabled = !boxes.some((box) => box.checked !== box.hasAttribute("checked"));
};
form.addEventListener("change", sync);
sync();
</script>`;

// Where a browser lands, once the click has already been honoured. The switches
// are what's left to decide, not a confirmation of what was asked for — someone
// who wants out usually wants out of more of it, and sending them to a sign-in
// to say so is how "report spam" happens. Which is also why the whole set is
// here: `state` is what's stored, and the kind this email was about is shown
// switched off because it now IS off, so the scope needs no wording to carry it.
// Re-ticking that row and saving is the undo.
export function renderUnsubscribeChoices(
  kind: NotifyKind,
  state: NotifyState,
  postUrl: string,
): string {
  const action = `action="${escapeHtml(postUrl)}"`;
  const saved: NotifyState = { ...state, [kind]: false };
  // A real checkbox, clipped rather than hidden so it keeps focus and keyboard
  // behaviour with no JavaScript — a hand-made copy of the app's `Switch`, since
  // a function has no build step to share one. The chip is what marks the row
  // this email came from, and it's permanent: an animation saying "we just
  // switched this off" would be over before the page is read, and while it ran
  // it drew the thumb in the ON position over a box that was already off, so a
  // tap landing in that window turned the row back on while appearing to do
  // nothing at all.
  const boxes = KINDS.map((each) => {
    const tag =
      each === kind ? '<span class="tag">from this email</span>' : "";
    return `<label class="row"><input type="checkbox" name="${each}" value="on"${saved[each] ? " checked" : ""}><span class="text">${escapeHtml(NOTIFY_LABELS[each])}${tag}</span><span class="track"></span></label>`;
  }).join("\n");

  return unsubscribePage(
    "Unsubscribed",
    `kip won't email you about "${NOTIFY_LABELS[kind]}" any more. Everything else is unchanged — change any of it below.`,
    `<p class="label">What kip emails you</p>
<form method="post" ${action}>
${boxes}
<button class="cta save" type="submit" name="action" value="set">Save these choices</button>
<button class="plain" type="submit" name="action" value="all">Turn off all kip email</button>
</form>
${SAVE_SCRIPT}`,
  );
}

// Names what's left on, since "saved" says nothing about what will now arrive.
export function renderNotifySaved(
  state: NotifyState,
  settingsUrl: string,
): string {
  const on = listKinds(state);
  return unsubscribePage(
    on ? "Choices saved" : "All kip email is off",
    on
      ? `kip will email you about: ${on}. Everything else is off.`
      : "kip won't email you about anything at all. Everything still happens in the app — you can turn any of it back on in Settings.",
    settingsButton(settingsUrl),
  );
}

// Names the one kind that was turned off, so nobody is left wondering whether
// they just silenced everything. The unattended path only: both of the page's
// own buttons carry an `action`, so a browser lands on `renderNotifySaved`.
export function renderUnsubscribed(
  kind: NotifyKind,
  settingsUrl: string,
): string {
  return unsubscribePage(
    "Unsubscribed",
    `kip won't email you about "${NOTIFY_LABELS[kind]}" any more. Everything else is unchanged, and you can turn this back on whenever you like.`,
    settingsButton(settingsUrl),
  );
}

// Every way of failing renders THIS — a key that doesn't match, a uid that was
// never a user, a kind kip doesn't have. Saying which would turn the endpoint
// into a way of asking whether an account exists, and none of the three is worth
// distinguishing to the person reading.
export function renderUnsubscribeFailed(settingsUrl: string): string {
  return unsubscribePage(
    "That link has expired",
    "This unsubscribe link no longer works. You can change exactly what kip emails you in Settings.",
    settingsButton(settingsUrl),
  );
}

// `Array.from` rather than `charAt`, so a name starting with an emoji or an
// astral-plane letter yields that character instead of half of it.
function initial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
}

function avatar(person: Person, photoCid: string | null): string {
  const name = escapeHtml(person.name);
  if (photoCid) {
    // Styled as the fallback too: with images blocked, the alt text lands in a
    // soft accent circle of the same size and still names the person.
    return `<img src="cid:${escapeHtml(photoCid)}" width="56" height="56" alt="${name}" style="width:56px;height:56px;border-radius:28px;background-color:${TERRA.accentSoft};color:${TERRA.accentInk};font:700 13px/56px ${FONT};text-align:center;display:block;">`;
  }
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="56" height="56" align="center" valign="middle" style="width:56px;height:56px;border-radius:28px;${ACCENT_FILL}color:#ffffff;font:800 24px/56px ${FONT};text-align:center;">${escapeHtml(initial(person.name))}</td></tr></table>`;
}

// One template for every event — the notice supplies the words, the link, the
// button and the face, and nothing here branches on which event it was.
export function renderEmail(notice: Notice, assets: EmailAssets): Email {
  const url = linkTo(assets.origin, notice.path);
  const subject = escapeHtml(notice.subject);
  const body = escapeHtml(notice.body);
  const person = escapeHtml(notice.person.name);
  const cta = escapeHtml(notice.cta);
  const href = escapeHtml(url);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${subject}</title>
<style>
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  .kip-canvas { background-color: #161009 !important; }
  .kip-card { background-color: #221a12 !important; }
  .kip-text { color: #f4ece2 !important; }
  .kip-muted { color: #a9998a !important; }
  .kip-link { color: #f4936c !important; }
}
</style>
</head>
<body class="kip-canvas" style="margin:0;padding:0;background-color:${TERRA.canvas};">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${TERRA.canvas};">${body}</div>
<table role="presentation" class="kip-canvas" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${TERRA.canvas};">
<tr><td align="center" style="padding:28px 12px 36px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td style="padding:0 6px 18px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="34" height="34" align="center" valign="middle" style="width:34px;height:34px;border-radius:11px;${ACCENT_FILL}color:#ffffff;font:800 19px/34px ${FONT};text-align:center;">k</td>
<td class="kip-text" style="padding-left:10px;font:800 21px/34px ${FONT};color:${TERRA.text};letter-spacing:-0.5px;">kip</td>
</tr></table>
</td></tr>
<tr><td class="kip-card" style="background-color:${TERRA.surface};border-radius:22px;padding:30px 28px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle" style="width:56px;">${avatar(notice.person, assets.photoCid)}</td>
<td class="kip-muted" valign="middle" style="padding-left:14px;font:600 15px/22px ${FONT};color:${TERRA.muted};">${person}</td>
</tr></table>
<p class="kip-text" style="margin:22px 0 0;font:800 25px/32px ${FONT};color:${TERRA.text};letter-spacing:-0.6px;">${subject}</p>
<p class="kip-text" style="margin:12px 0 0;font:400 16px/25px ${FONT};color:${TERRA.text};">${body}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:26px;"><tr>
<td align="center" style="border-radius:999px;${ACCENT_FILL}">
<a href="${href}" style="display:inline-block;padding:14px 30px;border-radius:999px;font:700 16px/20px ${FONT};color:#ffffff;text-decoration:none;">${cta}</a>
</td></tr></table>
</td></tr>
<tr><td class="kip-muted" style="padding:20px 12px 0;font:400 13px/20px ${FONT};color:${TERRA.muted};">
kip sends this because something happened that needs you. <a class="kip-link" href="${escapeHtml(assets.unsubscribeUrl)}" style="color:${TERRA.accentInk};">Unsubscribe</a>.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return {
    subject: notice.subject,
    // The word people look for, in both parts, pointing at the same place — and
    // not at Settings, which is behind a sign-in an unsubscribe must never need.
    text: `${notice.body}\n\n${notice.cta}: ${url}\n\nUnsubscribe: ${assets.unsubscribeUrl}`,
    html,
  };
}

// One non-GSM-7 character switches the whole message to UCS-2, where the
// 160-character segment becomes 70 — which every one of these would blow. Two
// live sources: the en dash `dateRange` emits, and display names, which are
// whatever someone typed.
const GSM_SUBSTITUTES: Record<string, string> = {
  "–": "-",
  "—": "-",
  "−": "-",
  "‘": "'",
  "’": "'",
  "‚": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "«": '"',
  "»": '"',
  "…": "...",
  "•": "-",
  "·": "-",
  "€": "EUR",
};

// The extension characters (^{}\[~]|) are GSM-7 but cost two septets each, which
// would make counting to 160 a lie; they are dropped with everything else.
const GSM_KEEP = /[A-Za-z0-9 !"#$%&'()*+,\-./:;<=>?@_]/;

export function toGsm7(text: string): string {
  // Decomposed first, so an accent is a mark to drop rather than a letter to
  // lose: é survives as e instead of disappearing.
  const substituted = Array.from(text.normalize("NFKD").replace(/\p{M}/gu, ""))
    .map((character) => GSM_SUBSTITUTES[character] ?? character)
    .join("");
  return Array.from(substituted)
    .filter((character) => GSM_KEEP.test(character))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

const SMS_SEGMENT = 160;
const TRUNCATION = "...";

// A subject is a name and then the wording that says what happened. The wording
// is short and fixed, the name is neither, so the name is the only part that is
// ever shortened — truncating from the right leaves a text that is half a name
// and a link, with nothing saying why it arrived.
//
// The split is made on the RAW subject, where the name is whatever `firstName`
// returned and so cannot contain a space. `toGsm7` can INTRODUCE one — it folds
// a non-breaking space, a newline and a tab into a plain space — so converting
// first and then looking for the boundary finds it inside the name, which is how
// a two-part name used to lose its first half and keep its second. The halves
// are converted apart and rejoined for the same reason.
function fitLeadingName(subject: string, budget: number): string {
  const space = subject.indexOf(" ");
  const name = toGsm7(space === -1 ? subject : subject.slice(0, space));
  const wording = toGsm7(space === -1 ? "" : subject.slice(space + 1));
  if (!wording) return name.slice(0, Math.max(budget, 0));
  if (!name) return wording.slice(0, Math.max(budget, 0));
  const room = budget - wording.length - 1;
  if (name.length <= room) return `${name} ${wording}`;
  // Nothing left to hold a name and an ellipsis: the wording goes alone rather
  // than the other way round.
  return room > TRUNCATION.length
    ? `${name.slice(0, room - TRUNCATION.length)}${TRUNCATION} ${wording}`
    : wording.slice(0, Math.max(budget, 0));
}

// Null for a kind with no text, so eligibility is one function's answer rather
// than a third table to drift. The subject already IS the one-line summary an
// SMS wants; the body is the same thing at length.
export function renderSms(notice: Notice, origin: string): string | null {
  if (!Object.hasOwn(NOTIFY_SMS_DEFAULTS, notice.kind)) return null;
  const url = linkTo(origin, notice.path);
  const summary = fitLeadingName(notice.subject, SMS_SEGMENT - url.length - 1);
  return summary ? `${summary} ${url}` : url;
}

// How long a text check may go on being retried. Comfortably past the deadline
// the CLIENT gives up at, because the server must never abandon a question
// while a spinner is still claiming it is being answered — but bounded, or a
// persistent failure (a credential that cannot be read is the realistic one)
// retries for days on a question nobody is waiting for. Same shape as the
// teardown's attempt budget: failure is capped and says so.
export const CHECK_ABANDON_MS = 600_000;

export type CheckStep = "skip" | "abandon" | "probe";

// A retried delivery replays the SAME event, so the snapshot it carries is
// stale — acting on it is exactly how a retry sends a second text. The caller
// therefore re-reads and asks again with fresh values.
export function checkStep(
  askedAt: number,
  answeredAt: number,
  now: number,
): CheckStep {
  if (askedAt <= answeredAt) return "skip";
  return now - askedAt > CHECK_ABANDON_MS ? "abandon" : "probe";
}
