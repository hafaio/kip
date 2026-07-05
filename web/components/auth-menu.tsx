"use client";

import { type ReactElement, useState } from "react";
import { LuChevronDown, LuLogOut, LuSettings, LuUser } from "react-icons/lu";
import { useKip } from "../utils/store";
import Avatar from "./avatar";

// Only shown once signed in (the app gates on auth). Sign-in itself lives on
// the SignInScreen, so this is the profile menu: your profile, Settings (the
// dock has no room for it), and sign-out.
export default function AuthMenu(): ReactElement | null {
  const { user, profile, signOut, setView, navigate } = useKip();
  const [open, setOpen] = useState(false);

  const displayName = profile?.displayName ?? user?.displayName ?? user?.email;
  const photoURL = profile?.photoURL ?? user?.photoURL ?? null;

  async function doSignOut() {
    try {
      await signOut();
    } catch (error) {
      console.error(error);
    }
    setOpen(false);
  }

  // An anonymous share-link visitor is signed in as far as Firebase is concerned,
  // but has no account in any sense that matters — showing them an avatar with a
  // profile and a sign-out would be offering things that don't exist for them.
  if (!user || user.isAnonymous) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Your account"
        className="flex h-10 items-center gap-0.5 rounded-full pr-1 transition hover:opacity-80"
      >
        <Avatar
          name={displayName ?? ""}
          photoURL={photoURL}
          className="h-9 w-9 text-sm shadow-soft"
        />
        {/* An avatar on its own reads as decoration, which is how Settings and
            sign-out end up looking absent — they live behind it. The chevron is
            the only thing saying it opens something. */}
        <LuChevronDown className="shrink-0 text-muted" size={14} />
      </button>
      {open ? (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div className="absolute right-0 z-20 mt-2 w-48 overflow-hidden rounded-2xl bg-surface p-1.5 shadow-panel">
            <button
              type="button"
              onClick={() => {
                if (user) navigate({ kind: "person", id: user.uid });
                setOpen(false);
              }}
              className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-[0.9375rem] font-medium text-text hover:bg-surface-hover"
            >
              <LuUser className="text-muted" />
              <span>Your profile</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setView("settings");
                setOpen(false);
              }}
              className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-[0.9375rem] font-medium text-text hover:bg-surface-hover"
            >
              <LuSettings className="text-muted" />
              <span>Settings</span>
            </button>
            <button
              type="button"
              onClick={doSignOut}
              className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-[0.9375rem] font-medium text-text hover:bg-surface-hover"
            >
              <LuLogOut className="text-muted" />
              <span>Sign out</span>
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
