import { describe, expect, it } from "bun:test";
import {
  ALL_OFF,
  asNotifyKind,
  dateRange,
  formIntent,
  linkTo,
  NOTIFY_LABELS,
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
} from "../../functions/src/messages";
import { NOTIFY_EVENTS } from "../utils/types";

// The notification triggers themselves need emulators, real Auth accounts and an
// SMTP server, so in practice they never get exercised — which is how they sat
// entirely untested up to the point of being deployed. The DECISIONS they make
// don't need any of that, so they live in a pure module and get tested here:
// which of the two parties hears about something, under which preference, what
// it actually says, which screen it points at, whose face it carries, and how it
// renders — all of which are decisions, and none of which need a network.

const HOST_PHOTO = "https://lh3.googleusercontent.com/host";
const GUEST_PHOTO = "https://lh3.googleusercontent.com/guest";

const booking = {
  status: "REQUESTED",
  start: "2026-08-14",
  end: "2026-08-19",
  ownerId: "host",
  hostName: "Maya Rivera",
  hostPhotoURL: HOST_PHOTO as string | null,
  guestName: "Sam Okafor",
  guestPhotoURL: GUEST_PHOTO as string | null,
  cancelledBy: null as string | null,
  cancelReason: null as string | null,
};

const BOOKING_ID = "bk_42";

describe("dates as people read them", () => {
  it("renders a range the way the app does", () => {
    expect(dateRange("2026-08-14", "2026-08-19")).toBe("Aug 14 – Aug 19");
  });

  // `new Date("2026-08-14")` is UTC midnight, which prints as the 13th anywhere
  // west of Greenwich. Parsing the string by hand is what avoids that, and this
  // is the case that would catch a regression back to Date.
  it("doesn't shift a date by a timezone", () => {
    expect(dateRange("2026-01-01", "2026-01-02")).toBe("Jan 1 – Jan 2");
  });

  it("passes anything that isn't an ISO date straight through", () => {
    expect(dateRange("soon", "later")).toBe("soon – later");
  });
});

describe("a booking appearing", () => {
  it("an ask goes to the host, needing a decision", () => {
    const notice = noticeForNewBooking(booking, BOOKING_ID);
    expect(notice.to).toBe("host");
    expect(notice.kind).toBe("bookingRequested");
    expect(notice.subject).toBe("Sam asked to stay");
    expect(notice.body).toContain("confirm or decline");
  });

  // Separately switchable, because one wants something from you and the other
  // is just news.
  it("an instant booking is news, under its own preference", () => {
    const notice = noticeForNewBooking(
      { ...booking, status: "CONFIRMED" },
      BOOKING_ID,
    );
    expect(notice.to).toBe("host");
    expect(notice.kind).toBe("bookingTaken");
    expect(notice.body).toContain("nothing for you to do");
  });

  it("falls back gracefully when a name is missing", () => {
    const notice = noticeForNewBooking(
      { ...booking, guestName: undefined },
      BOOKING_ID,
    );
    expect(notice.subject).toBe("Someone asked to stay");
  });
});

