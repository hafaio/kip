"use client";

import { useState } from "react";
import { auth } from "../utils/firebase";
import { leaveKip, StaleSession } from "../utils/leave";
import { useKip } from "../utils/store";
import { useDialog } from "./dialog";

// The one exit for an account with no credential, shared by the menu and
// Settings so the two cannot drift. Leaving IS deletion here — there is no way
// back in — so both surfaces must dismantle rather than merely sign out. The
// menu used to sign out alone while its confirm promised the friends and stays
// were going, which left a permanent ghost: a dead row in every friend's list, a
// phantom guest for every host, and a profile the reaper will never collect.
export function useLeave(): { leave: () => Promise<void>; leaving: boolean } {
  const { user, signOut, myListings, trips, incomingBookings, friends } =
    useKip();
  const { confirm, alert } = useDialog();
  const [leaving, setLeaving] = useState(false);

  async function leave(): Promise<void> {
    // A teardown is a long serial chain of writes and the controls stay tappable
    // while it runs. A second pass re-cancels bookings the first already set
    // CANCELLED, which the rules refuse — so a teardown that WORKED reports
    // "that didn't finish".
    if (!user || leaving) return;

    // `anonymous` is a snapshot, and the email door completes in ANOTHER
    // browser: someone who typed their address here and opened the mail on
    // their phone still reads as credential-less until this tab is blurred. So
    // the sentence below — there is no way back in — has to be re-checked
    // against the account itself, not against a flag, before it deletes them.
    const current = auth().currentUser;
    await current?.reload().catch(() => undefined);
    if (current && current.providerData.length > 0) {
      await alert({
        title: "You're all set",
        body: "This account has a way back in now, so there's nothing to delete here. Sign out instead if you want to leave this device.",
      });
      return;
    }

    const sure = await confirm({
      title: "Leave kip?",
      body: "You haven't added an email or a number, so there's no way back in. Your stays will be cancelled, your friends will lose you, and everything this browser holds goes for good.",
      confirmLabel: "Delete and leave",
      tone: "danger",
    });
    if (!sure) return;
    setLeaving(true);
    try {
      await leaveKip(
        user.uid,
        myListings,
        trips,
        incomingBookings,
        friends.map((friend) => friend.uid),
      );
      await signOut(true);
    } catch (error) {
      console.error(error);
      if (error instanceof StaleSession) {
        // "Sign in again and retry" is advice an account with no credential
        // cannot follow. Everything social is already gone by here, so what
        // remains is an empty ticket the reaper collects — finish the leave
        // rather than strand them in front of an instruction they can't act on.
        await signOut(true);
        return;
      }
      setLeaving(false);
      await alert({
        title: "That didn't finish",
        body: "Some of it went through. Check your connection and press it again — it picks up where it stopped.",
      });
    }
  }

  return { leave, leaving };
}
