"use client";

import type { ReactElement, ReactNode } from "react";

// The small helper/error/success line under a field or form. One style source
// for the note copy repeated across every form surface — auth, settings, the
// listing form, onboarding, and the profile.
type FieldNoteTone = "muted" | "danger" | "success";

const TONES: Record<FieldNoteTone, string> = {
  muted: "text-muted",
  danger: "text-danger",
  success: "text-success-ink",
};

export default function FieldNote({
  tone = "muted",
  children,
}: {
  tone?: FieldNoteTone;
  children: ReactNode;
}): ReactElement {
  return <p className={`px-1 text-sm ${TONES[tone]}`}>{children}</p>;
}
