"use client";

import {
  type ReactElement,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { LuChevronLeft, LuChevronRight } from "react-icons/lu";
import { photoSrc } from "../utils/photos";
import type { ListingPhoto } from "../utils/types";
import IconButton from "./ui/icon-button";

// How far a masked rail edge fades.
const FADE = "1.5rem";

// No photo is the ordinary case, so `fallback` differs by context: nothing on a
// card, where a grey gap would be worse, but an icon in a row, which needs its
// leading slot filled either way.
export default function CoverPhoto({
  photo,
  fallback = null,
  className = "",
}: {
  photo: ListingPhoto | undefined;
  fallback?: ReactElement | null;
  className?: string;
}): ReactElement | null {
  const src = photo ? photoSrc(photo.url) : null;
  if (!src) return fallback;

  return (
    <div
      className={`overflow-hidden rounded-2xl bg-surface-muted ${className}`.trim()}
    >
      {/* biome-ignore lint/performance/noImgElement: static export, no next/image loader */}
      <img src={src} alt="" className="h-full w-full object-cover" />
    </div>
  );
}

// Masked rather than overlaid with a gradient, because the same rail sits on the
// canvas in one place and on a card in another, and an overlay would need to know.
export function useRailFade(count: number): {
  ref: RefObject<HTMLDivElement | null>;
  maskImage: string | undefined;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ before: false, after: false });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `count` is not read below — it re-measures when a photo is added or removed, which the observer can't see, since the rail's own box doesn't change size when its contents do.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // An arrow, not a declaration: a hoisted one predates the guard above, so
    // `node` would still be nullable inside it.
    const measure = (): void => {
      const before = node.scrollLeft > 1;
      const after = node.scrollWidth - node.clientWidth - node.scrollLeft > 1;
      // Fires every frame while scrolling, so identity has to be stable.
      setEdges((current) =>
        current.before === before && current.after === after
          ? current
          : { before, after },
      );
    };
    measure();
    // What fits changes on rotate and any layout shift, not only on add.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    node.addEventListener("scroll", measure);
    return () => {
      observer.disconnect();
      node.removeEventListener("scroll", measure);
    };
  }, [count]);

  const stops = [
    edges.before ? "transparent 0" : "black 0",
    edges.before ? `black ${FADE}` : null,
    edges.after ? `black calc(100% - ${FADE})` : null,
    edges.after ? "transparent 100%" : "black 100%",
  ].filter((stop): stop is string => stop !== null);

  return {
    ref,
    maskImage:
      edges.before || edges.after
        ? `linear-gradient(to right, ${stops.join(", ")})`
        : undefined,
  };
}

// Scroll-snap, so touch costs no gesture code. The rail is optional because the
// owner already has one that reorders, and one target can't carry two gestures.
export function PhotoGallery({
  photos,
  thumbnails = true,
  heroClassName = "",
}: {
  photos: readonly ListingPhoto[];
  thumbnails?: boolean;
  heroClassName?: string;
}): ReactElement | null {
  const hero = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  // A hole in the middle would put every arrow press one photo out.
  const shown = photos.filter((photo) => photoSrc(photo.url) !== null);
  const { ref: rail, maskImage } = useRailFade(shown.length);

  // Scrolls the rail itself, not the thumbnail into view: the gallery can sit
  // below the fold, and scrollIntoView would drag the page up to it.
  useEffect(() => {
    const node = rail.current;
    const thumb = node?.querySelector<HTMLElement>(
      `[data-photo-index="${index}"]`,
    );
    if (!node || !thumb) return;
    node.scrollTo({
      left: thumb.offsetLeft - (node.clientWidth - thumb.clientWidth) / 2,
      behavior: "smooth",
    });
  }, [index, rail]);

  if (shown.length === 0) return null;

  function show(position: number): void {
    const node = hero.current;
    if (!node) return;
    node.scrollTo({ left: node.clientWidth * position, behavior: "smooth" });
  }

  const many = shown.length > 1;
  return (
    <div className="flex flex-col gap-2">
      <div className={`relative ${heroClassName}`.trim()}>
        <div
          ref={hero}
          // The scroll position IS which photo shows, so there's one source.
          onScroll={(event) => {
            const node = event.currentTarget;
            const at = Math.round(node.scrollLeft / node.clientWidth);
            setIndex(Math.max(0, Math.min(shown.length - 1, at)));
          }}
          className="flex h-full w-full snap-x snap-mandatory overflow-x-auto rounded-2xl"
        >
          {shown.map((photo) => (
            <CoverPhoto
              key={photo.id}
              photo={photo}
              className="h-full w-full shrink-0 snap-center"
            />
          ))}
        </div>
        {many ? (
          <>
            <IconButton
              label="Previous photo"
              variant="surface"
              disabled={index === 0}
              onClick={() => show(index - 1)}
              className="absolute left-2 top-1/2 -translate-y-1/2"
            >
              <LuChevronLeft />
            </IconButton>
            <IconButton
              label="Next photo"
              variant="surface"
              disabled={index === shown.length - 1}
              onClick={() => show(index + 1)}
              className="absolute right-2 top-1/2 -translate-y-1/2"
            >
              <LuChevronRight />
            </IconButton>
            <span className="absolute bottom-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-xs font-semibold tabular-nums text-white">
              {index + 1} / {shown.length}
            </span>
          </>
        ) : null}
      </div>

      {thumbnails && many ? (
        // `relative` so a thumbnail's offsetLeft is measured against the rail.
        <div
          ref={rail}
          style={{ maskImage }}
          className="relative flex gap-2 overflow-x-auto px-1 py-1"
        >
          {shown.map((photo, position) => (
            <button
              key={photo.id}
              type="button"
              data-photo-index={position}
              aria-label={`Show photo ${position + 1} of ${shown.length}`}
              aria-current={position === index}
              onClick={() => show(position)}
              className={`shrink-0 rounded-2xl transition ${
                position === index
                  ? "ring-2 ring-accent"
                  : "opacity-70 hover:opacity-100"
              }`}
            >
              {/* The same 96px the editing strip uses. */}
              <CoverPhoto photo={photo} className="h-24 w-24" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
