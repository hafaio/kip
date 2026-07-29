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
import OnboardingScreen from "../components/onboarding-screen";
import PersonPage from "../components/person-page";
import PlacesView from "../components/places-view";
import RoomPage from "../components/room-page";
import SettingsView from "../components/settings-view";
import SignInScreen from "../components/sign-in-screen";
import ThemeButton from "../components/theme-button";
import TripsView from "../components/trips-view";
import IconButton from "../components/ui/icon-button";
import Wordmark from "../components/wordmark";
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

function Splash(): ReactElement {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <span className="bg-gradient-accent grid h-16 w-16 animate-pulse place-items-center rounded-3xl text-3xl font-extrabold text-white shadow-glow">
        k
      </span>
    </div>
  );
}

// The per-screen page title shown in the header. Detail screens carry a generic
// label except person, which resolves to a familiar first name (or "You").
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
    user,
    profileReady,
    needsOnboarding,
    screen,
    canGoBack,
    popped,
    back,
    setView,
  } = useKip();
  const title = useScreenTitle(screen);
  const scroller = useRef<HTMLElement>(null);
  // Set by the effect below whenever the change came from history rather than a
  // tap, so the scroll effect knows which of the two things to do.
  const restoring = useRef(false);
  const lastPopped = useRef(popped);
  if (lastPopped.current !== popped) {
    lastPopped.current = popped;
    restoring.current = true;
  }

  // Opening a new screen should start at the top of it. Without this the scroll
  // position simply carries over, so tapping a place from halfway down Browse
  // lands you halfway down that place — usually past its photo and title. Keyed
  // on the screen's identity rather than the object, which is rebuilt on render.
  //
  // Instant, never smooth: a scroll animation on something that just appeared
  // reads as the page moving under you rather than as arriving somewhere.
  // `window` as well as the scroller, because which one actually scrolls depends
  // on the viewport.
  const screenKey = `${screen.kind}:${"id" in screen ? screen.id : ""}:${
    screen.kind === "tab" ? screen.tab : ""
  }:${screen.kind === "room" ? (screen.windowId ?? "") : ""}`;
  // Keep the current offset on this history entry, so going back can put the page
  // where it was. Written continuously rather than on the way out, because a
  // browser Back gives no chance to save anything first.
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

  // Opening a screen starts at the top of it; RETURNING to one puts it back where
  // you left it. Without the first, tapping a place from halfway down Browse
  // lands you halfway down that place, past its photo and title.
  //
  // Instant, never smooth: a scroll animation on something that has only just
  // appeared reads as the page moving under you rather than as arriving.
  //
  // The restore is applied twice — now and on the next frame — because a list you
  // are coming back to may not have its fetched contents yet, and you cannot
  // scroll to 900px until something is 900px tall. When the content is still
  // missing it lands short, which is the honest failure: too high, never wrong.
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
    // The list you're returning to may not have its fetched contents back yet,
    // and you can't scroll to 900px until something is 900px tall — the browser
    // silently clamps and you land at the top. So retry briefly while it fills
    // in, stopping as soon as the offset takes. If it never does, landing short
    // is the honest failure: too high, never somewhere you've never been.
    const timers = [60, 160, 320, 640].map((delay) =>
      window.setTimeout(apply, delay),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [screenKey, popped]);

  // Friends-only: nothing is public, so an unauthenticated visitor only ever
  // sees the sign-in screen. Hold on a splash until the session resolves, then
  // (once signed in) until the profile loads, so we can tell "needs a name"
  // apart from "still loading" without flashing the onboarding screen.
  if (!authReady) return <Splash />;
  // An anonymous session is a share-link visitor's ticket, not an account. It
  // has no profile and can see nothing here, so inside the app it counts as
  // signed out — otherwise the gate reads "authenticated, no profile" and asks a
  // passer-by to name themselves.
  if (!user || user.isAnonymous) return <SignInScreen />;
  if (!profileReady) return <Splash />;
  if (needsOnboarding) return <OnboardingScreen />;

  // The wordmark stands in for the title only when the title IS the app — the
  // Home tab. Everywhere else the header names the current screen.
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
          <CurrentScreen screen={screen} />
        </div>
      </main>

      <FloatingDock />
    </div>
  );
}
