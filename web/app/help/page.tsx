import type { Metadata } from "next";
import Link from "next/link";
import type { ReactElement } from "react";
import DocPage, { H2, List, link, P } from "../../components/doc-page";
import { CONTACT_EMAIL, ISSUES_URL } from "../../utils/contact";

export const metadata: Metadata = {
  title: "Help — kip",
  description:
    "What kip is, how to stop its texts, and where to reach a person.",
};

export default function HelpPage(): ReactElement {
  return (
    <DocPage title="Help" route="/help/">
      <H2>Did kip text you?</H2>
      <P>
        kip is a small, friends-only app for lending spare rooms between friends
        — no money, no public listings. It's at{" "}
        <a className={link} href="https://hafaio.github.io/kip">
          hafaio.github.io/kip
        </a>
        .
      </P>
      <P>
        kip only ever texts people about their own account, and only if they
        turned texts on: someone asked to stay at a place you listed, a host
        answered your request, a confirmed stay was called off, or someone
        agreed to be friends. It never sends marketing.
      </P>
      <P>
        <strong>To stop the texts, reply STOP to the message.</strong> That
        works instantly, whoever you are — you don't need an account or a
        password. (If you use kip, you can also turn texts off in Settings →
        Notifications.) If a text reached you and you've never used kip, the
        number may have previously belonged to someone who did; STOP ends it
        either way.
      </P>

      <H2>Something's broken, or you have a question</H2>
      <List>
        <li>
          <strong>Bugs and questions:</strong>{" "}
          <a className={link} href={ISSUES_URL}>
            open an issue on GitHub
          </a>{" "}
          — public, and the fastest way to get something fixed.
        </li>
        <li>
          <strong>Private matters</strong> — a privacy request, a safety
          concern, anything you'd rather not post publicly: email{" "}
          <a className={link} href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          . It goes straight to us, not onto the public issue tracker.
        </li>
      </List>

      <H2>The fine print</H2>
      <P>
        What kip is:{" "}
        <Link className={link} href="/about/">
          About
        </Link>
        . What it stores and why:{" "}
        <Link className={link} href="/privacy/">
          Privacy Policy
        </Link>
        . The rules:{" "}
        <Link className={link} href="/terms/">
          Terms
        </Link>
        .
      </P>
    </DocPage>
  );
}
