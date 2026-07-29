"use client";

import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";

// A round 44px icon button. `label` drives both the tooltip and the accessible
// name, since the visible content is just an icon. ghost is the default quiet
// control; surface is a raised white circle (header/detail back + share);
// success/danger tint on hover for a quiet destructive action — clearing a
// location filter, turning off a share link.
type IconButtonVariant = "ghost" | "surface" | "danger" | "success";

const VARIANTS: Record<IconButtonVariant, string> = {
  ghost: "text-muted hover:bg-surface-hover hover:text-text",
  surface: "bg-surface text-text shadow-soft hover:bg-surface-hover",
  danger: "text-muted hover:bg-surface-hover hover:text-danger",
  success: "bg-success-soft text-success hover:opacity-90",
};

export default function IconButton({
  label,
  variant = "ghost",
  className = "",
  type = "button",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  variant?: IconButtonVariant;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={`grid h-11 w-11 shrink-0 place-items-center rounded-full transition disabled:pointer-events-none disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
