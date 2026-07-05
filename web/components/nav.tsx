"use client";

import type { ReactElement, ReactNode } from "react";
import {
  LuDoorOpen,
  LuHouse,
  LuLuggage,
  LuSearch,
  LuUsers,
} from "react-icons/lu";
import { useKip } from "../utils/store";
import type { View } from "../utils/types";
import AuthMenu from "./auth-menu";
import ThemeButton from "./theme-button";
import { CountBadge } from "./ui/chip";
import Wordmark from "./wordmark";

type NavItem = {
  readonly view: View;
  readonly label: string;
  readonly icon: ReactNode;
  readonly badge: number;
};

// The primary destinations, shared by the desktop top bar and the mobile dock.
// Settings lives in the profile menu (AuthMenu) instead, to keep it to five
// thumb-sized tabs.
function useNavItems(): NavItem[] {
  const { incomingRequests, incomingBookings } = useKip();
  const pendingBookings = incomingBookings.filter(
    (booking) => booking.status === "REQUESTED",
  ).length;

  return [
    { view: "home", label: "Home", icon: <LuHouse size={20} />, badge: 0 },
    { view: "browse", label: "Browse", icon: <LuSearch size={20} />, badge: 0 },
    {
      view: "places",
      label: "Places",
      icon: <LuDoorOpen size={20} />,
      // Stays people are asking for. Friend asks are counted on Friends, not
      // here — they were double-counted when the two request kinds merged names.
      badge: pendingBookings,
    },
    { view: "trips", label: "Trips", icon: <LuLuggage size={20} />, badge: 0 },
    {
      view: "friends",
      label: "Friends",
      icon: <LuUsers size={20} />,
      badge: incomingRequests.length,
    },
  ];
}

// Desktop: a sticky top app bar replacing the old left sidebar. Wordmark left,
// nav as inline pill links (active = tonal accent pill), avatar right. Canvas
// background with a blur so content scrolls under it.
export function TopBar(): ReactElement {
  const { view, setView } = useKip();
  const items = useNavItems();

  return (
    <header className="sticky top-0 z-30 hidden border-b border-border bg-bg/80 backdrop-blur md:block">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
        <button
          type="button"
          onClick={() => setView("home")}
          className="transition hover:opacity-80"
          aria-label="Home"
        >
          <Wordmark />
        </button>
        <nav className="ml-4 flex items-center gap-1">
          {items.map((item) => {
            const active = view === item.view;
            return (
              <button
                key={item.view}
                type="button"
                onClick={() => setView(item.view)}
                className={`flex h-10 items-center gap-2 rounded-full px-4 text-[0.9375rem] font-semibold transition ${
                  active
                    ? "bg-accent-soft text-accent-ink"
                    : "text-muted hover:bg-surface-hover hover:text-text"
                }`}
              >
                {item.label}
                <CountBadge count={item.badge} />
              </button>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <ThemeButton />
          <AuthMenu />
        </div>
      </div>
    </header>
  );
}

// Mobile: a floating dock inset from the screen edges. Rounded, translucent with
// a blur, raised by a soft shadow over a hairline border — the one border kept
// on a floating surface, because a translucent dock over a photo has nothing
// else to separate it from what it sits on; the active tab is wrapped in a soft accent
// pill and count badges float over the icon. Content pads its bottom by ~96px so
// the dock never covers it.
export function FloatingDock(): ReactElement {
  const { view, setView } = useKip();
  const items = useNavItems();

  return (
    <nav className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+12px)] z-30 flex items-center justify-around rounded-3xl border border-border bg-surface/90 px-1.5 py-2 shadow-dock backdrop-blur md:hidden">
      {items.map((item) => {
        const active = view === item.view;
        return (
          <button
            key={item.view}
            type="button"
            onClick={() => setView(item.view)}
            aria-label={item.label}
            aria-current={active ? "page" : undefined}
            className={`flex min-w-[3.25rem] flex-col items-center gap-0.5 rounded-2xl py-1 text-[0.625rem] font-semibold transition ${
              active ? "text-accent-ink" : "text-faint"
            }`}
          >
            <span
              className={`relative grid h-8 w-10 place-items-center rounded-2xl transition-colors ${
                active ? "bg-accent-soft" : ""
              }`}
            >
              {item.icon}
              {item.badge > 0 ? (
                <span className="bg-gradient-accent absolute -top-0.5 right-1.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[0.625rem] font-bold leading-none text-white ring-2 ring-surface tabular-nums">
                  {item.badge}
                </span>
              ) : null}
            </span>
            <span className="leading-none">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
