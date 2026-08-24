"use client";

import { useState } from "react";
import { auth } from "../utils/firebase";
import { requestDeletion } from "../utils/leave";
import { useKip } from "../utils/store";
import { useDialog } from "./dialog";

// The one exit for an account with no credential, shared by the menu and
// Settings so the two cannot drift. Leaving IS deletion here — there is no way
// back in — so both surfaces ask for the teardown rather than merely signing
// out. The menu used to sign out alone while its confirm promised the friends
// and stays were going, which left a permanent ghost: a dead row in every
// friend's list, a phantom guest for every host, and a profile the reaper will
// never collect.
export function useLeave(): { leave: () => Promise<void>; leaving: boolean } {
  const { user } = useKip();
  const { confirm, alert } = useDialog();
  const [leaving, setLeaving] = useState(false);

  async function leave(): Promise<void> {
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
      // One write, and the screen it puts up belongs to the store: the trigger
      // reports its progress into that document and deletes it when it is done.
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

  return { leave, leaving };
}
