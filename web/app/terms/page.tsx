import type { Metadata } from "next";
import Link from "next/link";
import type { ReactElement } from "react";
import DocPage, { Card, H2, List, link, P } from "../../components/doc-page";
import { CONTACT_EMAIL, HAFAIO_URL, ISSUES_URL } from "../../utils/contact";

export const metadata: Metadata = {
  title: "Terms of Service — kip",
  description: "The rules for using kip, written to be read.",
};

const UPDATED = "August 23, 2026";

export default function TermsPage(): ReactElement {
  return (
    <DocPage title="Terms of Service" updated={UPDATED} route="/terms/">
      <P>
        These are the terms for using kip (
        <a className={link} href="https://hafaio.github.io/kip">
          https://hafaio.github.io/kip
        </a>
        ), a friends-only space-sharing app operated by{" "}
        <a className={link} href={HAFAIO_URL}>
          hafa.io
        </a>
        . Using kip means you agree to them. They're written to be read.
      </P>

      <H2>What kip is, and isn't</H2>
      <P>
        kip lets you list space you have the right to offer, mark when it's
        free, and let friends stay there for nothing. kip is free to use,
        handles no money, and takes no fees. It is not a marketplace, a rental
        platform, or a booking agent — it's a calendar between friends.
      </P>

      <H2>Your account</H2>
      <List>
        <li>You must be at least 18 to use kip.</li>
        <li>
          Your account is yours: keep access to the email address, phone number,
          or Google account you sign in with, because they're the only ways back
          in.
        </li>
        <li>
          Give your real name or the name your friends know you by — identity
          between friends is the entire basis of the app.
        </li>
        <li>
          You can leave at any time from Settings, which deletes your account
          and data as described in the{" "}
          <Link className={link} href="/privacy/">
            Privacy Policy
          </Link>
          . Usernames are never recycled, so a deleted account's username stays
          permanently retired.
        </li>
      </List>

      <H2>What you agree to</H2>
      <List>
        <li>
          Only list a place you actually have the right to offer for stays.
        </li>
        <li>Be honest — in your listings, your name, and your requests.</li>
        <li>
          Don't use kip to harass anyone, to break the law, or to do anything to
          another person's home or account that you wouldn't do to their face.
        </li>
        <li>
          Don't probe, scrape, or interfere with the service. (The code is open
          source; read it there instead.)
        </li>
      </List>
      <P>
        You keep ownership of everything you post — photos, descriptions, your
        name. You give kip permission to store it and show it to the people
        you've chosen to share it with, which is what the app is. That
        permission ends when you delete the content or your account.
      </P>

      <H2>Stays are between friends</H2>
      <P>
        kip introduces no strangers and vouches for no one: everyone who can see
        your place is someone you connected with or handed a link to. A stay is
        an arrangement between the two of you. kip is not a party to it, doesn't
        guarantee it, doesn't insure it, and can't mediate it. Hosts are
        responsible for their places and for being allowed to offer them; guests
        are responsible for their conduct. Whether either of you owes the other
        anything — a favour, a bottle of wine, an apology — is between you.
      </P>

      <H2>Text messaging program</H2>
      <Card>
        <p>
          kip offers optional automated account-notification texts (“kip
          notifications”), sent by kip via its messaging provider to the phone
          number on your account.
        </p>
        <List>
          <li>
            <strong>What it sends:</strong> automated notifications when
            something needs you or answers you — someone asks to stay at your
            place, a host answers your request, a confirmed stay is called off,
            or someone agrees to be friends. No marketing, ever.
          </li>
          <li>
            <strong>Opting in:</strong> you consent by turning on “Text me” in
            Settings, where these disclosures are shown. Consent is specific to
            this program, is not a condition of any purchase, and is never a
            condition of using kip or any part of it.
          </li>
          <li>
            <strong>Message frequency varies.</strong> How often you're texted
            depends entirely on how much happens to you.
          </li>
          <li>
            <strong>Message and data rates may apply.</strong>
          </li>
          <li>
            <strong>Opting out:</strong> reply <strong>STOP</strong> to any
            message to stop receiving texts, or turn them off in Settings. Reply{" "}
            <strong>HELP</strong> for help, or contact{" "}
            <a className={link} href={`mailto:${CONTACT_EMAIL}`}>
              {CONTACT_EMAIL}
            </a>
            .
          </li>
          <li>kip supports US phone numbers only.</li>
          <li>Carriers are not liable for delayed or undelivered messages.</li>
          <li>
            <strong>
              Your phone number and your opt-in are never shared with, sold to,
              or bought by third parties or affiliates.
            </strong>{" "}
            See the{" "}
            <Link className={link} href="/privacy/">
              Privacy Policy
            </Link>
            .
          </li>
        </List>
      </Card>

      <H2>Email notifications</H2>
      <P>
        kip emails confirmed addresses about account events. Every kind can be
        switched off in Settings, and every email carries a one-click
        unsubscribe.
      </P>

      <H2>Ending things</H2>
      <P>
        You can stop using kip, or delete your account, whenever you like. kip
        may suspend or remove an account that breaks these terms or abuses the
        service or other people on it. Since stays are free and kip holds no
        money, neither of us owes the other anything on the way out.
      </P>

      <H2>The honest disclaimers</H2>
      <P>
        kip is provided as it is, free of charge. It's built with care, but it
        comes with no warranty of any kind — not that it will be available,
        uninterrupted, or error-free. To the fullest extent permitted by law,
        kip and its operator are not liable for indirect, incidental, or
        consequential damages arising from the service or from any stay arranged
        through it; where liability can't be excluded, it is limited to the
        amount you paid to use kip, which is nothing. Nothing in these terms
        excludes liability that cannot lawfully be excluded.
      </P>
      <P>
        These terms are governed by the laws of New York, and any dispute that
        somehow reaches a court belongs in the state or federal courts of Kings
        County, New York.
      </P>

      <H2>Changes</H2>
      <P>
        If these terms change in substance, this page and its date change, and
        material changes will be called out. Previous versions are public in
        kip's repository history.
      </P>

      <H2>Contact</H2>
      <P>
        <a className={link} href={`mailto:${CONTACT_EMAIL}`}>
          {CONTACT_EMAIL}
        </a>
        , or{" "}
        <a className={link} href={ISSUES_URL}>
          an issue on GitHub
        </a>
        .
      </P>
    </DocPage>
  );
}
