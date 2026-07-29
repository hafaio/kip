import type { ReactElement } from "react";

// The Terra wordmark: a small gradient rounded square holding a white "k", set
// beside "kip" in a semibold tight-tracked sans. One source of truth for the
// brand lockup — header, sign-in, portal, splash all render this.
export default function Wordmark({
  size = "md",
}: {
  size?: "md" | "lg";
}): ReactElement {
  const tile =
    size === "lg"
      ? "h-11 w-11 rounded-2xl text-2xl"
      : "h-8 w-8 rounded-xl text-lg";
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
