"use client";

import { useTheme } from "next-themes";
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { LuChevronRight, LuLoaderCircle, LuX } from "react-icons/lu";
import {
  authErrorMessage,
  EMAIL_DOOR,
  GOOGLE_DOOR,
  PHONE_DOOR,
  PhoneAlreadySet,
  removeDoor,
  StaleSession,
  sendAttachLink,
} from "../utils/auth";
import { parseDestination } from "../utils/destination";
import { leaveKip } from "../utils/leave";
import { useKip } from "../utils/store";
import { asThemeChoice, type ThemeChoice } from "../utils/theme";
import { NOTIFY_EVENTS, type NotifyKind } from "../utils/types";
import { useDialog } from "./dialog";
import { otherAccountAlert, useNameGate } from "./name-gate";
import ReachField, {
  confirmReach,
  EMPTY_REACH,
  type ReachState,
  reachError,
  sendReach,
} from "./reach-field";
import Button from "./ui/button";
import Chip from "./ui/chip";
import FieldNote from "./ui/field-note";
import IconButton from "./ui/icon-button";
import Input from "./ui/input";
import { Group, Row, Section } from "./ui/list";
import Segmented from "./ui/segmented";
import Sheet from "./ui/sheet";
import Switch from "./ui/switch";
import { useLeave } from "./use-leave";

// One way in. The value is the address it carries once it's set, and the sub-
// line otherwise says what adding it buys — a Google account already supplies an
// address, so "no email" would be a lie on the row that most needs to be true.
function DoorRow({
  name,
  value,
  note,
  chip,
  busy,
  onAdd,
  // Absent when this is the only way in, which must never be removable.
  onRemove,
}: {
  name: string;
  value: string | null;
  note: string;
  chip?: ReactNode;
  busy: boolean;
  onAdd: () => void;
  onRemove: (() => void) | null;
}): ReactElement {
  return (
    <Row>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[0.9375rem] font-medium">{name}</span>
        {/* A long address wraps and clips at 390px, so it ends in an ellipsis
            instead — the same treatment the profile page gives the same
            string. */}
        <span className="truncate text-sm text-muted">{value ?? note}</span>
      </span>
      {chip}
      {value === null ? (
        <Button variant="secondary" onClick={onAdd} disabled={busy}>
          Add
        </Button>
      ) : onRemove ? (
        <IconButton
          variant="danger"
          label={`Remove ${name}`}
          onClick={onRemove}
          disabled={busy}
        >
          <LuX />
        </IconButton>
      ) : null}
    </Row>
  );
}

// The field defaults to email, and this sheet's door is a keypad from the first
// tap — `only` pins the route, this only picks the keyboard.
const PHONE_REACH: ReachState = { ...EMPTY_REACH, mode: "phone" };

