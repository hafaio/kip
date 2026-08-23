"use client";

import { useTheme } from "next-themes";
import { type ReactElement, useEffect, useState } from "react";
import { LuChevronRight } from "react-icons/lu";
import { leaveKip, StaleSession } from "../utils/leave";
import { useKip } from "../utils/store";
import { asThemeChoice, type ThemeChoice } from "../utils/theme";
import { NOTIFY_EVENTS, type NotifyKind } from "../utils/types";
import { useDialog } from "./dialog";
import { useNameGate } from "./name-gate";
import Button from "./ui/button";
import FieldNote from "./ui/field-note";
import { Group, Row, Section } from "./ui/list";
import Segmented from "./ui/segmented";
import Switch from "./ui/switch";
import { useLeave } from "./use-leave";

// Your name and handle are edited on your profile, where they're actually shown;
// this section is what's left — the address you sign in with, and a way through.
function AccountSection(): ReactElement | null {
  const {
    user,
    anonymous,
    navigate,
    myListings,
    trips,
    incomingBookings,
    friends,
  } = useKip();
  const { confirm, alert } = useDialog();
  // Shared with the menu, so the two exits cannot say different things or do
  // different amounts of work.
  const { leave, leaving: leavingDevice } = useLeave();
  const [leaving, setLeaving] = useState(false);

  // Deletion, not sign-out, and it says what other people lose too — a host
  // cancelling stays and a guest cancelling trips is what step one of this does,
  // and nobody should discover that after the fact.
  async function deleteAccount(): Promise<void> {
    // Same reason as `useLeave`: a second run re-cancels what the first already
    // cancelled, and the rules refusing that reads as a failure.
    if (!user || leaving) return;
    const sure = await confirm({
      title: "Delete your kip?",
      body: "Your stays and any stays at your places will be cancelled, and your friends will lose you from their lists. Past visits stay as a record, without your name. This can't be undone.",
      confirmLabel: "Delete everything",
      tone: "danger",
    });
    if (!sure) return;
    await teardown();
  }

  // Shared by both exits, because both must dismantle rather than merely leave.
  // Every step is a no-op on what is already gone, so pressing again after a
  // failure finishes the job rather than starting a second one.
  async function teardown(then?: () => Promise<void>): Promise<void> {
    if (!user) return;
    setLeaving(true);
    try {
      await leaveKip(
        user.uid,
        myListings,
        trips,
        incomingBookings,
        friends.map((friend) => friend.uid),
      );
      await then?.();
    } catch (error) {
      console.error(error);
      setLeaving(false);
      await alert(
        error instanceof StaleSession
          ? {
              title: "Almost done",
              body: "Your places, stays and friends are gone. Firebase needs a fresh sign-in to remove the account itself — come back in and press it once more.",
            }
          : {
              // Silence here left someone half dismantled with no idea of it.
              title: "That didn't finish",
              body: "Some of it went through. Check your connection and press it again — it picks up where it stopped.",
            },
      );
    }
  }

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
            Used only to reach you and to get you back into kip — never shown to
            other users or used to find you.
          </FieldNote>
        </div>
      ) : null}

      {/* The deliberate exit, and the ONLY one an account with no credential is
          offered. It is destruction rather than sign-out — the uid lives in this
          browser and nowhere else — so it says so, twice, and never sits in a
          casual menu. */}
      <Group>
        {anonymous ? (
          <Row onClick={leave} ariaLabel="Leave kip">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium text-danger">
                {leavingDevice ? "Leaving…" : "Leave kip"}
              </span>
              <span className="truncate text-sm text-muted">
                Cancels your stays and removes you from friends' lists
              </span>
            </span>
          </Row>
        ) : (
          <Row onClick={deleteAccount} ariaLabel="Delete your kip">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium text-danger">
                {leaving ? "Deleting…" : "Delete your kip"}
              </span>
              <span className="truncate text-sm text-muted">
                Cancels your stays and removes you from friends' lists
              </span>
            </span>
          </Row>
        )}
      </Group>
    </Section>
  );
}

// The two independent ways someone can reach you: a handle they can search for,
// and a share link they can open. Neither is on by default — a fresh account is
// unreachable until you choose to be found. Both switches are mirrors: the handle
// itself is claimed on your profile, and the link is copied there.
function DiscoverabilitySection(): ReactElement | null {
  const { askIdentity } = useNameGate();
  const {
    profile,
    anonymous,
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
        {/* A username is permanent, so it needs an account someone can get
            back into — the rule refuses the claim outright, and this says why
            rather than letting the switch fail. */}
        <Switch
          checked={profile.searchable}
          onChange={toggle}
          disabled={anonymous}
          label="Findable by username"
          description={
            anonymous
              ? "Add an email or a number first — a username is permanent, so it needs an account you can get back into."
              : handle
                ? `Anyone who knows @${handle} can send you a friend request.`
                : "Claim a username on your profile first — it's permanent, so you pick it there."
          }
        />
        {anonymous ? (
          <div className="px-4 pb-4">
            <Button variant="secondary" onClick={askIdentity}>
              Add email or number
            </Button>
          </div>
        ) : null}
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
  const { askIdentity } = useNameGate();
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
      {/* Two different gaps, and they used to be one. An address kip has but
          can't trust is a confirm; no address at all is an ask — and without
          this split the second rendered "Confirm undefined", which nobody saw
          only because these sessions could not reach Settings. */}
      {user.email ? (
        emailVerified ? null : (
          <div className="flex flex-col gap-3 rounded-3xl bg-surface p-4 shadow-card">
            <p className="text-sm text-muted">
              kip only emails an address that's been confirmed — otherwise
              anyone could enter someone else's and have kip mail them. Confirm{" "}
              {user.email} to start receiving these.
            </p>
            {sent ? (
              <FieldNote tone="success">
                Sent. Check your inbox, then reload kip.
              </FieldNote>
            ) : (
              <Button
                variant="secondary"
                onClick={resend}
                className="self-start"
              >
                Send confirmation email
              </Button>
            )}
            {error ? <FieldNote tone="danger">{error}</FieldNote> : null}
          </div>
        )
      ) : (
        <div className="flex flex-col items-start gap-3 rounded-3xl bg-surface p-4 shadow-card">
          <p className="text-sm text-muted">
            kip can only reach you by email. Add an address to hear when things
            happen without opening kip.
          </p>
          <Button variant="secondary" onClick={askIdentity}>
            Add email
          </Button>
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
