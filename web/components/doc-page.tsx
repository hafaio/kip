import Link from "next/link";
import type { ReactElement, ReactNode } from "react";
import SiteFooter, { type DocRoute } from "./site-footer";
import ThemeButton from "./theme-button";
import Wordmark from "./wordmark";

// The four written pages — About, Privacy, Terms, Help — share the portal's
// chrome and a dozen element classes. They are the only long-text surfaces in
// kip, and deliberately the only ones that set prose on the bare canvas: a card
// here means controls and lists everywhere else, so a wall of one behind two
// thousand words would read as a form.
//
// Nothing below touches the store, Firebase or a session. Twilio fetches the
// Privacy and Terms URLs server-side during campaign registration, so every word
// has to be in the exported HTML for a reader with no JavaScript.

export const link = "font-semibold text-accent-ink break-words";

export function H2({ children }: { children: ReactNode }): ReactElement {
  return (
    <h2 className="mt-10 text-xl font-bold tracking-[-0.02em]">{children}</h2>
  );
}

export function P({ children }: { children: ReactNode }): ReactElement {
  return <p className="mt-4">{children}</p>;
}

export function List({ children }: { children: ReactNode }): ReactElement {
  return (
    <ul className="mt-4 list-disc space-y-2 pl-5 marker:text-faint">
      {children}
    </ul>
  );
}

// Used exactly twice across the four pages — the privacy summary and the SMS
// disclosures — where lifting a block off the canvas is the point of it.
export function Card({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="mt-6 rounded-3xl bg-surface p-5 shadow-card">
      {children}
    </div>
  );
}

export default function DocPage({
  title,
  updated,
  route,
  children,
}: {
  title: string;
  updated?: string;
  route: DocRoute;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 items-center gap-3 px-4">
        <Link href="/" aria-label="kip home" className="rounded-2xl">
          <Wordmark />
        </Link>
        <div className="ml-auto flex items-center gap-1">
          <ThemeButton />
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 pt-6 pb-24 leading-7 text-text sm:pt-10">
        <h1 className="text-3xl font-extrabold tracking-[-0.03em] sm:text-4xl">
          {title}
        </h1>
        {updated ? (
          <p className="mt-2 text-sm tabular-nums text-muted">
            Last updated: {updated}
          </p>
        ) : null}
        {children}
        <SiteFooter current={route} className="mt-16" />
      </main>
    </div>
  );
}
