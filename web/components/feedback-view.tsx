"use client";

import { type ReactElement, useCallback, useEffect, useState } from "react";
import { LuRefreshCw, LuTrash2 } from "react-icons/lu";
import {
  deleteFeedback,
  fetchFeedback,
  markFeedbackSeen,
  type Report,
} from "../utils/feedback";
import { useKip } from "../utils/store";
import IconButton from "./ui/icon-button";
import { Group, Section } from "./ui/list";

// When it arrived, to the minute. Not a relative age: a report read weeks later
// is the normal case here, and "3 weeks ago" is worse than a date for that.
function when(at: number): string {
  if (!at) return "just now";
  return new Date(at).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function FeedbackView(): ReactElement {
  const { user, admin, prefs } = useKip();
  // Read ONCE, on the way in. `prefs.feedbackSeenAt` moves the moment this marks
  // itself seen, so reading it live would clear every mark a beat after the
  // screen drew them — the reader would never see which ones were new.
  const [wasSeenAt] = useState(prefs.feedbackSeenAt);
  const [reports, setReports] = useState<readonly Report[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      setReports(await fetchFeedback());
      // Marked seen HERE, not on mount, and only for someone the reports were
      // actually shown to. On mount it fired for anyone who guessed the
      // fragment and was refused every report — clearing their dot for reports
      // they had never been shown, which for the operator meant arriving at a
      // full inbox with nothing marked new. A failed load leaves the mark alone
      // for the same reason: nothing was read.
      const uid = user?.uid;
      if (uid && admin) await markFeedbackSeen(uid);
    } catch (error) {
      console.warn("feedback", error);
      setProblem("Couldn't load these. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }, [user, admin]);

  useEffect(() => {
    void load();
  }, [load]);

  // No confirm. A report is one line of somebody's prose that has been read and
  // dealt with, and clearing it is the ordinary end of that — an "are you sure?"
  // on every one of them is a tax on the common case to guard a rare mis-tap.
  async function remove(report: Report): Promise<void> {
    // Dropped locally rather than by reloading: the list is a fetch, and a
    // round trip to learn what this client already knows would blank the screen
    // for the length of it.
    setReports((held) => (held ?? []).filter((one) => one.id !== report.id));
    try {
      await deleteFeedback(report.id);
    } catch (error) {
      console.warn("feedback", error);
      setProblem("That one didn't delete. Reload to see where things stand.");
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 pb-8">
      <Section
        title={
          reports === null
            ? "Reports"
            : `Reports · ${reports.length}${reports.length === 100 ? "+" : ""}`
        }
        action={
          <IconButton
            label="Refresh"
            variant="ghost"
            onClick={load}
            disabled={busy}
          >
            <LuRefreshCw />
          </IconButton>
        }
      >
        {problem ? (
          <p aria-live="polite" className="px-1 text-sm text-danger">
            {problem}
          </p>
        ) : null}
        {reports === null ? (
          <p className="px-1 text-sm text-muted">Loading…</p>
        ) : reports.length === 0 ? (
          <p className="px-1 text-sm text-muted">Nothing yet.</p>
        ) : (
          <Group>
            {reports.map((report) => (
              // Not a Row: these are whole paragraphs of someone's prose, and a
              // Row is a fixed-height line with one tap target. Nothing here
              // navigates, so there is no whole-row target to preserve.
              <div key={report.id} className="flex flex-col gap-2 p-4">
                <div className="flex items-center gap-2">
                  {wasSeenAt === null || report.at > wasSeenAt ? (
                    <span className="size-2 shrink-0 rounded-full bg-accent">
                      <span className="sr-only">unread</span>
                    </span>
                  ) : null}
                  <span className="text-xs tabular-nums text-muted">
                    {when(report.at)}
                  </span>
                  <IconButton
                    label="Delete"
                    variant="danger"
                    className="ml-auto"
                    onClick={() => remove(report)}
                  >
                    <LuTrash2 />
                  </IconButton>
                </div>
                {/* Their words, wrapped as typed — a report is often a list of
                    steps, and collapsing the newlines loses the order. */}
                <p className="whitespace-pre-wrap text-[0.9375rem] leading-6 text-text">
                  {report.text}
                </p>
              </div>
            ))}
          </Group>
        )}
      </Section>
    </div>
  );
}