describe("a booking changing", () => {
  const confirmed = { ...booking, status: "CONFIRMED" };
  const cancelledByHost = {
    ...booking,
    status: "CANCELLED",
    cancelledBy: "host",
  };
  const cancelledByGuest = {
    ...booking,
    status: "CANCELLED",
    cancelledBy: "guest",
  };

  it("says nothing when the status didn't move", () => {
    expect(
      noticeForBookingChange(booking, { ...booking }, BOOKING_ID),
    ).toBeNull();
  });

  it("a confirmation goes to the guest", () => {
    const notice = noticeForBookingChange(booking, confirmed, BOOKING_ID);
    expect(notice?.to).toBe("guest");
    expect(notice?.kind).toBe("bookingDecision");
    expect(notice?.subject).toBe("Maya confirmed your stay");
  });

  it("a decline goes to the guest", () => {
    const notice = noticeForBookingChange(
      booking,
      { ...cancelledByHost, cancelReason: "DECLINED" },
      BOOKING_ID,
    );
    expect(notice?.to).toBe("guest");
    expect(notice?.subject).toContain("couldn't host");
  });

  // Distinct from a decline: nothing was refused, and there may well be other
  // dates worth asking about — so it points them back rather than apologising.
  it("moved dates read differently from a decline", () => {
    const notice = noticeForBookingChange(
      booking,
      { ...cancelledByHost, cancelReason: "SLOT_MOVED" },
      BOOKING_ID,
    );
    expect(notice?.subject).toBe("Those dates changed");
    expect(notice?.body).toContain("see what's free now");
  });

  it("a guest withdrawing their own ask tells nobody", () => {
    expect(
      noticeForBookingChange(booking, cancelledByGuest, BOOKING_ID),
    ).toBeNull();
  });

  it("a host calling off a confirmed stay tells the guest", () => {
    const notice = noticeForBookingChange(
      confirmed,
      { ...cancelledByHost, cancelReason: "STAY_CANCELLED" },
      BOOKING_ID,
    );
    expect(notice?.to).toBe("guest");
    expect(notice?.kind).toBe("stayCancelled");
    expect(notice?.subject).toBe("Your stay was cancelled");
  });

  // The mirror case — and the one most easily got backwards, since both are a
  // confirmed stay ending.
  it("a guest cancelling a confirmed stay tells the host", () => {
    const notice = noticeForBookingChange(
      confirmed,
      { ...cancelledByGuest, cancelReason: "STAY_CANCELLED" },
      BOOKING_ID,
    );
    expect(notice?.to).toBe("host");
    expect(notice?.kind).toBe("stayCancelled");
    expect(notice?.subject).toBe("Sam cancelled their stay");
    expect(notice?.body).toContain("free again");
  });

  it("says nothing about a status kip doesn't recognise", () => {
    expect(
      noticeForBookingChange(
        booking,
        { ...booking, status: "WEIRD" },
        BOOKING_ID,
      ),
    ).toBeNull();
  });
});

describe("a connect request", () => {
  it("names how they reached you — by handle", () => {
    const notice = noticeForConnectRequest({
      fromName: "Priya Raman",
      fromUsername: "priya_r",
      portalId: null,
    });
    expect(notice.to).toBe("recipient");
    expect(notice.subject).toBe("Priya wants to connect on kip");
    expect(notice.body).toContain("(@priya_r)");
    expect(notice.body).toContain("found you by your username");
  });

  it("names how they reached you — by link", () => {
    const notice = noticeForConnectRequest({
      fromName: "Priya Raman",
      fromUsername: "",
      portalId: "abc123",
    });
    expect(notice.body).toContain("opened a link you shared");
    // No handle claimed, so none shown — rather than a dangling "(@)".
    expect(notice.body).not.toContain("(@");
  });

  // The third route in — a host and their share-link guest are the one pair
  // neither of the others can serve. Its copy was missed when the route was
  // added, so a real request read "They found you by your username" to someone
  // who has no username and was never searched for.
  it("names how they reached you — through a stay you shared", () => {
    const notice = noticeForConnectRequest({
      fromName: "Priya Raman",
      fromUsername: "",
      portalId: null,
      bookingId: "bk1",
    });
    expect(notice.body).toContain("stayed together");
    expect(notice.body).not.toContain("username");
  });

  it("survives a sender with no name at all", () => {
    const notice = noticeForConnectRequest({});
    expect(notice.subject).toBe("Someone wants to connect on kip");
  });
});

