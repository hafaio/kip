"use client";

import type { ReactElement } from "react";
import type { ListingInput } from "../utils/listings";
import { useKip } from "../utils/store";
import ListingForm from "./listing-form";

// The listing editor as a stacked screen. `id` null mints a new listing (then
// replaces this screen with the new room page); an id edits in place (then pops
// back to wherever the editor was opened from).
export default function ListingFormScreen({
  id,
}: {
  id: string | null;
}): ReactElement {
  const {
    myListings,
    createListing,
    updateListing,
    setListingPhotos,
    replace,
    back,
  } = useKip();
  const initial = id
    ? myListings.find((listing) => listing.id === id)
    : undefined;

  if (id && !initial) {
    return <p className="text-muted">This place isn't available right now.</p>;
  }

  async function submit(input: ListingInput): Promise<void> {
    if (id) {
      await updateListing(id, input);
      back();
    } else {
      const newId = await createListing(input);
      replace({ kind: "room", id: newId });
    }
  }

  return (
    <ListingForm
      initial={initial}
      onSubmit={submit}
      onPhotos={id ? (photos) => setListingPhotos(id, photos) : undefined}
    />
  );
}
