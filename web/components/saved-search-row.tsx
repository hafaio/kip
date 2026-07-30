"use client";

import type { ReactElement } from "react";
import { LuTrash2 } from "react-icons/lu";
import { describeCriteria, type SavedSearchHits } from "../utils/search";
import { CountBadge } from "./ui/chip";
import IconButton from "./ui/icon-button";
import { Row } from "./ui/list";

// Shared by Home and the filter sheet so the two can't drift into wording a
// count differently. NOT a whole-row tap target, unlike rows elsewhere:
// removing one needs its own control, and a button can't nest in a button.
export default function SavedSearchRow({
  hits: { search, places, fresh },
  onOpen,
  onRemove,
}: {
  hits: SavedSearchHits;
  onOpen: () => void;
  onRemove: () => void;
}): ReactElement {
  return (
    <Row>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 flex-col items-start text-left"
      >
        <span className="w-full truncate font-medium">{search.label}</span>
        <span className="w-full truncate text-sm text-muted">
          {places === 1 ? "1 place" : `${places} places`} ·{" "}
          {describeCriteria(search.criteria)}
        </span>
      </button>
      <CountBadge count={fresh} />
      <IconButton
        label={`Remove ${search.label}`}
        variant="ghost"
        onClick={onRemove}
      >
        <LuTrash2 />
      </IconButton>
    </Row>
  );
}