// What this account can be reached and re-entered by. kip has no password, so
// there is no reset to fall back on: one credential is one lost inbox from
// unrecoverable, which is the whole reason this is a list rather than a line.
//
// Every row reads the store's snapshot rather than `user`, because linking and
// unlinking change those fields without changing the uid — Firebase hands React
// the same object and a row reading it never re-renders.
function DoorsSection(): ReactElement {
  const { doors, emailVerified, signIn } = useKip();
  const { confirm, alert } = useDialog();
  // Which sheet is up, rather than one flag each: they draw over the same note
  // and only one can be answered at a time.
  const [sheet, setSheet] = useState<"email" | "phone" | null>(null);
  const [address, setAddress] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [reach, setReach] = useState<ReachState>(PHONE_REACH);
  const recaptcha = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailDoor = doors.find((door) => door.providerId === EMAIL_DOOR);
  const phoneDoor = doors.find((door) => door.providerId === PHONE_DOOR);
  const googleDoor = doors.find((door) => door.providerId === GOOGLE_DOOR);
  const spare = doors.length > 1;
  const numberProblem = reachError(reach.raw, "phone");

  function openEmail(): void {
    setAddress("");
    setSentTo(null);
    setError(null);
    setSheet("email");
  }

  function openPhone(): void {
    setReach(PHONE_REACH);
    setError(null);
    setSheet("phone");
  }

  // Clearing on the way out, because the note under the group shows the same
  // `error` — so a rejected address would follow the sheet back onto a screen
  // with no field on it.
  function close(): void {
    setError(null);
    setSheet(null);
  }

  // No conflict can surface here: an address that belongs to someone else is
  // indistinguishable at send time — `enableImprovedEmailPrivacy` is what makes
  // it so — and `/continue/` is where it finally refuses and says so.
  async function sendLink(): Promise<void> {
    const parsed = parseDestination(address);
    if (parsed.kind !== "email") {
      setError("That doesn't look like an email address.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // No host: this was added from Settings, where there is no request for
      // the landing page to name.
      await sendAttachLink(parsed.value, "");
      setSentTo(parsed.value);
    } catch (caught) {
      console.error(caught);
      setError(authErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  // Both steps of the phone door, since the sheet's one button finishes
  // whichever is showing: a code that has been sent is waiting to be typed.
  async function submitNumber(): Promise<void> {
    if (numberProblem) return;
    setBusy(true);
    setError(null);
    try {
      if (reach.pending) {
        const { sameAccount } = await confirmReach(reach.pending, reach.code);
        setSheet(null);
        // The number was already on kip, so they are IN that account now — a
        // different uid, with its own places, friends and stays. Nothing here
        // can merge the two.
        if (!sameAccount) await alert(otherAccountAlert("number"));
        return;
      }
      const holder = recaptcha.current;
      if (!holder) throw new Error("no element for the check to bind to");
      // No host: this was added from Settings, where there is no request for
      // a landing page to name.
      const sent = await sendReach(reach.raw, "", holder);
      setReach({ ...reach, pending: sent.pending, sentTo: sent.sentTo });
    } catch (caught) {
      console.error(caught);
      if (reach.pending) {
        setError("That code didn't work. Check it, or ask for another.");
      } else if (caught instanceof PhoneAlreadySet) {
        // The row offered Add, so this account grew a number somewhere else —
        // another tab, or the sheet that collects one beside an ask.
        setError("This account already has a number. Reload kip to see it.");
      } else {
        setError(authErrorMessage(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  async function addGoogle(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { sameAccount } = await signIn();
      // That Google account already existed, so they have MOVED to it — the
      // listings, friends and stays on screen a second ago belong to a uid they
      // no longer are, and nothing here can merge the two.
      if (!sameAccount) await alert(otherAccountAlert("Google account"));
    } catch (caught) {
      console.error(caught);
      setError(authErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove(providerId: string, name: string): Promise<void> {
    const sure = await confirm({
      title: `Remove ${name}?`,
      body: "You'll still get in the other ways listed here, and you can add this one back anytime.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!sure) return;
    setBusy(true);
    setError(null);
    try {
      await removeDoor(providerId);
    } catch (caught) {
      console.error(caught);
      if (caught instanceof StaleSession) {
        await alert({
          title: "Come back in first",
          body: "Firebase only changes what an account signs in with on a fresh sign-in. Sign out, come back in, and remove it then.",
        });
      } else {
        setError("Couldn't remove that. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="How you get in">
      <Group>
        <DoorRow
          name="Email"
          value={emailDoor?.value ?? null}
          note="A one-time link, sent to your inbox"
          chip={
            // A label, not a second offer: confirming is what the Notifications
            // section asks for, since being unconfirmed costs you mail rather
            // than a way in.
            emailDoor && !emailVerified ? (
              <Chip tone="pending">Unconfirmed</Chip>
            ) : undefined
          }
          busy={busy}
          onAdd={openEmail}
          onRemove={spare ? () => remove(EMAIL_DOOR, "email") : null}
        />
        <DoorRow
          name="Phone"
          value={phoneDoor?.value ?? null}
          note="A one-time code, texted to you"
          busy={busy}
          onAdd={openPhone}
          onRemove={spare ? () => remove(PHONE_DOOR, "phone") : null}
        />
        <DoorRow
          name="Google"
          value={googleDoor?.value ?? null}
          note="One tap, no link to wait for"
          busy={busy}
          onAdd={addGoogle}
          onRemove={spare ? () => remove(GOOGLE_DOOR, "Google") : null}
        />
      </Group>

      {error && !sheet ? (
        <FieldNote tone="danger">{error}</FieldNote>
      ) : (
        <FieldNote>
          {doors.length > 1
            ? "Never shown to other users or used to find you."
            : "kip has no password, so these are the only ways back in — a second one means losing the first isn't losing your kip."}
        </FieldNote>
      )}

      <Sheet open={sheet === "email"} onClose={close} title="Add an email">
        {sentTo ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">
              Check {sentTo} and open the link — that's what attaches it. It
              lands on this account whichever device opens it. Reload kip
              afterwards to see it here.
            </p>
            <Button size="lg" onClick={close}>
              Done
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              sendLink();
            }}
          >
            <Input
              autoComplete="email"
              inputMode="email"
              autoFocus
              value={address}
              onChange={(event) => {
                setError(null);
                setAddress(event.target.value);
              }}
              placeholder="you@example.com"
            />
            <p className={`text-sm ${error ? "text-danger" : "text-muted"}`}>
              {error ??
                "kip sends a one-time link. Opening it adds the address to this account."}
            </p>
            <Button type="submit" size="lg" disabled={busy || !address}>
              {busy ? (
                <LuLoaderCircle className="animate-spin" />
              ) : (
                "Send the link"
              )}
            </Button>
          </form>
        )}
      </Sheet>

      <Sheet open={sheet === "phone"} onClose={close} title="Add a number">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submitNumber();
          }}
        >
          <ReachField
            state={reach}
            onChange={(next) => {
              setError(null);
              setReach(next);
            }}
            hostRef={recaptcha}
            only="phone"
          />
          {/* The code step names itself, so the line below it is only ever a
              refusal — leaving the muted copy up there would describe a step
              already taken. */}
          {error || numberProblem || !reach.pending ? (
            <p
              className={`text-sm ${error || numberProblem ? "text-danger" : "text-muted"}`}
            >
              {error ??
                numberProblem ??
                "kip texts a code to check the number is yours. It's a way back in, not a subscription — being texted when things happen is its own switch."}
            </p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            disabled={
              busy ||
              Boolean(numberProblem) ||
              (reach.pending ? !reach.code : !reach.raw)
            }
          >
            {busy ? (
              <LuLoaderCircle className="animate-spin" />
            ) : reach.pending ? (
              "Add the number"
            ) : (
              "Text me a code"
            )}
          </Button>
        </form>
      </Sheet>
    </Section>
  );
}

// Your name and handle are edited on your profile, where they're actually shown;
// this section is what's left — the ways into the account, and the way out.
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

      <DoorsSection />

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
  const { user, email, emailVerified, prefs, setNotify, resendVerification } =
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
      {email ? (
        emailVerified ? null : (
          <div className="flex flex-col gap-3 rounded-3xl bg-surface p-4 shadow-card">
            <p className="text-sm text-muted">
              kip only emails an address that's been confirmed — otherwise
              anyone could enter someone else's and have kip mail them. Confirm{" "}
              {email} to start receiving these.
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
