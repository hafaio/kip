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

// One photo, sized by the caller: the cover on a card or a list row, and each
// slide of the gallery below. A place with no photo is the ordinary case, and
// renders its `fallback` — nothing at all on a card, so the layout is the one the
// card has always had rather than a permanent grey gap, but the type icon in a
// list row, where the leading slot exists either way and an empty one would
// break the row rhythm.
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

// A rail wider than its box has to LOOK cut off, or the eight photos a place can
// hold read as the three and a half that fit at 390px. Masked rather than
// overlaid with a gradient: the same rail sits on the canvas in one place and on
// a card in another, and an overlay would have to know which.
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
    // An arrow rather than a declaration: a hoisted one is created before the
    // guard above, so `node` would still be nullable inside it.
    const measure = (): void => {
      const before = node.scrollLeft > 1;
      const after = node.scrollWidth - node.clientWidth - node.scrollLeft > 1;
      // A scroll fires this every frame, so hand back the same object unless
      // something actually changed.
      setEdges((current) =>
        current.before === before && current.after === after
          ? current
          : { before, after },
      );
    };
    measure();
    // The rail is as wide as the screen, so what fits changes on rotate and on
    // any layout shift above it — not only when a photo is added.
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

// A place's photos, browsable: one at a time in a hero that swipes (scroll-snap,
// so touch costs no gesture code) or steps with its arrows, over a rail that
// jumps straight to one.
//
// The rail is optional because the OWNER already has one — the editing strip
// further down their page, where dragging a thumbnail reorders it and the first
// photo is the cover. Giving those same pictures a second meaning ("show me this
// one") would put two gestures on one target, so the owner's hero browses with
// the arrows alone and only the read-only views get the rail.
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
  // Anything not on our own bucket never renders, and a hole in the middle of
  // the hero would put every arrow press one photo out.
  const shown = photos.filter((photo) => photoSrc(photo.url) !== null);
  const { ref: rail, maskImage } = useRailFade(shown.length);

  // Stepping the hero walks the rail along with it, which is also how the
  // photos past the edge announce themselves. Scrolling the rail itself rather
  // than the thumbnail into view: the gallery can sit below the fold, and
  // scrollIntoView would drag the whole page up to it.
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
          // The scroll position IS which photo is showing — swipe, arrow and
          // thumbnail all move it, so there's one thing to keep in step.
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
              {/* The same 96px the editing strip uses, so a place's photos are
                  one size wherever they're shown. */}
              <CoverPhoto photo={photo} className="h-24 w-24" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
