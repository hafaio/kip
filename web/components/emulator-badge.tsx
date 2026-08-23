"use client";

import type { ReactElement } from "react";
import { usingEmulators } from "../utils/firebase";

// Says which backend this build is talking to, because the difference is
// otherwise invisible and its symptoms look like bugs: an emulated Firestore
// starts empty, so every real share link resolves to nothing and reads as
// "this link isn't active". Folded out of production entirely by the NODE_ENV
// half of `usingEmulators`.
export default function EmulatorBadge(): ReactElement | null {
  if (!usingEmulators()) return null;
  return (
    <div className="pointer-events-none fixed left-1/2 top-2 z-50 -translate-x-1/2 rounded-full bg-danger px-3 py-1 text-xs font-semibold text-white shadow-card">
      Emulated — real share links won't resolve
    </div>
  );
}