// An email that says something happened and leaves you to go and find it is half
// an email. Every one carries a deep link to the exact screen — which the app's
// fragment routes make possible — so these pin that each event points at the
// right one.
describe("what each email links to", () => {
  const confirmed = { ...booking, status: "CONFIRMED" };

  it("a new booking points at that booking", () => {
    const notice = noticeForNewBooking(booking, BOOKING_ID);
    expect(notice.path).toBe("#/booking/bk_42");
    expect(notice.cta).toBe("Review the request");
  });

  it("a confirmation points at that booking", () => {
    const notice = noticeForBookingChange(booking, confirmed, BOOKING_ID);
    expect(notice?.path).toBe("#/booking/bk_42");
  });

  it("a cancellation points at that booking, from either side", () => {
    const byHost = noticeForBookingChange(
      confirmed,
      { ...confirmed, status: "CANCELLED", cancelledBy: "host" },
      BOOKING_ID,
    );
    const byGuest = noticeForBookingChange(
      confirmed,
      { ...confirmed, status: "CANCELLED", cancelledBy: "guest" },
      BOOKING_ID,
    );
    expect(byHost?.path).toBe("#/booking/bk_42");
    expect(byGuest?.path).toBe("#/booking/bk_42");
  });

  // A connect request has no page of its own — Friends is where it's answered.
  it("a connect request points at Friends", () => {
    const notice = noticeForConnectRequest({ fromName: "Priya Raman" });
    expect(notice.path).toBe("#/friends");
    expect(notice.cta).toBe("See the request");
  });

  it("an id that needs escaping survives the trip", () => {
    const notice = noticeForNewBooking(booking, "bk/42 43");
    expect(notice.path).toBe("#/booking/bk%2F42%2043");
  });
});

// The face on an email is always the OTHER party's — the person who did the
// thing being reported. Getting this backwards would show people their own photo
// and tell them nothing, and both directions of a cancellation exist precisely so
// it can be got backwards.
describe("whose photo the email carries", () => {
  const confirmed = { ...booking, status: "CONFIRMED" };

  it("an ask shows the host the guest who asked", () => {
    const notice = noticeForNewBooking(booking, BOOKING_ID);
    expect(notice.person).toEqual({
      name: "Sam Okafor",
      photoURL: GUEST_PHOTO,
    });
  });

  it("a confirmation shows the guest the host who confirmed", () => {
    const notice = noticeForBookingChange(booking, confirmed, BOOKING_ID);
    expect(notice?.person.photoURL).toBe(HOST_PHOTO);
  });

  it("a host calling off a stay shows the guest the host", () => {
    const notice = noticeForBookingChange(
      confirmed,
      { ...confirmed, status: "CANCELLED", cancelledBy: "host" },
      BOOKING_ID,
    );
    expect(notice?.to).toBe("guest");
    expect(notice?.person.photoURL).toBe(HOST_PHOTO);
  });

  it("a guest cancelling shows the host the guest", () => {
    const notice = noticeForBookingChange(
      confirmed,
      { ...confirmed, status: "CANCELLED", cancelledBy: "guest" },
      BOOKING_ID,
    );
    expect(notice?.to).toBe("host");
    expect(notice?.person.photoURL).toBe(GUEST_PHOTO);
  });

  it("a connect request shows the sender", () => {
    const notice = noticeForConnectRequest({
      fromName: "Priya Raman",
      fromPhotoURL: "https://lh3.googleusercontent.com/priya",
    });
    expect(notice.person.photoURL).toBe(
      "https://lh3.googleusercontent.com/priya",
    );
  });

  it("survives a party with no photo at all", () => {
    const notice = noticeForNewBooking(
      { ...booking, guestPhotoURL: null },
      BOOKING_ID,
    );
    expect(notice.person.photoURL).toBeNull();
  });
});

