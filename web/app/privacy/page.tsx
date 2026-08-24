import type { Metadata } from "next";
import Link from "next/link";
import type { ReactElement } from "react";
import DocPage, { Card, H2, List, link, P } from "../../components/doc-page";
import {
  CONTACT_EMAIL,
  HAFAIO_URL,
  ISSUES_URL,
  REPO_URL,
} from "../../utils/contact";

export const metadata: Metadata = {
  title: "Privacy Policy — kip",
  description:
    "What kip stores, what it deliberately doesn't, and who sees it.",
};

const UPDATED = "August 23, 2026";

export default function PrivacyPage(): ReactElement {
  return (
    <DocPage title="Privacy Policy" updated={UPDATED} route="/privacy/">
      <P>
        kip is a friends-only space-sharing app, made and run by{" "}
        <a className={link} href={HAFAIO_URL}>
          hafa.io
        </a>
        . kip collects the minimum it needs to work, shows it only to the people
        you choose, and sells nothing to anyone.
      </P>

      <Card>
        <p className="font-bold">The short version</p>
        <List>
          <li>
            Nothing on kip is public. Nobody can find you, or anything you list,
            unless you choose to be found.
          </li>
          <li>
            Your email address and phone number live on your sign-in account,
            not in kip's database. The one exception is the number you agree to
            be texted at, which is kept as part of your consent record.
          </li>
          <li>
            kip has no ads and no analytics, and does not sell or share your
            data for marketing — including your phone number and your consent to
            be texted. The one tracker it loads is Google reCAPTCHA, only on the
            phone door, because signing in by text needs it.
          </li>
          <li>Leaving kip deletes your account and your data.</li>
        </List>
      </Card>

      <H2>What kip stores</H2>
      <P>To work at all, kip keeps:</P>
      <List>
        <li>
          <strong>Your profile</strong> — a display name you choose, an optional
          username, an optional photo.
        </li>
        <li>
          <strong>Your places</strong> — titles, descriptions, photos, the dates
          they're free, and a location if you add one. You choose how precise
          that location is; it's shown only to people who can see the place.
        </li>
        <li>
          <strong>Your friendships and requests</strong> — who you're connected
          to, and pending asks in either direction.
        </li>
        <li>
          <strong>Your stays</strong> — requests, confirmations, and
          cancellations, with their dates.
        </li>
        <li>
          <strong>Your settings</strong> — notification preferences, saved
          searches, and privacy switches. A saved search keeps whatever you
          searched by, which can include a place's coordinates — and if you used
          “Use my location”, those are your device's, as your browser reported
          them. kip asks for that only when you press it, and only Browse ever
          asks.
        </li>
      </List>
      <P>
        All of it lives in Google Firebase (Firestore and Cloud Storage), which
        is kip's database and file store.
      </P>

      <H2>What kip deliberately does not store</H2>
      <List>
        <li>
          <strong>
            Your email address and phone number are not in the database.
          </strong>{" "}
          They exist only on your Firebase sign-in account, where they're used
          to let you back in. When kip sends you a notification, it reads the
          address off that account for that one send and puts it in no database
          — the delivery log described below is the one place it is written
          down. One exception, and it exists to protect you: turning on texts
          stores the number you agreed to be texted at, because a consent record
          that doesn't say which phone it was given for can't stop kip texting a
          different one.
        </li>
        <li>
          <strong>
            No analytics, no ad tech, no tracking pixels, no cookies of kip's
            own.
          </strong>{" "}
          What kip keeps in your browser's own storage is for you, not about
          you: your signed-in session, your light/dark choice, and a copy of
          what you've been shown — your profile, friends, places and stays, and
          the places and people kip drew for you — so the app opens without
          waiting for the network. Clearing your browser's data for kip removes
          all of it.
        </li>
        <li>
          <strong>Photo location data is removed.</strong> Photos you upload are
          re-encoded in your browser before they're stored, which strips
          metadata — including any GPS position your camera embedded. A photo of
          your home shouldn't carry its coordinates.
        </li>
      </List>

      <H2>Who can see what</H2>
      <List>
        <li>
          <strong>Discovery is off until you turn it on.</strong> A new account
          is unreachable. You can opt in to being found by username, or create a
          share link — and turn either off again.
        </li>
        <li>
          <strong>Share links are unguessable URLs.</strong> Knowing the link is
          what grants access; anyone you send one to can see what it covers.
          Revoking or regenerating a link cuts off every copy of the old one,
          instantly. The secret part of the link is carried in the URL fragment,
          which browsers don't send to servers — so it stays out of kip's
          hosting logs and out of other sites' referrer headers.
        </li>
        <li>
          <strong>Opening a share link creates a temporary session.</strong>{" "}
          Visitors are signed in anonymously behind the scenes so the link can
          show live dates. A note recording that a visitor opened a link expires
          on its own within about thirty days, wherever it sits. An unused
          session and its traces are deleted after about thirty days of
          inactivity — as is any account left with nothing attached to it at
          all: no profile, no stay, no friend, no share link.
        </li>
        <li>
          <strong>Asking to stay somewhere shows the host who you are.</strong>{" "}
          When you request dates, the host can see your profile — they're being
          asked to give a stranger their keys, and they should know whose. It is
          one-way until they say yes: being asked is not agreeing to be looked
          up, so you can't see them until the stay is confirmed. After that each
          of you can see the other's profile, up to about two months after the
          stay ends. Then it lapses on its own.
        </li>
        <li>
          <strong>Photos are protected by unguessable URLs.</strong> Whoever can
          see a place can see its photos. Like any image on the web, someone who
          could see a photo can save it.
        </li>
        <li>
          <strong>Where you're staying is private by default.</strong> Friends
          see your confirmed stays only if you turn on that switch in Settings.
        </li>
      </List>

      <H2>Text messages (SMS)</H2>
      <P>
        If you turn on texts in Settings, kip sends automated notification texts
        to the phone number on your account — things like a request for your
        dates, an answer to yours, or a cancelled stay. This is optional and off
        by default; agreeing to texts is never a condition of using kip. Message
        frequency varies. Message and data rates may apply. Reply STOP to any
        text to stop them, or HELP for help; you can also turn them off in
        Settings.
      </P>
      <P>
        <strong>
          kip does not share, sell, or provide your mobile phone number, or your
          consent to receive text messages, to any third party or affiliate for
          marketing or promotional purposes.
        </strong>{" "}
        No mobile information is shared with third parties or affiliates for
        marketing. The only party that handles your number besides kip is
        Twilio, the messaging provider that delivers the texts, and it does so
        solely to deliver them. Twilio keeps its own delivery logs of messages
        sent.
      </P>
      <P>
        When you turn texts on, kip records the date, the phone number you
        agreed to be texted at, and which version of the consent wording you
        saw, so there's an honest record of exactly what you agreed to. That
        record is kept even if you later turn texts off or change your number —
        and it goes when your account does.
      </P>

      <H2>Email</H2>
      <P>
        kip emails you about things that happen to you — a request, an answer, a
        cancellation — and only to an address you've confirmed. Each kind of
        email can be turned off in Settings, and every email carries a one-click
        unsubscribe for its kind. Notification email is currently delivered via
        Gmail, which processes the message in transit.
      </P>

      <H2>Services kip relies on</H2>
      <P>
        kip runs on a small number of services, each of which processes some of
        your data to do its job — none of which is marketing:
      </P>
      <List>
        <li>
          <strong>Google Firebase</strong> — sign-in, database, file storage,
          and the small server functions that send notifications and finish
          account deletions. Your data is stored on Google Cloud.
        </li>
        <li>
          <strong>Google reCAPTCHA</strong> — checks that a phone sign-in is a
          real person, which Firebase requires before it will text a code. It
          inspects your browser to score the request, which makes it the one
          tracker on kip — so it is loaded only at the moment you submit a phone
          number, and never if you sign in by email or with Google.
        </li>
        <li>
          <strong>GitHub Pages</strong> — hosts the app itself. Like any web
          host, GitHub sees standard request logs (such as IP addresses) when
          you load the page.
        </li>
        <li>
          <strong>Gmail</strong> — delivers notification email.
        </li>
        <li>
          <strong>Twilio</strong> — delivers notification texts, if you've
          turned them on.
        </li>
        <li>
          <strong>OpenStreetMap (Nominatim)</strong> — when you type a place
          name or address, either while listing somewhere or in Browse's
          location box, that text is sent to OpenStreetMap's free geocoding
          service to find its coordinates. Only the text you typed, and only
          when you type it.
        </li>
      </List>

      <H2>Logs and diagnostics</H2>
      <P>
        kip doesn't log what you do in the app. Two narrow exceptions. When
        something goes wrong in a way that throws no error — a page that
        silently stalls — kip may write a small record describing the app's
        state at that moment, so the bug can be fixed; no user of the app can
        read those, only the operator, and they're deleted automatically — after
        about a week, or two for a failure the server itself recorded. And the
        machinery that sends notifications keeps routine operational logs in
        Google Cloud — that a message was sent, or why it wasn't. Those name the
        address or number it went to, and Google keeps them about a month before
        deleting them. Both exist to keep kip working, nothing else.
      </P>

      <H2>Leaving, and what remains</H2>
      <P>
        You can delete your account from Settings at any time. Leaving cancels
        your upcoming stays in both directions, disconnects you from your
        friends, and deletes your photos, your places, your share links, your
        profile, and your sign-in account.
      </P>
      <P>Two honest footnotes:</P>
      <List>
        <li>
          <strong>Your username is retired, not recycled.</strong> Usernames are
          never released for someone else to claim — that's what prevents
          impersonation — so a deleted account's name stays reserved forever,
          including from you if you return.
        </li>
        <li>
          <strong>The other side keeps their record.</strong> A stay involves
          two people, and a record of it remains in the other person's history —
          dates and place, but not your name or photo, which are deleted with
          your account.
        </li>
      </List>

      <H2>Children</H2>
      <P>
        kip is for adults: you must be 18 or older to use it, and it is not
        directed at children. kip doesn't knowingly keep an account for anyone
        under 18 — if you believe one exists, email{" "}
        <a className={link} href={`mailto:${CONTACT_EMAIL}`}>
          {CONTACT_EMAIL}
        </a>{" "}
        and it will be removed.
      </P>

      <H2>Changes to this policy</H2>
      <P>
        If kip's practices change, this page changes with them and the date at
        the top is updated. kip is open source, so{" "}
        <a className={link} href={`${REPO_URL}/commits`}>
          every previous version of this page
        </a>{" "}
        is public.
      </P>

      <H2>Contact</H2>
      <P>
        Questions about privacy:{" "}
        <a className={link} href={`mailto:${CONTACT_EMAIL}`}>
          {CONTACT_EMAIL}
        </a>
        , or{" "}
        <a className={link} href={ISSUES_URL}>
          an issue on GitHub
        </a>
        . See also the{" "}
        <Link className={link} href="/terms/">
          Terms
        </Link>
        .
      </P>
    </DocPage>
  );
}
