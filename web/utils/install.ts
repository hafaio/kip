"use client";

import { useEffect, useState } from "react";

// The only way to open the install dialog yourself, and Chrome hands it over
// once. Kept until it is used.
type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let waiting: InstallPrompt | null = null;
const watchers = new Set<() => void>();

function tell(): void {
  for (const watcher of watchers) watcher();
}

// Safari offers no equivalent event: an iPhone installs through Share → Add to
// Home Screen and nothing can trigger that from a page. Detected so the menu
// can say how instead of offering a button that cannot work. `MSStream` rules
// out old Edge, which lied about being iOS.
function isApple(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // An iPad reports a MACINTOSH user agent by default, and has done since
  // iPadOS 13 — so the obvious test misses every iPad and the row simply
  // vanishes for them, on a device where Add to Home Screen is right there. A
  // Mac with a touchscreen is what tells them apart, and there is no such Mac.
  const touch = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  return (
    (/iPad|iPhone|iPod/.test(ua) || touch) &&
    !("MSStream" in window) &&
    /Safari/.test(ua) &&
    !/CriOS|FxiOS/.test(ua)
  );
}

// Already installed, so there is nothing to offer. Both halves are needed: the
// media query answers on Android and desktop, `standalone` is Safari's own.
function isInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && navigator.standalone === true)
  );
}

// At module scope, not from an effect. Chrome can fire `beforeinstallprompt`
// before React has mounted anything, and does not replay it — so a listener
// attached in `useEffect` misses it and the row never appears that session.
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    // Always held, so installing only happens when someone asks: Chrome shows
    // its own banner whenever it likes, which is nagging where kip means to
    // offer.
    event.preventDefault();
    waiting = event as InstallPrompt;
    tell();
  });
  window.addEventListener("appinstalled", () => {
    waiting = null;
    tell();
  });
}

export type InstallState = {
  // A real prompt is available, so the control can be a button.
  ready: boolean;
  // No prompt will ever come, but it CAN be installed by hand.
  byHand: boolean;
  install: () => Promise<void>;
};

export function useInstall(): InstallState {
  const [, bump] = useState(0);
  const [installed, setInstalled] = useState(false);
  const [apple, setApple] = useState(false);

  // Read after mount, never during render: both answers come from the browser,
  // and a static export renders this HTML on a machine that has neither.
  useEffect(() => {
    setInstalled(isInstalled());
    setApple(isApple());
    const watcher = () => bump((n) => n + 1);
    watchers.add(watcher);
    return () => {
      watchers.delete(watcher);
    };
  }, []);

  return {
    ready: !installed && waiting !== null,
    byHand: !installed && apple,
    install: async () => {
      const held = waiting;
      if (!held) return;
      try {
        await held.prompt();
      } catch (error) {
        // Refused rather than shown — no user gesture behind the call, say —
        // which leaves the event unspent, so it is kept and the row stays.
        console.warn("install", error);
        return;
      }
      // Shown, so it is spent: a second `prompt()` on the same event throws,
      // and only a fresh `beforeinstallprompt` can offer again.
      waiting = null;
      tell();
    },
  };
}
