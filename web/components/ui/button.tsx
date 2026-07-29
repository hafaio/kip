"use client";

import type { ButtonHTMLAttributes, ReactElement } from "react";

// Every button in the app is one of these Terra variants: a pill at the shared
// 44px (h-11) control height, or the chunky 48px (h-12) `size="lg"` used for
// full-width CTAs on sheets and detail surfaces. primary is the gradient CTA;
// secondary a tonal accent fill; ghost a quiet text button; danger a soft-red
// fill (the dialog raises it to a solid danger for the destructive confirm).
type ButtonVariant =
  | "primary"
  | "secondary"
  | "danger"
  | "dangerSolid"
  | "ghost";
type ButtonSize = "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-gradient-accent text-white shadow-glow hover:opacity-95",
  secondary: "bg-accent-soft text-accent-ink hover:opacity-80",
  danger: "bg-danger-soft text-danger hover:opacity-80",
  dangerSolid: "bg-danger text-white hover:opacity-90",
  ghost: "text-muted hover:bg-surface-hover hover:text-text",
};

const SIZES: Record<ButtonSize, string> = {
  md: "h-11 px-5 text-[0.9375rem]",
  lg: "h-12 px-6 text-base",
};

export default function Button({
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}): ReactElement {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-full font-semibold tracking-[-0.01em] transition disabled:pointer-events-none disabled:opacity-50 active:translate-y-px ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}
