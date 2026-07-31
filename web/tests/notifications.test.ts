import { describe, expect, it } from "bun:test";
import {
  ALL_OFF,
  asNotifyKind,
  dateRange,
  formIntent,
  linkTo,
  NOTIFY_LABELS,
  noticeForBookingChange,
  noticeForConnectAccepted,
  noticeForConnectRequest,
  noticeForNewBooking,
  notifyFromForm,
  notifyStateFrom,
  ONE_CLICK_BODY,
  renderEmail,
  renderNotifySaved,
  renderUnsubscribeChoices,
  renderUnsubscribeFailed,
  renderUnsubscribed,
  unsubscribeHeaders,
  unsubscribeLink,
} from "../../functions/src/messages";
import { NOTIFY_EVENTS } from "../utils/types";

// The triggers need emulators, Auth accounts and SMTP, so in practice they never
// get exercised. The decisions they make need none of that.

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

  // Catches a regression back to `Date`, which reads UTC midnight as the 13th.
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

  // Separately switchable: one wants something from you, the other is news.
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

  // Distinct from a decline: nothing was refused, so it points them back.
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

  // The mirror case, and the one most easily got backwards.
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

  // The third route's copy was missed when it was added, so a real request read
  // "They found you by your username" to someone who has none.
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

// The mirror of the one above, and the pair is easy to get backwards: this one
// is read by whoever ASKED, and names the person who said yes.
describe("a connect request accepted", () => {
  it("tells the sender who agreed", () => {
    const notice = noticeForConnectAccepted({
      uid: "u_priya",
      displayName: "Priya Raman",
      photoURL: HOST_PHOTO,
    });
    expect(notice.to).toBe("sender");
    expect(notice.kind).toBe("connectAccepted");
    expect(notice.subject).toBe("Priya agreed to be friends");
    expect(notice.body).toContain("Priya Raman");
    expect(notice.person.photoURL).toBe(HOST_PHOTO);
  });

  it("points at the new friend, not at Friends", () => {
    const notice = noticeForConnectAccepted({ uid: "u/1 2" });
    expect(notice.path).toBe("#/person/u%2F1%202");
    expect(notice.cta).toBe("See their profile");
  });

  it("survives an accepter with no name at all", () => {
    const notice = noticeForConnectAccepted({ uid: "u_priya" });
    expect(notice.subject).toBe("Someone agreed to be friends");
  });
});

// Every email deep-links to the screen it's about; these pin which.
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

  // A connect request has no page of its own.
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

// Always the OTHER party's — backwards, it shows people their own photo.
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

  // What a client refusing HTML shows, so it has to stand on its own.
  it("keeps a plain-text alternative that still links", () => {
    expect(withPhoto.text).toContain("Sam would like");
    expect(withPhoto.text).toContain(
      "Review the request: https://hafaio.github.io/kip/#/booking/bk_42",
    );
  });

  // Points at the endpoint, not Settings, which is behind a sign-in an
  // unsubscribe must never require. Both parts, or the text one silently rots.
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

  // Most clients block remote images, so the name has to carry it alone.
  it("names the person whether the photo loads, is blocked, or is absent", () => {
    expect(withPhoto.html).toContain('src="cid:kip-photo"');
    expect(withPhoto.html).toContain('alt="Sam Okafor"');
    expect(withPhoto.html).toContain("Sam Okafor");
    // No photo at all degrades to an initial in a circle, beside the name.
    expect(withoutPhoto.html).not.toContain("cid:");
    expect(withoutPhoto.html).toContain(">S<");
    expect(withoutPhoto.html).toContain("Sam Okafor");
  });

  // The whole reason for the CID attachment: a photo URL is a bearer capability,
  // and a remote image is fetched and cached by the recipient's client.
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

  // Several clients drop gradients, so anything legible sits on a solid.
  it("stays inside what an email client can render", () => {
    expect(withPhoto.html).not.toContain("display:flex");
    expect(withPhoto.html).not.toContain("<link");
    expect(withPhoto.html).toContain("<table");
    expect(withPhoto.html).toContain(
      "background-color:#dd5f38;background-image:",
    );
    expect(withPhoto.html).toContain("prefers-color-scheme: dark");
  });

  // One template: the only differences are the words, the link and the face.
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

// Only the deciding half — the endpoint itself needs Firestore.
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

