// Pure decisions and rendering, no Firebase. Split out because the triggers need
// emulators, Auth accounts and SMTP to exercise, so in practice they never are —
// and the wording of a cancellation is exactly what quietly goes wrong.

export type NotifyKind =
  | "bookingRequested"
  | "bookingTaken"
  | "bookingDecision"
  | "stayCancelled"
  | "connectRequest";

export type Party = "host" | "guest" | "recipient";

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

// Named because the animation fades this value out alongside the fill.
const GLOW = "0 6px 18px rgba(221,95,56,.34)";

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
};

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

// Absence means "not disabled", the same test `recipientFor` applies. Derived
// rather than copying the web app's defaults, so the page can't lie about what
// will actually arrive.
export function notifyStateFrom(stored: unknown): NotifyState {
  const map: Record<string, unknown> =
    typeof stored === "object" && stored
      ? (stored as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    KINDS.map((kind) => [kind, map[kind] !== false]),
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
:root { color-scheme: light dark; }
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
.track { position:relative; flex:none; width:44px; height:26px; border-radius:999px; background:#efe7dd; }
.track::before { content:""; position:absolute; inset:0; border-radius:999px; ${ACCENT_FILL}opacity:0; transition:opacity .18s; }
.track::after { content:""; position:absolute; top:2px; left:2px; width:22px; height:22px; border-radius:999px; background:#fff; box-shadow:0 1px 2px rgba(50,25,8,.05); transition:transform .18s; }
.row input:checked ~ .track { box-shadow:${GLOW}; }
.row input:checked ~ .track::before { opacity:1; }
.row input:checked ~ .track::after { transform:translateX(18px); }
.row input:focus-visible ~ .track { outline:2px solid ${TERRA.accent}; outline-offset:3px; }
.tag { display:inline-block; margin-left:8px; padding:2px 9px; border-radius:999px; background:${TERRA.accentSoft}; color:${TERRA.accentInk}; font-size:12px; font-weight:700; line-height:18px; vertical-align:2px; }
@keyframes kip-glow { from { box-shadow:${GLOW}; } to { box-shadow:0 6px 18px rgba(221,95,56,0); } }
@keyframes kip-fill { from { opacity:1; } to { opacity:0; } }
@keyframes kip-thumb { from { transform:translateX(18px); } to { transform:none; } }
.origin input:not(:checked) ~ .track { animation:kip-glow .5s ease .6s both; }
.origin input:not(:checked) ~ .track::before { animation:kip-fill .5s ease .6s both; }
.origin input:not(:checked) ~ .track::after { animation:kip-thumb .5s cubic-bezier(.3,.7,.4,1) .6s both; }
@media (prefers-reduced-motion: reduce) {
  /* Selector for selector with the rule above: a shorter one loses on
     specificity however late it comes, and the animation would have played for
     exactly the people who asked for no animation. */
  .track::before, .track::after { transition:none; }
  .origin input:not(:checked) ~ .track, .origin input:not(:checked) ~ .track::before, .origin input:not(:checked) ~ .track::after { animation:none; }
}
.save { margin-top:22px; }
.plain { display:block; margin:14px 0 0; padding:0; background:none; border:0; color:${TERRA.muted}; font-family:inherit; font-size:15px; text-decoration:underline; cursor:pointer; }
.after { margin-top:16px; font-size:15px; }
.after a { color:${TERRA.accentInk}; }
@media (prefers-color-scheme: dark) {
  body { background:#161009; color:#f4ece2; }
  .card { background:#221a12; box-shadow:none; }
  .quiet { color:#a9998a; }
  .track { background:#33291e; }
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

// The asking page deliberately has no such link: a second one of equal weight
// beside "turn off all kip email" makes the destructive one easier to mis-hit.
function settingsButton(settingsUrl: string): string {
  return `<p class="act"><a class="cta" href="${escapeHtml(settingsUrl)}">Open kip Settings</a></p>`;
}

// Changes nothing — it asks. Link scanners fetch every url in a message, so a
// GET that acted would unsubscribe people who never clicked. Shows the whole set,
// since someone who wants out usually wants out of all of it, and sending them to
// a sign-in to say so is how "report spam" happens. The kind this email was about
// arrives already switched off, so the scope is visible in the switches rather
// than carried by the wording of two near-identical buttons.
// Because pressing a button is no longer itself the action, the page has to say
// so in words, or someone who closes the tab leaves believing they unsubscribed.
export function renderUnsubscribeAsk(
  kind: NotifyKind,
  state: NotifyState,
  postUrl: string,
): string {
  const action = `action="${escapeHtml(postUrl)}"`;
  const proposed: NotifyState = { ...state, [kind]: false };
  // A real checkbox, clipped rather than hidden so it keeps focus and keyboard
  // behaviour with no JavaScript — a hand-made copy of the app's `Switch`, since
  // a function has no build step to share one. The chip is the load-bearing half
  // of "this is the row you came from"; the animation is decoration, and is
  // scoped to `:not(:checked)` so re-ticking a row drops it mid-flight rather
  // than sliding a thumb off a box the reader has just turned on.
  const boxes = KINDS.map((each) => {
    const origin = each === kind;
    const tag = origin ? '<span class="tag">from this email</span>' : "";
    return `<label class="row${origin ? " origin" : ""}"><input type="checkbox" name="${each}" value="on"${proposed[each] ? " checked" : ""}><span class="text">${escapeHtml(NOTIFY_LABELS[each])}${tag}</span><span class="track"></span></label>`;
  }).join("\n");

  return unsubscribePage(
    "Unsubscribe",
    `We've switched off "${NOTIFY_LABELS[kind]}" below. Nothing is saved until you press Save.`,
    `<p class="label">What kip emails you</p>
<form method="post" ${action}>
${boxes}
<button class="cta save" type="submit" name="action" value="set">Save these choices</button>
<button class="plain" type="submit" name="action" value="all">Turn off all kip email</button>
</form>`,
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
// they just silenced everything. Answers the POST — from a provider acting
// unattended and from the form above alike, so a person sees the same ending
// whichever route they came by.
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
