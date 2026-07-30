"use client";

import {
  type DragEvent as ReactDragEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  LuCamera,
  LuChevronLeft,
  LuChevronRight,
  LuLoaderCircle,
  LuTrash2,
} from "react-icons/lu";
import {
  deleteListingPhoto,
  MAX_PHOTOS,
  photoSrc,
  uploadListingPhoto,
} from "../utils/photos";
import type { ListingPhoto } from "../utils/types";
import { useRailFade } from "./cover-photo";

// A drag exposes its `types` but not its data until the drop, so a reorder needs
// a type of its own to be told apart from a file drop.
const PHOTO_DRAG_TYPE = "application/x-kip-photo";

function isPhotoDrag(event: ReactDragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes(PHOTO_DRAG_TYPE);
}

// On top of a photo, so it carries its own contrast rather than a surface token.
const OVERLAY_CONTROL =
  "grid h-7 w-7 place-items-center rounded-full bg-black/55 text-white transition hover:bg-black/75 disabled:opacity-50";

// Removing first is what makes a rightward move land after its target.
function reordered(
  photos: readonly ListingPhoto[],
  photoId: string,
  to: number,
): ListingPhoto[] {
  const moved = photos.filter((photo) => photo.id === photoId);
  const rest = photos.filter((photo) => photo.id !== photoId);
  return [...rest.slice(0, to), ...moved, ...rest.slice(to)];
}

