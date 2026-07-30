"use client";

import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { LuBookmark } from "react-icons/lu";
import {
  describeCriteria,
  hitsForSearches,
  type SavedSearch,
  type SearchCriteria,
  sameCriteria,
} from "../utils/search";
import { MAX_SAVED_SEARCHES } from "../utils/searches";
import { useKip } from "../utils/store";
import { useDialog } from "./dialog";
import SavedSearchRow from "./saved-search-row";
import Button from "./ui/button";
import Input from "./ui/input";
import { Group, Section } from "./ui/list";

// The bottom of the filter sheet: where a search is composed is where to keep
// one or pick one up again. Home renders the same list.
export default function SavedSearches({
  criteria,
  setCriteria,
  onApply,
}: {
  criteria: SearchCriteria;
  setCriteria: (criteria: SearchCriteria) => void;
  // Closes the sheet: picking one is asking to run it, not to fill a form in.
  onApply: () => void;
}): ReactElement {
  const {
    savedSearches,
    saveSearch,
    markSearchSeen,
    deleteSavedSearch,
    friendListings,
    friendWindows,
  } = useKip();
  const { confirm } = useDialog();
  const [naming, setNaming] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (naming) field.current?.focus();
  }, [naming]);

  const hits = useMemo(
    () => hitsForSearches(savedSearches, friendListings, friendWindows),
    [savedSearches, friendListings, friendWindows],
  );
  const suggestion = describeCriteria(criteria);
  const full = savedSearches.length >= MAX_SAVED_SEARCHES;
  // Ten slots, so a mis-tap spending one on a copy costs something real.
  const already = savedSearches.find((search) =>
    sameCriteria(search.criteria, criteria),
  );

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await saveSearch(label.trim() || suggestion, criteria);
      if (result === "full") {
        setError(`You can keep ${MAX_SAVED_SEARCHES} searches — remove one.`);
      } else if (result === "duplicate") {
        // Reachable despite the header swapping to "Saved as …": the filters
        // are above this field, so they can change while it's open.
        setError("You've already saved these filters.");
      } else {
        setLabel("");
        setNaming(false);
      }
    } catch (caught) {
      console.error(caught);
      setError("Couldn't save that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function apply(search: SavedSearch): void {
    setCriteria(search.criteria);
    markSearchSeen(search.id).catch((caught) =>
      console.error("markSearchSeen", caught),
    );
    onApply();
  }

  async function remove(search: SavedSearch): Promise<void> {
    const ok = await confirm({
      title: "Remove this search?",
      body: `"${search.label}" will stop appearing on your home screen.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (ok) await deleteSavedSearch(search.id);
  }

  return (
    <Section
      title="Saved searches"
      // Replaces the link rather than adding a line below it — same fact.
      action={
        already ? (
          <span className="min-w-0 truncate text-sm text-muted">
            Saved as "{already.label}"
          </span>
        ) : naming || full ? null : (
          <button
            type="button"
            onClick={() => setNaming(true)}
            className="shrink-0 text-sm font-semibold text-accent-ink hover:opacity-80"
          >
            Save this one
          </button>
        )
      }
    >
      {naming ? (
        <div className="flex flex-col gap-2">
          <Input
            ref={field}
            placeholder={suggestion}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                save();
              } else if (event.key === "Escape") {
                setNaming(false);
              }
            }}
          />
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => setNaming(false)}
              className="shrink-0"
            >
              Cancel
            </Button>
            <Button onClick={save} disabled={busy} className="flex-1">
              <LuBookmark />
              Save
            </Button>
          </div>
          <p className="px-1 text-sm text-muted">
            Named "{label.trim() || suggestion}" unless you change it.
          </p>
        </div>
      ) : null}

      {error ? <p className="px-1 text-sm text-danger">{error}</p> : null}
      {full && !naming ? (
        <p className="px-1 text-sm text-muted">
          That's the maximum of {MAX_SAVED_SEARCHES}. Remove one to save
          another.
        </p>
      ) : null}

      {hits.length > 0 ? (
        <Group>
          {hits.map((hit) => (
            <SavedSearchRow
              key={hit.search.id}
              hits={hit}
              onOpen={() => apply(hit.search)}
              onRemove={() => remove(hit.search)}
            />
          ))}
        </Group>
      ) : naming ? null : (
        <p className="px-1 text-sm text-muted">
          Nothing saved yet. Set some filters, then keep them here.
        </p>
      )}
    </Section>
  );
}
