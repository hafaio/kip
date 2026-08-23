"use client";

import { type ReactElement, useEffect, useRef } from "react";
import { LuArrowLeft } from "react-icons/lu";
import AuthMenu from "../components/auth-menu";
import BookingPage from "../components/booking-page";
import BrowseView from "../components/browse-view";
import FriendsPanel from "../components/friends-panel";
import HomeView from "../components/home-view";
import ListingFormScreen from "../components/listing-form-screen";
import { FloatingDock, TopBar } from "../components/nav";
import PersonPage from "../components/person-page";
import PlacesView from "../components/places-view";
import RoomPage from "../components/room-page";
import SettingsView from "../components/settings-view";
import ThemeButton from "../components/theme-button";
import TripsView from "../components/trips-view";
import Button from "../components/ui/button";
import IconButton from "../components/ui/icon-button";
import WelcomeScreen from "../components/welcome-screen";
import Wordmark, { Mark } from "../components/wordmark";
import { historyScroll, rememberScroll, useKip } from "../utils/store";
import type { Screen, View } from "../utils/types";

const TITLES: Record<View, string> = {
  home: "Home",
  browse: "Browse",
  places: "Places",
  friends: "Friends",
  trips: "Trips",
  settings: "Settings",
};

function CurrentScreen({ screen }: { screen: Screen }): ReactElement {
  switch (screen.kind) {
    case "person":
      return <PersonPage uid={screen.id} />;
    case "room":
      return <RoomPage id={screen.id} />;
    case "booking":
      return <BookingPage id={screen.id} />;
    case "listing-form":
      return <ListingFormScreen id={screen.id} />;
    case "tab":
      switch (screen.tab) {
        case "home":
          return <HomeView />;
        case "browse":
          return <BrowseView />;
        case "places":
          return <PlacesView />;
        case "friends":
          return <FriendsPanel />;
        case "trips":
          return <TripsView />;
        case "settings":
          return <SettingsView />;
      }
  }
}

// Reload rather than a retry button: the store has already retried and given up,
// and a reload is what re-runs auth from scratch, which covers the likeliest
// causes. A client cannot talk a server out of a refusal, so this is disclosure.
function StaleDataNotice(): ReactElement {
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-3xl bg-surface p-4 shadow-card sm:flex-row sm:items-center">
      <p className="min-w-0 flex-1 text-sm text-muted">
        kip stopped receiving updates, so this screen may be out of date.
      </p>
      <Button
        variant="secondary"
        onClick={() => window.location.reload()}
        className="shrink-0"
      >
        Reload
      </Button>
    </div>
  );
}