// `functions/` keeps its own copy of this vocabulary, and the page reads as a
// second Settings screen — two of them naming one switch differently is a bug
// you only notice with both open.
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
  const ask = renderUnsubscribeChoices("stayCancelled", stored, POST_URL);

  const checkedKinds = (page: string): string[] =>
    [...page.matchAll(/name="(\w+)" value="on"( checked)?/g)]
      .filter((row) => row[2])
      .map((row) => row[1]);

  // The click is honoured before this renders, so the page reports rather than
  // proposes. Saying "we've switched it off below" would leave someone who
  // closes the tab believing nothing had happened.
  it("says the thing is already done, and doesn't ask", () => {
    expect(ask).toContain("Unsubscribed");
    expect(ask).toContain("won&#39;t email you about");
    expect(ask).not.toContain("Nothing is saved");
    expect(ask).not.toContain("Are you sure");
  });

  // The state is shown by the switch rather than carried by wording alone.
  it("shows the kind that email was about switched off", () => {
    expect(ask).toContain(`&quot;${NOTIFY_LABELS.stayCancelled}&quot; any more`);
    expect(checkedKinds(ask)).toEqual([
      "bookingRequested",
      "bookingDecision",
      "connectRequest",
      "connectAccepted",
    ]);
  });

  // Save arrives greyed out and unpressable, which is how the page says "already
  // done" without a second sentence; moving any switch — re-ticking the row it
  // came from included, which is the undo — brings it back. A real `disabled`
  // rather than a CSS impression of one, so it isn't announced as available.
  it("has nothing for Save to do until a switch is moved", () => {
    expect(ask).toContain(
      "save.disabled = !boxes.some((box) => box.checked !== box.hasAttribute(\"checked\"))",
    );
    expect(ask).toContain('form.addEventListener("change", sync)');
    expect(ask).toContain(".save:disabled { background-image:none;");
  });

  // Pre-marking is only safe if saving means exactly what it looks like.
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

  // One loud button, so there's nothing for it to be confused with.
  it("has a single primary action, with the wider one kept quiet", () => {
    expect(ask).toContain(
      '<button class="cta save" type="submit" name="action" value="set">',
    );
    expect(ask).toContain(
      '<button class="plain" type="submit" name="action" value="all">',
    );
    expect(ask.match(/class="cta/g)).toHaveLength(1);
  });

  // One url, the same one the header advertises.
  it("posts to the url it came from", () => {
    expect(ask).toContain(`<form method="post" ${ACTION}>`);
    expect(ask.match(/<form/g)).toHaveLength(1);
  });

  // The page says what it wants outright, but the provider path must not move:
  // one-click still means the single kind the url names.
  it("leaves the unattended one-click path exactly as it was", () => {
    expect(ask).not.toContain("List-Unsubscribe");
    expect(unsubscribeHeaders(POST_URL)["List-Unsubscribe-Post"]).toBe(
      ONE_CLICK_BODY,
    );
    expect(formIntent(ONE_CLICK_BODY)).toBe("one");
  });

  // A real checkbox is what a JavaScript-less form submits and a screen reader
  // announces. Clipped, never `display:none`, or it stops being focusable.
  it("draws a switch without giving up the control underneath", () => {
    expect(ask).not.toContain("display:none");
    expect(ask).toContain(".row input:checked ~ .track");
    expect(ask).toContain(".row input:focus-visible ~ .track");
    // Its own layer, because a gradient can't be interpolated to a flat colour
    // but an opacity can.
    expect(ask).toContain(
      '.track::before { content:""; position:absolute; inset:0; border-radius:999px; background-color:#dd5f38;background-image:',
    );
    expect(ask).toContain(".row input:checked ~ .track::before { opacity:1; }");
    expect(ask).toContain("prefers-reduced-motion");
  });

  // A permanent mark, not a moment. The switch it sits beside is already drawn
  // off, so nothing here has to be watched to be understood.
  it("marks the row this email came from", () => {
    expect(ask.match(/class="tag"/g)).toHaveLength(1);
    const originRow = ask
      .split("<label")
      .find((row) => row.includes(">from this email<"));
    expect(originRow).toContain(NOTIFY_LABELS.stayCancelled);
    expect(originRow).not.toContain(" checked");
  });

  // The row used to animate its switch off on load, and for the .6s the
  // animation spent in its delay it drew the thumb ON over a box that was
  // already off — a tap landing there turned the row back on while appearing to
  // do nothing. There is nothing left to say that the words don't.
  it("draws every switch where it actually is, at every moment", () => {
    expect(ask).not.toContain("@keyframes");
    expect(ask).not.toContain("animation:");
    expect(ask).not.toContain("origin");
  });

  // Only the greying-out of Save is scripted, and it degrades to an ordinary
  // working button — so nothing on the page needs the script to have run.
  it("works without its script, and is self-contained", () => {
    expect(ask).toContain('<form method="post"');
    expect(ask).toContain('type="submit" name="action" value="set"');
    expect(ask).not.toContain("onclick");
    expect(ask).not.toContain("<link");
    expect(ask).not.toContain("src=");
    // Inline, so a browser that blocks remote script still gets the page — and
    // the form action is the only url on it, no Settings link to sit at equal
    // weight beside "turn off all kip email".
    expect(ask.match(/<script/g)).toHaveLength(1);
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
      connectAccepted: false,
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

  // The provider path has no browser to offer the rest of the switches to, so
  // this is the same ending with nothing to adjust.
  it("says it happened, and offers nothing to change", () => {
    expect(done).toContain("Unsubscribed");
    expect(done).not.toContain("<form");
    expect(
      renderUnsubscribeChoices(
        "stayCancelled",
        notifyStateFrom({}),
        "https://x/unsubscribe",
      ),
    ).toContain("<form");
  });

  it("offers the way back", () => {
    expect(done).toContain(`href="${SETTINGS}"`);
  });

  // "Saved" on its own says nothing about what will now arrive, and the whole
  // point of the wider form is that somebody chose a set.
  it("names what is left on after a set", () => {
    const saved = renderNotifySaved(
      notifyStateFrom({
        bookingTaken: false,
        connectRequest: false,
        connectAccepted: false,
      }),
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