describe("rendering an email", () => {
  const notice = noticeForNewBooking(booking, BOOKING_ID);
  const ORIGIN = "https://hafaio.github.io/kip";
  const UNSUB =
    "https://us-central1-hafaio-kip-dev.cloudfunctions.net/unsubscribe?uid=host&kind=bookingRequested&key=k1";
  const withPhoto = renderEmail(notice, {
    origin: ORIGIN,
    photoCid: "kip-photo",
    unsubscribeUrl: UNSUB,
  });
  const withoutPhoto = renderEmail(notice, {
    origin: ORIGIN,
    photoCid: null,
    unsubscribeUrl: UNSUB,
  });

  // The site is served under a base path, so a link that drops it 404s.
  it("joins the fragment path onto the origin, base path and all", () => {
    expect(linkTo(ORIGIN, "#/booking/bk_42")).toBe(
      "https://hafaio.github.io/kip/#/booking/bk_42",
    );
    expect(linkTo("https://hafaio.github.io/kip/", "#/friends")).toBe(
      "https://hafaio.github.io/kip/#/friends",
    );
  });

  it("carries the link and the button in the HTML", () => {
    expect(withPhoto.html).toContain(
      'href="https://hafaio.github.io/kip/#/booking/bk_42"',
    );
    expect(withPhoto.html).toContain("Review the request");
  });

  // The plain-text part is what a client that refuses HTML shows, so it has to
  // stand on its own — link included.
  it("keeps a plain-text alternative that still links", () => {
    expect(withPhoto.text).toContain("Sam would like");
    expect(withPhoto.text).toContain(
      "Review the request: https://hafaio.github.io/kip/#/booking/bk_42",
    );
  });

  // "Unsubscribe" is the word people look for, and it goes to the endpoint a
  // provider can also POST — not to Settings, which is behind a sign-in that an
  // unsubscribe must never require. Both parts, or the text one silently keeps
  // sending people somewhere they can't act.
  it("offers one Unsubscribe link, in both parts, pointing at the endpoint", () => {
    expect(withPhoto.html).toContain(
      `<a class="kip-link" href="${UNSUB.replaceAll("&", "&amp;")}"`,
    );
    expect(withPhoto.html).toContain(">Unsubscribe</a>");
    expect(withPhoto.text).toContain(`Unsubscribe: ${UNSUB}`);
    for (const part of [withPhoto.html, withPhoto.text]) {
      expect(part).not.toContain("#/settings");
      expect(part).not.toContain("turn these off");
    }
  });

  // Most clients block remote images by default, and some people block them
  // always — the email still has to say who this is about.
  it("names the person whether the photo loads, is blocked, or is absent", () => {
    expect(withPhoto.html).toContain('src="cid:kip-photo"');
    expect(withPhoto.html).toContain('alt="Sam Okafor"');
    expect(withPhoto.html).toContain("Sam Okafor");
    // No photo at all degrades to an initial in a circle, beside the name.
    expect(withoutPhoto.html).not.toContain("cid:");
    expect(withoutPhoto.html).toContain(">S<");
    expect(withoutPhoto.html).toContain("Sam Okafor");
  });

  // The whole reason for the CID attachment: a kip photo URL is an unguessable
  // bearer capability, and anything in an email is fetched by the recipient's
  // client (Gmail proxies and caches it), which hands the capability out.
  it("never puts the photo URL in the email", () => {
    expect(withPhoto.html).not.toContain(GUEST_PHOTO);
    expect(withPhoto.text).not.toContain(GUEST_PHOTO);
    expect(withoutPhoto.html).not.toContain(GUEST_PHOTO);
  });

  // A display name is pinned to a real profile, not to anything safe.
  it("escapes a name that is trying to be markup", () => {
    const hostile = renderEmail(
      noticeForNewBooking(
        { ...booking, guestName: "<script>alert('x')</script>" },
        BOOKING_ID,
      ),
      { origin: ORIGIN, photoCid: null, unsubscribeUrl: UNSUB },
    );
    expect(hostile.html).not.toContain("<script>");
    expect(hostile.html).toContain("&lt;script&gt;");
  });

  // Email clients are not browsers: no flexbox, no grid, no external stylesheet,
  // no webfont, and a gradient that several of them drop — so anything that has
  // to stay legible sits on a solid colour underneath.
  it("stays inside what an email client can render", () => {
    expect(withPhoto.html).not.toContain("display:flex");
    expect(withPhoto.html).not.toContain("<link");
    expect(withPhoto.html).toContain("<table");
    expect(withPhoto.html).toContain(
      "background-color:#dd5f38;background-image:",
    );
    expect(withPhoto.html).toContain("prefers-color-scheme: dark");
  });

  // One template, driven by the notice — every event renders through the same
  // shape, so the only differences are the words, the link and the face.
  it("renders every event through the same template", () => {
    const connect = renderEmail(
      noticeForConnectRequest({ fromName: "Priya Raman" }),
      { origin: ORIGIN, photoCid: null, unsubscribeUrl: UNSUB },
    );
    expect(connect.html).toContain("Priya Raman");
    expect(connect.html).toContain(
      'href="https://hafaio.github.io/kip/#/friends"',
    );
    expect(connect.subject).toBe("Priya wants to connect on kip");
  });
});