// In place of the splash once the profile gate has given up — the splash claims
// something is still on its way. Deliberately BEHIND the gate: the other reading
// of an unanswered profile is "no profile", which is onboarding and an overwrite.
// Nothing here is terminal: a late answer opens the gate and this unmounts itself.
function Unreachable({ canSignOut }: { canSignOut: boolean }): ReactElement {
  const { signOut } = useKip();

  async function doSignOut() {
    try {
      await signOut();
    } catch (error) {
      console.error(error);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-xl font-bold tracking-[-0.02em]">
        Can't reach kip right now
      </h1>
      <p className="text-sm text-muted">
        Nothing is lost — this device just can't get through to kip. Check your
        connection and try again.
      </p>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => window.location.reload()}>
          Try again
        </Button>
        {/* A session the server refuses outright — a disabled account, a
            revoked token — lands here too, and reloading hits the same wall.
            Withheld from a session with nothing to sign back in with: there it
            destroys the account outright, dressed as recovery advice. */}
        {canSignOut ? (
          <Button variant="ghost" onClick={doSignOut}>
            Sign out
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Splash(): ReactElement {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Mark />
    </div>
  );
}

// Person resolves to a first name; every other detail screen has a fixed label.
function useScreenTitle(screen: Screen): string {
  const { user, friends } = useKip();
  switch (screen.kind) {
    case "tab":
      return TITLES[screen.tab];
    case "room":
      return "Place";
    case "booking":
      return "Booking";
    case "listing-form":
      return screen.id ? "Edit place" : "Add place";
    case "person": {
      if (screen.id === user?.uid) return "You";
      const friend = friends.find((candidate) => candidate.uid === screen.id);
      return friend ? friend.displayName.split(" ")[0] : "Profile";
    }
  }
}

export default function Page(): ReactElement {
  const {
    authReady,
    listenersLost,
    user,
    anonymous,
    profileReady,
    profileUnreachable,
    screen,
    canGoBack,
    popped,
    back,
    setView,
  } = useKip();
  const title = useScreenTitle(screen);
  const scroller = useRef<HTMLElement>(null);
  // True when the change came from history rather than a tap.
  const restoring = useRef(false);
  const lastPopped = useRef(popped);
  if (lastPopped.current !== popped) {
    lastPopped.current = popped;
    restoring.current = true;
  }

  // The screen's identity, not the object, which is rebuilt on every render.
  const screenKey = `${screen.kind}:${"id" in screen ? screen.id : ""}:${
    screen.kind === "tab" ? screen.tab : ""
  }:${screen.kind === "room" ? (screen.windowId ?? "") : ""}`;
  // Written continuously, not on the way out: a browser Back gives no chance to
  // save anything first.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let queued = 0;
    const onScroll = () => {
      window.clearTimeout(queued);
      queued = window.setTimeout(
        () => rememberScroll(element.scrollTop || window.scrollY),
        150,
      );
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.clearTimeout(queued);
      element.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  // Opening a screen starts at its top; returning puts it back where you left it.
  // Instant, never smooth — an animation on something that has only just appeared
  // reads as the page moving under you. Both the scroller and `window`, since
  // which one actually scrolls depends on the viewport.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the keys ARE the dependencies — the effect reads nothing from them and exists only to fire when they change.
  useEffect(() => {
    const to = restoring.current ? historyScroll() : 0;
    restoring.current = false;
    const apply = () => {
      scroller.current?.scrollTo({ top: to, behavior: "instant" });
      window.scrollTo({ top: to, behavior: "instant" });
      return (scroller.current?.scrollTop ?? window.scrollY) >= to;
    };
    if (apply() || to === 0) return;
    // You can't scroll to 900px until something is 900px tall, and a list you're
    // returning to may not have refetched yet — so retry while it fills in.
    // Landing short is the honest failure: too high, never somewhere unvisited.
    const timers = [60, 160, 320, 640].map((delay) =>
      window.setTimeout(apply, delay),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [screenKey, popped]);

  if (!authReady) return <Splash />;
  // Only a session-less visitor is turned away. An anonymous one is a
  // participant or about to be: they may hold a name, an ask, even friendships,
  // and every rule they meet is blind to how they signed in.
  if (!user) return <WelcomeScreen />;
  if (!profileReady)
    return profileUnreachable ? (
      <Unreachable canSignOut={!anonymous} />
    ) : (
      <Splash />
    );

  // The wordmark stands in for the title only where the title IS the app.
  const isHome = screen.kind === "tab" && screen.tab === "home";

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Mobile top bar: clean canvas, back + title (or wordmark on Home) + avatar */}
      <header className="flex h-14 items-center gap-2 px-4 md:hidden">
        {canGoBack ? (
          <IconButton label="Back" onClick={back} className="-ml-2">
            <LuArrowLeft />
          </IconButton>
        ) : null}
        {isHome ? (
          <button
            type="button"
            onClick={() => setView("home")}
            className="transition hover:opacity-80"
            aria-label="Home"
          >
            <Wordmark />
          </button>
        ) : (
          <h1 className="truncate text-lg font-bold tracking-[-0.02em]">
            {title}
          </h1>
        )}
        <div className="ml-auto flex items-center gap-1">
          <ThemeButton />
          <AuthMenu />
        </div>
      </header>

      <TopBar />

      <main ref={scroller} className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-4 pt-2 pb-28 md:px-6 md:pt-8 md:pb-14">
          {canGoBack ? (
            <div className="mb-4 hidden items-center gap-2 md:flex">
              <IconButton label="Back" variant="surface" onClick={back}>
                <LuArrowLeft />
              </IconButton>
              <span className="text-sm font-semibold text-muted">{title}</span>
            </div>
          ) : null}
          {listenersLost ? <StaleDataNotice /> : null}
          <CurrentScreen screen={screen} />
        </div>
      </main>

      <FloatingDock />
    </div>
  );
}
