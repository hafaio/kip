"use client";

import type { ReactElement } from "react";
import { photoSrc } from "../utils/photos";

// Pass sizing via className (e.g. "h-9 w-9 text-sm") — Tailwind needs literal
// classes, so size can't be a number prop. `ring` wraps the avatar in a 2px
// terracotta→amber gradient ring, used to feature a host.
export default function Avatar({
  name,
  photoURL,
  className = "h-9 w-9 text-sm",
  ring = false,
}: {
  name: string;
  photoURL: string | null;
  className?: string;
  ring?: boolean;
}): ReactElement {
  // Almost every avatar drawn here comes from a copy the person it describes
  // wrote — a friend edge, a booking, a share link — so the address is theirs to
  // choose and `photoSrc` is what keeps it from being an arbitrary one. A URL
  // that fails the check falls back to the initial, same as no photo at all.
  const src = photoURL === null ? null : photoSrc(photoURL);
  const inner = src ? (
    // biome-ignore lint/performance/noImgElement: static export, no next/image loader
    <img
      src={src}
      alt=""
      className={`${className} shrink-0 rounded-full object-cover`}
      referrerPolicy="no-referrer"
    />
  ) : (
    <span
      className={`${className} grid shrink-0 place-items-center rounded-full bg-accent-soft font-bold text-accent-ink`}
    >
      {(name || "?").charAt(0).toUpperCase()}
    </span>
  );

  if (!ring) return inner;
  return (
    <span className="bg-gradient-accent inline-flex shrink-0 rounded-full p-[2px] shadow-soft">
      <span className="rounded-full border-2 border-surface">{inner}</span>
    </span>
  );
}