// One-click unsubscribe (RFC 8058). The half that can be tested here is the half
// that decides: what the link says, that the two headers agree, and that exactly
// one kind is ever named. The endpoint itself — the key comparison, the lazy
// mint, the write — needs Firestore, so it isn't reachable from this suite.
describe("the unsubscribe link", () => {
  const ENDPOINT =
    "https://us-central1-hafaio-kip-dev.cloudfunctions.net/unsubscribe";
  const KEY = "0f2f1a3e-5c9d-4c2b-9d47-2b3f7a1c8e10";

  it("carries the recipient, the one kind, and the key", () => {
    expect(unsubscribeLink(ENDPOINT, "uid_1", "bookingTaken", KEY)).toBe(
      `${ENDPOINT}?uid=uid_1&kind=bookingTaken&key=${KEY}`,
    );
  });

  it("escapes a uid that is trying to add a second kind", () => {
    const link = unsubscribeLink(
      ENDPOINT,
      "a&kind=stayCancelled",
      "bookingTaken",
      KEY,
    );
    expect(link).toContain("uid=a%26kind%3DstayCancelled");
    expect(link.split("kind=")).toHaveLength(2);
  });

  it("tolerates a trailing slash on the endpoint", () => {
    expect(
      unsubscribeLink(`${ENDPOINT}/`, "uid_1", "connectRequest", KEY),
    ).toBe(`${ENDPOINT}?uid=uid_1&kind=connectRequest&key=${KEY}`);
  });

  // Gmail ignores List-Unsubscribe unless the -Post header sits beside it, so a
  // pair that drifts apart is a feature that silently stops existing.
  it("announces one-click on the same url a human would click", () => {
    const link = unsubscribeLink(ENDPOINT, "uid_1", "bookingRequested", KEY);
    const headers = unsubscribeHeaders(link);
    expect(headers["List-Unsubscribe"]).toBe(`<${link}>`);
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  // It points at the function, not the app: Settings is behind a sign-in and a
  // one-click POST arrives with no session at all.
  it("points somewhere a mail provider can POST", () => {
    const headers = unsubscribeHeaders(
      unsubscribeLink(ENDPOINT, "uid_1", "bookingRequested", KEY),
    );
    expect(headers["List-Unsubscribe"]).not.toContain("#/settings");
    expect(headers["List-Unsubscribe"]).toContain("/unsubscribe?");
  });

  it("only recognises kinds that exist", () => {
    for (const kind of Object.keys(NOTIFY_LABELS)) {
      expect(asNotifyKind(kind)).toBe(kind as never);
    }
    for (const junk of ["", "all", "everything", "toString", "__proto__"]) {
      expect(asNotifyKind(junk)).toBeNull();
    }
    expect(asNotifyKind(undefined)).toBeNull();
    expect(asNotifyKind(["bookingTaken"])).toBeNull();
  });
});

// Kin to the checks in `drift.test.ts`, and here for the same reason those exist:
// `functions/` is a separate package and keeps its own copy of this vocabulary.
// The page now lists every kind, so it reads as a second Settings screen — and
// two screens naming the same switch differently is a bug you only notice by
// having both open. Cosmetic, unlike a key mismatch, which is why it's a
// same-words check rather than anything cleverer.
describe("both settings surfaces name the switches the same way", () => {
  it("labels match the web app's", () => {
    expect(NOTIFY_LABELS).toEqual(
      Object.fromEntries(
        Object.entries(NOTIFY_EVENTS).map(([kind, event]) => [
          kind,
          event.label,
        ]),
      ) as typeof NOTIFY_LABELS,
    );
  });
});

describe("the page a link lands on", () => {
  const POST_URL =
    "https://us-central1-hafaio-kip-dev.cloudfunctions.net/unsubscribe?uid=uid_1&kind=stayCancelled&key=k1";
  const ACTION = `action="${POST_URL.replaceAll("&", "&amp;")}"`;
  // As stored: this person already turned instant-booking news off.
  const stored = notifyStateFrom({ bookingTaken: false });
  const ask = renderUnsubscribeAsk("stayCancelled", stored, POST_URL);

  const checkedKinds = (page: string): string[] =>
    [...page.matchAll(/name="(\w+)" value="on"( checked)?/g)]
      .filter((row) => row[2])
      .map((row) => row[1]);

  // The whole point of the GET: mail passes through link scanners and security
  // proxies that fetch every url in a message, and a page that acted on being
  // fetched would unsubscribe people who never clicked. So this one only offers.
  it("changes nothing, and says so", () => {
    expect(ask).toContain("Unsubscribe");
    expect(ask).toContain("Nothing is saved until you press Save");
    expect(ask).not.toContain("Unsubscribed");
    expect(ask).not.toContain("won&#39;t email you");
  });

  // The scope used to be carried by wording alone — "turn off these emails"
  // above "turn off all kip email", two sentences a reader had to tell apart.
  // Now the switch itself shows it: the kind that email was about arrives off.
  it("arrives with the kind that email was about already switched off", () => {
    expect(ask).toContain(`We&#39;ve switched off &quot;${NOTIFY_LABELS.stayCancelled}&quot; below`);
    expect(checkedKinds(ask)).toEqual([
      "bookingRequested",
      "bookingDecision",
      "connectRequest",
    ]);
  });

  // Pre-marking is only safe if saving it means what it looks like: turn off
  // that one, leave every other switch exactly where the reader found it.
  it("saves as the one change it showed, and nothing else", () => {
    const submitted = checkedKinds(ask)
      .map((kind) => `${kind}=on`)
      .concat("action=set")
      .join("&");
    expect(formIntent(submitted)).toBe("set");
    expect(notifyFromForm(submitted)).toEqual({
      ...stored,
      stayCancelled: false,
    });
  });

  // One loud button now, so there is nothing left for it to be confused with.
  it("has a single primary action, with the wider one kept quiet", () => {
    expect(ask).toContain(
      '<button class="cta save" type="submit" name="action" value="set">',
    );
    expect(ask).toContain(
      '<button class="plain" type="submit" name="action" value="all">',
    );
    expect(ask.match(/class="cta/g)).toHaveLength(1);
  });

  // Acting is one request to one url — the same one the header advertises.
  it("posts to the url it came from", () => {
    expect(ask).toContain(`<form method="post" ${ACTION}>`);
    expect(ask.match(/<form/g)).toHaveLength(1);
  });

  // The page no longer sends RFC 8058's body — it says what it wants outright.
  // The provider path is untouched all the same, which is the thing that must
  // not move: the header still promises one-click, and one-click still means the
  // single kind the url names.
  it("leaves the unattended one-click path exactly as it was", () => {
    expect(ask).not.toContain("List-Unsubscribe");
    expect(unsubscribeHeaders(POST_URL)["List-Unsubscribe-Post"]).toBe(
      ONE_CLICK_BODY,
    );
    expect(formIntent(ONE_CLICK_BODY)).toBe("one");
  });

  // The switch is drawn beside a real checkbox rather than replacing it: the
  // input is what a form with no JavaScript submits, what a keyboard toggles,
  // and what a screen reader announces. Clipped, never `display:none`, or it
  // stops being focusable — and then the track has to show that focus itself.
  it("draws a switch without giving up the control underneath", () => {
    expect(ask).not.toContain("display:none");
    expect(ask).toContain(".row input:checked ~ .track");
    expect(ask).toContain(".row input:focus-visible ~ .track");
    // ON is the app's gradient, over a solid of the same family. It sits on its
    // own layer so the animation below can fade it — a gradient can't be
    // interpolated to a flat colour, but an opacity can.
    expect(ask).toContain(
      '.track::before { content:""; position:absolute; inset:0; border-radius:999px; background-color:#dd5f38;background-image:',
    );
    expect(ask).toContain(".row input:checked ~ .track::before { opacity:1; }");
    expect(ask).toContain("prefers-reduced-motion");
  });

  // The mark is the half that has to work: it's still there a minute later, and
  // under reduced motion it's the only thing left. The animation explains
  // nothing on its own — it's already over by the time anyone reads the page.
  it("marks the row this email came from", () => {
    expect(ask).toContain('<label class="row origin">');
    expect(ask.match(/class="tag"/g)).toHaveLength(1);
    const originRow = ask
      .split('<label class="row origin">')[1]
      .split("</label>")[0];
    expect(originRow).toContain(NOTIFY_LABELS.stayCancelled);
    expect(originRow).toContain(">from this email<");
    expect(originRow).not.toContain(" checked");
  });

  // Scoped to `:not(:checked)`, so ticking that row mid-flight drops the
  // animation and the live state takes over. A thumb still sliding off a box the
  // reader has just switched back on would be showing them something untrue.
  it("plays the switch off once, and lets a live toggle win", () => {
    expect(ask).toContain(
      ".origin input:not(:checked) ~ .track::after { animation:kip-thumb",
    );
    expect(ask).toContain(
      ".origin input:not(:checked) ~ .track::before { animation:kip-fill",
    );
    // One shot that holds where it lands, never a loop.
    expect(ask).toContain(".6s both;");
    expect(ask).not.toContain("infinite");
    // Reduced motion leaves the row simply off, wearing its mark — and the
    // override has to repeat `:not(:checked)`, or it loses on specificity and
    // the animation plays for precisely the people who asked for none.
    expect(ask).toContain(
      ".origin input:not(:checked) ~ .track, .origin input:not(:checked) ~ .track::before, .origin input:not(:checked) ~ .track::after { animation:none; }",
    );
  });

  // Some clients open these in a stripped browser, so nothing here can be a
  // script — and there is nothing to fetch either way.
  it("needs no JavaScript, and is self-contained", () => {
    expect(ask).not.toContain("<script");
    expect(ask).not.toContain("onclick");
    expect(ask).not.toContain("<link");
    expect(ask).not.toContain("src=");
    // The form action and nothing else — no Settings link here, so the only
    // thing of equal weight beside "turn off all kip email" is the save.
    expect(ask.match(/https?:\/\/[^"\s]+/g)).toEqual([
      POST_URL.replaceAll("&", "&amp;"),
    ]);
  });

  // This page's own url carries the uid and the key; following a link away
  // would otherwise hand both to wherever it went in a Referer header.
  it("doesn't leak its own url onwards", () => {
    expect(ask).toContain('<meta name="referrer" content="no-referrer">');
  });
});

// A POST body decides how much it changes, and the narrowest reading wins: the
// body a provider sends carries no `action` at all, so anything unfamiliar turns
// off one kind rather than all of them.
describe("what a posted form asks for", () => {
  it("reads RFC 8058's own body as the single kind", () => {
    expect(formIntent("List-Unsubscribe=One-Click")).toBe("one");
    expect(formIntent({ "List-Unsubscribe": "One-Click" })).toBe("one");
  });

  it("reads an empty, absent or unfamiliar body as the single kind", () => {
    for (const body of ["", {}, undefined, null, "action=everything", 7]) {
      expect(formIntent(body)).toBe("one");
    }
  });

  it("reads the page's two wider buttons", () => {
    expect(formIntent("action=set")).toBe("set");
    expect(formIntent({ action: "all" })).toBe("all");
  });

  // A ticked box is a kind still worth emailing about; an absent one is off,
  // which is how HTML sends checkboxes — so the form lists every kind.
  it("takes the ticked boxes as the whole set", () => {
    expect(notifyFromForm("action=set&bookingTaken=on&stayCancelled=on")).toEqual({
      bookingRequested: false,
      bookingTaken: true,
      bookingDecision: false,
      stayCancelled: true,
      connectRequest: false,
    });
    expect(notifyFromForm({ action: "set" })).toEqual(ALL_OFF);
  });

  // The exact bodies a real browser sent when each button on the page was
  // clicked. Note the all-off button carries the ticked boxes with it, since
  // they share a form — so "all" has to mean all regardless of them, which is
  // why the handler writes a fixed set rather than reading this one.
  it("reads what a browser actually sends", () => {
    const set =
      "bookingRequested=on&bookingDecision=on&stayCancelled=on&connectRequest=on&action=set";
    const all = set.replace("action=set", "action=all");
    expect(formIntent(set)).toBe("set");
    expect(notifyFromForm(set).stayCancelled).toBe(true);
    expect(notifyFromForm(set).bookingTaken).toBe(false);
    expect(formIntent(all)).toBe("all");
    expect(notifyFromForm(all).stayCancelled).toBe(true);
  });

  // The page has to show what the SENDER will do, and the sender skips only on
  // an explicit false — so a preference nobody has ever set reads as on, and a
  // second copy of the web app's defaults never gets a chance to disagree.
  it("treats an unset preference as on, exactly as the sender does", () => {
    expect(notifyStateFrom(undefined).stayCancelled).toBe(true);
    expect(notifyStateFrom({}).stayCancelled).toBe(true);
    expect(notifyStateFrom({ stayCancelled: false }).stayCancelled).toBe(false);
    expect(notifyStateFrom({ stayCancelled: true }).stayCancelled).toBe(true);
  });
});

describe("the page a POST lands on", () => {
  const SETTINGS = "https://hafaio.github.io/kip/#/settings";
  const done = renderUnsubscribed("stayCancelled", SETTINGS);

  // "Unsubscribe" reads as "stop all of this", so the page has to say which one
  // it was — and must not look like it touched the other four.
  it("names the one kind it turned off, and no other", () => {
    expect(done).toContain(NOTIFY_LABELS.stayCancelled);
    for (const [kind, label] of Object.entries(NOTIFY_LABELS)) {
      if (kind !== "stayCancelled") expect(done).not.toContain(label);
    }
    expect(done).toContain("Everything else is unchanged");
  });

  // Only a POST reports a change; the page a scanner can reach never does.
  it("is the only page that says it happened", () => {
    expect(done).toContain("Unsubscribed");
    expect(done).not.toContain("<form");
    expect(
      renderUnsubscribeAsk("stayCancelled", notifyStateFrom({}), "https://x/unsubscribe"),
    ).not.toContain("Unsubscribed");
  });

  it("offers the way back", () => {
    expect(done).toContain(`href="${SETTINGS}"`);
  });

  // "Saved" on its own says nothing about what will now arrive, and the whole
  // point of the wider form is that somebody chose a set.
  it("names what is left on after a set", () => {
    const saved = renderNotifySaved(
      notifyStateFrom({ bookingTaken: false, connectRequest: false }),
      SETTINGS,
    );
    expect(saved).toContain("Choices saved");
    expect(saved).toContain(
      `${NOTIFY_LABELS.bookingRequested}, ${NOTIFY_LABELS.bookingDecision} and ${NOTIFY_LABELS.stayCancelled}`,
    );
    expect(saved).not.toContain(NOTIFY_LABELS.bookingTaken);
  });

  // The all-off button is the same write with nothing ticked, so it lands here
  // too — and has to read as what it is rather than as a list of nothing.
  it("says so plainly when nothing is left on", () => {
    const none = renderNotifySaved(ALL_OFF, SETTINGS);
    expect(none).toContain("All kip email is off");
    expect(none).toContain("turn any of it back on in Settings");
    for (const label of Object.values(NOTIFY_LABELS)) {
      expect(none).not.toContain(label);
    }
  });

  it("is self-contained", () => {
    expect(done).not.toContain("<link");
    expect(done).not.toContain("<script");
    expect(done).not.toContain("src=");
    expect(done.match(/https?:\/\/[^"\s]+/g)).toEqual([SETTINGS]);
  });

  it("doesn't leak its own url onwards", () => {
    expect(done).toContain('<meta name="referrer" content="no-referrer">');
  });

  // Every way of failing renders the same thing: a wrong key and a uid that was
  // never a user must be indistinguishable, or the endpoint becomes a way to ask
  // whether an account exists. It offers no form either, so a stale link can't be
  // retried into working.
  it("says nothing at all when it refuses", () => {
    const refused = renderUnsubscribeFailed(SETTINGS);
    for (const label of Object.values(NOTIFY_LABELS)) {
      expect(refused).not.toContain(label);
    }
    expect(refused).not.toContain("uid");
    expect(refused).not.toContain("<form");
    expect(refused).toContain("no longer works");
    expect(refused).toContain(`href="${SETTINGS}"`);
  });
});
