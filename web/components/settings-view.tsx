"use client";

import { useTheme } from "next-themes";
import { type ReactElement, useEffect, useState } from "react";
import { LuChevronRight } from "react-icons/lu";
import { useKip } from "../utils/store";
import { asThemeChoice, type ThemeChoice } from "../utils/theme";
import { NOTIFY_EVENTS, type NotifyKind } from "../utils/types";
import { useDialog } from "./dialog";
import Button from "./ui/button";
import FieldNote from "./ui/field-note";
import { Group, Row, Section } from "./ui/list";
import Segmented from "./ui/segmented";
import Switch from "./ui/switch";

// Your name and handle are edited on your profile, where they're actually shown;
// this section is what's left — the address you sign in with, and a way through.
function AccountSection(): ReactElement | null {
  const { user, navigate } = useKip();

  if (!user) return null;

  return (
    <Section title="Account">
      <Group>
        <Row
          onClick={() => navigate({ kind: "person", id: user.uid })}
          ariaLabel="Name and photo"
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[0.9375rem] font-medium">
              Name and photo
            </span>
            <span className="truncate text-sm text-muted">
              Edit them on your profile
            </span>
          </span>
          <LuChevronRight className="shrink-0 text-faint" />
        </Row>
      </Group>

      {user.email ? (
        <div className="flex flex-col gap-1.5">
          <div className="px-1 text-sm font-semibold text-muted">Email</div>
          <div className="flex h-11 items-center rounded-xl bg-surface-muted px-3.5 text-base text-muted">
            {/* A long address in a fixed-height pill wraps and clips at 390px,
                so it ends in an ellipsis instead — the same treatment the
                profile page gives the same string. */}
            <span className="truncate">{user.email}</span>
          </div>
          <FieldNote>
            Used only to sign in — it lives on your account, never on your kip
            profile, and is never shown to other users or used to find you.
          </FieldNote>
        </div>
      ) : null}
    </Section>
  );
}

// The two independent ways someone can reach you: a handle they can search for,
// and a share link they can open. Neither is on by default — a fresh account is
// unreachable until you choose to be found. Both switches are mirrors: the handle
// itself is claimed on your profile, and the link is copied there.
function DiscoverabilitySection(): ReactElement | null {
  const {
    profile,
    setSearchable,
    setShareStays,
    prefs,
    navigate,
    publishUserPortal,
    revokeUserPortal,
    user,
  } = useKip();
  const { confirm } = useDialog();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!profile || !user) return null;
  const handle = profile.username;
  const uid = user.uid;

  async function toggle(next: boolean): Promise<void> {
    // Becoming findable needs something to be found by, and a handle is claimed
    // on your profile — permanently — so that decision is made there, not here.
    if (next && !handle) {
      navigate({ kind: "person", id: uid });
      return;
    }
    setError(null);
    try {
      await setSearchable(next);
    } catch (caught) {
      console.error(caught);
      setError("Couldn't save that. Try again.");
    }
  }

  // Turning the link off revokes it, which kills every link already sent — the
  // same irreversible act as ShareLink's own "Turn off", so it asks the same way.
  async function togglePortal(next: boolean): Promise<void> {
    if (!next) {
      const ok = await confirm({
        title: "Turn off the public link?",
        body: "Anyone holding the link loses access. You can make a new one anytime.",
        confirmLabel: "Turn off",
        tone: "danger",
      });
      if (!ok) return;
    }
    setError(null);
    setBusy(true);
    try {
      if (next) await publishUserPortal();
      else await revokeUserPortal();
    } catch (caught) {
      console.error(caught);
      setError("Couldn't save that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Privacy">
      <Group>
        <Switch
          checked={profile.searchable}
          onChange={toggle}
          label="Findable by username"
          description={
            handle
              ? `Anyone who knows @${handle} can send you a friend request.`
              : "Claim a username on your profile first — it's permanent, so you pick it there."
          }
        />
      </Group>

      <Group>
        <Switch
          checked={prefs.shareStaysWithFriends}
          onChange={(next) => setShareStays(next)}
          label="Let friends see where I'll be staying"
          description="When on, confirmed stays can appear to your friends. When off, your trips stay private to you and the host."
        />
        <Switch
          checked={prefs.profilePortalId !== null}
          onChange={togglePortal}
          disabled={busy}
          label="Public profile link"
          description="Anyone holding the link can see your places and ask to stay. It doesn't make them a friend."
        />
        {prefs.profilePortalId ? (
          <Row
            onClick={() => navigate({ kind: "person", id: uid })}
            ariaLabel="Copy your profile link"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[0.9375rem] font-medium">
                Copy your link
              </span>
              <span className="truncate text-sm text-muted">
                Copy or regenerate it on your profile
              </span>
            </span>
            <LuChevronRight className="shrink-0 text-faint" />
          </Row>
        ) : null}
      </Group>

      {error ? <FieldNote tone="danger">{error}</FieldNote> : null}
    </Section>
  );
}

// Email is the only channel, and it only ever goes to a verified address — so an
// unverified account would silently receive nothing. That has to be said here,
// with a way to fix it, or it just looks broken.
function NotificationsSection(): ReactElement | null {
  const { user, emailVerified, prefs, setNotify, resendVerification } =
    useKip();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;

  async function resend(): Promise<void> {
    setError(null);
    try {
      await resendVerification();
      setSent(true);
    } catch (caught) {
      console.error(caught);
      setError("Couldn't send that just now. Try again in a minute.");
    }
  }

  return (
    <Section title="Notifications">
      {emailVerified ? null : (
        <div className="flex flex-col gap-3 rounded-3xl bg-surface p-4 shadow-card">
          <p className="text-sm text-muted">
            kip only emails a verified address — otherwise anyone could sign up
            with someone else's and have mail sent to them. Verify {user.email}{" "}
            to start receiving these.
          </p>
          {sent ? (
            <FieldNote tone="success">
              Sent. Check your inbox, then reload kip.
            </FieldNote>
          ) : (
            <Button variant="secondary" onClick={resend} className="self-start">
              Send verification email
            </Button>
          )}
          {error ? <FieldNote tone="danger">{error}</FieldNote> : null}
        </div>
      )}

      <Group>
        {Object.entries(NOTIFY_EVENTS).map(([key, event]) => (
          <Switch
            key={key}
            checked={prefs.notify[key as NotifyKind]}
            onChange={(next) => setNotify(key as NotifyKind, next)}
            label={event.label}
            description={event.note}
          />
        ))}
      </Group>

      {!prefs.notify.stayCancelled ? (
        <FieldNote tone="danger">
          With this off, nobody will tell you if a stay you're counting on is
          called off — you'd only find out by opening kip.
        </FieldNote>
      ) : null}
    </Section>
  );
}

export default function SettingsView(): ReactElement {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current = mounted ? asThemeChoice(theme) : "system";

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-7">
      <AccountSection />

      <DiscoverabilitySection />

      <NotificationsSection />

      <Section title="Appearance">
        <Segmented<ThemeChoice>
          ariaLabel="Theme"
          value={current}
          onChange={setTheme}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </Section>
    </div>
  );
}
