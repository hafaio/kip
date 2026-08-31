"use client";

import { type ReactElement, useState } from "react";
import { MAX_FEEDBACK, sendFeedback } from "../utils/feedback";
import Button from "./ui/button";
import { Textarea } from "./ui/input";
import Sheet from "./ui/sheet";

export default function FeedbackSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactElement {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  function close(): void {
    onClose();
    // Only once it is out of sight: resetting while the sheet is still on
    // screen plays the whole form back in the last frame of the dismissal.
    setTimeout(() => {
      setText("");
      setSent(false);
      setProblem(null);
    }, 200);
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await sendFeedback(text);
      setSent(true);
    } catch (error) {
      console.warn("feedback", error);
      setProblem("That didn't send. Have another go in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={close}
      title={sent ? "Thank you" : "Send feedback"}
    >
      {sent ? (
        <>
          <p className="text-sm leading-6 text-muted">
            That's with us. We read every one, though we can't always write back
            — if you'd like an answer, say how to reach you.
          </p>
          <Button size="lg" className="mt-5 w-full" onClick={close}>
            Done
          </Button>
        </>
      ) : (
        <>
          {/* One box and nothing else. Asking someone to pick a category first
              makes them sort their own report before they can write it, and
              sorting them is the reader's job. */}
          <Textarea
            autoFocus
            rows={5}
            maxLength={MAX_FEEDBACK}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="What's on your mind?"
          />
          {/* Where it goes, said before the button rather than after it. kip
              keeps this to itself — nothing forwards it and nothing publishes
              it — which is worth saying outright, because "send feedback"
              elsewhere often means a public tracker. */}
          <p className="mt-3 text-sm leading-5 text-muted">
            This goes to the people who make kip, and nowhere else.
          </p>
          {/* Mounted whatever happens, at zero height when there is nothing to
              say: a live region announces a CHANGE, so a message that appears
              together with its element is one a screen reader never reads out. */}
          <p
            aria-live="polite"
            className={`text-sm leading-5 text-danger ${problem ? "mt-3" : ""}`}
          >
            {problem}
          </p>
          <Button
            size="lg"
            className="mt-4 w-full"
            disabled={busy || text.trim().length === 0}
            onClick={submit}
          >
            {busy ? "Sending…" : "Send"}
          </Button>
        </>
      )}
    </Sheet>
  );
}