// Order is user-visible: the first photo is the cover everywhere it appears.
export default function PhotoStrip({
  ownerId,
  listingId,
  photos,
  editable = false,
  onChange,
}: {
  ownerId: string;
  listingId: string;
  photos: readonly ListingPhoto[];
  editable?: boolean;
  onChange?: (photos: ListingPhoto[]) => Promise<void>;
}): ReactElement | null {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  // Shown before it's stored, so the strip moves under the finger rather than
  // after the round trip.
  const [pendingOrder, setPendingOrder] = useState<
    readonly ListingPhoto[] | null
  >(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // A full strip runs past a phone's width, and a hard edge would read as
  // "that's all of them".
  const { ref: strip, maskImage } = useRailFade(photos.length);

  const order = pendingOrder ?? photos;

  // A file dropped outside a drop target navigates the browser to it, replacing
  // the app. The strip's own handlers still see their drop first, by bubbling.
  useEffect(() => {
    if (!editable) return;
    function swallow(event: DragEvent): void {
      event.preventDefault();
    }
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, [editable]);

  if (!editable && photos.length === 0) return null;

  const full = photos.length >= MAX_PHOTOS;
  const accepting = editable && !full && !busy;
  // A write in flight takes the affordances out of service, not off the screen.
  const sortable = editable && onChange !== undefined && order.length > 1;

  // Both the picker and a drop land here, so the cap and the image filter are
  // applied once — `accept` is only a hint, and pickers let anything through.
  async function add(files: readonly File[]): Promise<void> {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0 || !onChange) return;
    setBusy(true);
    setError(null);
    try {
      const room = MAX_PHOTOS - photos.length;
      const added: ListingPhoto[] = [];
      for (const file of images.slice(0, room)) {
        // Upload first: a listing pointing at a missing object renders a
        // permanent gap, where an orphaned object is merely invisible.
        added.push(await uploadListingPhoto(ownerId, listingId, file));
      }
      if (added.length > 0) await onChange([...photos, ...added]);
    } catch (caught) {
      console.error(caught);
      setError("That didn't upload. Check your connection and try again.");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function remove(photoId: string): Promise<void> {
    if (!onChange) return;
    setBusy(true);
    setError(null);
    try {
      // Drop the photo first here — the reverse of adding. If deleting the object
      // then fails, the photo is already invisible, which is what was asked for.
      await onChange(photos.filter((photo) => photo.id !== photoId));
      await deleteListingPhoto(ownerId, listingId, photoId);
    } catch (caught) {
      console.error(caught);
      setError("Couldn't remove that photo. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // Both routes to a new order — a drop and the arrows — land here. The strip
  // shows the result immediately and hands `pendingOrder` back afterwards: on
  // success the listener already carries the same order, and on failure the
  // stored one is still the truth, so either way the prop is what to render.
  async function reorder(next: readonly ListingPhoto[]): Promise<void> {
    if (!onChange) return;
    setPendingOrder(next);
    setBusy(true);
    setError(null);
    try {
      await onChange([...next]);
    } catch (caught) {
      console.error(caught);
      setError("Couldn't save that order. Try again.");
    } finally {
      setPendingOrder(null);
      setBusy(false);
    }
  }

  function move(photoId: string, delta: number): void {
    const to = order.findIndex((photo) => photo.id === photoId) + delta;
    if (to < 0 || to >= order.length) return;
    reorder(reordered(order, photoId, to)).catch((caught) =>
      console.error("reorder", caught),
    );
  }

  function onDrop(event: ReactDragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDropping(false);
    if (!accepting) return;
    add(Array.from(event.dataTransfer.files)).catch((caught) =>
      console.error("add", caught),
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: dropping is an
          addition to the picker button below, which stays keyboard-reachable */}
      <div
        ref={strip}
        style={{ maskImage }}
        onDragEnter={(event) => {
          // Only files: a photo being dragged within the strip, or text, or a
          // link, must not arm the target for an upload.
          if (accepting && event.dataTransfer.types.includes("Files")) {
            setDropping(true);
          }
        }}
        onDragOver={(event) => {
          // Without cancelling the drag-over the browser never fires a drop here.
          // A photo drag is the thumbnails' business, so it is left alone: one
          // released between them carries no files and lands as a no-op rather
          // than being taken for an upload.
          if (!accepting || isPhotoDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        // Crossing a child fires dragleave for the one being left, so ignore any
        // whose destination is still inside the strip (null = left the window).
        onDragLeave={(event) => {
          const next = event.relatedTarget;
          if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
            setDropping(false);
            setOverId(null);
          }
        }}
        onDrop={onDrop}
        // The border is always there, transparent, so arming the target can't
        // shift the row by a pixel.
        className={`flex gap-2 overflow-x-auto rounded-2xl border px-1 py-1 transition ${
          dropping ? "border-accent bg-accent-soft" : "border-transparent"
        }`}
      >
        {order.map(({ id: photoId, url }, index) => (
          /* biome-ignore lint/a11y/noStaticElementInteractions: dragging is an
             addition to the arrow buttons below, which are keyboard-reachable */
          <div
            key={photoId}
            draggable={sortable && !busy}
            onDragStart={(event) => {
              // The id rides in a type of our own so a drop anywhere else reads
              // as nothing, and so the file-drop handlers can ignore it.
              event.dataTransfer.setData(PHOTO_DRAG_TYPE, photoId);
              event.dataTransfer.effectAllowed = "move";
              setDraggingId(photoId);
            }}
            onDragEnd={() => {
              setDraggingId(null);
              setOverId(null);
            }}
            onDragOver={(event) => {
              if (!sortable || busy || !isPhotoDrag(event)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setOverId(photoId);
            }}
            onDrop={(event) => {
              if (!isPhotoDrag(event)) return;
              event.preventDefault();
              // The strip's own drop handler adds files; this one is already
              // dealt with, so don't let it get there.
              event.stopPropagation();
              setOverId(null);
              setDraggingId(null);
              const dragged = event.dataTransfer.getData(PHOTO_DRAG_TYPE);
              if (dragged && dragged !== photoId) {
                reorder(reordered(order, dragged, index)).catch((caught) =>
                  console.error("reorder", caught),
                );
              }
            }}
            className={`relative h-24 w-24 shrink-0 overflow-hidden rounded-2xl bg-surface-muted transition ${
              draggingId === photoId ? "opacity-40" : ""
            } ${overId === photoId && draggingId !== photoId ? "ring-2 ring-accent" : ""}`}
          >
            {/* biome-ignore lint/performance/noImgElement: static export, no next/image loader */}
            <img
              src={photoSrc(url) ?? ""}
              alt=""
              // An image is draggable in its own right, and would start a drag of
              // the picture instead of the one this thumbnail defines.
              draggable={false}
              className="h-full w-full object-cover"
            />
            {editable && index === 0 ? (
              <span className="absolute left-1 top-1 rounded-full bg-black/45 px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wide text-white">
                Cover
              </span>
            ) : null}
            {editable ? (
              <button
                type="button"
                onClick={() => remove(photoId)}
                disabled={busy}
                aria-label="Remove photo"
                className={`absolute right-1 top-1 ${OVERLAY_CONTROL}`}
              >
                <LuTrash2 size={13} />
              </button>
            ) : null}
            {sortable && index > 0 ? (
              <button
                type="button"
                onClick={() => move(photoId, -1)}
                disabled={busy}
                aria-label={`Move photo ${index + 1} left`}
                className={`absolute bottom-1 left-1 ${OVERLAY_CONTROL}`}
              >
                <LuChevronLeft size={14} />
              </button>
            ) : null}
            {sortable && index < order.length - 1 ? (
              <button
                type="button"
                onClick={() => move(photoId, 1)}
                disabled={busy}
                aria-label={`Move photo ${index + 1} right`}
                className={`absolute bottom-1 right-1 ${OVERLAY_CONTROL}`}
              >
                <LuChevronRight size={14} />
              </button>
            ) : null}
          </div>
        ))}

        {editable && !full ? (
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            title="Add photos"
            className={`grid h-24 w-24 shrink-0 place-items-center rounded-2xl border border-dashed transition disabled:opacity-50 ${
              dropping
                ? "border-accent bg-surface text-accent-ink"
                : "border-border text-muted hover:bg-surface-hover"
            }`}
          >
            {busy ? <LuLoaderCircle className="animate-spin" /> : <LuCamera />}
          </button>
        ) : null}
      </div>

      {editable ? (
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => add(Array.from(event.target.files ?? []))}
        />
      ) : null}

      {error ? <p className="px-1 text-sm text-danger">{error}</p> : null}
      {editable && !full ? (
        <p className="px-1 text-sm text-muted">
          Tap to choose photos, or drop them here.
        </p>
      ) : null}
      {editable && full ? (
        <p className="px-1 text-sm text-muted">
          That's the maximum of {MAX_PHOTOS} photos.
        </p>
      ) : null}
      {sortable ? (
        <p className="px-1 text-sm text-muted">
          Drag a photo, or use its arrows, to change the order.
        </p>
      ) : null}
    </div>
  );
}
