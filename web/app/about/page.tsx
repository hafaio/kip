import type { Metadata } from "next";
import Link from "next/link";
import type { ReactElement } from "react";
import DocPage, { H2, link, P } from "../../components/doc-page";
import { HAFAIO_URL, REPO_URL } from "../../utils/contact";

export const metadata: Metadata = {
  title: "About kip",
  description: "A friends-only way to share space. No listings, no payments.",
};

export default function AboutPage(): ReactElement {
  return (
    <DocPage title="About kip" route="/about/">
      <P>
        kip is a friends-only way to share space. List a spare room — or your
        whole place while you're away — mark the dates it's free, and let
        friends stay for nothing. No public listings, no payments, no fees.
      </P>

      <H2>How it works</H2>
      <P>
        <strong>Nothing on kip is public.</strong> There's no search page, no
        directory, no map of places. A fresh account can't be found by anyone:
        you become reachable only when you choose to — by picking a username
        friends can search for, or by sending someone a share link you can
        revoke at any time.
      </P>
      <P>
        <strong>Places are visible to friends only.</strong> When you list a
        room, the only people who can ever see it are the friends you've
        connected with — and, if you send one, whoever holds a share link you
        created for that room or those dates. A friend asks for dates, you say
        yes (or mark dates “instant” so friends can book them
        first-come-first-served), and that's a stay.
      </P>
      <P>
        <strong>Share links work before someone has an account.</strong> Send a
        link to your sister and she can see what's free immediately; she only
        needs an account at the moment she asks for something. No password
        anywhere — you get in by an emailed link, a texted code, or Google.
      </P>
      <P>
        <strong>No money changes hands.</strong> kip has no payments and no
        service fee.
      </P>

      <H2>Who makes it</H2>
      <P>
        kip is a{" "}
        <a className={link} href={HAFAIO_URL}>
          hafa.io
        </a>{" "}
        project. It doesn't charge, doesn't show ads, and doesn't sell anything
        — including data. What kip knows about you and why is written down
        plainly in the{" "}
        <Link className={link} href="/privacy/">
          Privacy Policy
        </Link>
        . If something's broken, or you just want to reach us, the{" "}
        <Link className={link} href="/help/">
          Help page
        </Link>{" "}
        says how.
      </P>
      <P>
        The code is open source under the MIT license:{" "}
        <a className={link} href={REPO_URL}>
          github.com/hafaio/kip
        </a>
        . Every version of the app — and of these pages — is public in that
        repository's history.
      </P>
    </DocPage>
  );
}
