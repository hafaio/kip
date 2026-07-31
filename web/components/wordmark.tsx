import type { ReactElement } from "react";

// The "k" standing on its own — loading the app, and loading a share link. Was
// hand-copied into both screens, which is how the two would have drifted.
export function Mark(): ReactElement {
  return (
    <span className="bg-gradient-accent grid h-16 w-16 animate-pulse place-items-center rounded-full text-3xl font-extrabold text-white shadow-glow">
      k
    </span>
  );
}

// The Terra wordmark: the gradient disc holding a white "k", set beside "kip" in
// a heavy tight-tracked sans. One source of truth for the brand lockup — header,
// sign-in, portal all render this.
export default function Wordmark({
  size = "md",
}: {
  size?: "md" | "lg";
}): ReactElement {
  // `rounded-full`, not a radius from the scale. Terra's radii already exceed
  // half of a box this small and CSS clamps there, so both sizes drew circles
  // while their classes said otherwise — one scale change from squaring off.
  const tile =
    size === "lg"
      ? "h-11 w-11 rounded-full text-2xl"
      : "h-8 w-8 rounded-full text-lg";
  const word = size === "lg" ? "text-3xl" : "text-xl";
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={`bg-gradient-accent grid place-items-center font-extrabold text-white shadow-glow ${tile}`}
      >
        k
      </span>
      <span className={`font-extrabold tracking-[-0.03em] ${word}`}>kip</span>
    </span>
  );
}
