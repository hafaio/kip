"use client";

import Link from "next/link";
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
import { requestDeletion } from "../utils/leave";
import { standingConsent } from "../utils/settings";
import {
  CHECK_STALL_MS,
  formatUsNumber,
  probeState,
  SMS_FROM,
  startTextLink,
} from "../utils/sms";
import { useKip } from "../utils/store";
import { asThemeChoice, type ThemeChoice } from "../utils/theme";
import {
  NOTIFY_EVENTS,
  type NotifyKind,
  type NotifySmsKind,
} from "../utils/types";
import { useDialog } from "./dialog";
import { otherAccountAlert, useNameGate } from "./name-gate";
import ReachField, {
  codeReady,
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

// kip has no number to text from, so nothing can be sent and nothing may be
// agreed to. The same "ships able to be off" shape as `smsConfigured()` on the
// sender and `firebaseConfigured()` on the client: one constant, checked before
// anything is offered. Provisioning a number is what turns the section on.
const SMS_LIVE = Boolean(SMS_FROM);

// The field defaults to email, and this sheet's door is a keypad from the first
// tap — `only` pins the route, this only picks the keyboard.
const PHONE_REACH: ReachState = { ...EMPTY_REACH, mode: "phone" };

// Removing one of these two takes the reach it carried with it: unlinking clears
// the address or the number off the Auth account, which is the only copy kip
// keeps, so notifications on that channel stop. Probed against the Auth
// emulator, including the case where a Google door carries the same address —
// the address still goes. Google is absent because it is the exception: it
// leaves the address behind, and kip keeps mailing it.
const LOSES: Record<string, string> = {
  [EMAIL_DOOR]: "The address goes with it, so kip's email stops. ",
  [PHONE_DOOR]: "The number goes with it, so kip's texts stop. ",
};

// The one message line both sheets end on, mounted whether or not it has
// anything to say: a live region announces a CHANGE, so one that appears
// together with its text is one a screen reader never reads out. It carries its
// own top margin rather than taking a gap from the column, so an empty one costs
// no height at all — which is why it sits in a gapless wrapper with the button
// it follows rather than beside it.
//
// It used to stand at one line always, reserved so a refusal could not lift the
// field off the thumb of whoever was typing into it. What made that a fair trade
// was standing copy filling the line the rest of the time; both sheets have
// since run out of anything to say there, and 32px of empty sheet under the
// button on every render reads as the layout having broken rather than as room
// being kept.
function Problem({ message }: { message: string | null }): ReactElement {
  return (
    <p
      aria-live="polite"
      className={`text-sm leading-5 text-danger ${message ? "mt-3" : ""}`}
    >
      {message}
    </p>
  );
}

// What this account can be reached and re-entered by. kip has no password, so
// there is no reset to fall back on: one credential is one lost inbox from
// unrecoverable, which is the whole reason this is a list rather than a line.
//
// Every row reads the store's snapshot rather than `user`, because linking and
// unlinking change those fields without changing the uid — Firebase hands React
// the same object and a row reading it never re-renders.
function DoorsSection(): ReactElement {
  const { doors, emailVerified, keepTexts, prefs, setTexts, signIn } = useKip();
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
        if (!sameAccount) {
          // The number was already on kip, so they are IN that account now — a
          // different uid, with its own places, friends and stays. Nothing here
          // can merge the two.
          await alert(otherAccountAlert("number"));
        } else if (SMS_LIVE && reach.sentTo && standingConsent(prefs)) {
          // Gated too, not just the switch: this is the OTHER way a consent gets
          // written, and re-presenting the disclosures for texts kip cannot send
          // takes an agreement it has no use for.
          await offerTexts(reach.sentTo);
        }
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
        setError("Wrong code. Check it, or ask for another.");
      } else if (caught instanceof PhoneAlreadySet) {
        // The row offered Add, so this account grew a number somewhere else —
        // another tab, or the sheet that collects one beside an ask.
        setError("A number was added. Reload kip to see it.");
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

  // Changing your number is remove-then-add, and the texts you had turned on
  // must not just stop without you noticing. Not a transfer: the disclosures are
  // shown again, so what this writes is a fresh consent naming the NEW phone.
  // Only where a consent already stands — otherwise adding a number would nag
  // about texts nobody asked for, which is the bundling this design refuses.
  async function offerTexts(number: string): Promise<void> {
    const keep = await confirm({
      title: "Keep texts on?",
      body: `You had kip's texts turned on for your old number. kip can text ${number} instead — the same kinds you chose, as automated texts. Message frequency varies, and message and data rates may apply. Reply STOP to stop, HELP for help.`,
      confirmLabel: "Text this number",
      cancelLabel: "No texts",
    });
    try {
      if (keep) {
        await keepTexts(number);
      } else if (Object.values(prefs.notifySms).some(Boolean)) {
        // Removing the old number already zeroed the map, but a number can
        // change by routes this screen doesn't own. Declining has to mean off
        // wherever it was reached from.
        await setTexts(false);
      }
    } catch (caught) {
      console.error(caught);
      setError("Couldn't save that. Try again.");
    }
  }

  async function remove(providerId: string, name: string): Promise<void> {
    const sure = await confirm({
      title: `Remove ${name}?`,
      body: `${LOSES[providerId] ?? ""}You'll still get in the other ways listed here, and you can add this one back anytime.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!sure) return;
    setBusy(true);
    setError(null);
    try {
      await removeDoor(providerId);
      // Taking a number off the account is the plainest way there is of saying
      // stop texting me, so re-adding one asks again rather than resuming. The
      // consent record stays: it is what explains texts already sent, and what
      // tells a change of number from someone who never wanted texts at all.
      if (providerId === PHONE_DOOR) await setTexts(false);
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
              invalid={Boolean(error)}
              value={address}
              onChange={(event) => {
                setError(null);
                setAddress(event.target.value);
              }}
              placeholder="you@example.com"
            />
            <div className="flex flex-col">
              <Button type="submit" size="lg" disabled={busy || !address}>
                {busy ? (
                  <LuLoaderCircle className="animate-spin" />
                ) : (
                  "Send the link"
                )}
              </Button>
              <Problem message={error} />
            </div>
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
            invalid={Boolean(error || numberProblem)}
            busy={busy}
          />
          <div className="flex flex-col">
            <Button
              type="submit"
              size="lg"
              disabled={
                busy ||
                Boolean(numberProblem) ||
                (reach.pending ? !codeReady(reach) : !reach.raw)
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
            <Problem message={error ?? numberProblem} />
          </div>
        </form>
      </Sheet>
    </Section>
  );
}

// Your name and handle are edited on your profile, where they're actually shown;
// this section is what's left — the ways into the account, and the way out.
function AccountSection(): ReactElement | null {
  const { user, anonymous, navigate } = useKip();
  const { confirm, alert } = useDialog();
  // Shared with the menu, so the two exits cannot say different things or do
  // different amounts of work.
  const { leave, leaving: leavingDevice } = useLeave();
  const [leaving, setLeaving] = useState(false);

  // Deletion, not sign-out, and it says what other people lose too — a host
  // cancelling stays and a guest cancelling trips is what the first phase of it
  // does, and nobody should discover that after the fact.
  async function deleteAccount(): Promise<void> {
    if (!user || leaving) return;
    const sure = await confirm({
      title: "Delete your kip?",
      body: "Your stays and any stays at your places will be cancelled, and your friends will lose you from their lists. Past visits stay as a record, without your name. This can't be undone.",
      confirmLabel: "Delete everything",
      tone: "danger",
    });
    if (!sure) return;
    setLeaving(true);
    try {
      // Asking is the whole of it: a Cloud Function does the teardown and
      // retries on its own, so this tab is free to be closed. It used to be a
      // chain of writes from here, and closing the tab partway through left an
      // account nothing would ever finish.
      await requestDeletion(user.uid);
    } catch (error) {
      console.error(error);
      setLeaving(false);
      await alert({
        title: "Couldn't start that",
        body: "Nothing has been deleted. Check your connection and try again.",
      });
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

// One list, walked by both channels, so the two read label for label. The kinds
// a text cannot carry are still ROWS on the text side — saying "email only"
// where the toggle would be — because a channel that silently drops two of six
// looks like it forgot them. That replaces a sentence under the group naming the
// missing kinds, which was four rows away from the gap it explained.
const EVENTS = Object.entries(NOTIFY_EVENTS);

// Two channels, each with its own way of reaching nobody: email needs a verified
// address, and a text needs a number on the account plus consent that was given
// beside the disclosures. Both gaps are silent, so both are said here.
function NotificationsSection(): ReactElement | null {
  const { askIdentity } = useNameGate();
  const {
    user,
    email,
    emailVerified,
    phone,
    prefs,
    setNotify,
    setTexts,
    checkTexts,
    setTextNotify,
    resendVerification,
  } = useKip();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  // Derived from the two stamps and the clock rather than held in state, so a
  // reload can't lose a check in flight and a second press still means "ask
  // again". One timer, armed only while a check could still turn into a stall —
  // an interval would re-render the section to advance a clock nothing reads.
  const [now, setNow] = useState(() => Date.now());
  const probe = probeState(prefs.smsProbeAt, prefs.smsProbeDoneAt, now);
  const askedAt = prefs.smsProbeAt;
  useEffect(() => {
    if (probe !== "checking" || askedAt === null) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      askedAt + CHECK_STALL_MS - now,
    );
    return () => clearTimeout(timer);
  }, [probe, askedAt, now]);

  if (!user) return null;

  // One switch over the whole map: what people decide is "text me the important
  // stuff", and per-kind granularity later is a UI change with no migration.
  //
  // `some`, not `every`: a kind added to the table later is absent from a stored
  // map and reads false, and that is meant to stay false — the disclosures name
  // the kinds, so a new one is wording nobody agreed to and wants the switch
  // turned on again. `every` would meanwhile read "off" while four kinds still
  // text, which is the lie worth avoiding.
  //
  // AND bound to the number it was given for. Read off the map alone, the row
  // rendered ON and greyed out over an account whose phone door had been
  // removed — nothing to turn it off with — and a different number added later
  // resumed texting on an agreement about the old one.
  //
  // ANDed with `SMS_LIVE`, or an account that agreed before kip lost its number
  // renders every text row ON while nothing can be sent — a switch claiming kip
  // texts about this is the one thing the section must never say.
  const texting =
    SMS_LIVE &&
    prefs.smsConsentNumber !== null &&
    prefs.smsConsentNumber === phone &&
    Object.values(prefs.notifySms).some(Boolean);
  // Carrier-enforced, so kip only observes it — and only by attempting a send,
  // which needs the switch left on. Disabling it here stranded anyone whose STOP
  // landed as they were switching texts off: nothing to attempt, nothing to
  // clear the flag, and a dead control. Turning it on clears it instead, and the
  // next refused send writes it straight back.
  const blocked = prefs.smsStopped;
  const checking = probe === "checking";
  // Only once the sender has actually answered. Gated on the state rather than
  // on the stamp being non-null, or a STALL would show "kip tried a text" over
  // an older answer while this ask was still unaccounted for.
  const checkedStillBlocked = probe === "answered" && blocked;

  async function runCheck(): Promise<void> {
    setTextError(null);
    setNow(Date.now());
    try {
      await checkTexts();
    } catch (caught) {
      console.error(caught);
      setTextError("Couldn't check just now. Try again.");
    }
  }

  async function toggleTexts(next: boolean): Promise<void> {
    setTextError(null);
    try {
      await setTexts(next);
    } catch (caught) {
      console.error(caught);
      setTextError("Couldn't save that. Try again.");
    }
  }

  async function toggleKind(kind: NotifySmsKind, next: boolean): Promise<void> {
    setTextError(null);
    try {
      await setTextNotify(kind, next);
    } catch (caught) {
      console.error(caught);
      setTextError("Couldn't save that. Try again.");
    }
  }

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
    // Channel-major: two labelled blocks, each heading tight against the group
    // it names. Nested so the outer gap separates the channels while the inner
    // one keeps a heading with its list.
    <Section title="Notifications" className="gap-4">
      <Section title="Email">
        {/* Two different gaps, and they used to be one. An address kip has but
          can't trust is a confirm; no address at all is an ask — and without
          this split the second rendered "Confirm undefined", which nobody saw
          only because these sessions could not reach Settings. */}
        {email ? (
          emailVerified ? null : (
            <div className="flex flex-col gap-3 rounded-3xl bg-surface p-4 shadow-card">
              <p className="text-sm text-muted">
                kip only emails an address that's been confirmed — otherwise
                anyone could enter someone else's and have kip mail them.
                Confirm {email} to start receiving these.
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
              {phone && SMS_LIVE
                ? "kip has no address for you, so none of this arrives by email. A text can still reach you — turn those on below."
                : "kip has no way to reach you when you're not looking at it. Add an address to hear when things happen."}
            </p>
            <Button variant="secondary" onClick={askIdentity}>
              Add email
            </Button>
          </div>
        )}

        <Group>
          {EVENTS.map(([key, event]) => (
            <Switch
              key={key}
              checked={prefs.notify[key as NotifyKind]}
              onChange={(next) => setNotify(key as NotifyKind, next)}
              label={event.label}
              description={event.note}
              srSuffix="by email"
            />
          ))}
        </Group>
      </Section>

      <Section title="Texts">
        {/* Consent to be texted is collected on the first row and nowhere else: it
          must not ride along with signing in or with adding a number, which is
          what bundling it onto the reach field would have done. Off by default,
          and the disclosures are on the row being turned on.

          The rows under it carry no descriptions. Each is the same event as a
          row forty pixels up, whose note already says what it is, and four more
          paragraphs would double the section to repeat them. */}
        <Group>
          <Switch
            checked={texting}
            onChange={toggleTexts}
            disabled={!SMS_LIVE || !phone}
            label="Text me"
            description={
              !SMS_LIVE
                ? "kip has no number to text from yet, so nothing can be sent and there is nothing to agree to. This turns on when it has one."
                : phone
                  ? `Automated texts to ${phone} for the kinds below. Message frequency varies, and message and data rates may apply. Reply STOP to stop, HELP for help.`
                  : "kip texts the number on your account, and this one has none. Add a phone under How you get in, above."
            }
          />
          {EVENTS.map(([key, event]) =>
            event.sms ? (
              <Switch
                key={key}
                // Not the stored map alone: consent bound to a number that has
                // since changed leaves trues standing that nothing will act on,
                // and a greyed-out row drawn ON would be saying kip texts about
                // this. `texting` already folds in the no-number-at-all case.
                checked={texting && prefs.notifySms[key as NotifySmsKind]}
                // One condition for no sender, no phone, no consent and consent
                // about another number — every one of them is answered by the
                // row above, which is why none needs its own line here.
                disabled={!texting}
                onChange={(next) => toggleKind(key as NotifySmsKind, next)}
                label={event.label}
                srSuffix="by text"
              />
            ) : (
              // Nothing takes this branch today — every kind is textable — and it
              // is kept because the next one may not be: a saved-search digest is
              // not caused by a person acting on you and belongs in an inbox. The
              // table decides, so adding such a kind is one flag rather than a
              // second list here.
              <Switch
                key={key}
                checked={false}
                onChange={() => {}}
                label={event.label}
                unavailable="Email only"
              />
            ),
          )}
        </Group>

        {textError ? <FieldNote tone="danger">{textError}</FieldNote> : null}

        {/* kip can only ever OBSERVE this: the carrier holds the block, and the
          only way out is the person texting START themselves. So the number is
          named and made tappable rather than described — "the number kip texted
          you from" is in a message they may well have deleted.

          The check is here because nothing else would tell them it worked: the
          block lifts silently, and kip finds out only by trying. Without it the
          answer is "wait until kip next has something to text you about", which
          for a quiet week is indistinguishable from still being blocked. */}
        {SMS_LIVE && blocked ? (
          <FieldNote tone="danger">
            <span>
              Your carrier is blocking kip's texts: STOP was replied from{" "}
              {phone ?? "your number"}. kip can't lift that.{" "}
              {SMS_FROM ? (
                <>
                  Text START to{" "}
                  <a
                    className="font-semibold underline"
                    href={startTextLink(SMS_FROM)}
                  >
                    {formatUsNumber(SMS_FROM)}
                  </a>
                  , then check below.
                </>
              ) : (
                <>
                  Text START to the number kip texted you from, and this clears
                  the next time a text gets through.
                </>
              )}
            </span>
            {SMS_FROM ? (
              <span className="mt-3 flex items-center gap-3">
                <Button
                  variant="secondary"
                  onClick={runCheck}
                  disabled={checking}
                >
                  {checking ? (
                    <LuLoaderCircle className="animate-spin" />
                  ) : (
                    "Check now"
                  )}
                </Button>
                {checkedStillBlocked ? (
                  <span>kip tried a text; the block is still there.</span>
                ) : probe === "stalled" ? (
                  <span>That check didn't run. Try again.</span>
                ) : null}
              </span>
            ) : null}
          </FieldNote>
        ) : null}

        {/* Required beside an SMS consent, and they stay whether or not kip can
          send today. */}
        <FieldNote>
          See our{" "}
          <Link className="font-semibold text-accent-ink" href="/privacy/">
            Privacy Policy
          </Link>{" "}
          and{" "}
          <Link className="font-semibold text-accent-ink" href="/terms/">
            Terms
          </Link>
          .
        </FieldNote>

        {/* Across both channels: an email switch left on still tells you, and a
          text switch is no comfort while texts are off as a whole. */}
        {!prefs.notify.stayCancelled &&
        !(texting && prefs.notifySms.stayCancelled) ? (
          <FieldNote tone="danger">
            Nothing will tell you if a stay you're counting on is called off —
            no email, no text. You'd only find out by opening kip.
          </FieldNote>
        ) : null}
      </Section>
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
