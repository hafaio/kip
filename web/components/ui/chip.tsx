import type { ReactElement, ReactNode } from "react";

// A soft tonal status chip: a small pill with a low-contrast fill and a semibold
// label, so it reads as a passive label — never as a button, even beside one.
// Replaces the old editorial `Status` byline. Tones map to the app's states:
// pending (amber), confirmed (green), open and instant (accent), booked (dimmed
// neutral), type (neutral fill for ROOM/FLAT/HOUSE), neutral (cancelled /
// muted). Colour carries the meaning and adapts to dark mode through the
// semantic tokens.
export type ChipTone =
  | "pending"
  | "confirmed"
  | "open"
  | "booked"
  | "instant"
  | "type"
  | "neutral";

const TONES: Record<ChipTone, string> = {
  pending: "bg-pending-soft text-pending",
  confirmed: "bg-success-soft text-success-ink",
  open: "bg-accent-soft text-accent-ink",
  booked: "bg-surface-muted text-muted",
  // The gradient belongs to controls, and this chip sits right beside the
  // gradient Book button on a slot row — two identical pills, one of which does
  // nothing. Tonal instead; the bolt carries the meaning.
  instant: "bg-accent-soft text-accent-ink",
  type: "bg-surface-muted text-muted uppercase tracking-[0.04em]",
  neutral: "bg-surface-muted text-muted",
};

export default function Chip({
  tone = "neutral",
  icon,
  className = "",
  children,
}: {
  tone?: ChipTone;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <span
      className={`inline-flex w-fit shrink-0 select-none items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[0.6875rem] font-bold leading-none tracking-[0.02em] ${TONES[tone]} ${className}`}
    >
      {icon}
      {children}
    </span>
  );
}

// The gradient count badge used on nav destinations (dock + top bar) — a filled
// pill with a white number, no dot.
export function CountBadge({ count }: { count: number }): ReactElement | null {
  if (count <= 0) return null;
  return (
    <span className="bg-gradient-accent grid h-[1.125rem] min-w-[1.125rem] place-items-center rounded-full px-1 text-[0.6875rem] font-bold leading-none text-white tabular-nums">
      {count}
    </span>
  );
}
